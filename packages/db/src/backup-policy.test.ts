import { describe, expect, it } from 'vitest'
import {
  BACKUP_KEEP,
  REQUIRED_TOC_TABLES,
  STALE_AFTER_MS,
  type StatusInput,
  backupDirSetting,
  backupStamp,
  dumpCommand,
  dumpName,
  dumpStamp,
  evaluateToc,
  fullReadCommand,
  inventory,
  isWithin,
  lastLogEntry,
  parseBackupArgs,
  parseShaLine,
  planRetention,
  refuseRawDir,
  refuseResolvedDir,
  relocationNote,
  shaLine,
  staleLeftovers,
  stampTime,
  statusReport,
  syncRootsFromEnv,
  tocCommand,
} from './backup-policy'
import { APP_TABLES } from './wipe-guard'

/**
 * WS-1.3a — yedek kuralları, Docker ve dosya sistemi olmadan. Windows yolları
 * `path.win32` ile sınanıyor; Linux CI'da da koşuyorlar.
 */

const HEX = 'a'.repeat(64)
const stampAt = (iso: string) => backupStamp(new Date(iso))
const dumpAt = (iso: string) => dumpName(stampAt(iso))

describe('parseBackupArgs', () => {
  it.each<[string[], string]>([
    [[], 'backup'],
    [['--'], 'backup'],
    [['--status'], 'status'],
    [['--', '--status'], 'status'],
    [['--yes'], 'error'],
    [['--status', '--dry-run'], 'error'],
  ])('%j → %s', (argv, mode) => {
    expect(parseBackupArgs(argv).mode).toBe(mode)
  })
})

describe('damga ve ad', () => {
  it('UTC, sabit uzunluk, gidiş-dönüş', () => {
    const at = new Date('2026-10-16T09:30:15.987Z')
    expect(backupStamp(at)).toBe('20261016-093015Z')
    expect(stampTime('20261016-093015Z')).toBe(Date.parse('2026-10-16T09:30:15Z'))
    expect(dumpName('20261016-093015Z')).toBe('stok-20261016-093015Z.dump')
  })

  it('ad sırası zaman sırası', () => {
    const times = ['2026-01-02T00:00:00Z', '2025-12-31T23:59:59Z', '2026-01-01T10:00:00Z']
    const sorted = times.map(dumpAt).sort()
    expect(sorted).toEqual([...times].sort().map(dumpAt))
  })

  it.each([
    'stok-20261316-093015Z.dump',
    'stok-20261016-093015.dump',
    'stok-20261016-093015Z.dump.partial',
    'stok-20261016-093015Z.dump.sha256',
    'baska-20261016-093015Z.dump',
    'STOK-20261016-093015Z.dump',
  ])('desen dışı ya da geçersiz: %s', (name) => {
    expect(dumpStamp(name)).toBeNull()
  })
})

describe('dizin ayarı', () => {
  it('STOK_BACKUP_DIR önce gelir; boş değer de "tanımlı" sayılır', () => {
    expect(backupDirSetting({ STOK_BACKUP_DIR: 'D:\\yedek', LOCALAPPDATA: 'C:\\L' }, 'win32')).toEqual({
      raw: 'D:\\yedek',
      source: 'env',
    })
    expect(backupDirSetting({ STOK_BACKUP_DIR: '' }, 'win32')).toEqual({ raw: '', source: 'env' })
  })

  it('Windows varsayılanı %LOCALAPPDATA%\\stok\\yedek; başka platformda varsayılan yok', () => {
    expect(backupDirSetting({ LOCALAPPDATA: 'C:\\Users\\k\\AppData\\Local' }, 'win32')).toEqual({
      raw: 'C:\\Users\\k\\AppData\\Local\\stok\\yedek',
      source: 'default',
    })
    expect(backupDirSetting({}, 'win32')).toBeNull()
    expect(backupDirSetting({ LOCALAPPDATA: '/x' }, 'linux')).toBeNull()
  })

  it('OneDrive kökleri ortamdan; boş olanlar atlanır', () => {
    expect(syncRootsFromEnv({ OneDrive: 'C:\\O', OneDriveConsumer: '', OneDriveCommercial: 'C:\\İş' })).toEqual([
      'C:\\O',
      'C:\\İş',
    ])
  })
})

describe('refuseRawDir (sözdizimi, dosya sistemine dokunmadan)', () => {
  it.each<[string, string | null]>([
    ['C:\\Users\\k\\AppData\\Local\\stok\\yedek', null],
    ['D:/yedek', null],
    ['', 'empty'],
    ['   ', 'empty'],
    ['yedek', 'relative'],
    ['.\\yedek', 'relative'],
    ['\\yedek', 'relative'],
    ['C:yedek', 'relative'],
    ['\\\\sunucu\\pay\\yedek', 'network'],
    ['\\\\?\\C:\\Users\\k\\OneDrive\\yedek', 'network'],
    ['\\\\.\\C:\\yedek', 'network'],
    ['//sunucu/pay', 'network'],
  ])('win32 %j → %s', (raw, expected) => {
    expect(refuseRawDir(raw, 'win32')).toBe(expected)
  })

  it.each<[string, string | null]>([
    ['/home/runner/work/_temp/yedek', null],
    ['', 'empty'],
    ['yedek', 'relative'],
    ['./yedek', 'relative'],
  ])('linux %j → %s', (raw, expected) => {
    expect(refuseRawDir(raw, 'linux')).toBe(expected)
  })
})

describe('refuseResolvedDir (gerçek yol)', () => {
  const win = {
    platform: 'win32' as const,
    repoRoot: 'C:\\Users\\kullanici\\OneDrive\\Masaüstü\\Projeler\\stok\\stok',
    syncRoots: ['C:\\Users\\kullanici\\OneDrive'],
  }
  it.each<[string, string | null]>([
    ['C:\\Users\\kullanici\\AppData\\Local\\stok\\yedek', null],
    ['c:\\users\\KULLANICI\\appdata\\local\\stok\\yedek', null],
    ['C:\\Users\\kullanici\\OneDrive\\Masaüstü\\Projeler\\stok\\stok', 'repo'],
    ['C:\\Users\\kullanici\\OneDrive\\Masaüstü\\Projeler\\stok\\stok\\yedek', 'repo'],
    ['c:\\USERS\\kullanici\\onedrive\\MASAÜSTÜ\\projeler\\stok\\stok\\x', 'repo'],
    ['C:\\Users\\kullanici\\OneDrive\\yedek', 'sync'],
    ['C:\\Users\\kullanici\\OneDrive\\Masaüstü\\yedek', 'sync'],
    // NFD yazılmış "Masaüstü" (u + birleşen iki nokta): NFC olmasa repo içi
    // değil yalnız OneDrive altı sayılırdı.
    ['C:\\Users\\kullanici\\OneDrive\\Masau\u0308stu\u0308\\Projeler\\stok\\stok\\yedek', 'repo'],
    ['C:\\Users\\kullanici\\OneDriveYedek\\x', null],
    ['C:\\Users\\kullanici\\OneDrive2', null],
    ['D:\\Users\\kullanici\\OneDrive\\yedek', null],
    ['\\\\nas\\pay\\yedek', 'network'],
  ])('win32 %j → %s', (real, expected) => {
    expect(refuseResolvedDir(real, win)).toBe(expected)
  })

  const linux = { platform: 'linux' as const, repoRoot: '/home/runner/work/stok/stok', syncRoots: [] }
  it.each<[string, string | null]>([
    ['/home/runner/work/_temp/yedek', null],
    ['/home/runner/work/stok/stok/yedek', 'repo'],
    ['/home/runner/work/stok/stok-yedek', null],
    // posix büyük/küçük harf duyarlı
    ['/HOME/runner/work/stok/stok/yedek', null],
  ])('linux %j → %s', (real, expected) => {
    expect(refuseResolvedDir(real, linux)).toBe(expected)
  })

  it('relocationNote: aynı yol sessiz; paketli uygulama yönlendirmesi ve junction söylenir', () => {
    const intended = 'C:\\Users\\kullanici\\AppData\\Local\\stok\\yedek'
    expect(relocationNote(intended, 'c:\\users\\kullanici\\appdata\\local\\stok\\yedek', 'win32')).toBeNull()
    const packaged = 'C:\\Users\\kullanici\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Local\\stok\\yedek'
    expect(relocationNote(intended, packaged, 'win32')).toMatch(/paketli bir uygulamanın özel klasörüne yönlendi; uygulama kaldırılınca silinir/)
    expect(relocationNote(intended, 'D:\\yedek', 'win32')).toMatch(/başka bir konuma çözüldü/)
    expect(relocationNote('/tmp/yedek', '/tmp/yedek', 'linux')).toBeNull()
  })

  it('isWithin: ".." ile başlayan ad üst dizin sayılmaz', () => {
    expect(isWithin('C:\\a', 'C:\\a\\..b', 'win32')).toBe(true)
    expect(isWithin('C:\\a\\b', 'C:\\a', 'win32')).toBe(false)
  })
})

describe('Docker komutları', () => {
  it('döküm R-1 çağrısı; TTY yok', () => {
    const args = dumpCommand('kimlik')
    expect(args).toEqual(['exec', 'kimlik', 'pg_dump', '--format=custom', '--username=postgres', '--dbname=stok'])
    expect(args.some((a) => a === '-t' || a === '--tty' || a === '-it')).toBe(false)
  })

  it('doğrulama hiçbir veritabanına bağlanmaz: -d/--dbname yok, arşiv stdin\'den', () => {
    for (const args of [tocCommand('kimlik'), fullReadCommand('kimlik')]) {
      expect(args.slice(0, 3)).toEqual(['exec', '-i', 'kimlik'])
      expect(args[3]).toBe('pg_restore')
      expect(args.some((a) => a === '-d' || a.startsWith('--dbname') || a === '-t' || a === '--tty')).toBe(false)
    }
    expect(tocCommand('k')).toContain('--list')
    expect(fullReadCommand('k')).toContain('--file=/dev/null')
  })
})

describe('evaluateToc', () => {
  // `pg_restore --list` biçimi (M1'de PostgreSQL 17.11'in gerçek çıktısıyla karşılaştırıldı).
  const listing = (tables: readonly string[], opts: { dbname?: string; data?: boolean } = {}) =>
    [
      ';',
      '; Archive created at 2026-10-16 09:30:15 UTC',
      `;     dbname: ${opts.dbname ?? 'stok'}`,
      ';     TOC Entries: 213',
      ';     Format: CUSTOM',
      ';     Dumped from database version: 17.11',
      ';     Dumped by pg_dump version: 17.11',
      ';',
      '; Selected TOC Entries:',
      ';',
      '5; 2615 2200 SCHEMA - public pg_database_owner',
      ...tables.map((t, i) => `${220 + i}; 1259 ${16_386 + i} TABLE public ${t} postgres`),
      ...(opts.data === false ? [] : tables.map((t, i) => `${3500 + i}; 0 ${16_386 + i} TABLE DATA public ${t} postgres`)),
    ].join('\n')

  it('temel tabloların TABLE ve TABLE DATA girdileri varsa geçer, sürümü okur', () => {
    expect(evaluateToc(listing(REQUIRED_TOC_TABLES))).toEqual({ ok: true, pgVersion: '17.11' })
    expect(evaluateToc(listing([...REQUIRED_TOC_TABLES, 'locations']).replaceAll('\n', '\r\n'))).toMatchObject({ ok: true })
  })

  it('bir tablo eksikse reddeder ve adını söyler', () => {
    const result = evaluateToc(listing(REQUIRED_TOC_TABLES.filter((t) => t !== 'stock_movements')))
    expect(result).toEqual({
      ok: false,
      reason: 'eksik girdi: TABLE public.stock_movements, TABLE DATA public.stock_movements',
    })
  })

  it('yalnız TABLE girdileri (veri yok) reddedilir', () => {
    expect(evaluateToc(listing(REQUIRED_TOC_TABLES, { data: false })).ok).toBe(false)
  })

  it('başka veritabanının arşivi ya da başlıksız çıktı reddedilir', () => {
    expect(evaluateToc(listing(REQUIRED_TOC_TABLES, { dbname: 'postgres' }))).toMatchObject({ ok: false })
    expect(evaluateToc('')).toMatchObject({ ok: false })
  })

  it('aranan tablolar APP_TABLES\'ın alt kümesi', () => {
    for (const t of REQUIRED_TOC_TABLES) expect(APP_TABLES).toContain(t)
  })
})

describe('.sha256 satırı', () => {
  it('sha256sum biçimi gidiş-dönüş; ad ve biçim sıkı', () => {
    const name = dumpAt('2026-10-16T09:30:15Z')
    expect(shaLine(HEX, name)).toBe(`${HEX}  ${name}\n`)
    expect(parseShaLine(shaLine(HEX, name), name)).toBe(HEX)
    expect(parseShaLine(`${HEX}  ${name}\r\n`, name)).toBe(HEX)
    expect(parseShaLine(shaLine(HEX, name), 'stok-20200101-000000Z.dump')).toBeNull()
    expect(parseShaLine(`${HEX.toUpperCase()}  ${name}\n`, name)).toBeNull()
    expect(parseShaLine(`${HEX} ${name}\n`, name)).toBeNull()
  })
})

describe('saklama (planRetention)', () => {
  const recorded = (isos: string[]) => isos.flatMap((iso) => [dumpAt(iso), `${dumpAt(iso)}.sha256`])
  const hours = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1, i)).toISOString())

  it('16 kayıtlı dökümde (bu koşu dahil) en eski 2 silinir; toplam 14 kalır', () => {
    const old = hours(15)
    const current = dumpAt('2026-10-16T09:30:15Z')
    const names = [...recorded(old), current, `${current}.sha256`]
    const deleted = planRetention(names, current)
    expect(deleted).toEqual([dumpAt(old[1]!), dumpAt(old[0]!)])
    expect(BACKUP_KEEP).toBe(14)
  })

  it('bu koşunun dökümü, adı en eski görünse bile (saat geri gitti) korunur', () => {
    const current = dumpAt('2025-01-01T00:00:00Z')
    const names = [...recorded(hours(15)), current, `${current}.sha256`]
    const deleted = planRetention(names, current)
    expect(deleted).not.toContain(current)
    expect(deleted).toHaveLength(2)
  })

  it('yabancı dosyalara, .sha256\'sız dökümlere ve kalıntılara dokunmaz', () => {
    const current = dumpAt('2026-10-16T09:30:15Z')
    const unrecorded = dumpAt('2020-01-01T00:00:00Z')
    const names = [
      ...recorded(hours(20)),
      current,
      `${current}.sha256`,
      unrecorded,
      'notlar.txt',
      'stok-20200101-000000Z.dump.partial',
      'yedek-gunlugu.jsonl',
    ]
    const deleted = planRetention(names, current)
    expect(deleted).toHaveLength(7)
    for (const d of deleted) expect(dumpStamp(d)).not.toBeNull()
    expect(deleted).not.toContain(unrecorded)
  })

  it('14 ve altında hiçbir şey silinmez', () => {
    const current = dumpAt('2026-10-16T09:30:15Z')
    expect(planRetention([...recorded(hours(13)), current, `${current}.sha256`], current)).toEqual([])
  })
})

describe('kalıntılar (staleLeftovers)', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  const ago = (ms: number) => backupStamp(new Date(now - ms))
  it.each<[string, boolean]>([
    [`stok-${ago(STALE_AFTER_MS + 1000)}.dump.partial`, true],
    [`stok-${ago(STALE_AFTER_MS - 60_000)}.dump.partial`, false],
    [`stok-${ago(2 * STALE_AFTER_MS)}.dump.sha256.partial`, true],
    [`son-basarili.json.${ago(2 * STALE_AFTER_MS)}.partial`, true],
    // dökümü olmayan .sha256 (yetim)
    [`stok-${ago(2 * STALE_AFTER_MS)}.dump.sha256`, true],
    ['stok-20261316-000000Z.dump.partial', false],
    ['baska.partial', false],
  ])('%s → %s', (name, stale) => {
    expect(staleLeftovers([name], now)).toEqual(stale ? [name] : [])
  })

  it('dökümü duran .sha256 kalıntı değil', () => {
    const d = `stok-${ago(2 * STALE_AFTER_MS)}.dump`
    expect(staleLeftovers([d, `${d}.sha256`], now)).toEqual([])
  })
})

describe('durum (statusReport)', () => {
  const newestName = dumpAt('2026-10-16T09:00:00Z')
  const olderName = dumpAt('2026-10-15T09:00:00Z')
  const names = [newestName, `${newestName}.sha256`, olderName, `${olderName}.sha256`]
  const base: StatusInput = {
    dir: 'C:\\L\\stok\\yedek',
    source: 'default',
    names,
    newest: { name: newestName, bytes: 4_404_019, check: 'match' },
    lastSuccessFile: newestName,
    lastRun: { at: '2026-10-16T09:00:05.000Z', outcome: 'ok' },
    now: Date.parse('2026-10-16T11:00:00Z'),
    formatTime: (ms) => new Date(ms).toISOString(),
  }
  const text = (s: StatusInput) => statusReport(s).lines.join('\n')

  it('kayıtlı, şimdi doğrulanan ve yeniden doğrulanmayan ayrı yazılır; eşleşince çıkış 0', () => {
    const report = statusReport(base)
    expect(report.exitCode).toBe(0)
    const out = report.lines.join('\n')
    expect(out).toMatch(/Kayıtlı yedek {4}: 2 döküm \(her biri oluşturulurken/)
    expect(out).toContain(`En yeni          : ${newestName}`)
    expect(out).toContain('2 saat önce · 4,2 MB')
    expect(out).toContain('Şimdi doğrulanan : en yeni döküm, SHA-256 eşleşiyor')
    expect(out).toContain('diğer 1 kayıtlı döküm yeniden doğrulanmadı')
    expect(out).toContain('Geri yükleme bu komutla denenmez')
    expect(out).not.toMatch(/Uyarı/)
  })

  it('SHA-256 tutmazsa ya da okunamazsa çıkış 1 ve güvenme uyarısı', () => {
    for (const check of ['mismatch', 'unreadable'] as const) {
      const report = statusReport({ ...base, newest: { ...base.newest!, check } })
      expect(report.exitCode).toBe(1)
      expect(report.lines.join('\n')).toMatch(/bu döküme güvenmeyin/)
    }
  })

  it('kayıtlı döküm yoksa çıkış 1', () => {
    const report = statusReport({ ...base, names: [], newest: null, lastSuccessFile: null, lastRun: null })
    expect(report.exitCode).toBe(1)
    expect(report.lines).toContain('Kayıtlı yedek    : yok')
  })

  it('son-basarili.json uyuşmazlığı, kayıt dışı döküm, kalıntı ve başarısız son koşu görünür', () => {
    const out = text({
      ...base,
      names: [...names, dumpAt('2020-01-01T00:00:00Z'), `stok-${stampAt('2026-10-16T08:00:00Z')}.dump.partial`],
      lastSuccessFile: olderName,
      lastRun: { at: '2026-10-16T10:00:00.000Z', outcome: 'failed', reason: 'Kapsayıcı çalışmıyor' },
    })
    expect(out).toContain(`son-basarili.json "${olderName}" gösteriyor; en yeni kayıtlı döküm "${newestName}"`)
    expect(out).toContain(".sha256'sı olmayan 1 döküm kayıt dışı")
    expect(out).toContain('Kalıntı          : 1 geçici dosya')
    expect(out).toContain('Son koşu         : BAŞARISIZ · 2026-10-16T10:00:00.000Z · Kapsayıcı çalışmıyor')
  })

  it('en yeni olarak verilen döküm envanterin en yenisi değilse "şimdi doğrulanan" sayılmaz', () => {
    const report = statusReport({ ...base, newest: { name: olderName, bytes: 1, check: 'match' } })
    expect(report.exitCode).toBe(1)
  })
})

describe('log', () => {
  it('son geçerli satır okunur; bozuk satır "bilinmiyor"', () => {
    const ok = JSON.stringify({ at: '2026-10-16T09:00:00Z', outcome: 'ok', file: 'x' })
    expect(lastLogEntry(`${ok}\n`)).toMatchObject({ outcome: 'ok' })
    expect(lastLogEntry(`${ok}\n{bozuk\n`)).toBeNull()
    expect(lastLogEntry('')).toBeNull()
  })

  it('envanter kayıtlıyı en yeni önce sıralar', () => {
    const a = dumpAt('2026-01-01T00:00:00Z')
    const b = dumpAt('2026-02-01T00:00:00Z')
    expect(inventory([a, `${a}.sha256`, b, `${b}.sha256`]).recorded).toEqual([b, a])
  })
})
