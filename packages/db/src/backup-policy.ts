import path from 'node:path'

/**
 * ============================================================================
 * YEREL YEDEK KURALLARI (WS-1.3a, OPS-10) — yan etkisiz
 *
 * `backup.ts` bütün I/O'yu yapıyor; neyin yasak, neyin kayıtlı, neyin
 * silinebilir olduğuna burada karar veriliyor. Ayrım `wipe-guard.ts` ile aynı
 * sebepten: kararlar tablo testleriyle, Docker ve dosya sistemi olmadan ve
 * Linux CI'da Windows yol kurallarıyla birlikte sınanabilsin.
 *
 *   - Dizin `%LOCALAPPDATA%\stok\yedek` ya da `STOK_BACKUP_DIR`. Repo içi
 *     (repo public), OneDrive (senkron bulut), göreli ve `\\` önekli yollar
 *     reddedilir.
 *   - Döküm adı UTC damgalı: `stok-YYYYMMDD-HHmmssZ.dump`.
 *   - "Kayıtlı yedek" = desene uyan döküm + yanında `.sha256`. `.sha256` ancak
 *     içindekiler (TOC) ve tam okuma geçince yazılıyor; bu yüzden bu adda bir
 *     döküm oluşturulurken doğrulanmıştır. Bugünkü bütünlüğün kanıtı değildir.
 *   - Saklama yalnız başarılı koşudan sonra: en yeni 14 kayıtlı döküm.
 * ============================================================================
 */

export const BACKUP_KEEP = 14
/** Bu boyutta bir döküm saniyeler sürüyor; bir saatten eski geçici dosya yaşayan bir koşuya ait olamaz. */
export const STALE_AFTER_MS = 60 * 60 * 1000
export const BACKUP_DIR_ENV = 'STOK_BACKUP_DIR'
export const STATUS_FLAG = '--status'
export const LAST_SUCCESS_FILE = 'son-basarili.json'
export const LOG_FILE = 'yedek-gunlugu.jsonl'
export const SHA_SUFFIX = '.sha256'
export const PARTIAL_SUFFIX = '.partial'

/**
 * Arşivde `TABLE` ve `TABLE DATA` girdisi aranan temel tablolar. Bütün
 * `APP_TABLES` değil: kod yeni bir migration'la güncellenip veritabanı henüz
 * migrate edilmemişken (tam da yedek alınacak an) yedek reddedilirdi.
 * Alt küme olduğu `backup-policy.test.ts`'te sınanıyor.
 */
export const REQUIRED_TOC_TABLES = ['tenants', 'users', 'products', 'stock_movements', 'current_stock'] as const

// ---------------------------------------------------------------------------
// Argümanlar
// ---------------------------------------------------------------------------

export type BackupMode = { mode: 'backup' } | { mode: 'status' } | { mode: 'error'; message: string }

export function parseBackupArgs(argv: readonly string[]): BackupMode {
  // pnpm bazı sürümlerde araya `--` koyuyor; bayrak değil.
  const args = argv.filter((a) => a !== '--')
  const unknown = args.filter((a) => a !== STATUS_FLAG)
  if (unknown.length) return { mode: 'error', message: `Bilinmeyen seçenek: ${unknown.join(' ')}` }
  return args.includes(STATUS_FLAG) ? { mode: 'status' } : { mode: 'backup' }
}

// ---------------------------------------------------------------------------
// Damga ve adlar
// ---------------------------------------------------------------------------

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z$/
const DUMP_RE = /^stok-(\d{8}-\d{6}Z)\.dump$/
const SHA_RE = /^stok-(\d{8}-\d{6}Z)\.dump\.sha256$/
const LEFTOVER_RE = /^(?:stok-(\d{8}-\d{6}Z)\.dump(?:\.sha256)?|son-basarili\.json\.(\d{8}-\d{6}Z))\.partial$/

/**
 * UTC: ana makinenin saat dilimi ayarından ve henüz verilmemiş saat dilimi
 * kararından (`DAT-16`) bağımsız. Yerel saatle ad, ayar ya da yaz saati
 * değişince sıralamayı ve dolayısıyla saklamayı bozabilirdi.
 */
export function backupStamp(at: Date): string {
  const iso = at.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
}

/** Damganın anı (ms); geçersiz takvim değeri (ör. 13. ay) null. */
export function stampTime(stamp: string): number | null {
  const m = STAMP_RE.exec(stamp)
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
  return backupStamp(new Date(t)) === stamp ? t : null
}

export const dumpName = (stamp: string) => `stok-${stamp}.dump`

/** Desene uyan dökümün damgası; uymuyorsa null. */
export function dumpStamp(name: string): string | null {
  const stamp = DUMP_RE.exec(name)?.[1]
  return stamp !== undefined && stampTime(stamp) !== null ? stamp : null
}

// ---------------------------------------------------------------------------
// Dizin kuralı
// ---------------------------------------------------------------------------

export type DirRefusal = 'empty' | 'relative' | 'network' | 'repo' | 'sync'

export interface DirSetting {
  raw: string
  source: 'env' | 'default'
}

type Env = Readonly<Record<string, string | undefined>>

/**
 * `STOK_BACKUP_DIR`, yoksa Windows'ta `%LOCALAPPDATA%\stok\yedek`. Başka
 * platformda varsayılan yok (K1 yalnız Windows'u tanımlıyor): değişken
 * zorunlu, yoksa null. Tanımlı ama boş değer burada değil `refuseRawDir`'de
 * reddediliyor; boş değer "varsayılanı kullan" demek değil.
 */
export function backupDirSetting(env: Env, platform: NodeJS.Platform): DirSetting | null {
  const fromEnv = env[BACKUP_DIR_ENV]
  if (fromEnv !== undefined) return { raw: fromEnv, source: 'env' }
  const local = env.LOCALAPPDATA
  if (platform === 'win32' && local) return { raw: path.win32.join(local, 'stok', 'yedek'), source: 'default' }
  return null
}

/**
 * Sözdizimi kuralı, dosya sistemine dokunmadan. Windows'ta `isAbsolute`
 * yetmiyor: `\x` (sürücüsüz) ve `C:x` (sürücüde göreli) çalışma dizinine göre
 * değişir ve `path.win32.isAbsolute('\\x')` true döner. `\\` öneki (UNC,
 * `\\?\`, `\\.\`) reddediliyor: aygıt yolu öneki repo/OneDrive önek
 * karşılaştırmasını atlatabilir; ağ paylaşımında atomik yeniden adlandırma
 * ve fsync da ölçülmedi.
 */
export function refuseRawDir(raw: string, platform: NodeJS.Platform): DirRefusal | null {
  if (raw.trim() === '') return 'empty'
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(raw)) return 'network'
    return /^[A-Za-z]:[\\/]/.test(raw) ? null : 'relative'
  }
  return path.posix.isAbsolute(raw) ? null : 'relative'
}

export interface DirContext {
  platform: NodeJS.Platform
  /** Repo kökünün gerçek yolu. */
  repoRoot: string
  /** OneDrive köklerinin gerçek yolları. */
  syncRoots: readonly string[]
}

/** Gerçek yola (realpath) uygulanan kural: repo içi ya da senkron klasörü altı. */
export function refuseResolvedDir(real: string, ctx: DirContext): DirRefusal | null {
  // realpath, eşlenmiş ağ sürücüsünü UNC yoluna çeviriyor.
  if (ctx.platform === 'win32' && /^[\\/]{2}/.test(real)) return 'network'
  if (isWithin(ctx.repoRoot, real, ctx.platform)) return 'repo'
  if (ctx.syncRoots.some((root) => isWithin(root, real, ctx.platform))) return 'sync'
  return null
}

/**
 * İstenen yol ile gerçek konum farklıysa kullanıcıya söylenecek not; aynıysa
 * null. Windows'ta paketli (MSIX) bir uygulamanın alt sürecinde, örneğin
 * Claude masaüstü uygulamasının terminalinde, `%LOCALAPPDATA%` altına yeni
 * yazılan klasör paketin özel `LocalCache`'ine yönleniyor (2026-10-16'da
 * ölçüldü). O klasör uygulama kaldırılınca silinir; "yedek alındı" demek
 * yetmez, nerede durduğu söylenmeli.
 */
export function relocationNote(intended: string, real: string, platform: NodeJS.Platform): string | null {
  if (isWithin(intended, real, platform) && isWithin(real, intended, platform)) return null
  if (platform === 'win32' && /\\Packages\\[^\\]+\\LocalCache\\/i.test(real)) {
    return `Dizin bu süreç için paketli bir uygulamanın özel klasörüne yönlendi; uygulama kaldırılınca silinir. Kalıcı yedek için komutu normal bir terminalden çalıştırın ya da ${BACKUP_DIR_ENV} ile başka bir yerel dizin verin. İstenen: ${intended}`
  }
  return `Dizin başka bir konuma çözüldü (bağlantı noktası ya da yönlendirme). İstenen: ${intended}`
}

/** OneDrive'ın kişisel ve iş kökleri; tanımsız ya da boş olanlar atlanır. */
export function syncRootsFromEnv(env: Env): string[] {
  return ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']
    .map((key) => env[key])
    .filter((v): v is string => v !== undefined && v.trim() !== '')
}

/**
 * `child`, `parent`'ın kendisi ya da altı mı; yol parçası sınırına göre:
 * `OneDriveYedek`, `OneDrive`'ın altı değil. Windows'ta büyük/küçük harf
 * duyarsız ve `toLowerCase()` yerel ayardan bağımsız (Türkçe `I`/`ı` dönüşümü
 * karşılaştırmayı bozmasın). NFC: aynı ad iki Unicode biçiminde gelebilir
 * (`Masaüstü`).
 */
export function isWithin(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix
  const norm = (s: string) => {
    const n = p.normalize(s.normalize('NFC'))
    return platform === 'win32' ? n.toLowerCase() : n
  }
  const rel = p.relative(norm(parent), norm(child))
  return rel === '' || !(rel === '..' || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel))
}

// ---------------------------------------------------------------------------
// Docker komutları
// ---------------------------------------------------------------------------

/** R-1'in çağrısı. TTY yok (`-t` yok): TTY satır sonlarını çevirip ikili akışı bozar. */
export const dumpCommand = (containerId: string) => [
  'exec', containerId, 'pg_dump', '--format=custom', '--username=postgres', '--dbname=stok',
]

/**
 * Doğrulama komutları hiçbir veritabanına BAĞLANMAZ (`-d` yok); bunlar geri
 * yükleme değil, arşivi stdin'den okuyorlar. İçindekiler tablosu dosyanın
 * başında: `--list` kesik ya da bozuk veri bloğunu görmüyor. M1 ölçümü
 * (2026-10-16, PostgreSQL 17.11): %60'ında kesilmiş ve bir baytı çevrilmiş
 * arşivde `--list` çıkış 0; tam okuma ikisini de reddetti ("end of file",
 * "incorrect data check").
 */
export const tocCommand = (containerId: string) => ['exec', '-i', containerId, 'pg_restore', '--list']
export const fullReadCommand = (containerId: string) => ['exec', '-i', containerId, 'pg_restore', '--file=/dev/null']

// ---------------------------------------------------------------------------
// İçindekiler (TOC)
// ---------------------------------------------------------------------------

export type TocResult = { ok: true; pgVersion: string | null } | { ok: false; reason: string }

/** `pg_restore --list`: başlıkta `dbname: stok`; temel tabloların `TABLE` ve `TABLE DATA` girdileri. */
export function evaluateToc(listing: string): TocResult {
  const dbname = /^;\s+dbname:\s+(\S+)\s*$/m.exec(listing)?.[1]
  if (dbname !== 'stok') return { ok: false, reason: `arşivdeki veritabanı "${dbname ?? '?'}", beklenen "stok"` }
  const entries = new Set<string>()
  for (const line of listing.split(/\r?\n/)) {
    const m = /^\d+;\s+\d+\s+\d+\s+(TABLE DATA|TABLE)\s+(\S+)\s+(\S+)\s/.exec(line)
    if (m) entries.add(`${m[1]} ${m[2]}.${m[3]}`)
  }
  const missing = REQUIRED_TOC_TABLES.flatMap((t) => [`TABLE public.${t}`, `TABLE DATA public.${t}`]).filter(
    (e) => !entries.has(e),
  )
  if (missing.length) return { ok: false, reason: `eksik girdi: ${missing.join(', ')}` }
  return { ok: true, pgVersion: /^;\s+Dumped from database version:\s+(\S+)/m.exec(listing)?.[1] ?? null }
}

// ---------------------------------------------------------------------------
// SHA-256 dosyası
// ---------------------------------------------------------------------------

/** sha256sum biçimi: `sha256sum -c` ve elle karşılaştırma için. */
export const shaLine = (hex: string, name: string) => `${hex}  ${name}\n`

/** `.sha256`'daki özet; biçim ya da ad tutmuyorsa null. */
export function parseShaLine(content: string, name: string): string | null {
  const m = /^([0-9a-f]{64}) {2}(\S+)\r?\n?$/.exec(content)
  return m && m[2] === name ? m[1]! : null
}

// ---------------------------------------------------------------------------
// Dizin envanteri, saklama, kalıntılar
// ---------------------------------------------------------------------------

export interface Inventory {
  /** Desene uyan ve yanında `.sha256` olan dökümler; en yeni önce. */
  recorded: string[]
  /** Desene uyan ama `.sha256`'sı olmayan dökümler: kayıt dışı, otomatik silinmez. */
  unrecorded: string[]
  /** Yarım kalmış geçici dosyalar ve dökümü olmayan `.sha256`'lar. */
  leftovers: string[]
}

function leftoverStamp(name: string, present: ReadonlySet<string>): string | null {
  const m = LEFTOVER_RE.exec(name)
  if (m) return m[1] ?? m[2] ?? null
  const orphan = SHA_RE.exec(name)
  return orphan && !present.has(name.slice(0, -SHA_SUFFIX.length)) ? orphan[1]! : null
}

export function inventory(names: readonly string[]): Inventory {
  const present = new Set(names)
  // Ad UTC damgalı ve sabit uzunlukta: sözlük sırası zaman sırası.
  const dumps = names.filter((n) => dumpStamp(n) !== null).sort().reverse()
  return {
    recorded: dumps.filter((n) => present.has(`${n}${SHA_SUFFIX}`)),
    unrecorded: dumps.filter((n) => !present.has(`${n}${SHA_SUFFIX}`)),
    leftovers: names.filter((n) => leftoverStamp(n, present) !== null).sort(),
  }
}

/**
 * Silinecek kayıtlı dökümler (her birinin `.sha256`'sı da silinir). Bu
 * koşunun dökümü her durumda kalır ve sayıya dahil; saat geri gitse ve ad
 * daha eski görünse bile. Yalnız başarılı koşudan sonra çağrılır: başarısız
 * koşuda silme, sağlam yedeği kayıpla değiştirmek olurdu. Desen dışı
 * dosyalara ve `.sha256`'sız dökümlere dokunmaz.
 */
export function planRetention(names: readonly string[], current: string, keep = BACKUP_KEEP): string[] {
  const others = inventory(names).recorded.filter((n) => n !== current)
  return others.slice(Math.max(keep - 1, 0))
}

/** Damgası `STALE_AFTER_MS`'ten eski kalıntılar. Yalnız başarılı koşunun sonunda silinir. */
export function staleLeftovers(names: readonly string[], now: number): string[] {
  const present = new Set(names)
  return names.filter((n) => {
    const stamp = leftoverStamp(n, present)
    const at = stamp === null ? null : stampTime(stamp)
    return at !== null && now - at > STALE_AFTER_MS
  })
}

// ---------------------------------------------------------------------------
// Log ve durum
// ---------------------------------------------------------------------------

/** Log satırı: yalnız meta veri. Satır verisi, parola ve bağlantı adresi yazılmaz. */
export interface LogEntry {
  at: string
  outcome: 'ok' | 'failed'
  file?: string
  bytes?: number
  sha256?: string
  durationMs?: number
  volume?: string
  pgVersion?: string | null
  deleted?: string[]
  cleaned?: string[]
  warnings?: string[]
  reason?: string
}

/** Docker ve `pg_dump` hata metinleri uzun olabiliyor; log ve çıktı için kırpılıyor. */
export const clipReason = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** Log'un son satırı; okunamıyorsa null (durum "bilinmiyor" der, uydurmaz). */
export function lastLogEntry(logText: string): LogEntry | null {
  const last = logText.split(/\r?\n/).filter((l) => l.trim() !== '').at(-1)
  if (last === undefined) return null
  try {
    const e = JSON.parse(last) as Partial<LogEntry>
    return typeof e.at === 'string' && (e.outcome === 'ok' || e.outcome === 'failed') ? (e as LogEntry) : null
  } catch {
    return null
  }
}

export function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60_000)
  if (minutes < 1) return '1 dakikadan az'
  if (minutes < 60) return `${minutes} dakika`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} saat` : `${Math.floor(hours / 24)} gün`
}

export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

export type ShaCheck = 'match' | 'mismatch' | 'unreadable'

export interface StatusInput {
  dir: string
  source: DirSetting['source']
  names: readonly string[]
  /** En yeni kayıtlı döküm ve SHA-256'sının şimdi yeniden hesaplanmış karşılaştırması. */
  newest: { name: string; bytes: number; check: ShaCheck } | null
  /** `son-basarili.json`'ın gösterdiği dosya; yoksa ya da okunamıyorsa null. */
  lastSuccessFile: string | null
  lastRun: LogEntry | null
  now: number
  /** Yerel saat gösterimi; testler sabit verebilsin. */
  formatTime: (ms: number) => string
}

/**
 * Üç kavram ayrı yazılıyor: "kayıtlı" (oluşturulurken doğrulandı), "şimdi
 * doğrulanan" (yalnız en yeni döküm, SHA-256 yeniden hesaplandı) ve geri
 * yüklenebilirlik (bu komut iddia etmiyor; kanıtı ayrı tatbikat). Hepsine
 * "doğrulanmış" demek, işaret dosyası duran ama bozulmuş bir dökümü sağlam
 * gösterirdi. Çıkış 0 yalnız en yeni kayıtlı dökümün SHA-256'sı tutuyorsa.
 */
export function statusReport(s: StatusInput): { lines: string[]; exitCode: 0 | 1 } {
  const inv = inventory(s.names)
  const lines = [`Yedek dizini     : ${s.dir} (${s.source === 'env' ? BACKUP_DIR_ENV : 'varsayılan'})`]
  const newest = s.newest && inv.recorded[0] === s.newest.name ? s.newest : null
  if (!newest) {
    lines.push('Kayıtlı yedek    : yok')
  } else {
    const at = stampTime(dumpStamp(newest.name) ?? '') ?? 0
    const verdict = {
      match: 'SHA-256 eşleşiyor',
      mismatch: 'SHA-256 EŞLEŞMİYOR, bu döküme güvenmeyin',
      unreadable: 'döküm ya da .sha256 okunamadı, bu döküme güvenmeyin',
    }[newest.check]
    lines.push(
      `Kayıtlı yedek    : ${inv.recorded.length} döküm (her biri oluşturulurken içindekiler, tam okuma ve SHA-256 ile doğrulandı)`,
      `En yeni          : ${newest.name} · ${s.formatTime(at)} · ${ageText(s.now - at)} önce · ${sizeText(newest.bytes)}`,
      `Şimdi doğrulanan : en yeni döküm, ${verdict}`,
    )
    if (inv.recorded.length > 1) lines.push(`                   diğer ${inv.recorded.length - 1} kayıtlı döküm yeniden doğrulanmadı`)
    lines.push('Geri yükleme bu komutla denenmez; geri yüklenebilirlik ayrı tatbikatla kanıtlanır.')
  }
  if (inv.unrecorded.length) {
    lines.push(`Uyarı            : .sha256'sı olmayan ${inv.unrecorded.length} döküm kayıt dışı; otomatik silinmez.`)
  }
  if (inv.leftovers.length) {
    lines.push(`Kalıntı          : ${inv.leftovers.length} geçici dosya; bir saatten eskileri sonraki başarılı yedekte silinir.`)
  }
  if (newest && s.lastSuccessFile !== newest.name) {
    lines.push(`Uyarı            : ${LAST_SUCCESS_FILE} ${s.lastSuccessFile ? `"${s.lastSuccessFile}" gösteriyor` : 'yok ya da okunamadı'}; en yeni kayıtlı döküm "${newest.name}".`)
  }
  if (s.lastRun) {
    const when = s.formatTime(Date.parse(s.lastRun.at))
    lines.push(
      s.lastRun.outcome === 'ok'
        ? `Son koşu         : başarılı · ${when}`
        : `Son koşu         : BAŞARISIZ · ${when} · ${s.lastRun.reason ?? 'neden yazılmamış'}`,
    )
  }
  return { lines, exitCode: newest?.check === 'match' ? 0 : 1 }
}
