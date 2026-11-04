import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * ============================================================================
 * T195 — `scripts/wait-for-db.mjs` İMAJIN GEÇİCİ INIT SUNUCUSUNU "HAZIR" SAYMIYOR
 *
 * Taze volume'de `docker-entrypoint.sh` init betiklerini yalnız sokette dinleyen
 * geçici bir sunucuda koşturuyor. Betik o sırada "hazır" deseydi ardından koşan
 * `migrate` geçici sunucunun kapanmasına denk gelip `ECONNRESET` alırdı (CI #72,
 * #113). Pencere normalde bir iki saniye; burada init'e `pg_sleep` konarak her
 * koşuda 8 saniye açık tutuluyor: test olasılıksal değil, belirlenimci.
 *
 * YALNIZ BU DOSYANIN AÇTIĞI `stok_test_wait_<rastgele>` PROJESİ kuruluyor ve
 * siliniyor; geliştirme projesine ve volume'lerine hiçbir çağrı gitmiyor.
 * ============================================================================
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PROJECT = `stok_test_wait_${randomBytes(4).toString('hex')}`
const IMAGE = 'postgres:17-alpine'
const INIT_SLEEP_SECONDS = 8

let dir: string
let file: string

function assertDisposable(): void {
  if (!/^stok_test_wait_[0-9a-f]{8}$/.test(PROJECT)) throw new Error(`Gözden çıkarılabilir proje değil: ${PROJECT}`)
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

describe('wait-for-db.mjs, izole Docker projesinde (T195)', () => {
  beforeAll(() => {
    if (!docker(['info']).ok) throw new Error('Bu test Docker gerektiriyor (CI test işinde var).')
    assertDisposable()
    dir = mkdtempSync(join(tmpdir(), 'stok-wait-'))
    const init = join(dir, 'init')
    mkdirSync(init)
    // Init bitince tablo var: betik döndüğünde tablo yoksa init sürerken dönmüş demek.
    writeFileSync(
      join(init, '00-yavas.sql'),
      `SELECT pg_sleep(${INIT_SLEEP_SECONDS});\nCREATE TABLE public.init_done (id int);\n`,
    )
    file = join(dir, 'compose.json')
    writeFileSync(
      file,
      JSON.stringify({
        services: {
          db: {
            image: IMAGE,
            environment: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'postgres', POSTGRES_DB: 'stok' },
            ports: ['127.0.0.1::5432'],
            volumes: [
              { type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' },
              { type: 'bind', source: init, target: '/docker-entrypoint-initdb.d', read_only: true },
            ],
          },
        },
        volumes: { pgdata: {} },
      }),
    )
    const up = compose('up', '-d')
    if (!up.ok) throw new Error(`Test projesi açılamadı: ${up.err}`)
  }, 300_000)

  afterAll(() => {
    assertDisposable()
    if (file) compose('down', '-v', '--remove-orphans')
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('init betikleri bitmeden "hazır" demiyor; döndüğü an TCP sorgusu init sonrasını görüyor', async () => {
    const waited = spawnSync(process.execPath, [join(ROOT, 'scripts', 'wait-for-db.mjs'), String(port())], {
      cwd: ROOT,
      env: env(),
      encoding: 'utf8',
    })
    expect(waited.status, `${waited.stdout}${waited.stderr}`).toBe(0)

    // Bekleme ya da yeniden deneme YOK: betiğin sözü tek sorguyla sınanıyor.
    const q = postgres(`postgresql://postgres:postgres@127.0.0.1:${port()}/stok`, {
      max: 1,
      connect_timeout: 5,
      onnotice: () => {},
    })
    try {
      const [row] = await q<{ t: string | null }[]>`SELECT to_regclass('public.init_done')::text AS t`
      expect(row!.t).toBe('init_done')
    } finally {
      await q.end({ timeout: 1 })
    }
  }, 120_000)
})
