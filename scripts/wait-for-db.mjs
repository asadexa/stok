#!/usr/bin/env node
/**
 * Veritabanı GERÇEKTEN sorgu kabul edene kadar bekler.
 *
 *   node scripts/wait-for-db.mjs [port]
 *
 * NEDEN AÇIK PORT YETMİYOR. Docker portu konteyner başlar başlamaz
 * yayınlıyor: `docker-proxy` dinlemeye hemen başlıyor ama arkasındaki
 * Postgres hâlâ `initdb` ve `db/init/*.sql` ile uğraşıyor olabiliyor.
 * TCP bağlantısı KURULUYOR, sorgu ise reddediliyor.
 *
 * Bu, kullanıcı testinde gerçekten yaşandı: `pnpm db:reset` konteyneri
 * başlattı, hemen ardından koşan `migrate` hiçbir şey uygulayamadı ve
 * drizzle-kit hatayı spinner'ın arkasında yuttuğu için geriye sadece
 * `Exit status 1` kaldı. Sonrasındaki her hata (`relation does not
 * exist`, `function does not exist`) bu tek sessiz başarısızlığın
 * türeviydi.
 *
 * Bu yüzden iki ayrı yoklama var:
 *
 *   Docker      konteynerin İÇİNDEN `pg_isready` — tek güvenilir cevap
 *   Yerel kurulum   TCP yeter: yerel Postgres portu ancak hazır olunca açar
 */

import { spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'

const SHELL = process.platform === 'win32'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function quiet(command, args) {
  return spawnSync(command, args, { stdio: 'ignore', shell: SHELL }).status === 0
}

function capture(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: SHELL })
  return result.status === 0 ? (result.stdout ?? '').toString().trim() : ''
}

export function portOpen(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const finish = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** Compose'un `db` servisi bu makinede var mı? Kimlik döner, yoksa boş. */
export function composeContainerId() {
  if (!quiet('docker', ['info'])) return ''
  return capture('docker', ['compose', 'ps', '-q', 'db'])
}

/**
 * Hazır olana kadar bekler. `onTick` her denemede çağrılıyor — çağıran
 * isterse nokta basıp kullanıcıya bir şeyin döndüğünü gösterebilsin.
 */
export async function waitForDatabase(port, { timeoutMs = 60_000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs
  const inDocker = composeContainerId() !== ''

  while (Date.now() < deadline) {
    const ready = inDocker
      ? quiet('docker', ['compose', 'exec', '-T', 'db', 'pg_isready', '-U', 'postgres', '-d', 'stok'])
      : await portOpen(port)
    if (ready) return true
    onTick?.()
    await sleep(1000)
  }
  return false
}

// Doğrudan çağrıldığında CLI gibi davranıyor: `db:up` ve `db:reset` bunu
// kullanıyor, böylece "konteyner başladı" ile "veritabanı hazır" arasındaki
// fark bir daha kimseyi yakalamıyor.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('wait-for-db.mjs')) {
  const port = Number(process.argv[2]) || 5433
  process.stdout.write('Veritabanının hazır olması bekleniyor')
  const ready = await waitForDatabase(port, { onTick: () => process.stdout.write('.') })
  process.stdout.write('\n')
  if (!ready) {
    process.stderr.write(
      `Veritabanı 60 saniyede hazır olmadı (port ${port}).\n` +
        "Docker kullanıyorsanız: docker compose logs db\n",
    )
    process.exit(1)
  }
  console.log('Veritabanı hazır.')
}
