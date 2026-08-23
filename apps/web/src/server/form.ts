import 'server-only'
import { AppError, errorText } from '@stok/shared'

/**
 * ============================================================================
 * FORM YARDIMCILARI
 *
 * Sunucu eylemleri hatayı yakalayıp adres çubuğuna `?hata=KOD` yazarak geri
 * yönlendiriyor. Neden metni değil kodu taşıyoruz: hata sözleşmesi (D-2.2)
 * "sunucu sabit kod döner, Türkçe metin istemcide üretilir" diyor ve REST
 * uçları da bu kodu döndürecek. Adres çubuğunda hazır Türkçe cümle taşımak
 * o sözleşmeyi ikiye bölerdi — ve kullanıcı adres çubuğuna istediği metni
 * yazıp ekranda gösterebilirdi.
 *
 * Ayrıntılar BEYAZ LİSTEYLE taşınıyor. `JSON.stringify(err.details)` yazmak
 * kolay olurdu ama iç alan adlarını ve bazen kimlikleri adres çubuğuna
 * dökerdi; buradaki üç alan metni anlamlı kılmak için yeterli.
 * ============================================================================
 */

const DETAIL_KEYS = ['sku', 'barcode', 'name', 'retryAfterSeconds'] as const

/**
 * Doğrulama hatasının İLK mesajı ayrıca taşınıyor. `issues` dizisini
 * olduğu gibi adres çubuğuna koymak hem çirkin hem de iç alan adlarını
 * dökerdi; tek satırlık mesaj kullanıcıya hangi alanın yanlış olduğunu
 * söylemeye yetiyor.
 */
const ISSUE_PARAM = 'sorun'

export type FormParams = Record<string, string | undefined>

/** `AppError`'ı `hata=KOD&sku=...` biçimli sorgu dizesine çevirir. */
export function errorQuery(err: unknown): string {
  const search = new URLSearchParams()
  if (err instanceof AppError) {
    search.set('hata', err.code)
    for (const key of DETAIL_KEYS) {
      const value = err.details[key]
      if (typeof value === 'string' || typeof value === 'number') {
        search.set(key, String(value))
      }
    }
    const issues = err.details.issues
    if (Array.isArray(issues)) {
      const first = issues.find(
        (i): i is { message: string } =>
          typeof i === 'object' && i !== null && typeof (i as { message?: unknown }).message === 'string',
      )
      if (first) search.set(ISSUE_PARAM, first.message.slice(0, 200))
    }
  } else {
    // Beklenmeyen hata: ayrıntı LOG'A, kullanıcıya genel kod. `err.message`
    // adres çubuğuna konsaydı SQL parçaları ve dosya yolları sızardı.
    console.error('[form]', err)
    search.set('hata', 'SERVER_ERROR')
  }
  return search.toString()
}

/** Sorgu parametrelerinden gösterilecek Türkçe metni üretir. */
export function messageFrom(params: FormParams): string | null {
  if (!params.hata) return null
  const details: Record<string, unknown> = {}
  for (const key of DETAIL_KEYS) {
    if (params[key] !== undefined) details[key] = params[key]
  }
  if (params.retryAfterSeconds) details.retryAfterSeconds = Number(params.retryAfterSeconds)
  if (params[ISSUE_PARAM]) details.issues = [{ message: params[ISSUE_PARAM] }]
  return errorText(params.hata, details)
}

/**
 * Zorunlu metin alanı. Boşsa boş dizeyi geçiriyoruz, `undefined` değil:
 * zod'un "gerekli" hatası, bizim uyduracağımız bir mesajdan daha doğru
 * ve tek yerde tanımlı.
 */
export function text(form: FormData, key: string): string {
  return String(form.get(key) ?? '')
}

/** Opsiyonel metin: boş alan "girilmedi" demek. */
export function optionalText(form: FormData, key: string): string | undefined {
  const value = String(form.get(key) ?? '').trim()
  return value === '' ? undefined : value
}

/**
 * Güncelleme formunda boş alan "girilmedi" değil "TEMİZLE" demek.
 * İkisini ayırmazsak bir kez girilen alış fiyatı bir daha boşaltılamaz.
 */
export function nullableText(form: FormData, key: string): string | null {
  return optionalText(form, key) ?? null
}

/**
 * Sayı alanı. Virgül noktaya çevriliyor: Türkçe klavyede ondalık ayırıcı
 * virgül ve kullanıcı "3,5" yazdığında bunu reddetmek anlamsız bir engel.
 * Sayıya çevrilemeyen metin `NaN` olarak geçiyor ve zod reddediyor —
 * burada sessizce 0'a çevirmek, kullanıcının yazdığından farklı bir değeri
 * kaydetmek olurdu.
 */
export function optionalNumber(form: FormData, key: string): number | undefined {
  const raw = optionalText(form, key)
  return raw === undefined ? undefined : Number(raw.replace(',', '.'))
}

export function nullableNumber(form: FormData, key: string): number | null {
  return optionalNumber(form, key) ?? null
}

export function numberOr(form: FormData, key: string, fallback: number): number {
  return optionalNumber(form, key) ?? fallback
}
