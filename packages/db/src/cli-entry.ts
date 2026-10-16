import { realpathSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ============================================================================
 * CLI GİRİŞ KONTROLÜ — `backup.ts` VE `db-reset.ts` İÇİN ORTAK (T196)
 *
 * İki CLI testlerin içe aktarabilmesi için modül; `main` yalnız dosya
 * doğrudan çalıştırılınca koşmalı. Bu kontrol yanlış "hayır" derse komut
 * hiçbir şey yapmadan 0 ile çıkar: yedekte "yedek var" yanılgısı (S20),
 * reset'te `db:reset && …` zincirinin sıfırlandığını sanması.
 *
 * Node ana modülün yolunu JS `fs.realpathSync` ile çözüyor (`import.meta.url`),
 * `process.argv[1]`'i çözmüyor. Eski karşılaştırma (`resolve(argv[1])` ile
 * `import.meta.url`) yol bir junction ya da symlink içerince yanlış dönüyordu.
 * Bu yüzden iki taraf aynı fonksiyonla çözülüyor:
 *   - Yalnız `argv[1]`'i çözmek `--preserve-symlinks-main` ile yanlış döner;
 *     Node o zaman ana modülü çözmüyor.
 *   - JS `realpathSync`, `.native` değil: Node ana modülü bununla çözüyor,
 *     iki taraf aynı kuralla çözülsün. `.native` Windows'ta büyük/küçük harfi
 *     ve 8.3 kısa adı da kanonikleştiriyor; yalnız `argv[1]` tarafında
 *     kullanılınca küçük harfle ya da kısa adla girilen yolda yanlış döndü.
 * Ölçüm (2026-10-16, Node 24.20, tsx 4.23.12): gerçek yol, junction, küçük
 * harf, 8.3 kısa ad, tsx CLI ve `--preserve-symlinks-main` altında yalnız bu
 * biçim her durumda doğru.
 *
 * tsx uzantısız yolu da çalıştırıyor (`tsx src/backup` → `backup.ts`), ama
 * `argv[1]` uzantısız kalıyor (ölçüldü). Bu yüzden `argv[1]` yoksa modülün
 * kendi uzantısı eklenip yeniden deneniyor. Uzantı yalnız `argv[1]` yokken
 * ekleniyor: var olan uzantısız bir dosya başka bir ana modüldür.
 *
 * Çözülemeyen yol "ana modül değil" sayılıyor: `argv[1]` bu dosya değil
 * demek (ör. `node -e`). İçe aktaran araç hata almamalı.
 * ============================================================================
 */
export function isCliEntry(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false
  try {
    const self = realpathSync(fileURLToPath(moduleUrl))
    return (realOrNull(argv1) ?? realOrNull(argv1 + extname(self))) === self
  } catch {
    return false
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
