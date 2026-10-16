import { spawn } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isCliEntry } from './cli-entry'

/**
 * ============================================================================
 * CLI GİRİŞ KONTROLÜ — `db:backup`, `db:backup --status`, `db:reset` (T196)
 *
 * İki CLI testlerin içe aktarabilmesi için modül; `main` yalnız dosya
 * doğrudan çalıştırılınca koşuyor. Eski kontrol `resolve(process.argv[1])`'i
 * `import.meta.url` ile karşılaştırıyordu. Node ana modülün yolunu realpath
 * ile çözüyor, `argv[1]`'i çözmüyor: yol bir junction ya da symlink içerince
 * kontrol yanlış dönüyor, komut hiçbir şey yapmadan 0 ile çıkıyordu. Yedekte
 * bu, "yedek var" yanılgısının sessiz biçimi (S20). Uzantısız çağrı da aynı
 * sonucu veriyordu: tsx `src/backup`'ı `backup.ts`'e çözüyor, `argv[1]`
 * uzantısız kalıyor.
 *
 * Komutların hiçbiri Docker'a ya da veritabanına gitmiyor: `--status` boş
 * geçici dizini okuyor, bilinmeyen seçenek ve argümansız reset yalnız mesaj
 * basıyor. Yine de `DOCKER_HOST` uzak görünüyor ve compose projesi var
 * olmayan bir ad: bir gerileme komutu daha ileri götürse yerel olmayan uç
 * diye reddedilir.
 *
 * Bağlantı (Windows'ta junction, başka yerde symlink) repo kaynağını
 * gösteriyor. Yalnız bağlantı olarak kaldırılıyor; kaldırılamazsa geçici
 * dizin yinelemeli silinmiyor, çünkü yinelemeli silme hedefe inebilirdi.
 * ============================================================================
 */

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = fileURLToPath(new URL('.', import.meta.url))
const PROBE_MARK = 'yalnız içe aktarıldı'
const VIAS = ['gerçek yol', 'bağlantı', 'uzantısız bağlantı'] as const

let work: string | undefined
let link: string | undefined
let emptyDir: string

const isLink = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true

/** Yalnız bağlantıyı kaldırır; Windows junction'ı `unlink`'le gitmezse yinelemesiz `rmdir`. */
function removeLink(path: string): void {
  if (!isLink(path)) return
  try {
    unlinkSync(path)
  } catch {
    rmdirSync(path)
  }
}

/** CLI'ın çağrılacak yolu. Uzantısız yolu tsx `.ts`'e çözüyor, `argv[1]` uzantısız kalıyor. */
function cliPath(via: (typeof VIAS)[number], name: 'backup' | 'db-reset'): string {
  if (via === 'gerçek yol') return join(SRC_DIR, `${name}.ts`)
  return via === 'bağlantı' ? join(link!, `${name}.ts`) : join(link!, name)
}

function run(args: string[]) {
  return new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
      cwd: PACKAGE_DIR,
      env: {
        ...process.env,
        STOK_BACKUP_DIR: emptyDir,
        DOCKER_HOST: 'tcp://127.0.0.1:1',
        COMPOSE_PROJECT_NAME: 'stok_test_cli_yok',
      },
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      output += d
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      output += d
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    child.on('error', reject)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, output })
    })
  })
}

describe('CLI giriş kontrolü: junction/symlink ve uzantısız yoldan da çalışır (T196)', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'stok-cli-'))
    emptyDir = join(work, 'bos')
    mkdirSync(emptyDir)
    link = join(work, 'src-baglanti')
    symlinkSync(SRC_DIR, link, process.platform === 'win32' ? 'junction' : 'dir')
    // Ön koşul: bağlantı gerçekten bağlantı ve kaynağı gösteriyor.
    if (!isLink(link) || realpathSync(link) !== realpathSync(SRC_DIR)) {
      throw new Error(`Bağlantı kurulamadı: ${link}`)
    }
    writeFileSync(
      join(work, 'ice-aktar.mjs'),
      [
        `await import(${JSON.stringify(pathToFileURL(join(SRC_DIR, 'backup.ts')).href)})`,
        `await import(${JSON.stringify(pathToFileURL(join(SRC_DIR, 'db-reset.ts')).href)})`,
        `console.log(${JSON.stringify(PROBE_MARK)})`,
      ].join('\n'),
    )
  })

  afterAll(() => {
    if (link) removeLink(link)
    if (work && link && !isLink(link)) rmSync(work, { recursive: true, force: true })
  })

  it.each(VIAS)('%s: backup --status boş dizini okur, çıkış 1', async (via) => {
    const { status, output } = await run([cliPath(via, 'backup'), '--status'])
    expect(status, output).toBe(1)
    expect(output).toContain('Kayıtlı yedek    : yok')
    expect(readdirSync(emptyDir)).toEqual([])
  }, 60_000)

  it.each(VIAS)('%s: backup bilinmeyen seçeneği reddeder, çıkış 1', async (via) => {
    const { status, output } = await run([cliPath(via, 'backup'), '--bilinmeyen'])
    expect(status, output).toBe(1)
    expect(output).toContain('✗ Bilinmeyen seçenek: --bilinmeyen')
  }, 60_000)

  it.each(VIAS)('%s: db-reset argümansız kullanım basar, çıkış 1', async (via) => {
    const { status, output } = await run([cliPath(via, 'db-reset')])
    expect(status, output).toBe(1)
    expect(output).toContain('Kullanım:')
  }, 60_000)

  it('içe aktarmak CLI başlatmaz: çıktı yalnız işaret, çıkış 0, dizin boş', async () => {
    // CLI'a benzeyen argüman da verilse `main` koşmamalı.
    const { status, output } = await run([join(work!, 'ice-aktar.mjs'), '--status'])
    expect(status, output).toBe(0)
    expect(output.trim()).toBe(PROBE_MARK)
    expect(readdirSync(emptyDir)).toEqual([])
  }, 60_000)

  describe('isCliEntry', () => {
    const file = (dir: string) => join(dir, 'backup.ts')
    const url = (dir: string) => pathToFileURL(file(dir)).href

    it('Node ana modülü çözer, argv[1]\'i çözmez: bağlantılı argv[1] de giriş', () => {
      expect(isCliEntry(url(SRC_DIR), file(SRC_DIR))).toBe(true)
      expect(isCliEntry(url(SRC_DIR), file(link!))).toBe(true)
    })

    it('--preserve-symlinks-main: modül de bağlantı yolunda kalır, yine giriş', () => {
      expect(isCliEntry(url(link!), file(link!))).toBe(true)
    })

    it('uzantısız argv[1]: tsx modülü uzantıyla çözüyor, yine giriş', () => {
      expect(isCliEntry(url(SRC_DIR), join(SRC_DIR, 'backup'))).toBe(true)
      expect(isCliEntry(url(SRC_DIR), join(link!, 'backup'))).toBe(true)
    })

    it('var olan uzantısız dosya başka bir ana modül: uzantı eklenmez', () => {
      // Geçici dizinde `x` (ana modül) ve `x.ts` (onun içe aktardığı modül) yan yana.
      const main = join(work!, 'x')
      writeFileSync(main, '')
      writeFileSync(`${main}.ts`, '')
      expect(isCliEntry(pathToFileURL(`${main}.ts`).href, main)).toBe(false)
    })

    it('başka dosya, olmayan yol ve argv[1] yokluğu giriş değil; hata fırlatmaz', () => {
      expect(isCliEntry(url(SRC_DIR), join(SRC_DIR, 'db-reset.ts'))).toBe(false)
      expect(isCliEntry(url(SRC_DIR), join(SRC_DIR, 'olmayan.ts'))).toBe(false)
      expect(isCliEntry(url(SRC_DIR), undefined)).toBe(false)
      expect(isCliEntry(url(SRC_DIR), '')).toBe(false)
      // Modül tarafı dosya değilse de (ör. paketlenmiş kod) içe aktaran hata almaz.
      expect(isCliEntry('node:fs', file(SRC_DIR))).toBe(false)
    })
  })
})
