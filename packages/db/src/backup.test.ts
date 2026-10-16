import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyDump } from './backup'
import {
  BACKUP_KEEP,
  LAST_SUCCESS_FILE,
  LOG_FILE,
  backupStamp,
  dumpName,
  evaluateToc,
  inventory,
  lastLogEntry,
  shaLine,
  tocCommand,
} from './backup-policy'
import { DEMO_TENANT_IDS } from './wipe-guard'

/**
 * ============================================================================
 * WS-1.3a — `pnpm db:backup` GERÇEK DOCKER ÜZERİNDE
 *
 * Her koşu kendi geçici compose projesini (`stok_test_backup_<rastgele>`)
 * kuruyor; hedef standart `COMPOSE_FILE`/`COMPOSE_PROJECT_NAME`
 * değişkenleriyle veriliyor (kodda teste özel giriş yok). Geliştirme
 * veritabanına ve varsayılan yedek dizinine hiçbir çağrı gitmiyor:
 * `STOK_BACKUP_DIR` her çağrıda bu dosyanın geçici dizinini gösteriyor.
 * Dökümlerde yalnız sentetik veri var ve dizin sonunda siliniyor.
 *
 * Fikstür `db-reset.test.ts`'ten uyarlandı; o dosya refactor'ün davranış
 * kanıtı olduğu için ortak modüle çıkarılmadı (birleştirme WS-1.4'te).
 *
 * `sentetik_dolgu` tablosu dökümü veri bloğu ağırlıklı yapıyor: kesme ve
 * bayt bozma dosyanın başındaki içindekiler tablosuna değil sıkıştırılmış
 * veriye denk gelsin (M1'deki gibi).
 * ============================================================================
 */

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PROJECT = `stok_test_backup_${randomBytes(4).toString('hex')}`
const IMAGE = 'postgres:17-alpine'
/** Fikstürün sentetik kiracı adı: çıktıda ve log'da görünmemeli. */
const TENANT_NAME = 'Sentetik Yedek Kiracısı'

let work: string
let file: string
let firstDir: string
let first: { status: number | null; output: string }
let startedAtBefore: string

function assertDisposable(): void {
  if (!/^stok_test_backup_[0-9a-f]{8}$/.test(PROJECT)) throw new Error(`Gözden çıkarılabilir proje değil: ${PROJECT}`)
}

function docker(args: string[]) {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const compose = (...args: string[]) => docker(['compose', '-p', PROJECT, '-f', file, ...args])
const containerId = () => compose('ps', '-a', '-q', 'db').out

function port(): number {
  const published = compose('port', 'db', '5432').out
  return Number(published.slice(published.lastIndexOf(':') + 1))
}

/**
 * Bekleme betiği hangi kapsayıcıya `pg_isready` soracağını compose
 * değişkenlerinden buluyor. Değişkenler aktarılmazsa depo kökündeki projeyi
 * arıyor: CI test işinde öyle bir proje yok (veritabanı servis kapsayıcısı),
 * betik yalnız TCP'ye bakıyor ve Linux'ta `docker-proxy` portu PostgreSQL
 * hazır olmadan kabul ediyor. CI #72'de migration bu yüzden ECONNRESET aldı.
 */
function waitReady(): void {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'wait-for-db.mjs'), String(port())], {
    cwd: ROOT,
    env: { ...process.env, COMPOSE_FILE: file, COMPOSE_PROJECT_NAME: PROJECT },
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`Test kümesi hazır olmadı: ${r.stdout}${r.stderr}`)
}

/**
 * `waitReady` ilk kurulumda yine erken dönebilir: resmi imaj init betiklerini
 * yalnız Unix soketinde dinleyen geçici bir sunucuyla çalıştırıyor
 * (`listen_addresses=''`). Kapsayıcı içindeki `pg_isready` sokete sorduğu için
 * onu "hazır" görüyor, Linux'ta `docker-proxy` de portu kabul ediyor. Yayımlanan
 * porttan dönen `SELECT 1` ise ancak asıl sunucu TCP'de dinlerken mümkün;
 * migration ondan sonra başlıyor. Başarısız denemeler sınırlı süre tekrarlanıyor,
 * süre dolarsa son hata yazılıyor.
 */
async function waitForQuery(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    const q = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} })
    try {
      await q`SELECT 1`
      return
    } catch (err) {
      lastError = (err as Error).message
    } finally {
      await q.end({ timeout: 1 })
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Test kümesi ${timeoutMs / 1000} sn içinde sorgu kabul etmedi: ${lastError}`)
}

function state() {
  const [c] = JSON.parse(docker(['inspect', containerId()]).out)
  return { startedAt: c.State.StartedAt as string, running: c.State.Running as boolean }
}

/** Windows'ta ortam anahtarları büyük/küçük harf duyarsız. */
function envWithout(...names: string[]): NodeJS.ProcessEnv {
  const drop = new Set(names.map((n) => n.toUpperCase()))
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.has(k.toUpperCase())))
}

/** CLI her zaman bu dosyanın projesini ve geçici dizinini görür. */
function runBackup(dir: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env = {
    ...envWithout('DOCKER_HOST'),
    COMPOSE_FILE: file,
    COMPOSE_PROJECT_NAME: PROJECT,
    DATABASE_URL: `postgresql://stok_app:stok_app_dev@127.0.0.1:${port()}/stok`,
    STOK_BACKUP_DIR: dir,
    ...extraEnv,
  }
  return new Promise<{ status: number | null; output: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/backup.ts', ...args], { cwd: PACKAGE_DIR, env })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      output += d
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      output += d
    })
    const timer = setTimeout(() => child.kill(), 120_000)
    child.on('error', reject)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolvePromise({ status, output })
    })
  })
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** Sahte kayıtlı döküm: içerik rastgele, `.sha256`'sı tutarlı. Saklama ve durum adlara ve özete bakıyor. */
function fakeRecorded(dir: string, at: Date): string {
  const name = dumpName(backupStamp(at))
  const content = randomBytes(256)
  writeFileSync(join(dir, name), content)
  writeFileSync(join(dir, `${name}.sha256`), shaLine(sha(content), name))
  return name
}

const fakes = (dir: string, count: number) =>
  Array.from({ length: count }, (_, i) => fakeRecorded(dir, new Date(Date.UTC(2026, 0, 1, i))))

/** Log dışındaki her dosyanın içeriği: "hiçbir döküm değişmedi" karşılaştırması için. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((n) => n !== LOG_FILE)
      .map((n) => [n, sha(readFileSync(join(dir, n)))]),
  )
}

const lastLog = (dir: string) => lastLogEntry(readFileSync(join(dir, LOG_FILE), 'utf8'))

describe('db:backup, izole Docker projesinde (WS-1.3a)', () => {
  beforeAll(async () => {
    if (!docker(['info']).ok) throw new Error('Bu testler Docker gerektiriyor (CI test işinde var).')
    assertDisposable()
    work = mkdtempSync(join(tmpdir(), 'stok-yedek-test-'))
    file = join(work, 'compose.json')
    // JSON geçerli YAML: Windows yolu (`Masaüstü`, sürücü harfi) tırnak derdi olmadan gidiyor.
    writeFileSync(
      file,
      JSON.stringify({
        services: {
          db: {
            image: IMAGE,
            environment: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'postgres', POSTGRES_DB: 'stok' },
            ports: ['127.0.0.1::5432'],
            volumes: [
              { type: 'volume', source: 'stok_pgdata', target: '/var/lib/postgresql/data' },
              { type: 'bind', source: join(ROOT, 'db', 'init'), target: '/docker-entrypoint-initdb.d', read_only: true },
            ],
            healthcheck: { test: ['CMD-SHELL', 'pg_isready -U postgres -d stok'], interval: '2s', timeout: '5s', retries: 30 },
          },
        },
        volumes: { stok_pgdata: {} },
      }),
    )
    const up = compose('up', '-d')
    if (!up.ok) throw new Error(`Test projesi açılamadı: ${up.err}`)
    waitReady()
    const url = `postgresql://postgres:postgres@127.0.0.1:${port()}/stok`
    await waitForQuery(url)
    const q = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await migrate(drizzle(q), { migrationsFolder: join(PACKAGE_DIR, 'migrations') })
      await q`INSERT INTO public.tenants (id, name) VALUES (${DEMO_TENANT_IDS[0]!}, ${TENANT_NAME}), (${DEMO_TENANT_IDS[1]!}, 'Demo 2')`
      await q.unsafe('CREATE TABLE public.sentetik_dolgu AS SELECT g AS id, md5(g::text) AS v FROM generate_series(1, 100000) g')
    } finally {
      await q.end()
    }
    // Ön koşul: CLI hedefi gerçekten bu projeden mi çözüyor? Kanıt yoksa
    // dosyanın hiçbir testi koşmaz. Bu koşu aynı zamanda 1. testin verisi.
    startedAtBefore = state().startedAt
    firstDir = join(work, 'ilk')
    first = await runBackup(firstDir, [])
    if (!first.output.includes(`compose projesi ${PROJECT},`)) {
      throw new Error(`db:backup test projesini hedeflemiyor; testler durduruldu:\n${first.output}`)
    }
  }, 300_000)

  afterAll(() => {
    assertDisposable()
    if (file) {
      docker(['unpause', containerId()])
      compose('down', '-v', '--remove-orphans')
    }
    if (work) rmSync(work, { recursive: true, force: true })
  }, 120_000)

  it('doğrulanmış döküm, .sha256, son başarı ve log; kesinti yok; veri çıktıya ve log\'a sızmıyor', () => {
    expect(first.status, first.output).toBe(0)
    const names = readdirSync(firstDir)
    const [dump] = inventory(names).recorded
    expect(dump).toBeDefined()
    expect(names.sort()).toEqual([dump!, `${dump}.sha256`, LAST_SUCCESS_FILE, LOG_FILE].sort())
    const content = readFileSync(join(firstDir, dump!))
    expect(readFileSync(join(firstDir, `${dump}.sha256`), 'utf8')).toBe(shaLine(sha(content), dump!))

    const last = JSON.parse(readFileSync(join(firstDir, LAST_SUCCESS_FILE), 'utf8'))
    expect(last).toMatchObject({ file: dump, bytes: content.length, sha256: sha(content), volume: `${PROJECT}_stok_pgdata` })

    const logText = readFileSync(join(firstDir, LOG_FILE), 'utf8')
    const entries = logText.trim().split('\n').map((l) => JSON.parse(l))
    expect(entries).toHaveLength(1)
    expect(Object.keys(entries[0]).sort()).toEqual(
      ['at', 'bytes', 'cleaned', 'deleted', 'durationMs', 'file', 'outcome', 'pgVersion', 'sha256', 'volume', 'warnings'].sort(),
    )
    expect(entries[0]).toMatchObject({ outcome: 'ok', file: dump, deleted: [], cleaned: [], warnings: [] })

    // Kesinti yok: kapsayıcı durdurulup yeniden açılmadı.
    expect(state()).toEqual({ startedAt: startedAtBefore, running: true })
    for (const text of [first.output, logText]) expect(text).not.toContain(TENANT_NAME)

    // Saf TOC kuralı gerçek `pg_restore --list` çıktısında da geçiyor (biçim varsayımı ölçülüyor).
    const listing = spawnSync('docker', tocCommand(containerId()), { input: content, encoding: 'utf8', maxBuffer: 16 << 20 })
    expect(listing.status, listing.stderr).toBe(0)
    expect(evaluateToc(listing.stdout)).toEqual({ ok: true, pgVersion: expect.stringMatching(/^17\./) })
  })

  it('verifyDump kesik ve baytı bozulmuş kopyayı reddeder, sağlamı kabul eder', async () => {
    const [dump] = inventory(readdirSync(firstDir)).recorded
    const good = join(firstDir, dump!)
    await expect(verifyDump(containerId(), good)).resolves.toEqual({ pgVersion: expect.stringMatching(/^17\./) })

    const bytes = readFileSync(good)
    const cut = join(work, 'kesik.dump')
    writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length * 0.6)))
    await expect(verifyDump(containerId(), cut)).rejects.toThrow(/baştan sona okunamadı/)

    const flipped = Buffer.from(bytes)
    const at = Math.floor(bytes.length * 0.7)
    flipped[at] = flipped[at]! ^ 0xff
    const bad = join(work, 'bozuk.dump')
    writeFileSync(bad, flipped)
    await expect(verifyDump(containerId(), bad)).rejects.toThrow(/baştan sona okunamadı/)

    // Sağlam ama yanlış arşiv: aynı kümedeki `postgres` veritabanı. Tam okuma
    // geçer; içindekiler kuralı (dbname, temel tablolar) reddetmeli.
    const other = spawnSync(
      'docker',
      ['exec', containerId(), 'pg_dump', '--format=custom', '--username=postgres', '--dbname=postgres'],
      { maxBuffer: 64 << 20 },
    )
    expect(other.status).toBe(0)
    const wrong = join(work, 'baska-veritabani.dump')
    writeFileSync(wrong, other.stdout)
    await expect(verifyDump(containerId(), wrong)).rejects.toThrow(/içindekiler tablosu beklenen gibi değil/)
  }, 120_000)

  it('repo içindeki dizine yazmaz: dizin oluşmaz, Docker\'a gidilmez', async () => {
    const dir = join(ROOT, `yedek-test-${randomBytes(4).toString('hex')}`)
    const { status, output } = await runBackup(dir, [])
    expect(status).toBe(1)
    expect(output).toMatch(/repo içinde/)
    expect(output).not.toMatch(/Kaynak :/)
    expect(existsSync(dir)).toBe(false)
  }, 120_000)

  it('Docker ucu uzaksa ret; dizin oluşmaz', async () => {
    const dir = join(work, 'uzak')
    const { status, output } = await runBackup(dir, [], { DOCKER_HOST: 'tcp://127.0.0.1:1' })
    expect(status).toBe(1)
    expect(output).toMatch(/Docker yerel değil/)
    expect(existsSync(dir)).toBe(false)
  }, 120_000)

  it('uygulama başka bir veritabanına bağlıysa (DATABASE_URL) ret; parola yazılmaz', async () => {
    const dir = join(work, 'baska-veritabani')
    const { status, output } = await runBackup(dir, [], {
      DATABASE_URL: 'postgresql://stok_app:gizli_parola@127.0.0.1:1/stok',
    })
    expect(status).toBe(1)
    expect(output).toMatch(/Uygulama 127\.0\.0\.1:1\/stok \(YEREL\) veritabanına bağlı/)
    expect(output).not.toContain('gizli_parola')
    expect(existsSync(dir)).toBe(false)
  }, 120_000)

  it('saklama: en yeni 14 kayıtlı kalır; yabancı, kayıt dışı ve yeni kalıntıya dokunulmaz; eski kalıntı silinir', async () => {
    const dir = join(work, 'saklama')
    mkdirSync(dir)
    const old = fakes(dir, 15)
    writeFileSync(join(dir, 'notlar.txt'), 'yabancı dosya')
    const unrecorded = dumpName(backupStamp(new Date(Date.UTC(2020, 0, 1))))
    writeFileSync(join(dir, unrecorded), 'kayıt dışı')
    const stalePartial = `${dumpName(backupStamp(new Date(Date.now() - 2 * 3_600_000)))}.partial`
    const freshPartial = `${dumpName(backupStamp(new Date(Date.now() - 60_000)))}.partial`
    writeFileSync(join(dir, stalePartial), 'yarım')
    writeFileSync(join(dir, freshPartial), 'yarım')

    const { status, output } = await runBackup(dir, [])
    expect(status, output).toBe(0)
    const names = readdirSync(dir)
    expect(inventory(names).recorded).toHaveLength(BACKUP_KEEP)
    for (const gone of old.slice(0, 2)) {
      expect(names).not.toContain(gone)
      expect(names).not.toContain(`${gone}.sha256`)
    }
    for (const kept of old.slice(2)) expect(names).toContain(kept)
    expect(names).toEqual(expect.arrayContaining(['notlar.txt', unrecorded, freshPartial]))
    expect(names).not.toContain(stalePartial)
    expect(lastLog(dir)).toMatchObject({ outcome: 'ok', deleted: [old[1], old[0]], cleaned: [stalePartial] })
  }, 120_000)

  it('pg_dump yarıda kalırsa .partial silinir, failed log yazılır, hiçbir döküm silinmez', async () => {
    const dir = join(work, 'duraklat')
    mkdirSync(dir)
    fakes(dir, 20)
    const before = snapshot(dir)
    expect(docker(['pause', containerId()]).ok).toBe(true)
    try {
      const { status, output } = await runBackup(dir, [])
      expect(status).toBe(1)
      expect(output).toMatch(/pg_dump başarısız/)
      expect(readdirSync(dir).filter((n) => n.endsWith('.partial'))).toEqual([])
      expect(snapshot(dir)).toEqual(before)
      expect(lastLog(dir)).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/pg_dump başarısız/) })
    } finally {
      docker(['unpause', containerId()])
    }
  }, 120_000)

  it("kapsayıcı durmuşsa ret ve dökümler aynı; --status Docker'sız çalışır ve bozulmayı görür", async () => {
    const dir = join(work, 'durmus')
    mkdirSync(dir)
    const names = fakes(dir, 20)
    const before = snapshot(dir)
    expect(compose('stop', 'db').ok).toBe(true)
    try {
      const refused = await runBackup(dir, [])
      expect(refused.status).toBe(1)
      expect(refused.output).toMatch(/Kapsayıcı çalışmıyor/)
      expect(snapshot(dir)).toEqual(before)
      expect(lastLog(dir)).toMatchObject({ outcome: 'failed' })

      const ok = await runBackup(dir, ['--status'])
      expect(ok.status, ok.output).toBe(0)
      expect(ok.output).toContain('Şimdi doğrulanan : en yeni döküm, SHA-256 eşleşiyor')
      expect(ok.output).toContain('diğer 19 kayıtlı döküm yeniden doğrulanmadı')
      expect(ok.output).toMatch(/Son koşu {9}: BAŞARISIZ/)

      const newest = join(dir, names.at(-1)!)
      const bytes = readFileSync(newest)
      bytes[0] = bytes[0]! ^ 0xff
      writeFileSync(newest, bytes)
      const bad = await runBackup(dir, ['--status'])
      expect(bad.status).toBe(1)
      expect(bad.output).toContain('EŞLEŞMİYOR')

      const emptyDir = join(work, 'bos')
      mkdirSync(emptyDir)
      const empty = await runBackup(emptyDir, ['--status'])
      expect(empty.status).toBe(1)
      expect(empty.output).toContain('Kayıtlı yedek    : yok')
    } finally {
      compose('start', 'db')
      waitReady()
    }
  }, 180_000)
})
