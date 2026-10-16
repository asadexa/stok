import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * ============================================================================
 * `db:reset` HEDEF ÇÖZÜMÜNÜN RETLERİ — KARAKTERİZASYON (WS-1.3a)
 *
 * `db-reset.test.ts` mutlu yolu ve reset'in kendi fırlattığı retleri (onay,
 * uzak uç, volume'ün başka kullanıcısı) sınıyor. Docker katmanının fırlattığı
 * retler orada yok: Docker CLI bulunamazsa, compose araması hata verirse,
 * kapsayıcı yoksa, veri volume'ü compose projesine ait değilse. Bu katman
 * yedek komutuyla paylaşılmak üzere ayrı modüle taşınırken bir ret `main`'de
 * yakalanmayıp yığın izine dönse çıkış kodu yine 1 olurdu; çıkış koduna bakan
 * hiçbir test bunu görmezdi. Bu dosya o retlerin metnini ve biçimini (ret
 * satırı, "Sıfırlama yapılmadı.", yığın izi yok) sabitliyor.
 *
 * Hiçbir test kapsayıcı başlatmıyor ya da veri silmiyor: hepsi `--dry-run` ve
 * ret hedef çözülürken, veritabanına bağlanmadan geliyor. Testin yarattığı
 * kaynaklar `stok_test_target_<rastgele>` adlı, hiç başlatılmayan bir
 * kapsayıcı ve compose etiketi taşımayan bir volume; silinmeden önce adları
 * doğrulanıyor.
 * ============================================================================
 */

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const PROJECT = `stok_test_target_${randomBytes(4).toString('hex')}`
/** Kapsayıcısı hiç olmayan proje: compose araması boş döner. */
const EMPTY_PROJECT = `${PROJECT}_bos`
/** Compose dışında, etiketsiz yaratılan volume: `external: true` ile bağlanıyor. */
const EXTERNAL_VOLUME = `${PROJECT}_harici`
const IMAGE = 'postgres:17-alpine'

let dir: string
let file: string

function assertDisposable(): void {
  if (!/^stok_test_target_[0-9a-f]{8}$/.test(PROJECT)) throw new Error(`Gözden çıkarılabilir proje değil: ${PROJECT}`)
  if (EXTERNAL_VOLUME !== `${PROJECT}_harici`) throw new Error(`Gözden çıkarılabilir volume değil: ${EXTERNAL_VOLUME}`)
}

function docker(args: string[]) {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const compose = (project: string, ...args: string[]) => docker(['compose', '-p', project, '-f', file, ...args])

/** Windows'ta ortam anahtarları büyük/küçük harf duyarsız: `Path` ile `PATH` aynı değişken. */
function envWithout(...names: string[]): NodeJS.ProcessEnv {
  const drop = new Set(names.map((n) => n.toUpperCase()))
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.has(k.toUpperCase())))
}

/** Reset hedefi bu dosyanın projesinden çözsün; `DOCKER_HOST` yerel bağlamı ezmesin. */
function composeEnv(project: string, composeFile: string): NodeJS.ProcessEnv {
  return { ...envWithout('DOCKER_HOST'), COMPOSE_FILE: composeFile, COMPOSE_PROJECT_NAME: project }
}

function runDryRun(env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/db-reset.ts', '--dry-run'], { cwd: PACKAGE_DIR, env })
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
      resolve({ status, output })
    })
  })
}

function containerState() {
  const id = compose(PROJECT, 'ps', '-a', '-q', 'db').out
  const [c] = JSON.parse(docker(['inspect', id]).out)
  return { id: c.Id as string, running: c.State.Running as boolean, startedAt: c.State.StartedAt as string }
}

/**
 * Ret biçimi: `✗ <neden>` satırı, ardından "Sıfırlama yapılmadı." satırı.
 * Yakalanmayan bir hata da çıkış 1 verir ama yığın iziyle biter; ayrımı bu
 * satırlar yapıyor. "Hedef:" yok: ret hedef çözülürken geldi.
 */
function expectRefusal(result: { status: number | null; output: string }, reason: string | RegExp): void {
  const lines = result.output.split(/\r?\n/)
  expect(result.status, result.output).toBe(1)
  if (typeof reason === 'string') expect(lines, result.output).toContain(`✗ ${reason}`)
  else expect(lines.some((l) => reason.test(l)), result.output).toBe(true)
  expect(lines, result.output).toContain('  Sıfırlama yapılmadı.')
  expect(result.output).not.toMatch(/^\s+at\s/m)
  expect(result.output).not.toMatch(/Hedef:/)
}

describe('db:reset hedef çözümü retleri (karakterizasyon, WS-1.3a)', () => {
  beforeAll(() => {
    if (!docker(['info']).ok) throw new Error('Bu testler Docker gerektiriyor (CI test işinde var).')
    assertDisposable()
    dir = mkdtempSync(join(tmpdir(), 'stok-target-'))
    file = join(dir, 'compose.json')
    // JSON geçerli YAML: Windows yolu tırnak derdi olmadan gidiyor.
    writeFileSync(
      file,
      JSON.stringify({
        services: {
          db: {
            image: IMAGE,
            volumes: [{ type: 'volume', source: 'stok_pgdata', target: '/var/lib/postgresql/data' }],
          },
        },
        volumes: { stok_pgdata: { external: true, name: EXTERNAL_VOLUME } },
      }),
    )
    const volume = docker(['volume', 'create', EXTERNAL_VOLUME])
    if (!volume.ok) throw new Error(`Test volume'ü yaratılamadı: ${volume.err}`)
    // `create`: kapsayıcı var ama hiç başlatılmadı; içinde PostgreSQL çalışmıyor.
    const created = compose(PROJECT, 'create')
    if (!created.ok) throw new Error(`Test kapsayıcısı yaratılamadı: ${created.err}`)
  }, 120_000)

  afterAll(() => {
    assertDisposable()
    if (file) compose(PROJECT, 'down', '--remove-orphans')
    docker(['volume', 'rm', EXTERNAL_VOLUME])
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('(a) compose araması hata verirse ret', async () => {
    // Proje adı verilince compose `ps` dosyayı hiç okumuyor; var olmayan ya
    // da bozuk dosya yine 0 dönüyor (ölçüldü). Ad dosyadan çıkarılmak zorunda
    // kalınca var olmayan dosya hata veriyor.
    const env = {
      ...envWithout('DOCKER_HOST', 'COMPOSE_PROJECT_NAME'),
      COMPOSE_FILE: join(dir, 'olmayan-compose.json'),
    }
    const result = await runDryRun(env)
    expectRefusal(result, /^✗ compose kapsayıcısı aranamadı: \S/)
  }, 120_000)

  it('(b) compose `db` kapsayıcısı yoksa ret', async () => {
    const result = await runDryRun(composeEnv(EMPTY_PROJECT, file))
    expectRefusal(result, "Compose `db` kapsayıcısı bulunamadı; hangi volume'ün silineceği belirlenemiyor. Önce: pnpm db:up")
  }, 120_000)

  it('(c) Docker CLI bulunamazsa ret', async () => {
    // PATH'i ortamdan çıkarmak yetmiyor: Windows'ta alt süreç `docker`'ı yine
    // buldu (ölçüldü; libuv eksik PATH'i üst süreçten tamamlıyor). Bu yüzden
    // PATH içinde `docker` olmayan geçici dizini gösteriyor. Compose
    // değişkenleri boş projeyi gösteriyor: `docker` bir şekilde bulunsa bile
    // geliştirme projesine gidilmez.
    const env = {
      ...envWithout('PATH', 'DOCKER_HOST'),
      PATH: dir,
      COMPOSE_FILE: file,
      COMPOSE_PROJECT_NAME: EMPTY_PROJECT,
    }
    const result = await runDryRun(env)
    expectRefusal(result, /^✗ docker çalıştırılamadı: /)
  }, 120_000)

  it("(d) veri volume'ü compose projesine ait değilse ret; kapsayıcı başlatılmaz", async () => {
    const before = containerState()
    const result = await runDryRun(composeEnv(PROJECT, file))
    expectRefusal(result, `Volume ${EXTERNAL_VOLUME} bu compose projesine (${PROJECT}) ait değil.`)
    expect(containerState()).toEqual(before)
    expect(before.running).toBe(false)
  }, 120_000)
})
