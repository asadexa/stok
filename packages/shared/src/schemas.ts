import { z } from 'zod'
import {
  BARCODE_KIND_VALUES,
  type BarcodeKind,
  multiplierMatchesKind,
} from './barcodes.js'
import { MOVEMENT_REASON_VALUES, MOVEMENT_REASONS, type MovementReason } from './reasons.js'
import { UNIT_VALUES, type Unit } from './units.js'

const reasonEnum = z.enum(MOVEMENT_REASON_VALUES as [MovementReason, ...MovementReason[]])
const unitEnum = z.enum(UNIT_VALUES as [Unit, ...Unit[]])
const barcodeKindEnum = z.enum(BARCODE_KIND_VALUES as [BarcodeKind, ...BarcodeKind[]])

/** NUMERIC(14,3): en fazla 3 ondalık basamak. */
const MAX_DECIMALS = 3
const decimalsOf = (n: number) => {
  const s = n.toString()
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}
const hasValidPrecision = (n: number) => decimalsOf(n) <= MAX_DECIMALS

/**
 * Para: NUMERIC(12,2). Basamak sınırı BURADA da zorlanıyor çünkü
 * PostgreSQL fazlasını sessizce yuvarlar — 19,999 TL girip 20,00 TL
 * kaydedilmesini kullanıcı ancak raporda fark ederdi.
 */
const moneySchema = z
  .number({ invalid_type_error: 'Tutar sayı olmalı' })
  .finite()
  .nonnegative()
  .max(99_999_999.99)
  .refine((n) => decimalsOf(n) <= 2, { message: 'En fazla 2 ondalık basamak (kuruş)' })

/**
 * Miktar. Kullanıcı HER ZAMAN pozitif girer; işareti sebep belirler.
 *
 * Düşman QA testleri (PLAN.md T39) bu şemaya çarpar:
 *   1e999   → Infinity → .finite() reddeder
 *   -5      → .positive() reddeder
 *   0       → .positive() reddeder
 *   0.0001  → precision refine reddeder
 *   "12"    → z.number() reddeder (coerce YOK, bilerek)
 */
export const qtySchema = z
  .number({ invalid_type_error: 'Miktar sayı olmalı' })
  .finite()
  .positive()
  .max(1_000_000)
  .refine(hasValidPrecision, { message: `En fazla ${MAX_DECIMALS} ondalık basamak` })

/**
 * Barkod. El terminalleri ve klavye emülasyonlu okuyucular sonuna
 * satır sonu veya boşluk ekleyebiliyor, bu yüzden trim şart.
 */
export const barcodeSchema = z
  .string()
  .trim()
  .min(1, 'Barkod boş olamaz')
  .max(64)

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
  barcode: barcodeSchema,
  qty: qtySchema,
  reason: reasonEnum.refine((r) => MOVEMENT_REASONS[r].userSelectable, {
    message: 'Bu sebep elle seçilemez',
  }),
  note: z.string().trim().max(500).optional(),
  locationId: z.string().uuid().optional(),
  /** Girişte alış fiyatı. Maliyet takibi (Faz 2) bu veriyi bugünden topluyor. */
  unitCost: z.number().nonnegative().finite().optional(),
  /** Cihaz saati. Sunucu saatinden AYRI saklanır; sıralama sunucu saatiyle. */
  clientCreatedAt: z.string().datetime({ offset: true }),
  /** Negatif stok override. Sunucu ayrıca admin rolü arar (PLAN.md U1). */
  allowNegative: z.boolean().default(false),
})

export type CreateMovementInput = z.infer<typeof createMovementSchema>

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
export const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  unit: unitEnum.default('ADET'),
  category: z.string().trim().max(100).optional(),
  brand: z.string().trim().max(100).optional(),
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
  barcodes: z.array(barcodeInputSchema).min(1, 'En az bir barkod gerekli'),
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

export const exportStockSchema = z.object({
  /**
   * Ekrandaki arama kutusuyla AYNI alan.
   *
   * Başta yoktu ve bu sessiz bir yalandı: kullanıcı "vida" arayıp 12 satır
   * görüyor, "Excel'e aktar" diyor ve eline 4000 satırlık dosya geliyordu.
   * Export'un ekranda görüneni vermesi, raporun doğru olmasından ayrı bir
   * şey değil.
   */
  search: z.string().trim().max(100).optional(),
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
  search: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  productId: z.string().uuid().optional(),
  onlyCritical: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
})

export type ListStockInput = z.infer<typeof listStockSchema>
