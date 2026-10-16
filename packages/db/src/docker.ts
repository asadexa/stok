import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * ============================================================================
 * DOCKER KATMANI — `db:reset` VE YEDEK İÇİN ORTAK (WS-1.3a)
 *
 * İki araç da aynı soruyu soruyor: bu makinedeki compose `db` kapsayıcısı
 * hangisi ve verisini hangi volume tutuyor? Cevap tek yerde, çünkü iki kopya
 * zamanla ayrışır: reset'te ayrışma yanlış volume'ün silinmesi, yedekte
 * yanlış veritabanının sessizce yedeklenmesi demek. Kod WS-1.2b'de
 * `db-reset.ts` içinde yazıldı; davranışı değişmeden buraya taşındı.
 *
 * Hangi kapsayıcının hedef olduğuna (sayı kontrolü ve mesajı) çağıran araç
 * karar veriyor. Buradaki zincir, verilen kapsayıcının gerçekten bir compose
 * `db` servisi olduğunu ve verisinin o projenin volume'ünde durduğunu
 * doğruluyor.
 * ============================================================================
 */

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const DATA_DIR = '/var/lib/postgresql/data'

/**
 * Docker katmanının reti. Çağıran araçlar bunu yakalayıp kendi çerçevesiyle
 * basıyor; alt sınıfları (ör. `ResetRefused`) da aynı yoldan geçiyor.
 */
export class DockerRefused extends Error {}

/**
 * Kabuk YOK: `docker` Windows'ta da bir `.exe`, argümanlar (SQL dahil)
 * olduğu gibi gidiyor. Komutlar depo kökünde koşuyor; compose standart
 * `COMPOSE_FILE`/`COMPOSE_PROJECT_NAME` değişkenlerini kendisi okuyor.
 */
export function docker(args: string[], input?: string) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 16 << 20 })
  if (r.error) throw new DockerRefused(`docker çalıştırılamadı: ${r.error.message}`)
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

export function dockerOk(args: string[], what: string, input?: string): string {
  const r = docker(args, input)
  if (!r.ok) throw new DockerRefused(`${what}: ${r.err || 'docker hata döndü'}`)
  return r.out
}

export const lines = (s: string) => s.split(/\r?\n/).filter(Boolean)

export function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new DockerRefused(`${what} okunamadı; çıktı doğrulanamadı.`)
  }
}

/**
 * `docker inspect` tek öğeli bir dizi döndürür. Beklenmeyen çıktı (boş,
 * dizi değil, birden çok öğe) ret: alanı eksik bir nesne aşağıda `undefined`
 * karşılaştırmalarına dönüşür ve kontrolleri sessizce geçirebilirdi.
 */
// biome-ignore lint/suspicious/noExplicitAny: Docker'ın JSON'u; kullanılan alanlar aşağıda tek tek doğrulanıyor.
export function inspectOne(args: string[], what: string): any {
  const list = parseJson<unknown>(dockerOk(args, `${what} okunamadı`), what)
  if (!Array.isArray(list) || list.length !== 1 || typeof list[0] !== 'object' || list[0] === null) {
    throw new DockerRefused(`${what} beklenen biçimde değil.`)
  }
  return list[0]
}

export function dockerEndpoint(): string {
  const fromEnv = process.env.DOCKER_HOST
  if (fromEnv) return fromEnv
  return dockerOk(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], 'Docker bağlamı okunamadı')
}

export interface Target {
  project: string
  containerId: string
  running: boolean
  image: string
  volume: string
}

/**
 * Verilen kapsayıcı → veri bağlaması → volume; zincirin her halkası
 * doğrulanıyor. Kapsayıcının nasıl seçildiği (compose araması, sayı kontrolü)
 * çağıranın işi.
 */
export function targetFromContainer(id: string): Target {
  const c = inspectOne(['inspect', id], 'kapsayıcı bilgisi')
  if (typeof c.Id !== 'string' || typeof c.Image !== 'string' || typeof c.State?.Running !== 'boolean') {
    throw new DockerRefused('Kapsayıcı bilgisi beklenen biçimde değil.')
  }
  const labels = c.Config?.Labels ?? {}
  const project: string | undefined = labels['com.docker.compose.project']
  if (!project || labels['com.docker.compose.service'] !== 'db') {
    throw new DockerRefused('Kapsayıcı bir compose `db` servisi değil.')
  }
  const mount = (c.Mounts ?? []).find((m: { Destination: string }) => m.Destination === DATA_DIR)
  if (mount?.Type !== 'volume' || !mount.Name) {
    throw new DockerRefused(`Veri dizini (${DATA_DIR}) adlandırılmış bir Docker volume'ü değil.`)
  }
  const v = inspectOne(['volume', 'inspect', mount.Name], 'volume bilgisi')
  if (v.Labels?.['com.docker.compose.project'] !== project || !v.Labels?.['com.docker.compose.volume']) {
    throw new DockerRefused(`Volume ${mount.Name} bu compose projesine (${project}) ait değil.`)
  }
  return { project, containerId: c.Id, running: c.State.Running, image: c.Image, volume: mount.Name }
}
