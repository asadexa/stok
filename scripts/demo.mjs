#!/usr/bin/env node
/**
 * Demo kurulumu: sıfırdan çalışır bir sisteme tek komutla.
 *
 *   pnpm demo          örnek veri zaten varsa dokunmaz
 *   pnpm demo --seed   veritabanını sıfırlayıp örnek veriyi yeniden yükler
 *
 * NEDEN NODE, BASH DEĞİL. Önceki sürüm bir `.sh` dosyasıydı ve Windows'ta
 * hiç çalışmıyordu: CMD `./scripts/demo.sh` satırını tanımıyor, Git Bash
 * her kurulumda PATH'te olmuyor, WSL'de dağıtım kurulu olmayabiliyor.
 * README ise "tek komut" diye onu gösteriyordu. Node zaten zorunlu bir
 * bağımlılık — projeyi kuran herkeste var.
 *
 * HER ADIMDA DURUYOR ve her adımın kendi hata mesajı var; "command failed
 * with exit code 1" satırı ilk kez kuran birine hiçbir şey söylemez.
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { composeContainerId, portOpen, waitForDatabase } from './wait-for-db.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)

// ---------------------------------------------------------------------------
// Çıktı
// ---------------------------------------------------------------------------

// Renk yalnızca gerçek bir terminalde. Çıktı bir dosyaya veya CI loguna
// yönlendirildiğinde kaçış dizileri okunabilirliği bozuyor.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)

const step = (text) => console.log(`\n${paint('0;34', `▶ ${text}`)}`)
const ok = (text) => console.log(paint('0;32', `  ✓ ${text}`))
const warn = (text) => console.log(paint('0;33', `  ! ${text}`))

function die(message) {
  console.error(`\n${paint('0;31', `✗ ${message}`)}\n`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Komut çalıştırma
// ---------------------------------------------------------------------------

/**
 * Windows'ta `pnpm` ve `docker` birer `.cmd` sarmalayıcı ve Node onları
 * kabuk olmadan çalıştıramaz — `spawn` doğrudan `ENOENT` veriyor.
 *
 * `shell` yalnızca Windows'ta açık: POSIX'te kapalı tutmak, argümanların
 * kabuk tarafından yeniden yorumlanmasını (glob, kelime bölme) engelliyor.
 * Buradaki argümanların hiçbirinde boşluk veya kabuk metakarakteri yok,
 * o yüzden Windows tarafı da güvende.
 */
const SHELL = process.platform === 'win32'

function run(command, args, options = {}) {
  return spawnSync(command, args, { stdio: 'inherit', shell: SHELL, ...options })
}

function capture(command, args) {
  const result = run(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    okStatus: result.status === 0,
    stdout: (result.stdout ?? '').toString(),
  }
}

const quiet = (command, args) => run(command, args, { stdio: 'ignore' }).status === 0

/**
 * `run` KELİMESİ ZORUNLU. pnpm, `--filter` ile verilen ilk kelimeyi bir
 * script adı değil çalıştırılabilir olarak yorumlayabiliyor; Windows'ta
 * `pnpm --filter @stok/db migrate` komutu "'migrate' is not recognized"
 * hatasıyla düşüyor. `run` belirsizliği tamamen kaldırıyor ve her
 * platformda aynı davranıyor.
 */
const pnpmScript = (pkg, script) => run('pnpm', ['--filter', pkg, 'run', script])

// ---------------------------------------------------------------------------
// Veritabanı yoklaması
// ---------------------------------------------------------------------------

/** `.env` dosyasını okur. Değer tırnaklıysa tırnakları soyar. */
function readEnvFile(path) {
  const values = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)
    values[match[1]] = value
  }
  return values
}

// ---------------------------------------------------------------------------

async function main() {
  const reseedRequested = process.argv.slice(2).includes('--seed')

  // -------------------------------------------------------------------------
  step('Gereksinimler')
  // -------------------------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 22) {
    die(`Node.js ${nodeMajor} bulundu, 22 veya üstü gerekli. https://nodejs.org`)
  }
  ok(`Node.js v${process.versions.node}`)

  const pnpmVersion = capture('pnpm', ['--version'])
  if (!pnpmVersion.okStatus) {
    die('pnpm kurulu değil. Kurmak için: npm install -g pnpm')
  }
  ok(`pnpm ${pnpmVersion.stdout.trim()}`)

  // -------------------------------------------------------------------------
  step('Ayar dosyası')
  // -------------------------------------------------------------------------
  if (existsSync('.env')) {
    ok('.env zaten var, dokunulmadı')
  } else {
    if (!existsSync('.env.example')) die('.env.example bulunamadı. Depo eksik klonlanmış olabilir.')
    copyFileSync('.env.example', '.env')
    ok('.env oluşturuldu (.env.example kopyalandı)')
  }

  const env = readEnvFile('.env')
  if (!env.DATABASE_URL) die('.env içinde DATABASE_URL yok.')

  let dbPort
  try {
    dbPort = Number(new URL(env.DATABASE_URL).port || 5432)
  } catch {
    die(`DATABASE_URL çözümlenemedi: ${env.DATABASE_URL}`)
  }

  // -------------------------------------------------------------------------
  step('Veritabanı')
  // -------------------------------------------------------------------------
  // Çalışan bir Postgres varsa ona bağlanıyoruz; yoksa Docker ile açıyoruz.
  // Docker'ı zorunlu tutmak, elinde zaten Postgres olan kullanıcıyı gereksiz
  // yere ikinci bir kuruluma sokardı.
  const alreadyUp = await portOpen(dbPort)

  if (!alreadyUp) {
    if (!quiet('docker', ['info'])) {
      die(`Ne çalışan bir Postgres ne de Docker bulundu.
  Seçenek 1: Docker Desktop'ı kurup açın, sonra bu komutu tekrar çalıştırın.
  Seçenek 2: Kendi Postgres'inizi ${dbPort} portunda çalıştırın ve .env içindeki
             DATABASE_URL / MIGRATION_DATABASE_URL satırlarını ona göre düzenleyin.`)
    }
    if (!quiet('docker', ['compose', 'up', '-d'])) {
      die("docker compose başarısız. 'docker compose up -d' çıktısına bakın.")
    }
  }

  // AÇIK PORT "HAZIR" DEMEK DEĞİL, ve bu ayrım bir kullanıcı testini
  // bitirdi: Docker portu konteyner başlar başlamaz yayınlıyor, arkadaki
  // Postgres hâlâ `initdb` ile uğraşırken TCP bağlantısı kuruluyor ama
  // sorgu reddediliyor. Beklemeden migrate'e geçilirse drizzle-kit hatayı
  // yutuyor ve geriye anlamsız bir "Exit status 1" kalıyor.
  //
  // Zaten hazır bir veritabanında döngü ilk denemede dönüyor: bedeli yok.
  process.stdout.write('  Hazır olması bekleniyor')
  const ready = await waitForDatabase(dbPort, { onTick: () => process.stdout.write('.') })
  process.stdout.write('\n')
  if (!ready) {
    die(
      composeContainerId()
        ? "Veritabanı 60 saniyede açılmadı. 'docker compose logs db' ile bakın."
        : `localhost:${dbPort} adresindeki Postgres yanıt vermiyor.`,
    )
  }
  ok(alreadyUp ? `localhost:${dbPort} üzerindeki Postgres hazır` : 'Veritabanı hazır (Docker)')

  // -------------------------------------------------------------------------
  step('Bağımlılıklar')
  // -------------------------------------------------------------------------
  if (run('pnpm', ['install', '--frozen-lockfile'], { stdio: 'ignore' }).status !== 0) {
    die('pnpm install başarısız. Elle görmek için: pnpm install')
  }
  ok('Paketler kurulu')

  // -------------------------------------------------------------------------
  step('Veritabanı kurulumu')
  // -------------------------------------------------------------------------
  // `pg_trgm` eklentisi ve `stok_app` rolü. Docker bunları konteyner İLK
  // KEZ oluşturulurken kendisi uyguluyor, ama kendi Postgres'ini kurmuş
  // biri için hiçbir yerde uygulanmıyordu ve migration "stok_app rolü yok"
  // diye düşüyordu. Yani Docker gereksiz yere ZORUNLU haldeydi.
  //
  // Her açılışta koşuyor: üç ifade de idempotent. "Kuruldu mu" bayrağı
  // tutmuyoruz — tutulan her bayrak gerçekle ayrışabilecek ikinci bir
  // kaynaktır.
  if (pnpmScript('@stok/db', 'init').status !== 0) {
    die('Veritabanı kurulumu başarısız.\n  Elle görmek için: pnpm --filter @stok/db run init')
  }
  ok('Eklenti ve roller yerinde')

  // -------------------------------------------------------------------------
  step("Migration'lar")
  // -------------------------------------------------------------------------
  if (pnpmScript('@stok/db', 'migrate').status !== 0) {
    die('Migration başarısız.\n  Elle görmek için: pnpm --filter @stok/db run migrate')
  }
  ok('Şema güncel')

  // -------------------------------------------------------------------------
  step('Örnek veri')
  // -------------------------------------------------------------------------
  // Seed MEVCUT VERİYİ SİLİYOR. Demo verisiyle oynanmış bir veritabanını
  // sessizce sıfırlamak, "bir saattir test ediyordum" diyen kullanıcı için
  // kabul edilemez.
  let reseed = reseedRequested
  if (!reseed) {
    const count = capture('pnpm', ['--filter', '@stok/db', 'run', 'product-count'])
    const parsed = Number(count.stdout.trim().split(/\r?\n/).pop())

    if (!count.okStatus || !Number.isFinite(parsed)) {
      // Sayamadıysak VERİ VAR SAYIYORUZ. Yanlış tarafa düşmek, birinin
      // saatlerce girdiği kayıtları silmek demek olurdu.
      warn('Ürün sayısı okunamadı; örnek veri yeniden yüklenmedi.')
      warn('Sıfırdan başlamak için: pnpm demo --seed')
    } else if (parsed > 0) {
      warn(`Veritabanında zaten ${parsed} ürün var, örnek veri yeniden yüklenmedi.`)
      warn('Sıfırdan başlamak için: pnpm demo --seed')
    } else {
      reseed = true
    }
  }

  if (reseed && pnpmScript('@stok/db', 'seed').status !== 0) {
    die('Seed başarısız.')
  }

  // -------------------------------------------------------------------------
  step('Hazır')
  // -------------------------------------------------------------------------
  console.log(`
  Adres:     ${env.APP_URL || 'http://localhost:3000'}

  Yönetici:  admin@yilmaz.example          / admin123
  Çalışan:   ahmet@yilmazkirtasiye.example / calisan123

  Neyi deneyebilirsiniz ve neyi DENEYEMEZSİNİZ: README.md → "Demo"
`)
  console.log(paint('0;34', '▶ Sunucu başlatılıyor (durdurmak için Ctrl+C)\n'))

  // Sunucu ön planda kalıyor ve çıkış kodunu devralıyoruz: `pnpm demo`
  // başarısız bir derlemede sıfırla dönmemeli.
  const server = spawn('pnpm', ['--filter', '@stok/web', 'run', 'dev'], {
    stdio: 'inherit',
    shell: SHELL,
  })
  server.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0))
  })
}

await main()
