import { z } from 'zod'
import { MOVEMENT_REASON_VALUES, MOVEMENT_REASONS, type MovementReason } from './reasons.js'
import { UNIT_VALUES, type Unit } from './units.js'

const reasonEnum = z.enum(MOVEMENT_REASON_VALUES as [MovementReason, ...MovementReason[]])
const unitEnum = z.enum(UNIT_VALUES as [Unit, ...Unit[]])

/** NUMERIC(14,3): en fazla 3 ondalık basamak. */
const MAX_DECIMALS = 3
const hasValidPrecision = (n: number) => {
  const s = n.toString()
  const dot = s.indexOf('.')
  return dot === -1 || s.length - dot - 1 <= MAX_DECIMALS
}

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

/** Ürün oluşturma. Sadece admin. */
export const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  unit: unitEnum.default('ADET'),
  category: z.string().trim().max(100).optional(),
  brand: z.string().trim().max(100).optional(),
  purchasePrice: z.number().nonnegative().finite().optional(),
  salePrice: z.number().nonnegative().finite().optional(),
  minStock: z.number().nonnegative().finite().default(0),
  locationId: z.string().uuid().optional(),
  barcodes: z
    .array(
      z.object({
        barcode: barcodeSchema,
        kind: z.enum(['UNIT', 'CASE', 'EAN', 'INTERNAL']).default('UNIT'),
        qtyMultiplier: z.number().positive().finite().default(1),
      }),
    )
    .min(1, 'En az bir barkod gerekli')
    // D7: koli barkodunun çarpanı 1 olamaz, yoksa koli okutulunca stok
    // 1 artar ve sistem sessizce yanlış sayı söyler.
    .refine((bs) => bs.every((b) => b.kind !== 'CASE' || b.qtyMultiplier > 1), {
      message: 'Koli barkodunun çarpanı birden büyük olmalı',
    }),
})

export type CreateProductInput = z.infer<typeof createProductSchema>
