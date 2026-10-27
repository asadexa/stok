import { z } from 'zod'
import {
  BARCODE_KIND_VALUES,
  type BarcodeKind,
  multiplierMatchesKind,
} from './barcodes'
import {
  PRICE_OVERRIDE_REASON_VALUES,
  PRICE_OVERRIDE_REASONS,
  type PriceOverrideReason,
  type PriceSource,
} from './prices'
import { MOVEMENT_REASON_VALUES, MOVEMENT_REASONS, type MovementReason } from './reasons'
import { ROLE_VALUES, type Role } from './roles'
import {
  CURRENCY_VALUES,
  type Currency,
  SUPPLIER_PRICE_TYPE_VALUES,
  type SupplierPriceType,
  TAX_MODE_VALUES,
  type TaxMode,
} from './suppliers'
import { UNIT_VALUES, type Unit, unitDecimals } from './units'

/** Ürün oluşturma, barkod ekleme ve içe aktarma aynı cümleyi söylesin. */
export const ADET_MULTIPLIER_MESSAGE = 'Adetle sayılan üründe koli içi adet tam sayı olmalı'

const reasonEnum = z.enum(MOVEMENT_REASON_VALUES as [MovementReason, ...MovementReason[]])
const unitEnum = z.enum(UNIT_VALUES as [Unit, ...Unit[]])
const barcodeKindEnum = z.enum(BARCODE_KIND_VALUES as [BarcodeKind, ...BarcodeKind[]])
const roleEnum = z.enum(ROLE_VALUES as [Role, ...Role[]])
const priceOverrideReasonEnum = z.enum(
  PRICE_OVERRIDE_REASON_VALUES as [PriceOverrideReason, ...PriceOverrideReason[]],
)

/**
 * İSTEMCİNİN İDDİA EDEBİLECEĞİ FİYAT KAYNAKLARI — hepsi değil (T88).
 *
 * `LIST`, `MANUAL` ve `INDEXED` sunucunun TÜRETTİĞİ değerler: fiyatın liste
 * fiyatına eşit olup olmadığını, ya da endeksle hesaplanıp hesaplanmadığını
 * sunucu zaten biliyor. İstemcinin bunları göndermesine izin verilseydi,
 * elle yazılmış bir fiyat `LIST` etiketiyle kaydedilebilir ve kasa açığı
 * raporu "liste fiyatından satıldı" diye yalan söylerdi.
 *
 * Geriye kalan ikisi sunucunun BİLEMEYECEĞİ gözlemler — fiş okundu mu,
 * kullanıcı tahmin mi etti — o yüzden yalnızca onlar istemciden geliyor.
 */
const CLIENT_PRICE_SOURCES = ['RECEIPT', 'ESTIMATED'] as const satisfies readonly PriceSource[]
const clientPriceSourceEnum = z.enum(CLIENT_PRICE_SOURCES)

/** NUMERIC(14,3): en fazla 3 ondalık basamak. */
const MAX_DECIMALS = 3
/**
 * Ondalık basamak sayısı: mantisin basamakları eksi üs.
 *
 * `toString()` çok küçük ve çok büyük sayıları ÜSTEL yazıyor (`1e-7`,
 * `1.5e-7`). Eski hâli yalnız nokta arıyordu ve `1e-7`'yi 0 basamak sayıyordu:
 * değer şemadan geçip 0.000'a ölçekleniyor, veritabanının `delta <> 0`
 * CHECK'ine 500 olarak çarpıyordu (T130). Aynı açık para ve koli çarpanında da
 * vardı.
 */
const decimalsOf = (n: number) => {
  const [mantissa = '', exponent = '0'] = n.toString().split('e')
  const dot = mantissa.indexOf('.')
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1
  return Math.max(0, mantissaDecimals - Number(exponent))
}
const hasValidPrecision = (n: number) => decimalsOf(n) <= MAX_DECIMALS

/**
 * Para: NUMERIC(12,2). Basamak sınırı BURADA da zorlanıyor çünkü
 * PostgreSQL fazlasını sessizce yuvarlar — 19,999 TL girip 20,00 TL
 * kaydedilmesini kullanıcı ancak raporda fark ederdi.
 */
/**
 * `.finite()` YOK — `qtySchema`'daki ile aynı gerekçe ve aynı mutasyon
 * testiyle bulundu: `+Infinity`'yi `.max()`, `-Infinity`'yi
 * `.nonnegative()`, `NaN`'ı zod'un kendisi zaten reddediyor. Hiç
 * ateşlenmeyen bir koruma, kaldırıldığında hiçbir testi kırmıyor ve
 * komşusunu kaldıran birine yanlış güven veriyor.
 */
const moneySchema = z
  .number({ invalid_type_error: 'Tutar sayı olmalı' })
  .nonnegative()
  .max(99_999_999.99)
  .refine((n) => decimalsOf(n) <= 2, { message: 'En fazla 2 ondalık basamak (kuruş)' })

/**
 * Miktar. Kullanıcı HER ZAMAN pozitif girer; işareti sebep belirler.
 *
 * Düşman QA testleri (PLAN.md T39) bu şemaya çarpar:
 *   1e999   → Infinity → .max() reddeder (Infinity her sonlu üst sınırdan büyük)
 *   -1e999  → -Infinity → .positive() reddeder
 *   NaN     → z.number() reddeder (emoji/harf `Number()`'dan NaN olarak gelir)
 *   -5, 0   → .positive() reddeder
 *   0.0001  → precision refine reddeder
 *   "12"    → z.number() reddeder (coerce YOK, bilerek)
 *
 * `.finite()` YOK, bilerek — ve bir mutasyon testiyle kaldırıldı (T39).
 * Kaldırıldığında HİÇBİR test kırmızı yanmıyordu: `+Infinity`'yi `.max()`,
 * `-Infinity`'yi `.positive()`, `NaN`'ı zod'un kendisi zaten reddediyor.
 * Yani hiç ateşlenmeyen bir koruma duruyordu. Zararsız görünüyor ama
 * değil: bir gün biri `.max()`'ı kaldırırken "`.finite()` nasılsa tutuyor"
 * diye düşünebilir. İspatlanamayan koruma, yanlış güven üretiyor.
 */
export const qtySchema = z
  .number({ invalid_type_error: 'Miktar sayı olmalı' })
  // Mesajlar Türkçe ve açık: `INVALID_QUANTITY` metni bunlardan üretiliyor
  // (errors.ts). Varsayılan bırakılsaydı ekrana zod'un İngilizcesi düşerdi.
  .positive('Miktar sıfırdan büyük olmalı')
  .max(1_000_000, 'Miktar en fazla 1.000.000 olabilir')
  .refine(hasValidPrecision, { message: `En fazla ${MAX_DECIMALS} ondalık basamak` })

/**
 * Barkod. El terminalleri ve klavye emülasyonlu okuyucular sonuna
 * satır sonu veya boşluk ekleyebiliyor, bu yüzden trim şart.
 */
export const barcodeSchema = z
  .string()
  .trim()
  .min(1, 'Barkod boş olamaz')
  .max(64, 'Barkod en fazla 64 karakter olabilir')

/**
 * Stok hareketi oluşturma isteği. createMovement() tek yazma kapısının girdisi.
 *
 * `idempotencyKey` istemcide, BARKOD OKUTMA ANINDA üretilir (PLAN.md D-1.3).
 * Gönderim anında üretilirse uygulama yeniden başladıktan sonraki tekrar
 * denemede yeni anahtar oluşur ve tam olarak önlenmek istenen çift kayıt
 * meydana gelir.
 */
export const createMovementSchema = z.object({
  idempotencyKey: z.string().uuid(),
  /**
   * Ürün ya barkodla ya kimliğiyle seçiliyor; ikisinden TAM OLARAK biri.
   * Barkodsuz ürün (S3) yalnız kimlikle bulunabiliyor; sahte barkod
   * üretilmiyor. İkisi birden kabul edilseydi farklı ürünü gösteren bir
   * çiftte hangisinin geçerli olduğu sessizce seçilirdi.
   */
  barcode: barcodeSchema.optional(),
  productId: z.string().uuid().optional(),
  /**
   * Hareketin deposu. Boşsa sunucu karar veriyor: depo yoksa atanmamış, tek
   * depo varsa o depo, birden çok depo varsa `DEPOT_REQUIRED`.
   */
  depotId: z.string().uuid().optional(),
  qty: qtySchema,
  reason: reasonEnum.refine((r) => MOVEMENT_REASONS[r].userSelectable, {
    message: 'Bu sebep elle seçilemez',
  }),
  note: z.string().trim().max(500).optional(),
  locationId: z.string().uuid().optional(),
  /**
   * Hareketin GERÇEKLEŞEN birim fiyatı — girişte alış, çıkışta satış (T88).
   * `moneySchema`: kuruş sınırı burada zorlanıyor, yoksa PostgreSQL fazla
   * basamağı sessizce yuvarlar ve girilen tutar kaydedilenden farklı olur.
   */
  unitPrice: moneySchema.optional(),
  /**
   * İstemcinin o an ekranda gördüğü liste fiyatı. KARŞILAŞTIRMADA
   * KULLANILMIYOR — sunucu liste fiyatını üründen kendisi okuyor.
   *
   * Ayrı sütuna yazılıyor ki uyuşmazlık GÖRÜNÜR olsun: fiş 110 ₺ yazarken
   * sunucudaki liste 120 ₺ ise, ekranın bayat olduğu ancak bu iki sayı yan
   * yana durduğunda anlaşılır. Sunucununkiyle sessizce değiştirilseydi
   * müşteriye yanlış fiş kesildiği hiç fark edilmezdi.
   */
  clientListPrice: moneySchema.optional(),
  /** Liste fiyatından sapma sebebi. Serbest metin değil, listeden (T88). */
  priceOverrideReason: priceOverrideReasonEnum.optional(),
  /** Yalnızca sunucunun bilemeyeceği kaynaklar; gerisini sunucu türetiyor. */
  priceSource: clientPriceSourceEnum.optional(),
  /**
   * Fiyatın ait olduğu EKONOMİK AN — hareketin yazıldığı an değil (T89).
   *
   * 5 yıldır rafta duran bir malın devri bugün yazılıyor ama fiyatı 5 yıl
   * öncesine ait. İkisi aynı sütunda tutulsaydı enflasyon düzeltmesi
   * (T90) imkansız olurdu: sistem o fiyatı bugünün parası sanardı ve
   * yenileme maliyeti olduğundan düşük çıkardı.
   *
   * Boş = hareket tarihi. `YYYY-MM-DD`; saat yok çünkü fiyatın saati
   * diye bir şey yok ve saat dilimi tartışması gereksiz.
   */
  priceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fiyat tarihi GG.AA.YYYY biçiminde olmalı')
    .optional(),
  /**
   * "Elimde fatura yok, bugün aynısını kaça alacağımı yazdım."
   *
   * Ayrı bir bayrak değil, `price_source = 'ESTIMATED'` oluyor. Boolean
   * tutulsaydı fiyat kaynağı iki yerden okunurdu ve "fişten okundu ama
   * tahmini" gibi anlamsız bir durum temsil edilebilirdi.
   */
  priceEstimated: z.boolean().default(false),
  /** Cihaz saati. Sunucu saatinden AYRI saklanır; sıralama sunucu saatiyle. */
  clientCreatedAt: z.string().datetime({ offset: true }),
  /** Negatif stok override. Sunucu ayrıca admin rolü arar (PLAN.md U1). */
  allowNegative: z.boolean().default(false),
})
  // "Diğer" sebebi TEK BAŞINA hiçbir şey anlatmıyor; açıklamasız
  // kaydedilseydi rapor "bu ay 4.200 ₺ Diğer" derdi ve kimse nedenini
  // öğrenemezdi. Kuralın kendisi `prices.ts`'te, veri olarak duruyor.
  .refine(
    (m) =>
      m.priceOverrideReason === undefined ||
      !PRICE_OVERRIDE_REASONS[m.priceOverrideReason].requiresNote ||
      (m.note !== undefined && m.note !== ''),
    { message: '"Diğer" seçildiğinde açıklama zorunlu', path: ['note'] },
  )
  .refine((m) => (m.barcode === undefined) !== (m.productId === undefined), {
    message: 'Ürün barkodla ya da ürün seçilerek belirtilmeli (ikisi birden değil)',
    path: ['barcode'],
  })

export type CreateMovementInput = z.infer<typeof createMovementSchema>

/**
 * ============================================================================
 * ENVANTER DÜZELTMESİ (sunucuya özel)
 *
 * "Envanteri Güncelle": dosyadaki miktar deponun YENİ TOPLAMI. Hareket farkı
 * kadar yazılıyor (`COUNT_ADJUST_UP/DOWN`). Bu şema kullanıcı formuna AÇIK
 * DEĞİL: `createMovement` onu yalnız sunucudaki çağıranın `inventory`
 * seçeneğiyle okuyor; normal hareket şeması COUNT_ADJUST'u reddetmeye devam
 * ediyor.
 *
 * Sebep ve miktar BURADA YOK: farkın işaretini sunucu `targetQty -
 * expectedQty`'den türetiyor. Çağıran gönderseydi bir işaret hatası azalmayı
 * artış olarak yazardı ve sayı makul göründüğü için kimse fark etmezdi.
 *
 * `expectedQty`, önizlemede okunan depo miktarı. Kilit altında aynı değilse
 * yazılmıyor (`STOCK_CHANGED`): arada yapılan satış dosyadaki değerle ezilmesin.
 * ============================================================================
 */
export const inventoryAdjustmentSchema = z.object({
  idempotencyKey: z.string().uuid(),
  productId: z.string().uuid(),
  depotId: z.string().uuid(),
  expectedQty: z
    .number({ invalid_type_error: 'Miktar sayı olmalı' })
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .refine(hasValidPrecision, { message: `En fazla ${MAX_DECIMALS} ondalık basamak` }),
  targetQty: z
    .number({ invalid_type_error: 'Miktar sayı olmalı' })
    .nonnegative('Envanter miktarı negatif olamaz')
    .max(1_000_000, 'Miktar en fazla 1.000.000 olabilir')
    .refine(hasValidPrecision, { message: `En fazla ${MAX_DECIMALS} ondalık basamak` }),
  note: z.string().trim().max(500).optional(),
  clientCreatedAt: z.string().datetime({ offset: true }),
})

export type InventoryAdjustmentInput = z.infer<typeof inventoryAdjustmentSchema>

export const createMovementResponseSchema = z.object({
  movementId: z.string().uuid(),
  productId: z.string().uuid(),
  productName: z.string(),
  /** Barkodun çarpanı uygulandıktan SONRAKİ efektif miktar (PLAN.md D7). */
  effectiveQty: z.number(),
  delta: z.number(),
  newQty: z.number(),
  /** Aynı idempotencyKey ikinci kez geldiyse true. İstemci bunu sessizce yutar. */
  duplicate: z.boolean().default(false),
})

export type CreateMovementResponse = z.infer<typeof createMovementResponseSchema>

/**
 * ============================================================================
 * ÜRÜN TANIMI (T21)
 *
 * Fiyat ve miktar alanları `z.number()`, `z.coerce.number()` DEĞİL: coerce
 * boş metni 0'a çevirir ve "alış fiyatını boş bıraktım" ile "alış fiyatı
 * sıfır" ayrımı kaybolur. Formdan gelen metni sayıya çevirmek çağıranın işi
 * ve orada boş alan `undefined` olmalı.
 * ============================================================================
 */

const barcodeInputSchema = z
  .object({
    barcode: barcodeSchema,
    kind: barcodeKindEnum.default('UNIT'),
    qtyMultiplier: z
      .number()
      .positive()
      .finite()
      .max(100_000)
      .refine(hasValidPrecision, { message: `En fazla ${MAX_DECIMALS} ondalık basamak` })
      .default(1),
  })
  // D7 iki yönlü: koli çarpanı 1 olamaz (5 koli girilince stok 5 artardı,
  // gerçekte 60), tekli barkodun çarpanı 1'den farklı olamaz (tek kalem
  // okutulunca stok 12 artardı). İkisi de sayıyı makul gösterip sessizce
  // yanlış yazar. Kural `BARCODE_KINDS` içindeki bayraktan türüyor.
  .refine((b) => multiplierMatchesKind(b.kind, b.qtyMultiplier), {
    message: 'Barkod türü ile çarpan uyuşmuyor',
    path: ['qtyMultiplier'],
  })

/** Ürün oluşturma. Sadece admin. */
/**
 * Ürün görselinin adresi.
 *
 * SADECE `http`/`https`. `javascript:` ve `data:` şemaları bilerek dışarıda:
 * bu adres arayüzde bir `<img src>` içine giriyor ve toplu aktarmayla
 * DIŞARIDAN geliyor. Şema kısıtlanmasaydı, hazırladığı Excel'i yükleten
 * biri sayfaya kendi içeriğini sokabilirdi.
 *
 * Boş string `undefined`'a düşüyor: Excel'de boş bırakılan hücre ile hiç
 * olmayan sütun aynı şey — ikisi de "görsel yok".
 */
export const imageUrlSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v === '' ? undefined : v))
  .refine(
    (v) => v === undefined || /^https?:\/\//i.test(v),
    { message: 'Görsel adresi http:// veya https:// ile başlamalı' },
  )

export const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  unit: unitEnum.default('ADET'),
  category: z.string().trim().max(100).optional(),
  brand: z.string().trim().max(100).optional(),
  imageUrl: imageUrlSchema,
  purchasePrice: moneySchema.optional(),
  salePrice: moneySchema.optional(),
  minStock: z
    .number()
    .nonnegative()
    .finite()
    .max(1_000_000)
    .refine(hasValidPrecision, { message: `En fazla ${MAX_DECIMALS} ondalık basamak` })
    .default(0),
  locationId: z.string().uuid().optional(),
  // Barkod isteğe bağlı (S3): barkodsuz ürün ürün kimliğiyle hareket alıyor
  // (`createMovementSchema.productId`). Ürün formu ve ürün aktarımı bugün yine
  // barkod gönderiyor; aktarımın kuralı ayrı (açılış stoğu sessizce düşmesin).
  barcodes: z.array(barcodeInputSchema).default([]),
})
  // Adetle sayılan üründe koli çarpanı tam sayı (T130). 2,5 çarpanlı bir
  // koli barkodu tanımlansaydı her okutması kesirli adet üretir ve tek yazma
  // kapısında reddedilirdi: barkod tanımlı görünür ama hiç kullanılamazdı.
  .superRefine((product, ctx) => {
    if (unitDecimals(product.unit) !== 0) return
    product.barcodes.forEach((barcode, index) => {
      if (!Number.isInteger(barcode.qtyMultiplier)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: ADET_MULTIPLIER_MESSAGE,
          path: ['barcodes', index, 'qtyMultiplier'],
        })
      }
    })
  })

export type CreateProductInput = z.infer<typeof createProductSchema>

/**
 * Ürün güncelleme.
 *
 * Barkodlar BURADA YOK: onların kendi uç noktaları var (`addBarcodeSchema`
 * ve barkod silme). Aynı forma sıkıştırılsaydı "gönderilen listede olmayan
 * barkodu sil" anlamına gelirdi ve tarayıcıda açık kalmış eski bir sekmeden
 * gelen kaydetme, aradaki eklemeleri sessizce silerdi.
 *
 * Her alan opsiyonel ama `null` ile `undefined` FARKLI: `undefined` =
 * dokunma, `null` = temizle. Kategori/marka/fiyat/konum için bu ayrım şart,
 * yoksa bir kez girilen alış fiyatı bir daha asla boşaltılamazdı.
 */
export const updateProductSchema = z.object({
  sku: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  unit: unitEnum.optional(),
  category: z.string().trim().max(100).nullable().optional(),
  brand: z.string().trim().max(100).nullable().optional(),
  // Güncellemede `nullable`: kullanıcı görseli KALDIRABİLMELİ. `optional`
  // "dokunma", `null` "sil" demek; ikisi ayrı olmazsa görsel bir kez
  // konduktan sonra geri alınamazdı.
  imageUrl: imageUrlSchema.nullable(),
  purchasePrice: moneySchema.nullable().optional(),
  salePrice: moneySchema.nullable().optional(),
  minStock: z
    .number()
    .nonnegative()
    .finite()
    .max(1_000_000)
    .refine(hasValidPrecision, { message: `En fazla ${MAX_DECIMALS} ondalık basamak` })
    .optional(),
  locationId: z.string().uuid().nullable().optional(),
})

export type UpdateProductInput = z.infer<typeof updateProductSchema>

/**
 * ============================================================================
 * TEDARİKÇİ VERİSİ (T200, PRD-14)
 * ============================================================================
 */

// Mesajlar Türkçe: formda boş bırakılan seçim alanında zod'un İngilizce
// "Invalid enum value" metni ekrana düşerdi (VALIDATION_FAILED ilk mesajı gösterir).
const currencyEnum = z.enum(CURRENCY_VALUES as [Currency, ...Currency[]], {
  errorMap: () => ({ message: 'Para birimini seçin' }),
})
const taxModeEnum = z.enum(TAX_MODE_VALUES as [TaxMode, ...TaxMode[]], {
  errorMap: () => ({ message: 'KDV durumunu seçin' }),
})
const supplierPriceTypeEnum = z.enum(
  SUPPLIER_PRICE_TYPE_VALUES as [SupplierPriceType, ...SupplierPriceType[]],
  { errorMap: () => ({ message: 'Fiyat türünü seçin' }) },
)

/**
 * Tedarikçi fiyatı: NUMERIC(14,4), sıfırdan büyük.
 *
 * Ürün kartının parasından (`moneySchema`, 2 ondalık) AYRI: B2B listelerinde
 * küçük kalemler 3-4 ondalıkla fiyatlanıyor. Fazla basamak reddediliyor,
 * yuvarlanmıyor; PostgreSQL yuvarlasaydı her yenilemede kaydedilen ile
 * dosyadaki fiyat ayrışır ve sahte fiyat değişimi yazılırdı. Üst sınır
 * NUMERIC(14,4)'ün tavanının altında: `toFixed(4)` bu büyüklükte tam.
 */
export const supplierPriceSchema = z
  .number({ invalid_type_error: 'Fiyat sayı olmalı' })
  .positive('Fiyat sıfırdan büyük olmalı')
  .max(99_999_999.9999, 'Fiyat en fazla 99.999.999,9999 olabilir')
  .refine((n) => decimalsOf(n) <= 4, { message: 'Fiyatta en fazla 4 ondalık basamak olabilir' })

/** Tedarikçi stoğu. Eksi stok veri hatası: satır reddedilir. */
const supplierStockSchema = z
  .number({ invalid_type_error: 'Stok sayı olmalı' })
  .nonnegative('Stok eksi olamaz')
  .max(9_999_999_999.999, 'Stok en fazla 9.999.999.999,999 olabilir')
  .refine(hasValidPrecision, { message: `Stokta en fazla ${MAX_DECIMALS} ondalık basamak` })

/**
 * Yeni tedarikçi.
 *
 * Para birimi, KDV durumu ve fiyat türü ZORUNLU: dosyada bu sütunlar çoğu
 * zaman yok ve her yüklemede sorulsaydı yanlış seçim fark edilmeden
 * kaydedilirdi. Tedarikçide bir kez beyan ediliyor, dosyadaki sütun satırda
 * öncelikli.
 *
 * `unitPriceDeclared` VARSAYILAN OLARAK `false` (T200, B2): fiyatın kaç ürün
 * birimine ait olduğu belirsiz sayılır. Yalnız yönetici açıkça "fiyatlar 1
 * ürün birimi içindir" derse karşılaştırmaya girer. Varsayılan `true`
 * olsaydı koli fiyatı adet fiyatıyla aynı sıraya girer, koli 12 kat pahalı
 * görünürdü.
 */
export const createSupplierSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Tedarikçi adı boş olamaz')
    .max(120, 'Tedarikçi adı en fazla 120 karakter olabilir'),
  defaultCurrency: currencyEnum,
  defaultTaxMode: taxModeEnum,
  defaultPriceType: supplierPriceTypeEnum,
  unitPriceDeclared: z.boolean().default(false),
})

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>

/**
 * Tedarikçi ayarlarını düzenleme: aynı alanlar, TAMAMI gönderilir. Kısmi
 * güncelleme yok: form her alanı zaten taşıyor ve "gönderilmeyen alan
 * dokunulmaz mı, temizlenir mi" sorusu burada doğmasın.
 */
export const updateSupplierSchema = createSupplierSchema

export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>

/**
 * Tedarikçi kaynağından gelen TEK kalem, varsayılanlar uygulandıktan sonra.
 * Dosya (xlsx/csv) ve JSON sözleşmesi aynı şemaya iner; T201'in HTTP kaynağı
 * da buraya yazacak. Kaynağa göre ayrı doğrulama, bir yolda geçip ötekinde
 * patlayan satırlar üretirdi.
 *
 * `priceQty` yalnız kaynak AÇIKÇA söylerse dolu. Barkod çarpanından
 * türetilmez: koli barkodu, fiyatın koliye ait olduğunu kanıtlamaz.
 */
export const supplierFeedItemSchema = z.object({
  // Uzunluk mesajları Türkçe: önizlemenin satır hatası tablosunda görünüyorlar;
  // varsayılan bırakılsaydı "String must contain at most 300 character(s)" çıkardı.
  supplierCode: z
    .string()
    .trim()
    .min(1, 'Tedarikçi kodu ve barkod boş')
    .max(100, 'Tedarikçi kodu en fazla 100 karakter olabilir'),
  barcode: barcodeSchema.optional(),
  name: z.string().trim().min(1, 'Ürün adı boş').max(300, 'Ürün adı en fazla 300 karakter olabilir'),
  brand: z.string().trim().max(100, 'Marka en fazla 100 karakter olabilir').optional(),
  price: supplierPriceSchema,
  currency: currencyEnum,
  taxMode: taxModeEnum,
  priceType: supplierPriceTypeEnum,
  priceQty: qtySchema.optional(),
  stockQty: supplierStockSchema.optional(),
  sourceUpdatedAt: z
    .string()
    .datetime({ offset: true, message: 'Güncelleme zamanı saat dilimli ISO 8601 olmalı' })
    .optional(),
})

export type SupplierFeedItem = z.infer<typeof supplierFeedItemSchema>

/**
 * ============================================================================
 * KULLANICI YÖNETİMİ (T24)
 * ============================================================================
 */

/**
 * Parola kuralı: en az 8 karakter, üst sınır 200.
 *
 * Karmaşıklık kuralı (büyük harf + rakam + sembol) BİLEREK YOK. Depoda
 * çalışan biri o kuralı "Depo2024!" ile karşılar ve parolayı monitöre
 * yapıştırır — kural güvenliği artırmadan kullanılabilirliği düşürür.
 * Asıl koruma uzunluk, scrypt ve kaba kuvvet kilidi (T51).
 *
 * Üst sınır güvenlik gereği: sınırsız uzunluk scrypt'i hizmet reddi
 * aracına çevirir.
 */
export const passwordSchema = z
  .string()
  .min(8, 'Parola en az 8 karakter olmalı')
  .max(200)

/**
 * Kendi parolasını değiştirme.
 *
 * MEVCUT PAROLA ZORUNLU ve bu yönetici sıfırlamasından ayıran şey.
 * `setUserPassword` kendi parolanı doğrulama olmadan değiştirmene izin
 * veriyor; o yol yönetici için doğru (unutan kullanıcıya sıfırlama), ama
 * kendi hesabı için yanlış: açık kalmış bir oturumun başına geçen biri
 * parolayı değiştirip sahibini kendi hesabından kilitleyebilirdi.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Mevcut parolanızı girin').max(200),
  password: passwordSchema,
})

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('Geçerli bir e-posta girin').max(200),
  name: z.string().trim().min(1, 'Ad boş olamaz').max(120),
  role: roleEnum,
  password: passwordSchema,
  /** Paylaşılan telefonda hızlı kullanıcı geçişi (E10). Şimdilik opsiyonel. */
  pin: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'PIN 4-8 rakam olmalı')
    .optional(),
})

export type CreateUserInput = z.infer<typeof createUserSchema>

/**
 * Kullanıcı güncelleme. Parola BURADA YOK: ayrı bir uç noktası var.
 *
 * Aynı forma konsaydı, adı düzeltmek için açılan her kayıtta boş parola
 * alanı bulunurdu ve "boş bırakırsam ne olur" sorusu her seferinde
 * sorulurdu. Parola değiştirmek ayrı ve bilinçli bir eylem.
 */
export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: roleEnum.optional(),
  active: z.boolean().optional(),
  pin: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'PIN 4-8 rakam olmalı')
    .nullable()
    .optional(),
})

export type UpdateUserInput = z.infer<typeof updateUserSchema>

export const setPasswordSchema = z.object({
  password: passwordSchema,
})

export type SetPasswordInput = z.infer<typeof setPasswordSchema>

/** Var olan ürüne barkod ekleme. */
export const addBarcodeSchema = barcodeInputSchema

export type AddBarcodeInput = z.infer<typeof addBarcodeSchema>

/**
 * ============================================================================
 * KİMLİK DOĞRULAMA (T13)
 * ============================================================================
 */

/**
 * Giriş isteği.
 *
 * `tenantId` normalde GEREKMEZ: sunucu e-postadan tenant'ı kendisi çözer.
 * Sadece aynı e-posta birden fazla işletmede kayıtlıysa sunucu
 * `TENANT_AMBIGUOUS` döner ve istemci seçim yaptırıp bu alanla tekrar
 * gönderir. Kullanıcıyı normal durumda "işletme kodu" girmeye zorlamak,
 * "5 dakikada öğrenilen arayüz" hedefine aykırı olurdu.
 */
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  // Parolaya üst sınır koymak şart: sınırsız uzunluk, scrypt'i hizmet
  // reddi aracına çevirir (uzun girdi = uzun CPU).
  password: z.string().min(1).max(200),
  tenantId: z.string().uuid().optional(),
})

export type LoginInput = z.infer<typeof loginSchema>

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(4096),
})

export type RefreshInput = z.infer<typeof refreshSchema>

/**
 * Hareket listesi sorgusu.
 *
 * `userId` filtresi ÇALIŞAN için sunucuda zorla kendi kimliğine çevrilir
 * (rol matrisi: "hareket geçmişi → sadece kendi"). İstemcinin gönderdiği
 * değere güvenilmez.
 */
export const listMovementsSchema = z.object({
  productId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  reason: reasonEnum.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
})

export type ListMovementsInput = z.infer<typeof listMovementsSchema>

/**
 * ============================================================================
 * EXPORT (T14)
 *
 * `limit`/`offset` YOK: export'un tanımı "hepsi". Sayfalama koymak,
 * kullanıcıya eksik bir raporu tam sanarak vermek olurdu. Boyut kontrolü
 * sayfalama ile değil, eşik + arka plan işi ile yapılıyor (D-4.2).
 * ============================================================================
 */

export const exportMovementsSchema = z.object({
  productId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  reason: reasonEnum.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})

export type ExportMovementsInput = z.infer<typeof exportMovementsSchema>

/**
 * Ürün aramasının (stok tablosu, Ctrl+K, tedarikçi kalemi bağlama) en uzun
 * metni. Aramayı kendisi dolduran ekran (tedarikçi kaleminin 300 karakterlik
 * adı) bu sınıra kırpıyor; aşan metin doğrulamada reddedilip sayfayı
 * düşürüyordu (T200 1b REVIEW, B2).
 */
export const SEARCH_MAX_LENGTH = 100

export const exportStockSchema = z.object({
  /**
   * Ekrandaki arama kutusuyla AYNI alan.
   *
   * Başta yoktu ve bu sessiz bir yalandı: kullanıcı "vida" arayıp 12 satır
   * görüyor, "Excel'e aktar" diyor ve eline 4000 satırlık dosya geliyordu.
   * Export'un ekranda görüneni vermesi, raporun doğru olmasından ayrı bir
   * şey değil.
   */
  search: z.string().trim().max(SEARCH_MAX_LENGTH).optional(),
  /** Arşivlenmiş ürünler varsayılan olarak HARİÇ: rapor bugünün stoğu. */
  includeArchived: z.boolean().default(false),
  /** Sadece kritik seviyenin altındakiler. Sipariş listesi çıkarmak için. */
  onlyCritical: z.boolean().default(false),
  category: z.string().trim().max(100).optional(),
})

export type ExportStockInput = z.infer<typeof exportStockSchema>

/**
 * Stok tablosu sorgusu (T19).
 *
 * `search` HEM ürün adına HEM stok koduna bakıyor ve ikisi de `tr_norm()`
 * üzerinden geçiyor (D-4.1). Admin barkod okuyucuyu klavye gibi kullanıyor;
 * okuttuğu şey çoğu zaman koddur, arama kutusu ikisini de bulmalı.
 */
export const listStockSchema = z.object({
  search: z.string().trim().max(SEARCH_MAX_LENGTH).optional(),
  category: z.string().trim().max(100).optional(),
  productId: z.string().uuid().optional(),
  onlyCritical: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
})

export type ListStockInput = z.infer<typeof listStockSchema>
