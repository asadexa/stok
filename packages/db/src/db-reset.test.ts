import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectionRunArgs, isClusterProbe, isDatabaseProbe, parseResetArgs } from './db-reset'
import { DEMO_TENANT_IDS } from './wipe-guard'

/**
 * ============================================================================
 * WS-1.2b — `pnpm db:reset` GERÇEK DOCKER ÜZERİNDE
 *
 * YIKICI DENEMELER YALNIZ BU DOSYANIN AÇTIĞI PROJEDE. Her koşu kendi geçici
 * compose dosyasıyla `stok_test_reset_<rastgele>` projesini kuruyor; reset'e
 * hedef standart `COMPOSE_FILE`/`COMPOSE_PROJECT_NAME` değişkenleriyle
 * veriliyor (kodda teste özel bir giriş yok). Geliştirme projesine, `stok`
 * volume'üne ya da pilota hiçbir çağrı gitmiyor; her `down -v`'den önce
 * proje adı doğrulanıyor.
 *
 * Gerçek compose dosyası kullanılamıyor: sabit `container_name` ve `5433`
 * geliştirme kapsayıcısıyla çakışırdı. Reset kodu dosyaya değil compose
 * etiketlerine ve bağlamalara baktığı için davranış aynı.
 *
 * "Kesinti yok" kapsayıcının `StartedAt`'i ile ölçülüyor: durdurulup açılan
 * kapsayıcının başlama zamanı değişir.
 * ============================================================================
 */

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PROJECT = `stok_test_reset_${randomBytes(4).toString('hex')}`
const VOLUME = `${PROJECT}_stok_pgdata`
const IMAGE = 'postgres:17-alpine'
const CONFIRM = `--confirm-volume=${VOLUME}`
const PILOT_TENANT = '00000000-0000-4000-8000-00000000beef'

let dir: string
let file: string

function assertDisposable(): void {
  if (!/^stok_test_reset_[0-9a-f]{8}$/.test(PROJECT)) throw new Error(`Gözden çıkarılabilir proje değil: ${PROJECT}`)
}

const env = () => ({ ...process.env, COMPOSE_FILE: file, COMPOSE_PROJECT_NAME: PROJECT })

function docker(args: string[]) {
  const r = spawnSync('docker', args, { encoding: 'utf8', env: env() })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const compose = (...args: string[]) => docker(['compose', '-p', PROJECT, '-f', file, ...args])

function port(): number {
  const published = compose('port', 'db', '5432').out
  return Number(published.slice(published.lastIndexOf(':') + 1))
}

function waitReady(): void {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'wait-for-db.mjs'), String(port())], {
    cwd: ROOT,
    env: env(),
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`Test kümesi hazır olmadı: ${r.stdout}${r.stderr}`)
}

async function sql<T>(database: string, run: (q: postgres.Sql) => Promise<T>): Promise<T> {
  const q = postgres(`postgresql://postgres:postgres@127.0.0.1:${port()}/${database}`, { max: 1, onnotice: () => {} })
  try {
    return await run(q)
  } finally {
    await q.end()
  }
}

function state() {
  const id = compose('ps', '-a', '-q', 'db').out
  const [c] = JSON.parse(docker(['inspect', id]).out)
  const [v] = JSON.parse(docker(['volume', 'inspect', VOLUME]).out)
  return { id: c.Id as string, running: c.State.Running as boolean, startedAt: c.State.StartedAt as string, volumeCreatedAt: v.CreatedAt as string }
}

const leftoverInspections = () =>
  docker(['ps', '-a', '-q', '--filter', 'label=stok.reset.inspect', '--filter', `volume=${VOLUME}`]).out

function runReset(args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/db-reset.ts', ...args], {
      cwd: PACKAGE_DIR,
      env: { ...env(), ...extraEnv },
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      output += d
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      output += d
    })
    const timer = setTimeout(() => child.kill(), 240_000)
    child.on('error', reject)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, output })
    })
  })
}

describe('parseResetArgs', () => {
  it.each<[string[], string]>([
    [[], 'usage'],
    [['--'], 'usage'],
    [['--wipe-non-demo-data=stok'], 'usage'],
    [['--dry-run'], 'dry-run'],
    [['--', '--dry-run'], 'dry-run'],
    [['--confirm-volume=x'], 'reset'],
    [['--confirm-volume='], 'reset'],
    [['--dry-run', '--confirm-volume=x'], 'error'],
    [['--yes'], 'error'],
  ])('%j → %s', (argv, mode) => {
    expect(parseResetArgs(argv).mode).toBe(mode)
  })
})

describe('inspectionRunArgs', () => {
  it('ağsız, TCP dinlemeyen, salt okunur ve parolasız (boş volume initdb yapamaz)', () => {
    const args = inspectionRunArgs('n', 'vol', 'sha256:abc')
    expect(args.join(' ')).toContain('--network none')
    expect(args).toContain('listen_addresses=')
    expect(args).toContain('default_transaction_read_only=on')
    expect(args).toContain('autovacuum=off')
    expect(args).toContain('type=volume,src=vol,dst=/var/lib/postgresql/data')
    expect(args.some((a) => a.startsWith('-p') || a.startsWith('--publish'))).toBe(false)
    expect(args.join(' ')).not.toMatch(/POSTGRES_PASSWORD/)
  })
})

describe('inceleme çıktısının biçimi (belirsiz çıktı → ret)', () => {
  const db = {
    database: 'stok',
    superuser: true,
    hasTenants: true,
    largeObjects: 0,
    schemas: ['public'],
    extensions: ['plpgsql'],
    relations: [{ schema: 'public', name: 'tenants', kind: 'r', forceRls: true, policies: 1 }],
  }
  it('beklenen biçim kabul ediliyor', () => {
    expect(isDatabaseProbe(db)).toBe(true)
    expect(isClusterProbe({ databases: ['stok'], roles: ['postgres'], tablespaces: ['pg_default'] })).toBe(true)
  })
  it.each<[string, unknown]>([
    ['null', null],
    ['eklenti listesi null', { ...db, extensions: null }],
    ['large object sayısı metin', { ...db, largeObjects: '0' }],
    ['superuser eksik', { ...db, superuser: undefined }],
    ['ilişkide politika sayısı yok', { ...db, relations: [{ ...db.relations[0], policies: undefined }] }],
  ])('veritabanı kataloğu: %s → ret', (_name, value) => {
    expect(isDatabaseProbe(value)).toBe(false)
  })
  it.each<[string, unknown]>([
    ['boş nesne', {}],
    ['roller null', { databases: ['stok'], roles: null, tablespaces: [] }],
  ])('küme kataloğu: %s → ret', (_name, value) => {
    expect(isClusterProbe(value)).toBe(false)
  })
})

describe('db:reset, izole Docker projesinde (WS-1.2b)', () => {
  beforeAll(async () => {
    if (!docker(['info']).ok) throw new Error('Bu testler Docker gerektiriyor (CI test işinde var).')
    assertDisposable()
    dir = mkdtempSync(join(tmpdir(), 'stok-reset-'))
    file = join(dir, 'compose.json')
    // JSON geçerli YAML: Windows yolu (`Masaüstü`, sürücü harfi) tırnak derdi olmadan gidiyor.
    writeFileSync(
      file,
      JSON.stringify({
        services: {
          db: {
            image: IMAGE,
            restart: 'unless-stopped',
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
    // Gerçek migration'lar: uygulama tabloları RLS'iyle birlikte, bugünkü kurulum gibi.
    await sql('stok', async (q) => {
      await migrate(drizzle(q), { migrationsFolder: join(PACKAGE_DIR, 'migrations') })
      await q`INSERT INTO public.tenants (id, name) VALUES (${DEMO_TENANT_IDS[0]!}, 'Demo 1'), (${DEMO_TENANT_IDS[1]!}, 'Demo 2')`
    })
    // Yıkıcı testlerden ÖNCE: CLI hedefi gerçekten bu projeden mi çözüyor?
    // Compose ortam değişkenlerini okumasaydı depo kökündeki gerçek
    // geliştirme projesini hedeflerdi. Kanıt yoksa dosyanın hiçbir testi koşmaz.
    const probe = await runReset(['--dry-run'])
    if (!probe.output.includes(`compose projesi ${PROJECT},`) || !probe.output.includes(`volume ${VOLUME}`)) {
      throw new Error(`db:reset test projesini hedeflemiyor; yıkıcı testler durduruldu:\n${probe.output}`)
    }
  }, 300_000)

  afterAll(() => {
    assertDisposable()
    docker(['rm', '-f', `${PROJECT}-extra`])
    for (const id of leftoverInspections().split(/\s+/).filter(Boolean)) docker(['rm', '-f', id])
    if (file) compose('down', '-v', '--remove-orphans')
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('onaysız çağrı yalnız kullanım yazar; Docker\'a dokunmaz', async () => {
    const before = state()
    const { status, output } = await runReset([])

    expect(status).toBe(1)
    expect(output).toMatch(/Kullanım/)
    expect(output).not.toMatch(/Hedef:/)
    expect(state()).toEqual(before)
  })

  it.each([[`--confirm-volume=yanlis_volume`], ['--confirm-volume=']])(
    'onay %s ise kapsayıcı durdurulmaz',
    async (arg) => {
      const before = state()
      const { status, output } = await runReset([arg])

      expect(status).toBe(1)
      expect(output).toMatch(/Volume onayı eksik ya da yanlış/)
      expect(state()).toEqual(before)
    },
    120_000,
  )

  it('Docker uç noktası uzaksa doğru onayla bile hiçbir şey yapılmaz', async () => {
    const before = state()
    const { status, output } = await runReset([CONFIRM], { DOCKER_HOST: 'tcp://127.0.0.1:1' })

    expect(status).toBe(1)
    expect(output).toMatch(/Docker yerel değil/)
    expect(state()).toEqual(before)
  }, 120_000)

  it('volume\'ü başka bir kapsayıcı da kullanıyorsa durdurmadan reddeder', async () => {
    const before = state()
    expect(docker(['create', '--name', `${PROJECT}-extra`, '--mount', `type=volume,src=${VOLUME},dst=/x`, IMAGE]).ok).toBe(true)
    try {
      const { status, output } = await runReset([CONFIRM])
      expect(status).toBe(1)
      expect(output).toMatch(/başka kapsayıcı tarafından da kullanılıyor/)
      expect(state()).toEqual(before)
    } finally {
      docker(['rm', '-f', `${PROJECT}-extra`])
    }
  }, 120_000)

  it('dry-run: yalnız demo verisinde silinebilir der, nihai onay saymaz, kesinti yapmaz', async () => {
    const before = state()
    const { status, output } = await runReset(['--dry-run'])

    expect(status, output).toBe(0)
    expect(output).toMatch(/NİHAİ ONAY DEĞİL/)
    expect(output).toContain(VOLUME)
    expect(state()).toEqual(before)
  }, 120_000)

  it.each<[string, string, string, string, RegExp]>([
    ['stok_test_* adlı veritabanı', 'postgres', 'CREATE DATABASE stok_test_x', 'DROP DATABASE stok_test_x', /stok_test_x/],
    [
      'FORCE RLS ve politikalı yabancı tablo',
      'stok',
      'CREATE TABLE public.yabanci (id int); ALTER TABLE public.yabanci ENABLE ROW LEVEL SECURITY; ALTER TABLE public.yabanci FORCE ROW LEVEL SECURITY; CREATE POLICY p ON public.yabanci USING (true)',
      'DROP TABLE public.yabanci',
      /public\.yabanci/,
    ],
    ['tanınmayan rol', 'postgres', 'CREATE ROLE yabanci_rol', 'DROP ROLE yabanci_rol', /yabanci_rol/],
    ['template1 içinde tablo', 'template1', 'CREATE TABLE public.sablon (id int)', 'DROP TABLE public.sablon', /template1: public\.sablon/],
    ['large object', 'stok', 'SELECT lo_create(4242)', 'SELECT lo_unlink(4242)', /large object/],
    [
      'demo dışı kiracı (stok onayı yok)',
      'stok',
      `INSERT INTO public.tenants (id, name) VALUES ('${PILOT_TENANT}', 'Sentetik Pilot')`,
      `DELETE FROM public.tenants WHERE id = '${PILOT_TENANT}'`,
      /demo dışı 1 kiracı/,
    ],
  ])('dry-run reddeder ve kesinti yapmaz: %s', async (_name, database, setup, teardown, message) => {
    await sql(database, (q) => q.unsafe(setup))
    try {
      const before = state()
      const { status, output } = await runReset(['--dry-run'])
      expect(status).toBe(1)
      expect(output).toMatch(message)
      expect(state()).toEqual(before)
    } finally {
      await sql(database, (q) => q.unsafe(teardown))
    }
  }, 120_000)

  it('izole doğrulama reddederse eski kapsayıcı yeniden açılır, veri ve volume yerinde', async () => {
    await sql('postgres', (q) => q.unsafe('CREATE DATABASE stok_test_x'))
    try {
      const before = state()
      const { status, output } = await runReset([CONFIRM])

      expect(status).toBe(1)
      expect(output).toMatch(/İzole doğrulama: silinemez/)
      expect(output).toMatch(/stok_test_x/)
      const after = state()
      expect(after.id).toBe(before.id)
      expect(after.running).toBe(true)
      // Durdurulup açıldı: izole yol gerçekten koştu.
      expect(after.startedAt).not.toBe(before.startedAt)
      expect(after.volumeCreatedAt).toBe(before.volumeCreatedAt)
      expect(leftoverInspections()).toBe('')
      const tenants = await sql('stok', (q) => q`SELECT count(*)::int AS n FROM public.tenants`)
      expect(tenants[0]!.n).toBe(2)
      const extra = await sql('postgres', (q) => q`SELECT 1 FROM pg_database WHERE datname = 'stok_test_x'`)
      expect(extra).toHaveLength(1)
    } finally {
      await sql('postgres', (q) => q.unsafe('DROP DATABASE IF EXISTS stok_test_x'))
    }
  }, 240_000)

  it('demo dışı kiracı: volume onayı yetmez; iki onayla volume silinir ve küme yeniden kurulur', async () => {
    await sql('stok', (q) => q`INSERT INTO public.tenants (id, name) VALUES (${PILOT_TENANT}, 'Sentetik Pilot')`)
    const before = state()

    const refused = await runReset([CONFIRM])
    expect(refused.status).toBe(1)
    expect(refused.output).toMatch(/demo dışı 1 kiracı/)
    expect(state().volumeCreatedAt).toBe(before.volumeCreatedAt)
    const kept = await sql('stok', (q) => q`SELECT 1 FROM public.tenants WHERE id = ${PILOT_TENANT}`)
    expect(kept).toHaveLength(1)

    const done = await runReset([CONFIRM, '--wipe-non-demo-data=stok'])
    expect(done.status, done.output).toBe(0)
    const after = state()
    expect(after.volumeCreatedAt).not.toBe(before.volumeCreatedAt)
    expect(after.running).toBe(true)
    const fresh = await sql('stok', (q) => q`SELECT to_regclass('public.tenants') IS NULL AS empty`)
    expect(fresh[0]!.empty).toBe(true)
    expect(leftoverInspections()).toBe('')
  }, 240_000)

  it('migration öncesi taze volume yalnız volume onayıyla sıfırlanır', async () => {
    const before = state()
    const { status, output } = await runReset([CONFIRM])

    expect(status, output).toBe(0)
    expect(state().volumeCreatedAt).not.toBe(before.volumeCreatedAt)
  }, 240_000)
})
