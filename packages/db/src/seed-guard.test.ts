import { spawn } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { count, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { products, tenants, users } from './schema'
import { describeTarget } from './target'
import { detUuid, resetTestDatabase, testAdminDb, testDatabaseUrls } from './testing'

/**
 * ============================================================================
 * T125 — SEED YANLIŞ HEDEFTE SİLEMEZ
 *
 * Seed GERÇEK alt süreç olarak koşuyor (`src/seed.ts`), import edilerek
 * değil: koruma seed'in kendi giriş noktasında duruyor ve sınanması gereken
 * şey "yanlış kabukta `pnpm seed` yazıldığında ne olur". Seed her şeyi
 * sildiği için kendi veritabanlarında koşuyor; `stok_test_db`'ye dokunsaydı
 * diğer test dosyalarının kiracılarını silerdi.
 *
 * "UZAK" ADRES GERÇEKTEN ERİŞİLEBİLİR (T186): 127.0.0.2 de loopback ama
 * izin listesinde yok. Veritabanı portu WS-1.1'den beri yalnız 127.0.0.1'e
 * bağlı; 127.0.0.2:5433 yerelde reddediliyor, CI'da açık. Test bu yüzden
 * 127.0.0.2'de kendi yönlendiricisini açıp trafiği test kümesine iletiyor:
 * iki ortamda da adres seedguard veritabanına ulaşıyor (kontrol testi bunu
 * ölçüyor) ve yönlendirici gelen bağlantıları sayıyor. Koruma çalışmasaydı
 * seed bu adresten veriyi silerdi; "bağlantı açmadan" iddiası da sayaçla
 * ölçülüyor, bir bağlantı hatasına güvenilmiyor.
 *
 * Seed ASENKRON koşuyor: `spawnSync` bu sürecin olay döngüsünü kilitlerdi,
 * yönlendirici bağlantıyı kabul edemez ve uzak adres yine ulaşılamaz olurdu.
 *
 * YIKICI DENEMELER YALNIZ `stok_test_*`: buradaki her adres, koruma
 * kaldırılsa bile yalnız bu dosyanın her koşuda sıfırdan kurduğu test
 * veritabanlarına ulaşıyor; `postgres` ve gerçek veritabanları hedef değil.
 * ============================================================================
 */

const GUARD_DB = 'stok_test_seedguard'
const DEMO_DB = 'stok_test_seeddemo'
// T187/T186: adresi başka yere yönlenen seed'in ulaşacağı, silinmesi güvenli yer.
const DIVERTED_DB = 'stok_test_seeddivert'
// T187: tabloları başka şemaya çözülen veritabanı.
const SHADOW_DB = 'stok_test_seedshadow'
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const PILOT_TENANT = detUuid('tenant:seedguard-pilot')
// seed.ts'teki demo kiracılarıyla aynı deterministik kimlikler.
const DEMO_TENANT_IDS = [detUuid('tenant:yilmaz'), detUuid('tenant:demir')]

let guard: ReturnType<typeof testAdminDb>
let demo: ReturnType<typeof testAdminDb>
let diverted: ReturnType<typeof testAdminDb>
let shadow: ReturnType<typeof testAdminDb>
let remote: Forwarder
let local: Forwarder

function runSeed(url: string, args: string[] = [], env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/seed.ts', ...args], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, MIGRATION_DATABASE_URL: url, ...env },
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      output += d
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      output += d
    })
    const timer = setTimeout(() => child.kill(), 180_000)
    child.on('error', reject)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, output })
    })
  })
}

interface Forwarder {
  port: number
  connections: () => number
  close: () => Promise<void>
}

/** Gelen bağlantıları sayıp test kümesine ileten TCP yönlendirici (T186). */
async function startForwarder(host: string): Promise<Forwarder> {
  const upstream = new URL(testDatabaseUrls(GUARD_DB).migrationUrl)
  const sockets = new Set<net.Socket>()
  let connections = 0
  const server = net.createServer((client) => {
    connections++
    const db = net.connect(Number(upstream.port), upstream.hostname)
    for (const s of [client, db]) {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
      s.on('error', () => {
        client.destroy()
        db.destroy()
      })
    }
    client.pipe(db).pipe(client)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve())
  })
  return {
    port: (server.address() as net.AddressInfo).port,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}

function via(url: string, host: string, port: number): string {
  const u = new URL(url)
  u.hostname = host
  u.port = String(port)
  return u.toString()
}

/**
 * Adresin GERÇEKTEN hangi veritabanına ulaştığı (kontrol testleri). Sürücü
 * `PGDATABASE`'i bağlantı kurulurken değil, seçenekler okunurken alıyor.
 */
async function currentDatabaseVia(url: string, pgDatabase?: string): Promise<string> {
  const previous = process.env.PGDATABASE
  if (pgDatabase) process.env.PGDATABASE = pgDatabase
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  if (previous === undefined) delete process.env.PGDATABASE
  else process.env.PGDATABASE = previous
  try {
    const [row] = await sql<{ db: string }[]>`SELECT current_database() AS db`
    return row!.db
  } finally {
    await sql.end()
  }
}

async function pilotIntact(): Promise<boolean> {
  const rows = await guard.db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, PILOT_TENANT))
  return rows.length === 1
}

/**
 * Sentetik pilot kiracı ve ona bağlı bir konum. Konum, CASCADE'in kiracıyı
 * değil yalnız alt tabloları sildiği durumu (şema gölgesi) görünür kılıyor.
 * Şema adı açık yazılıyor: gölgeli veritabanında şemasız ad başka tabloya gider.
 */
async function insertPilot(client: postgres.Sql): Promise<void> {
  await client`INSERT INTO public.tenants (id, name) VALUES (${PILOT_TENANT}, 'Sentetik Pilot İşletme')`
  await client`INSERT INTO public.locations (tenant_id, code, name) VALUES (${PILOT_TENANT}, 'ANA', 'Ana depo')`
}

async function pilotRowsIn(client: postgres.Sql): Promise<number> {
  const [row] = await client<{ n: number }[]>`
    SELECT (SELECT count(*) FROM public.tenants WHERE id = ${PILOT_TENANT})
         + (SELECT count(*) FROM public.locations WHERE tenant_id = ${PILOT_TENANT}) AS n`
  return Number(row!.n)
}

beforeAll(async () => {
  for (const name of [GUARD_DB, DEMO_DB, DIVERTED_DB, SHADOW_DB]) await resetTestDatabase(name)
  guard = testAdminDb(GUARD_DB)
  demo = testAdminDb(DEMO_DB)
  diverted = testAdminDb(DIVERTED_DB)
  shadow = testAdminDb(SHADOW_DB)
  // Seed'e ait olmayan, "gerçek" yerine geçen sentetik bir kiracı.
  await guard.db.insert(tenants).values({ id: PILOT_TENANT, name: 'Sentetik Pilot İşletme' })
  // Daha önce seed'lenmiş bir demo veritabanını taklit ediyor.
  await demo.db.insert(tenants).values([
    { id: DEMO_TENANT_IDS[0]!, name: 'Eski demo 1' },
    { id: DEMO_TENANT_IDS[1]!, name: 'Eski demo 2' },
  ])
  await insertPilot(diverted.client)
  await insertPilot(shadow.client)
  // Gölge: boş bir `golge.tenants` kiracıları sayan sorguyu, veritabanı
  // ayarı da bütün yeni oturumların şemasız adlarını oraya yönlendiriyor.
  // Defter tabloları public'te kalıyor; CASCADE onları silerdi.
  await shadow.client.unsafe(`
    CREATE SCHEMA golge;
    CREATE TABLE golge.tenants (LIKE public.tenants INCLUDING ALL);
    ALTER DATABASE ${SHADOW_DB} SET search_path = golge, public;
  `)
  remote = await startForwarder('127.0.0.2')
  local = await startForwarder('127.0.0.1')
}, 180_000)

afterAll(async () => {
  await remote?.close()
  await local?.close()
  for (const c of [guard, demo, diverted, shadow]) await c?.client.end()
})

describe('seed koruması (T125)', () => {
  const localUrl = () => testDatabaseUrls(GUARD_DB).migrationUrl
  const remoteUrl = () => via(localUrl(), '127.0.0.2', remote.port)

  it('uzak adres gerçekten bu test veritabanına ulaşıyor (kontrol, T186)', async () => {
    expect(describeTarget(remoteUrl()).isLocal).toBe(false)
    expect(await currentDatabaseVia(remoteUrl())).toBe(GUARD_DB)
    expect(await pilotIntact()).toBe(true)
  })

  it('uzak hedefte bağlantı açmadan reddediyor ve veriye dokunmuyor', async () => {
    const before = remote.connections()
    const { status, output } = await runSeed(remoteUrl())

    expect(status).not.toBe(0)
    expect(output).toMatch(/yalnız yerel veritabanında çalışır/)
    expect(remote.connections()).toBe(before)
    expect(await pilotIntact()).toBe(true)
  })

  it('uzak hedefte silme onayı da işe yaramıyor', async () => {
    const before = remote.connections()
    const { status, output } = await runSeed(remoteUrl(), [`--wipe-non-demo-data=${GUARD_DB}`])

    expect(status).not.toBe(0)
    expect(output).toMatch(/yalnız yerel veritabanında çalışır/)
    expect(remote.connections()).toBe(before)
    expect(await pilotIntact()).toBe(true)
  })

  it('yerel hedefte demo dışı kiracı varsa reddediyor', async () => {
    const { status, output } = await runSeed(localUrl())

    expect(status).not.toBe(0)
    expect(output).toMatch(/seed'e ait olmayan 1 kiracı var/)
    expect(await pilotIntact()).toBe(true)
  })

  it('onay başka bir veritabanının adıyla verilirse reddediyor', async () => {
    const { status, output } = await runSeed(localUrl(), ['--wipe-non-demo-data=stok'])

    expect(status).not.toBe(0)
    expect(output).toMatch(/seed'e ait olmayan 1 kiracı var/)
    expect(await pilotIntact()).toBe(true)
  })

  it('RLS’e tabi bir rolle kiracılar görülemediği için reddediyor', async () => {
    // Uygulama rolü (stok_app): tabloları FORCE RLS ile bağlamsız BOŞ görür.
    // "Hiç kiracı yok" sanılsaydı koruma sessizce açık kalırdı.
    const { status, output } = await runSeed(testDatabaseUrls(GUARD_DB).appUrl)

    expect(status).not.toBe(0)
    expect(output).toMatch(/RLS'i atlamıyor/)
    expect(await pilotIntact()).toBe(true)
  })

  it('yalnız demo kiracıları varken seed çalışıyor (pnpm demo --seed yolu)', async () => {
    const { status, output } = await runSeed(testDatabaseUrls(DEMO_DB).migrationUrl)

    expect(status, output).toBe(0)
    expect(output).toMatch(/INVARIANT OK/)
    const [tenantCount] = await demo.db.select({ n: count() }).from(tenants)
    const [productCount] = await demo.db.select({ n: count() }).from(products)
    const admins = await demo.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'admin@yilmaz.example'))
    expect(tenantCount?.n).toBe(2)
    expect(productCount?.n).toBeGreaterThan(0)
    expect(admins).toHaveLength(1)
  }, 180_000)

  it('yerelde hedefin adıyla verilen onay demo dışı veriyi siliyor', async () => {
    const { status, output } = await runSeed(localUrl(), [`--wipe-non-demo-data=${GUARD_DB}`])

    expect(status, output).toBe(0)
    expect(await pilotIntact()).toBe(false)
    const demoTenants = await guard.db.select({ id: tenants.id }).from(tenants)
    expect(demoTenants.map((t) => t.id).sort()).toEqual([...DEMO_TENANT_IDS].sort())
  }, 180_000)
})

/**
 * WS-1.2a — ADSIZ HEDEF. Adreste veritabanı adı yoksa sürücü `PGDATABASE`'e,
 * o da yoksa kullanıcı adıyla aynı adlı veritabanına bağlanıyor ve eski
 * kapıda boş onay boş adla eşleşiyordu. Seed bu hedefi BAĞLANMADAN
 * reddetmeli. `PGDATABASE` burada hem gerçek bir yolu sınıyor hem de koruma
 * kaldırıldığında seed'in `postgres`'e değil izole veritabanına gitmesini
 * sağlıyor (T186).
 */
describe('seed adsız hedefte (WS-1.2a)', () => {
  const unnamedUrl = () => {
    const u = new URL(via(testDatabaseUrls(GUARD_DB).migrationUrl, '127.0.0.1', local.port))
    u.pathname = ''
    return u.toString()
  }

  it('adsız adres PGDATABASE ile izole veritabanına ulaşıyor (kontrol)', async () => {
    expect(describeTarget(unnamedUrl()).database).toBe('')
    expect(await currentDatabaseVia(unnamedUrl(), DIVERTED_DB)).toBe(DIVERTED_DB)
    expect(await pilotRowsIn(diverted.client)).toBe(2)
  })

  it('veritabanı adı yazılmamışsa bağlanmadan reddediyor', async () => {
    const before = local.connections()
    const { status, output } = await runSeed(unnamedUrl(), [], { PGDATABASE: DIVERTED_DB })

    expect(status).not.toBe(0)
    expect(output).toMatch(/veritabanının adı adreste yok/)
    expect(output).not.toMatch(/Seed baslıyor/)
    expect(local.connections()).toBe(before)
    expect(await pilotRowsIn(diverted.client)).toBe(2)
  })

  it('adsız hedefte boş onay da işe yaramıyor', async () => {
    const before = local.connections()
    const { status, output } = await runSeed(unnamedUrl(), ['--wipe-non-demo-data='], {
      PGDATABASE: DIVERTED_DB,
    })

    expect(status).not.toBe(0)
    expect(output).toMatch(/veritabanının adı adreste yok/)
    expect(output).not.toMatch(/Seed baslıyor/)
    expect(local.connections()).toBe(before)
    expect(await pilotRowsIn(diverted.client)).toBe(2)
  })
})

/**
 * T187 — KAPININ GÖSTERDİĞİ İLE SİLİNEN AYNI OLMALI. Adres `seedguard`'ı
 * gösterip `?database=` ile başka veritabanına, ya da veritabanı ayarı
 * tabloları başka şemaya götürebiliyor. Onay gösterilen adla verilse bile
 * silme olmamalı.
 */
describe('seed hedef ayrışması (T187)', () => {
  const divertedUrl = () => {
    const u = new URL(via(testDatabaseUrls(GUARD_DB).migrationUrl, '127.0.0.1', local.port))
    u.searchParams.set('database', DIVERTED_DB)
    return u.toString()
  }

  it('?database= adresi gösterilenden başka veritabanına ulaşıyor (kontrol)', async () => {
    expect(describeTarget(divertedUrl()).database).toBe(GUARD_DB)
    expect(await currentDatabaseVia(divertedUrl())).toBe(DIVERTED_DB)
  })

  it('?database= ile gösterilen adla onay verilse bile bağlanmadan reddediyor', async () => {
    const before = local.connections()
    const { status, output } = await runSeed(divertedUrl(), [`--wipe-non-demo-data=${GUARD_DB}`])

    expect(status).not.toBe(0)
    expect(output).toMatch(/yalnız yerel veritabanında çalışır/)
    expect(local.connections()).toBe(before)
    expect(await pilotRowsIn(diverted.client)).toBe(2)
  })

  it('gölge veritabanında tablolar public dışına çözülüyor (kontrol)', async () => {
    const fresh = postgres(testDatabaseUrls(SHADOW_DB).migrationUrl, { max: 1, onnotice: () => {} })
    try {
      const [row] = await fresh<{ isPublic: boolean }[]>`
        SELECT to_regclass('tenants') = to_regclass('public.tenants') AS "isPublic"`
      expect(row!.isPublic).toBe(false)
    } finally {
      await fresh.end()
    }
  })

  it('tablolar başka şemaya çözülüyorsa reddediyor ve defter duruyor', async () => {
    const { status, output } = await runSeed(testDatabaseUrls(SHADOW_DB).migrationUrl)

    expect(status).not.toBe(0)
    expect(output).toMatch(/public şemasına çözülmüyor/)
    expect(output).not.toMatch(/Seed baslıyor/)
    expect(await pilotRowsIn(shadow.client)).toBe(2)
  })
})
