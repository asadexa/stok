import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { products, tenants, users } from './schema'
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
 * "UZAK" ADRES GERÇEKTEN ERİŞİLEBİLİR: 127.0.0.2 de loopback ama izin
 * listesinde yok. Koruma bağlanmadan reddetmeseydi seed bu adresten aynı
 * veritabanına ulaşıp silerdi; testin kırmızı yanacağı yer tam orası.
 * ============================================================================
 */

const GUARD_DB = 'stok_test_seedguard'
const DEMO_DB = 'stok_test_seeddemo'
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const PILOT_TENANT = detUuid('tenant:seedguard-pilot')
// seed.ts'teki demo kiracılarıyla aynı deterministik kimlikler.
const DEMO_TENANT_IDS = [detUuid('tenant:yilmaz'), detUuid('tenant:demir')]

let guard: ReturnType<typeof testAdminDb>
let demo: ReturnType<typeof testAdminDb>

function runSeed(url: string, args: string[] = []) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/seed.ts', ...args], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, MIGRATION_DATABASE_URL: url },
    encoding: 'utf8',
    timeout: 180_000,
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function viaHost(url: string, host: string): string {
  const u = new URL(url)
  u.hostname = host
  return u.toString()
}

async function pilotIntact(): Promise<boolean> {
  const rows = await guard.db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, PILOT_TENANT))
  return rows.length === 1
}

beforeAll(async () => {
  await resetTestDatabase(GUARD_DB)
  await resetTestDatabase(DEMO_DB)
  guard = testAdminDb(GUARD_DB)
  demo = testAdminDb(DEMO_DB)
  // Seed'e ait olmayan, "gerçek" yerine geçen sentetik bir kiracı.
  await guard.db.insert(tenants).values({ id: PILOT_TENANT, name: 'Sentetik Pilot İşletme' })
  // Daha önce seed'lenmiş bir demo veritabanını taklit ediyor.
  await demo.db.insert(tenants).values([
    { id: DEMO_TENANT_IDS[0]!, name: 'Eski demo 1' },
    { id: DEMO_TENANT_IDS[1]!, name: 'Eski demo 2' },
  ])
}, 120_000)

afterAll(async () => {
  await guard.client.end()
  await demo.client.end()
})

describe('seed koruması (T125)', () => {
  const localUrl = () => testDatabaseUrls(GUARD_DB).migrationUrl

  it('uzak hedefte bağlantı açmadan reddediyor ve veriye dokunmuyor', async () => {
    const { status, output } = runSeed(viaHost(localUrl(), '127.0.0.2'))

    expect(status).not.toBe(0)
    expect(output).toMatch(/yalnız yerel veritabanında çalışır/)
    expect(await pilotIntact()).toBe(true)
  })

  it('uzak hedefte silme onayı da işe yaramıyor', async () => {
    const { status, output } = runSeed(viaHost(localUrl(), '127.0.0.2'), [
      `--wipe-non-demo-data=${GUARD_DB}`,
    ])

    expect(status).not.toBe(0)
    expect(output).toMatch(/yalnız yerel veritabanında çalışır/)
    expect(await pilotIntact()).toBe(true)
  })

  it('yerel hedefte demo dışı kiracı varsa reddediyor', async () => {
    const { status, output } = runSeed(localUrl())

    expect(status).not.toBe(0)
    expect(output).toMatch(/seed'e ait olmayan 1 kiracı var/)
    expect(await pilotIntact()).toBe(true)
  })

  it('onay başka bir veritabanının adıyla verilirse reddediyor', async () => {
    const { status, output } = runSeed(localUrl(), ['--wipe-non-demo-data=stok'])

    expect(status).not.toBe(0)
    expect(output).toMatch(/seed'e ait olmayan 1 kiracı var/)
    expect(await pilotIntact()).toBe(true)
  })

  it('RLS’e tabi bir rolle kiracılar görülemediği için reddediyor', async () => {
    // Uygulama rolü (stok_app): tabloları FORCE RLS ile bağlamsız BOŞ görür.
    // "Hiç kiracı yok" sanılsaydı koruma sessizce açık kalırdı.
    const { status, output } = runSeed(testDatabaseUrls(GUARD_DB).appUrl)

    expect(status).not.toBe(0)
    expect(output).toMatch(/RLS'i atlamıyor/)
    expect(await pilotIntact()).toBe(true)
  })

  it('yalnız demo kiracıları varken seed çalışıyor (pnpm demo --seed yolu)', async () => {
    const { status, output } = runSeed(testDatabaseUrls(DEMO_DB).migrationUrl)

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
    const { status, output } = runSeed(localUrl(), [`--wipe-non-demo-data=${GUARD_DB}`])

    expect(status, output).toBe(0)
    expect(await pilotIntact()).toBe(false)
    const demoTenants = await guard.db.select({ id: tenants.id }).from(tenants)
    expect(demoTenants.map((t) => t.id).sort()).toEqual([...DEMO_TENANT_IDS].sort())
  }, 180_000)
})
