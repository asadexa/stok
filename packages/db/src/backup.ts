import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { appendFile, open, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { config } from 'dotenv'
import {
  BACKUP_DIR_ENV,
  type DirRefusal,
  type DirSetting,
  LAST_SUCCESS_FILE,
  LOG_FILE,
  type LogEntry,
  PARTIAL_SUFFIX,
  REQUIRED_TOC_TABLES,
  SHA_SUFFIX,
  type ShaCheck,
  type StatusInput,
  backupDirSetting,
  backupStamp,
  clipReason,
  dumpCommand,
  dumpName,
  evaluateToc,
  fullReadCommand,
  inventory,
  lastLogEntry,
  parseBackupArgs,
  parseShaLine,
  planRetention,
  refuseRawDir,
  refuseResolvedDir,
  relocationNote,
  shaLine,
  sizeText,
  staleLeftovers,
  statusReport,
  syncRootsFromEnv,
  tocCommand,
} from './backup-policy'
import { isCliEntry } from './cli-entry'
import { DockerRefused, ROOT, type Target, dockerEndpoint, dockerOk, lines, targetFromContainer } from './docker'
import { type DatabaseTarget, describeTarget, formatTarget } from './target'
import { isLocalDockerEndpoint } from './wipe-guard'

/**
 * ============================================================================
 * YEREL YEDEK (WS-1.3a, OPS-10)
 *
 *   pnpm db:backup            compose `db`'deki `stok`'u doğrulanmış bir dökümle yedekler
 *   pnpm db:backup --status   yedek dizinini okur; Docker'a gitmez, hiçbir şey yazmaz
 *
 * Komut R-1 planının öngördüğü `scripts/pilot.mjs`'te değil: WS-1.2b'den beri
 * yerel işletim komutları `packages/db`'de TypeScript, kökte `db:*` takma adı.
 * Kurallar `backup-policy.ts`'te; burada yalnız I/O var.
 *
 * Sıra: dizin kuralı (Docker'a dokunmadan) → Docker yerel mi → compose `db`
 * kapsayıcısı çalışıyor mu → uygulamanın `DATABASE_URL`'i bu kapsayıcıyı mı
 * gösteriyor → `pg_dump` akışla `.partial`'a → içindekiler + tam okuma →
 * SHA-256 → `.sha256` → `.partial` son adına (işleme noktası) → son başarı,
 * saklama, kalıntı temizliği, log.
 *
 * Final adlı döküm ancak doğrulamadan sonra oluşuyor; arada süreç ölürse
 * yalnız `.partial` kalır ve sayılmaz. Bu komut geri yükleme YAPMAZ:
 * `pg_restore` çağrıları veritabanına bağlanmadan arşivi okur. Geri
 * yüklenebilirliğin kanıtı ayrı tatbikat (WS-1.4).
 * ============================================================================
 */

const USAGE = [
  'Kullanım:',
  '  pnpm db:backup            compose `db` kapsayıcısındaki stok veritabanını doğrulanmış bir dökümle yedekler',
  "  pnpm db:backup --status   yedek dizinini okur; Docker'a gitmez, hiçbir şey yazmaz",
  `Dizin: ${BACKUP_DIR_ENV}, yoksa Windows'ta %LOCALAPPDATA%\\stok\\yedek.`,
].join('\n')

/** Yedeğin reti; Docker katmanının retleriyle aynı biçimde basılıyor. */
class BackupRefused extends DockerRefused {}

// ---------------------------------------------------------------------------
// Dizin
// ---------------------------------------------------------------------------

interface BackupDir {
  /** Gerçek yol (realpath): dosyaların fiilen durduğu yer. */
  dir: string
  /** Ayardan gelen yol; gerçek yoldan farklıysa kullanıcıya söyleniyor. */
  intended: string
  source: DirSetting['source']
}

const DIR_REFUSALS: Record<DirRefusal | 'no-default' | 'not-directory', string> = {
  'no-default': `Yedek dizini tanımsız: ${BACKUP_DIR_ENV} verilmeli (varsayılan yalnız Windows'ta %LOCALAPPDATA%\\stok\\yedek).`,
  empty: `${BACKUP_DIR_ENV} tanımlı ama boş; boş değer varsayılan dizin demek değil.`,
  relative: 'Yedek dizini göreli ya da sürücüsüz bir yol; çalışma dizinine göre değişir. Tam yol verin (ör. D:\\yedek).',
  network: 'Yedek dizini bir ağ ya da aygıt yolu; yalnız bu makinedeki yerel disk kabul ediliyor.',
  repo: 'Yedek dizini repo içinde: repo herkese açık, döküm ise parola özetleri, kişisel veri ve alış fiyatları içeriyor.',
  sync: 'Yedek dizini OneDrive altında: döküm buluta senkronlanırdı.',
  'not-directory': 'Yedek dizini yolu bir dosyayı gösteriyor.',
}

function refuseDir(reason: keyof typeof DIR_REFUSALS, path?: string): never {
  throw new BackupRefused(path?.trim() ? `${DIR_REFUSALS[reason]}\n  Yol: ${path}` : DIR_REFUSALS[reason])
}

/** Var olan en derin üst dizinin gerçek yolu ve henüz olmayan parçalar. Dizin yaratılmaz. */
function realPathOf(target: string): string {
  let current = resolve(target)
  const rest: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    rest.unshift(basename(current))
    current = parent
  }
  return join(realpathSync.native(current), ...rest)
}

function dirContext() {
  const realIfExists = (p: string) => (existsSync(p) ? realpathSync.native(p) : p)
  return {
    platform: process.platform,
    repoRoot: realpathSync.native(ROOT),
    syncRoots: syncRootsFromEnv(process.env).map(realIfExists),
  }
}

/** Kural, Docker'a ve dizin yaratmaya dokunmadan; `realpathSync.native` junction, `subst` ve eşlenmiş sürücüyü çözüyor. */
function resolveBackupDir(): BackupDir {
  const setting = backupDirSetting(process.env, process.platform)
  if (!setting) refuseDir('no-default')
  const syntax = refuseRawDir(setting.raw, process.platform)
  if (syntax) refuseDir(syntax, setting.raw)
  let real: string
  try {
    real = realPathOf(setting.raw)
  } catch (err) {
    throw new BackupRefused(`Yedek dizini çözülemedi: ${(err as Error).message}`)
  }
  const refusal = refuseResolvedDir(real, dirContext())
  if (refusal) refuseDir(refusal, real)
  if (existsSync(real) && !statSync(real).isDirectory()) refuseDir('not-directory', real)
  return { dir: real, intended: resolve(setting.raw), source: setting.source }
}

/**
 * Dizin yaratılır ve gerçek yolu yeniden denetlenir: kontrolden sonra bir
 * junction değiştiyse ya da yazma başka yere yönlendiyse (paketli uygulama)
 * yakalanır. Dönen gerçek yol, dosyaların fiilen durduğu yer.
 */
function ensureDir(target: BackupDir): string {
  mkdirSync(target.dir, { recursive: true, mode: 0o700 })
  const real = realpathSync.native(target.dir)
  const refusal = refuseResolvedDir(real, dirContext())
  if (refusal) refuseDir(refusal, real)
  if (!statSync(real).isDirectory()) refuseDir('not-directory', real)
  return real
}

// ---------------------------------------------------------------------------
// Kaynak
// ---------------------------------------------------------------------------

function resolveSource(): Target {
  const endpoint = dockerEndpoint()
  if (!isLocalDockerEndpoint(endpoint)) {
    throw new BackupRefused(`Docker yerel değil (${endpoint}); yedek yalnız bu makinedeki kapsayıcıdan alınır.`)
  }
  const ids = lines(dockerOk(['compose', 'ps', '-a', '-q', 'db'], 'compose kapsayıcısı aranamadı'))
  if (ids.length !== 1) {
    throw new BackupRefused(
      ids.length === 0
        ? 'Compose `db` kapsayıcısı bulunamadı; yedek yalnız Docker kurulumunda alınır. Önce: pnpm db:up'
        : `Compose \`db\` için ${ids.length} kapsayıcı var; hangisinin yedekleneceği belirsiz.`,
    )
  }
  const target = targetFromContainer(ids[0]!)
  if (!target.running) {
    throw new BackupRefused('Kapsayıcı çalışmıyor; yedek komutu kapsayıcıyı başlatmaz. Önce: pnpm db:up')
  }
  return target
}

/**
 * K4'ün somut hali: yedeklenen kapsayıcı uygulamanın bağlandığı veritabanı
 * mı? Değilse kapsayıcıyı "başarıyla" yedeklemek sessiz bir yanlış yedek
 * olurdu. Adres yazılmıyor (parola içerir); yalnız sunucu, port, veritabanı.
 */
function assertAppDatabase(): void {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new BackupRefused(
      "DATABASE_URL tanımlı değil (kök .env); yedeklenecek veritabanının uygulamanınki olduğu doğrulanamadı.",
    )
  }
  let app: DatabaseTarget
  try {
    app = describeTarget(url)
  } catch {
    throw new BackupRefused('DATABASE_URL bir bağlantı adresi olarak çözümlenemedi.')
  }
  const published = lines(dockerOk(['compose', 'port', 'db', '5432'], 'kapsayıcının yayımladığı port okunamadı'))[0] ?? ''
  const port = Number(published.slice(published.lastIndexOf(':') + 1))
  if (!app.isLocal || app.port !== port || app.database !== 'stok') {
    throw new BackupRefused(
      `Uygulama ${formatTarget(app)} veritabanına bağlı; compose \`db\` kapsayıcısı ${published || 'port yayımlamıyor'}. Yedek yalnız uygulamanın bağlı olduğu yerel Docker veritabanından (stok) alınır.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Akış, doğrulama, dosyalar
// ---------------------------------------------------------------------------

interface StreamResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Okuyan sürecin girdiyi bitirmeden kapattığı boru hataları (platforma göre kod değişiyor). */
const BROKEN_PIPE = new Set(['EPIPE', 'EOF', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED'])

/**
 * Docker'ı akışla çalıştırır: kabuk yok, TTY yok, kodlama yok (ikili veri
 * olduğu gibi geçiyor; PowerShell yönlendirmesi onu bozardı). `output`
 * verilirse stdout o dosyaya yazılıyor (dosyayı bu koşu yaratmış olmalı),
 * `input` verilirse stdin o dosyadan okunuyor.
 */
async function dockerStream(args: string[], io: { input?: string; output?: string } = {}): Promise<StreamResult> {
  const child = spawn('docker', args, {
    cwd: ROOT,
    stdio: [io.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const exited = new Promise<number | null>((done, fail) => {
    child.once('error', (err) => fail(new BackupRefused(`docker çalıştırılamadı: ${err.message}`)))
    child.once('close', done)
  })
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (d: string) => {
    if (stderr.length < 8192) stderr += d
  })
  let stdout = ''
  const settle = (p: Promise<void>) => p.then(() => null, (err: NodeJS.ErrnoException) => err)
  let output: Promise<NodeJS.ErrnoException | null> = Promise.resolve(null)
  if (io.output) output = settle(pipeline(child.stdout!, createWriteStream(io.output, { flags: 'r+' })))
  else {
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      stdout += d
    })
  }
  let input: Promise<NodeJS.ErrnoException | null> = Promise.resolve(null)
  if (io.input) input = settle(pipeline(createReadStream(io.input), child.stdin!))
  const [code, outputError, inputError] = await Promise.all([exited, output, input])
  // Okuyan süreç girdinin hepsini okumadan çıkabilir: `pg_restore --list`
  // yalnız dosyanın başındaki içindekiler tablosunu okuyor, kalanına yazma
  // EPIPE alıyor (Windows'ta ölçüldü). Bu durumda karar çıkış kodunun; kırık
  // giriş borusu hata sayılmaz. Başka her akış hatası, süreç 0 dönse de hata:
  // döküm dosyası eksik yazılmış olabilir (disk dolu).
  const broken = outputError ?? (inputError && !BROKEN_PIPE.has(inputError.code ?? '') ? inputError : null)
  if (broken && code === 0) throw new BackupRefused(`Aktarım yarıda kaldı: ${broken.message}`)
  return { code, stdout, stderr: stderr.trim() }
}

/**
 * Arşivi veritabanına bağlanmadan doğrular; geri yükleme değil. İçindekiler
 * (`dbname: stok`, temel tabloların `TABLE` ve `TABLE DATA` girdileri) ve tam
 * okuma: `--list` dosyanın başındaki tabloyu okuduğu için kesik ya da bozuk
 * veri bloğunu görmüyor (M1). Testler kesik ve bozuk kopyayla doğrudan çağırıyor.
 */
export async function verifyDump(containerId: string, file: string): Promise<{ pgVersion: string | null }> {
  const toc = await dockerStream(tocCommand(containerId), { input: file })
  if (toc.code !== 0) {
    throw new BackupRefused(`Arşivin içindekiler tablosu okunamadı (çıkış ${toc.code}): ${clipReason(toc.stderr)}`)
  }
  const result = evaluateToc(toc.stdout)
  if (!result.ok) throw new BackupRefused(`Arşivin içindekiler tablosu beklenen gibi değil: ${result.reason}`)
  const full = await dockerStream(fullReadCommand(containerId), { input: file })
  if (full.code !== 0) {
    throw new BackupRefused(`Arşiv baştan sona okunamadı (çıkış ${full.code}): ${clipReason(full.stderr)}`)
  }
  return { pgVersion: result.pgVersion }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Yeniden adlandırmadan önce disk: elektrik kesilirse son adlı ama boş bir dosya kalmasın. */
async function fsyncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Yalnız yeni dosya (`wx`): var olan dosyanın ya da bağın üzerine yazılmaz. */
async function writeNew(file: string, content: string): Promise<void> {
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function exists(file: string): boolean {
  try {
    lstatSync(file)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Windows'ta `rename` hedefin üzerine yazıyor; var olan dökümün ya da özetin üzerine yazılmasın. */
async function renameNew(from: string, to: string): Promise<void> {
  if (exists(to)) {
    throw new BackupRefused(`${basename(to)} zaten var; üzerine yazılmadı (aynı saniyede başka bir yedek ya da geri giden saat).`)
  }
  await rename(from, to)
}

async function appendLog(dir: string, entry: LogEntry): Promise<void> {
  await appendFile(join(dir, LOG_FILE), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// Modlar
// ---------------------------------------------------------------------------

const dirLabel = (target: BackupDir) => (target.source === 'env' ? BACKUP_DIR_ENV : 'varsayılan')

async function backup(target: BackupDir, onDirReady: (dir: string) => void): Promise<number> {
  const source = resolveSource()
  assertAppDatabase()
  const dir = ensureDir(target)
  onDirReady(dir)
  console.log(`Kaynak : compose projesi ${source.project}, kapsayıcı ${source.containerId.slice(0, 12)}, volume ${source.volume}`)
  console.log(`Hedef  : ${dir} (${dirLabel(target)})`)
  const warnings: string[] = []
  const relocated = relocationNote(target.intended, dir, process.platform)
  if (relocated) {
    console.warn(`  ! ${relocated}`)
    warnings.push(relocated)
  }

  const started = Date.now()
  const stamp = backupStamp(new Date(started))
  const name = dumpName(stamp)
  const final = join(dir, name)
  const partial = `${final}${PARTIAL_SUFFIX}`
  const shaFinal = `${final}${SHA_SUFFIX}`
  const shaPartial = `${shaFinal}${PARTIAL_SUFFIX}`
  // Hata yolunda yalnız bu koşunun yarattığı dosyalar silinir; aynı saniyedeki
  // başka bir koşunun `.partial`'ına dokunulmaz.
  const created: string[] = []
  let result!: { sha256: string; bytes: number; pgVersion: string | null }
  try {
    await writeNew(partial, '')
    created.push(partial)
    const dump = await dockerStream(dumpCommand(source.containerId), { output: partial })
    if (dump.code !== 0) throw new BackupRefused(`pg_dump başarısız (çıkış ${dump.code}): ${clipReason(dump.stderr)}`)
    await fsyncFile(partial)
    const { pgVersion } = await verifyDump(source.containerId, partial)
    const sha256 = await sha256File(partial)
    const bytes = statSync(partial).size
    await writeNew(shaPartial, shaLine(sha256, name))
    created.push(shaPartial)
    await renameNew(shaPartial, shaFinal)
    created.push(shaFinal)
    // İşleme noktası: bu adda bir döküm yalnız doğrulamadan sonra var.
    await renameNew(partial, final)
    result = { sha256, bytes, pgVersion }
  } catch (err) {
    for (const file of created) await rm(file, { force: true })
    throw err
  }

  const finished = new Date()
  const lastTmp = join(dir, `${LAST_SUCCESS_FILE}.${stamp}${PARTIAL_SUFFIX}`)
  try {
    const last = { at: finished.toISOString(), file: name, ...result, volume: source.volume }
    await writeNew(lastTmp, `${JSON.stringify(last, null, 2)}\n`)
    // Tek "son başarı" dosyası: üzerine yazılması bilinçli.
    await rename(lastTmp, join(dir, LAST_SUCCESS_FILE))
  } catch (err) {
    await rm(lastTmp, { force: true })
    warnings.push(`${LAST_SUCCESS_FILE} yazılamadı: ${(err as Error).message}`)
  }

  // Saklama ve temizlik yalnız burada, döküm işlendikten sonra (Q-3).
  const names = readdirSync(dir)
  const deleted: string[] = []
  for (const old of planRetention(names, name)) {
    try {
      await unlink(join(dir, old))
      await rm(join(dir, `${old}${SHA_SUFFIX}`), { force: true })
      deleted.push(old)
    } catch (err) {
      warnings.push(`${old} silinemedi: ${(err as Error).message}`)
    }
  }
  const cleaned: string[] = []
  for (const left of staleLeftovers(names, finished.getTime())) {
    try {
      await unlink(join(dir, left))
      cleaned.push(left)
    } catch (err) {
      warnings.push(`${left} silinemedi: ${(err as Error).message}`)
    }
  }
  await appendLog(dir, {
    at: finished.toISOString(),
    outcome: 'ok',
    file: name,
    bytes: result.bytes,
    sha256: result.sha256,
    durationMs: finished.getTime() - started,
    volume: source.volume,
    pgVersion: result.pgVersion,
    deleted,
    cleaned,
    warnings,
  })

  const recorded = inventory(readdirSync(dir)).recorded.length
  console.log(`\n✓ Yedek alındı ve doğrulandı: ${name} (${sizeText(result.bytes)})`)
  console.log(`  SHA-256   : ${result.sha256}`)
  console.log(
    `  Doğrulama : içindekiler (${REQUIRED_TOC_TABLES.length} temel tablo) ve tam okuma geçti${result.pgVersion ? `; PostgreSQL ${result.pgVersion}` : ''}`,
  )
  console.log(
    `  Saklama   : ${recorded} kayıtlı döküm${deleted.length ? `; ${deleted.length} eski döküm silindi` : ''}${cleaned.length ? `; ${cleaned.length} kalıntı temizlendi` : ''}`,
  )
  // Yönlendirme notu başta basıldı; burada yalnız sonradan çıkan uyarılar.
  for (const warning of warnings.filter((w) => w !== relocated)) console.warn(`  ! ${warning}`)
  console.log('  Geri yükleme bu komutla denenmez; geri yüklenebilirlik ayrı tatbikatla kanıtlanır.\n')
  return 0
}

function readLastSuccessFile(dir: string): string | null {
  try {
    const data = JSON.parse(readFileSync(join(dir, LAST_SUCCESS_FILE), 'utf8')) as { file?: unknown }
    return typeof data.file === 'string' ? data.file : null
  } catch {
    // Durum "yok ya da okunamadı" diye yazıyor; sessizce geçilmiyor.
    return null
  }
}

async function status(target: BackupDir): Promise<number> {
  const names = existsSync(target.dir) ? readdirSync(target.dir) : []
  const newestName = inventory(names).recorded[0]
  let newest: StatusInput['newest'] = null
  if (newestName) {
    const file = join(target.dir, newestName)
    let check: ShaCheck = 'unreadable'
    let bytes = 0
    try {
      bytes = statSync(file).size
      const expected = parseShaLine(readFileSync(`${file}${SHA_SUFFIX}`, 'utf8'), newestName)
      if (expected !== null) check = (await sha256File(file)) === expected ? 'match' : 'mismatch'
    } catch {
      // "okunamadı" olarak yazılıyor ve çıkış 1.
      check = 'unreadable'
    }
    newest = { name: newestName, bytes, check }
  }
  const logFile = join(target.dir, LOG_FILE)
  const report = statusReport({
    dir: target.dir,
    source: target.source,
    names,
    newest,
    lastSuccessFile: existsSync(target.dir) ? readLastSuccessFile(target.dir) : null,
    lastRun: lastLogEntry(existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''),
    now: Date.now(),
    formatTime: (ms) => new Date(ms).toLocaleString('tr-TR'),
  })
  for (const line of report.lines) console.log(line)
  const relocated = relocationNote(target.intended, target.dir, process.platform)
  if (relocated) console.log(`Not              : ${relocated}`)
  return report.exitCode
}

async function main(): Promise<number> {
  // Ortamı uygulama hazırlıyor (PROJECT_BRAIN §12.9): kök `.env`, çalışma
  // dizininden bağımsız (zamanlanmış görev başka dizinden çağırabilir).
  // Var olan değişkenler ezilmiyor.
  config({ path: join(ROOT, '.env') })
  const parsed = parseBackupArgs(process.argv.slice(2))
  if (parsed.mode === 'error') {
    console.error(`✗ ${parsed.message}\n\n${USAGE}`)
    return 1
  }
  const footer = parsed.mode === 'status' ? 'Durum gösterilemedi.' : 'Yedek alınmadı.'
  let logDir: string | null = null
  try {
    const target = resolveBackupDir()
    if (parsed.mode === 'status') return await status(target)
    if (existsSync(target.dir)) logDir = target.dir
    return await backup(target, (dir) => {
      logDir = dir
    })
  } catch (err) {
    // Dizin geçerli ve varsa her başarısızlık log'a: zamanlanmış koşuda
    // (1.3b) çıktıyı kimse görmüyor, `--status` son koşuyu buradan okuyor.
    if (logDir) {
      const reason = clipReason(err instanceof Error ? err.message : String(err))
      try {
        await appendLog(logDir, { at: new Date().toISOString(), outcome: 'failed', reason })
      } catch (logErr) {
        console.error(`  ! Yedek günlüğü yazılamadı: ${(logErr as Error).message}`)
      }
    }
    if (err instanceof DockerRefused) {
      console.error(`\n✗ ${err.message}\n  ${footer}\n`)
      return 1
    }
    throw err
  }
}

// Testler `verifyDump`'ı içe aktarıyor; CLI yalnız doğrudan çalıştırılınca
// koşar, junction/symlink içeren yoldan da (`cli-entry.ts`).
if (isCliEntry(import.meta.url, process.argv[1])) {
  process.exitCode = await main()
}
