/**
 * Hata sözleşmesi. TEK KAYNAK.
 *
 * PLAN.md D-2.2: sunucu SABİT bir `code` döner, kullanıcıya gösterilen Türkçe
 * metin İSTEMCİDE üretilir.
 *
 *   { "code": "INSUFFICIENT_STOCK",         // makine okur, asla değişmez
 *     "message": "qty 5 > available 3",     // İngilizce, sadece log
 *     "details": { "available": 3, "requested": 5 } }
 *
 * Sunucu Türkçe metin dönseydi metni değiştirmek için deploy gerekirdi ve
 * mobil uygulama kendi diline çeviremezdi. `message` ASLA doğrudan ekrana
 * basılmaz.
 *
 * `retryable` alanı outbox durum makinesini besler (PLAN.md Bölüm 2):
 *
 *   retryable: true   → [sending] → [pending], backoff ile tekrar dene
 *   retryable: false  → [sending] → [rejected], kullanıcıya göster
 *
 * Bu ayrımı istemcide "status >= 500 mü" diye tahmin etmek yerine burada
 * açıkça yazmak, açık olanı zekice olana tercih etme ilkesi.
 */

export type ErrorDetails = Record<string, unknown>

export interface ErrorMeta {
  http: number
  /** Outbox tekrar denemeli mi, yoksa kullanıcıya mı sormalı. */
  retryable: boolean
  /** Kullanıcıya gösterilecek Türkçe metin. */
  tr: (d: ErrorDetails) => string
}

/**
 * `validationError()` ayrıntılara `issues: [{ path, message }]` koyuyor.
 * Metin üretimi burada, çünkü hata sözleşmesi (D-2.2) Türkçe metnin tek
 * kaynağının bu dosya olduğunu söylüyor.
 */
function firstIssueMessage(details: ErrorDetails): string | undefined {
  const issues = details.issues
  if (!Array.isArray(issues)) return undefined
  for (const issue of issues) {
    if (
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as { message?: unknown }).message === 'string'
    ) {
      return (issue as { message: string }).message
    }
  }
  return undefined
}

export const ERROR_CODES = {
  // --- İş kuralı: tekrar denemek işe yaramaz, kullanıcı müdahalesi gerek ---
  BARCODE_UNKNOWN: {
    http: 404,
    retryable: false,
    tr: () => 'Bu barkod sistemde tanımlı değil',
  },
  PRODUCT_ARCHIVED: {
    http: 409,
    retryable: false,
    tr: (d) => `"${d.name ?? 'Ürün'}" arşivde, hareket yazılamaz`,
  },
  INSUFFICIENT_STOCK: {
    http: 409,
    retryable: false,
    tr: (d) => `Elde ${d.available} adet var, ${d.requested} adet çıkışı yapılamaz`,
  },
  INVALID_QUANTITY: {
    http: 400,
    retryable: false,
    tr: () => 'Miktar sıfırdan büyük bir sayı olmalı',
  },
  VALIDATION_FAILED: {
    http: 400,
    retryable: false,
    // zod mesajları ZATEN TÜRKÇE ve alana özgü ("Koli barkodunun çarpanı
    // birden büyük olmalı"). Bunu yutup "Girilen bilgilerde hata var"
    // demek, kullanıcıyı formda hangi alanın yanlış olduğunu tahmin
    // etmeye zorluyordu — üç sayı alanı olan bir formda bu, denemeyle
    // bulunacak bir bilmece.
    //
    // İLK sorunu gösteriyoruz, hepsini değil: liste hâlinde altı satır
    // hata, tek satırlık bir yönlendirmeden daha az okunur.
    tr: (d) => firstIssueMessage(d) ?? 'Girilen bilgilerde hata var',
  },
  FORBIDDEN: {
    http: 403,
    retryable: false,
    tr: () => 'Bu işlem için yetkiniz yok',
  },
  NOT_FOUND: {
    http: 404,
    retryable: false,
    tr: () => 'Kayıt bulunamadı',
  },
  SKU_EXISTS: {
    http: 409,
    retryable: false,
    // Çakışan kaydın ADI da veriliyor: "bu kod kullanımda" mesajı tek
    // başına kullanıcıyı ürünü aramaya gönderir, adı görürse zaten
    // eklemiş olduğunu anında anlar.
    tr: (d) => `"${d.sku}" stok kodu zaten kullanılıyor${d.name ? `: ${d.name}` : ''}`,
  },
  BARCODE_EXISTS: {
    http: 409,
    retryable: false,
    tr: (d) => `${d.barcode} barkodu başka bir üründe tanımlı${d.name ? `: ${d.name}` : ''}`,
  },
  LAST_BARCODE: {
    http: 409,
    retryable: false,
    // Barkodsuz ürün depoda OKUTULAMAZ, yani pratikte kaybolur. Kullanıcı
    // bunu ancak eline terminali alıp raf başında fark eder.
    tr: () => 'Ürünün son barkodu kaldırılamaz. Önce yenisini ekleyin.',
  },

  // --- Toplu içe aktarma (T23 / E1) ---
  IMPORT_NO_HEADER: {
    http: 400,
    retryable: false,
    tr: () => 'Dosyanın ilk satırında sütun başlıkları bulunamadı',
  },
  IMPORT_MISSING_COLUMN: {
    http: 400,
    retryable: false,
    // Bulunan başlıklar metinde: kullanıcı sütunu yanlış adlandırmışsa
    // hangi adı yazdığını görmeden düzeltemez.
    tr: (d) =>
      `Dosyada "Stok Kodu" ve "Ürün Adı" sütunları olmalı. Bulunanlar: ${d.found ?? '—'}`,
  },
  IMPORT_TOO_LARGE: {
    http: 413,
    retryable: false,
    tr: (d) => `Dosyada ${d.limit} satırdan fazla var. Dosyayı bölerek yükleyin.`,
  },

  // --- Şeffaf: kullanıcı hiçbir şey görmez, doğru davranış budur ---
  DUPLICATE_MOVEMENT: {
    http: 200,
    retryable: false,
    tr: () => '', // gösterilmez: aynı kayıt zaten işlenmiş
  },

  // --- Geçici: tekrar denenebilir ---
  POOL_EXHAUSTED: {
    http: 503,
    retryable: true,
    tr: () => 'Sistem yoğun, tekrar deneniyor',
  },
  SERIALIZATION_FAILURE: {
    http: 503,
    retryable: true,
    tr: () => 'Sistem yoğun, tekrar deneniyor',
  },
  SERVER_ERROR: {
    http: 500,
    retryable: true,
    tr: () => 'Beklenmeyen bir hata oluştu, tekrar deneniyor',
  },

  // --- Kimlik doğrulama ---
  INVALID_CREDENTIALS: {
    http: 401,
    retryable: false,
    // Metin BİLEREK "e-posta bulunamadı" demiyor: hangi e-postaların kayıtlı
    // olduğunu söylemek, kaba kuvvet saldırısına hedef listesi vermektir.
    tr: () => 'E-posta veya parola hatalı',
  },
  ACCOUNT_INACTIVE: {
    http: 403,
    retryable: false,
    tr: () => 'Hesabınız pasif durumda, yöneticinize başvurun',
  },
  TENANT_AMBIGUOUS: {
    http: 409,
    retryable: false,
    tr: () => 'Bu e-posta birden fazla işletmede kayıtlı, hangisine gireceğinizi seçin',
  },
  TOO_MANY_ATTEMPTS: {
    http: 429,
    // Outbox için tekrar denenebilir DEĞİL: kullanıcının beklemesi gerek,
    // otomatik tekrar sadece kilidi uzatır.
    retryable: false,
    tr: (d) => {
      const s = typeof d.retryAfterSeconds === 'number' ? d.retryAfterSeconds : 60
      if (s < 60) return `Çok fazla hatalı deneme. ${s} saniye sonra tekrar deneyin`
      const dk = Math.ceil(s / 60)
      return `Çok fazla hatalı deneme. ${dk} dakika sonra tekrar deneyin`
    },
  },
  TOKEN_INVALID: {
    http: 401,
    retryable: false,
    tr: () => 'Oturum geçersiz, tekrar giriş yapın',
  },

  // --- Oturum ve sürüm ---
  TOKEN_EXPIRED: {
    http: 401,
    retryable: false, // önce yenile, sonra tekrar dene: özel akış
    tr: () => 'Oturum süresi doldu, tekrar giriş yapın',
  },
  CLIENT_TOO_OLD: {
    http: 426,
    retryable: false,
    tr: () => 'Uygulamanın yeni sürümü gerekli',
  },

  // --- Rapor ve donanım ---
  EXPORT_TOO_LARGE: {
    http: 413,
    retryable: false,
    // Metin "arka planda hazırlanıp e-posta ile gönderilecek" diyordu ve bu
    // YANLIŞTI: bu kod SADECE istek REDDEDİLDİĞİNDE fırlıyor (satır sayısı
    // sert sınırın üstünde). Kullanıcı hiç gelmeyecek bir e-postayı
    // beklerdi. Kuyruğa alınan durumun ayrı bir yolu var ve hata bile
    // değil.
    //
    // Sayılar metinde: "çok büyük" tek başına kullanıcıya ne kadar
    // daraltması gerektiğini söylemiyor.
    tr: (d) =>
      `Rapor çok büyük: ${d.rowCount} satır, üst sınır ${d.limit}. ` +
      'Tarih aralığını veya filtreleri daraltın.',
  },
  PRINTER_UNAVAILABLE: {
    http: 503,
    retryable: false,
    tr: () => 'Yazıcıya ulaşılamadı, PDF olarak indirebilirsiniz',
  },
  MAIL_DELIVERY_FAILED: {
    http: 502,
    retryable: true,
    tr: () => 'E-posta gönderilemedi',
  },
} as const satisfies Record<string, ErrorMeta>

export type ErrorCode = keyof typeof ERROR_CODES

export interface ApiErrorBody {
  code: ErrorCode
  /** İngilizce, sadece log ve hata ayıklama. Ekrana basılmaz. */
  message: string
  details?: ErrorDetails
}

/**
 * Sunucuda fırlatılan, adlandırılmış hata.
 * PLAN.md kuralı: genel `catch (e)` yasak, her istisna adıyla yakalanır.
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly details: ErrorDetails

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }

  get http(): number {
    return ERROR_CODES[this.code].http
  }

  toBody(): ApiErrorBody {
    return { code: this.code, message: this.message, details: this.details }
  }
}

/**
 * İstemci tarafı: hata kodunu kullanıcıya gösterilecek Türkçe metne çevirir.
 *
 * Parametre bilerek `string`, `ErrorCode` değil. Sunucu, istemcinin
 * tanımadığı yeni bir kod gönderebilir (eski mobil sürüm, yeni sunucu).
 * Tip sistemi bunu göremez, çalışma zamanı görür.
 */
export function errorText(code: string, details: ErrorDetails = {}): string {
  const meta = (ERROR_CODES as Record<string, ErrorMeta | undefined>)[code]
  if (!meta) return 'Beklenmeyen bir hata oluştu'
  return meta.tr(details)
}

/**
 * Outbox: bu hata tekrar denenmeli mi, yoksa kullanıcıya mı sorulmalı.
 * Tanınmayan kod için varsayılan `true`: bilmediğimiz bir hatada kaydı
 * atmaktansa tekrar denemek daha güvenli. Veri kaybetmemek önceliklidir.
 */
export function isRetryable(code: string): boolean {
  const meta = (ERROR_CODES as Record<string, ErrorMeta | undefined>)[code]
  return meta?.retryable ?? true
}
