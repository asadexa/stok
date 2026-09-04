import 'server-only'
import { AppError, ERROR_CODES, type ErrorCode, errorText } from '@stok/shared'

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

/**
 * Adres çubuğuna TAŞINMAYAN ayrıntılar.
 *
 * Liste ters çevrildi: eskiden taşınacak alanların beyaz listesi vardı ve
 * eksikti — "Elde undefined adet var, undefined adet çıkışı yapılamaz"
 * mesajı tarayıcı testinde böyle yakalandı. Beyaz liste her yeni hata
 * kodunda güncellenmeyi unutulacak bir yer; unutulduğunda da hata
 * vermiyor, kullanıcıya "undefined" gösteriyor.
 *
 * Artık her sayı/metin/bayrak taşınıyor, bunlar HARİÇ:
 *   - kimlikler: adres çubuğunu okunmaz yapıyor ve metinde kullanılmıyor
 *   - `issues`: dizi; ilk mesajı ayrıca `sorun` parametresiyle gidiyor
 */
const HIDDEN_DETAIL_KEYS = new Set([
  'userId',
  'productId',
  'tenantId',
  'barcodeId',
  'jobId',
  'permission',
  'issues',
])

/**
 * Doğrulama hatasının İLK mesajı ayrıca taşınıyor. `issues` dizisini
 * olduğu gibi adres çubuğuna koymak hem çirkin hem de iç alan adlarını
 * dökerdi; tek satırlık mesaj kullanıcıya hangi alanın yanlış olduğunu
 * söylemeye yetiyor.
 */
const ISSUE_PARAM = 'sorun'

/**
 * `messageFrom`'un OKUDUĞU parametreler — hepsi bu kadar.
 *
 * Index imzalı gevşek bir tip (`Record<string, string | undefined>`)
 * kullanılmıyor: sayfalar kendi parametrelerini açıkça tanımlıyor ve
 * index imzasız bir arayüz index imzalı bir tipe atanamaz. Okunan
 * anahtarları tek tek saymak hem derleyiciyi memnun ediyor hem de bu
 * fonksiyonun sözleşmesini görünür kılıyor.
 *
 * Sayfalar kendi arayüzlerini bunu genişleterek tanımlıyor.
 */
export interface FormParams {
  hata?: string
  sorun?: string
  /**
   * Hata ayrıntıları adres çubuğunda serbest anahtarlarla taşınıyor
   * (`available`, `requested`, `limit`, `sku`, …). Sayfalar kendi bildikleri
   * alanları bu arayüzü genişleterek tanımlıyor; `messageFrom` hepsini
   * okuyor ve metin üreticisine veriyor.
   */
  [key: string]: string | undefined
}

/**
 * Next'in `redirect()` ve `notFound()` fonksiyonları AKIŞ KONTROLÜ için
 * fırlatıyor — hata değiller.
 *
 * `try { ...; redirect(ok) } catch (err) { redirect(hata) }` yazıldığında
 * başarı yönlendirmesi kendi catch'ine düşüyor ve kullanıcı "beklenmeyen
 * hata" görüyor. İşin en kötü hâli: iş GERÇEKTEN yapılmış oluyor (rapor
 * kuyruğa girmiş, kayıt yazılmış) ama ekran başarısız diyor — kullanıcı
 * tekrar deniyor ve mükerrer kayıt oluşuyor.
 *
 * Doğru çözüm yönlendirmeyi `try` dışına almak ve kod öyle yazılıyor; bu
 * kontrol ikinci savunma hattı: aynı hata tekrar yazılırsa sessizce yanlış
 * davranmak yerine yönlendirme çalışmaya devam ediyor.
 */
function rethrowControlFlow(err: unknown): void {
  const digest = (err as { digest?: unknown } | null)?.digest
  if (typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND')) {
    throw err
  }
}


/**
 * SUNUCU KUSURU OLAN HATALARI LOGA YAZAR.
 *
 * `AppError` yakalanıp bir yönlendirmeye çevrildiğinde, sunucu günlüğünde
 * HİÇBİR İZ KALMIYORDU. Kullanıcı ekranda "Beklenmeyen bir hata oluştu"
 * görüyor, operatör terminalde sadece `POST /giris 303` görüyor ve elinde
 * teşhise götüren tek satır bile olmuyor.
 *
 * Kullanıcı testinde bu tam olarak yaşandı: eksik bir `AUTH_SECRET`'in
 * teşhisi, hatayı fırlatan satırın kaynak kodda elle bulunmasını
 * gerektirdi — oysa `AppError`'ın mesajı ne yapılacağını zaten yazıyordu.
 *
 * SADECE 5xx yazılıyor. "Parola hatalı" veya "elde yeterli stok yok"
 * kullanıcının yaptığı bir şey, sunucunun kusuru değil; onları loga
 * yazmak günlüğü gürültüye boğar ve gerçek arızayı görünmez kılar.
 */
export function logServerFault(scope: string, err: unknown): void {
  if (!(err instanceof AppError)) return
  const http = ERROR_CODES[err.code as ErrorCode]?.http ?? 500
  if (http < 500) return
  console.error(`[${scope}] ${err.code}: ${err.message}`, err.details)
}

/**
 * ============================================================================
 * HATA DÖNÜŞÜNDE FORMU GERİ DOLDURMA
 *
 * Sunucu eylemi hata verdiğinde yönlendirme yapıyoruz ve form YENİDEN
 * kuruluyor; taşınmayan her alan varsayılanına döner.
 *
 * BU SESSİZ BİR YANLIŞ KAYIT ÜRETİR. Tarayıcı testinde yaşandı: kullanıcı
 * miktara 5 yazıyor, "birim fiyat zorunlu" hatası alıyor, fiyatı dolduruyor
 * ve kaydediyor — ama miktar bu arada varsayılana (1) dönmüş oluyor. İkinci
 * gönderim BAŞARILI olduğu için hiçbir uyarı çıkmıyor; depoda farkı sayım
 * gününe kadar kimse görmüyor.
 *
 * Alanları tek tek elle taşımak yerine bu yardımcı var: yeni bir alan
 * eklendiğinde listeye yazılması unutulursa aynı hata sessizce geri gelir.
 *
 * Boş alanlar taşınmıyor — sorgu dizesini `miktar=&not=&fiyat=` diye
 * şişirmenin faydası yok. `keepEmpty` ile istisna yapılabiliyor: gerçekten
 * boş gönderilmiş bir alanın boş kalması gerekiyorsa.
 * ============================================================================
 */
export function preserveFields(
  form: FormData,
  fields: readonly string[],
  extra: Record<string, string | undefined> = {},
): URLSearchParams {
  const search = new URLSearchParams()
  for (const name of fields) {
    const value = String(form.get(name) ?? '').trim()
    if (value !== '') search.set(name, value)
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') search.set(key, value)
  }
  return search
}

/** `AppError`'ı `hata=KOD&sku=...` biçimli sorgu dizesine çevirir. */
export function errorQuery(err: unknown): string {
  rethrowControlFlow(err)
  const search = new URLSearchParams()
  if (err instanceof AppError) {
    logServerFault('form', err)
    search.set('hata', err.code)
    for (const [key, value] of Object.entries(err.details)) {
      if (HIDDEN_DETAIL_KEYS.has(key)) continue
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
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
  // Metin üreticileri sayı bekleyen alanlara sayı, metin bekleyenlere metin
  // görmeli. Adres çubuğundan her şey metin geliyor; sayıya çevrilebilenler
  // çevriliyor — "Elde 3 adet" ile "Elde \"3\" adet" arasındaki fark.
  const details: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || key === 'hata' || key === ISSUE_PARAM) continue
    const asNumber = Number(value)
    details[key] = value !== '' && Number.isFinite(asNumber) ? asNumber : value
  }
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
