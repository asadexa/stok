/**
 * Barkod türleri. TEK KAYNAK.
 *
 * Bu liste daha önce üç yerde ayrı ayrı yazılıydı: zod enum'unda, DB CHECK
 * constraint'inde ve arayüzde. Sebep kodları ve rollerdeki kalıbın aynısına
 * çekildi — T44 testi bu üretici ile veritabanındaki gerçek constraint'i
 * karşılaştırıyor, yani üçü artık ayrı düşemiyor.
 *
 * ÇARPAN KURALI (D7) bu dosyanın asıl konusu:
 *
 *   ┌──────────┬─────────┬──────────────────────────────────────────┐
 *   │ tür      │ çarpan  │ okutulunca                               │
 *   ├──────────┼─────────┼──────────────────────────────────────────┤
 *   │ UNIT     │ = 1     │ girilen miktar kadar                     │
 *   │ EAN      │ = 1     │ girilen miktar kadar                     │
 *   │ INTERNAL │ = 1     │ girilen miktar kadar                     │
 *   │ CASE     │ > 1     │ girilen miktar × çarpan                  │
 *   └──────────┴─────────┴──────────────────────────────────────────┘
 *
 * İki yönlü kural: koli barkodunun çarpanı 1 OLAMAZ (12'li koliden 5 koli
 * girildiğinde sistem 5 yazardı, gerçekte 60 adet), tekli barkodun çarpanı
 * 1'den FARKLI olamaz (tek bir kalem okutulduğunda stok 12 artardı). İkisi
 * de sayıyı makul gösterip sessizce yanlış yazan hatalar; ikisi de hem
 * burada hem veritabanında CHECK ile kapalı.
 */

export interface BarcodeKindMeta {
  tr: string
  /** Çarpanı 1'den farklı olabilen tek tür koli. Bkz. yukarıdaki tablo. */
  allowsMultiplier: boolean
  /** Kullanıcıya türü seçtirirken gösterilen kısa açıklama. */
  hint: string
}

export const BARCODE_KINDS = {
  UNIT: {
    tr: 'Tekli',
    allowsMultiplier: false,
    hint: 'Ürünün kendi barkodu. Bir okutma = bir birim.',
  },
  CASE: {
    tr: 'Koli',
    allowsMultiplier: true,
    hint: 'Koli barkodu. Okutulunca miktar çarpanla çarpılır.',
  },
  EAN: {
    tr: 'EAN',
    allowsMultiplier: false,
    hint: 'Üreticinin bastığı standart barkod.',
  },
  INTERNAL: {
    tr: 'Dahili',
    allowsMultiplier: false,
    hint: 'Depoda basılan iç barkod.',
  },
} as const satisfies Record<string, BarcodeKindMeta>

export type BarcodeKind = keyof typeof BARCODE_KINDS

export const BARCODE_KIND_VALUES = Object.keys(BARCODE_KINDS) as BarcodeKind[]

export function barcodeKindLabel(kind: BarcodeKind): string {
  return BARCODE_KINDS[kind].tr
}

export function allowsMultiplier(kind: BarcodeKind): boolean {
  return BARCODE_KINDS[kind].allowsMultiplier
}

/**
 * Tür ile çarpan tutarlı mı. Zod şeması ve servis katmanı bunu çağırıyor;
 * veritabanı aynı kuralı iki CHECK ile ayrıca zorluyor.
 */
export function multiplierMatchesKind(kind: BarcodeKind, multiplier: number): boolean {
  return allowsMultiplier(kind) ? multiplier > 1 : multiplier === 1
}

export function barcodeKindsCheckConstraint(column = 'kind'): string {
  return `${column} IN (${BARCODE_KIND_VALUES.map((k) => `'${k}'`).join(', ')})`
}

/**
 * "Koli çarpanı 1'den büyük olmalı" CHECK metni.
 * Ayrı fonksiyon: hangi türlerin çarpan alabildiği `BARCODE_KINDS` içindeki
 * `allowsMultiplier` bayrağından türüyor, elle yazılmıyor.
 */
export function multiplierCheckConstraint(
  kindColumn = 'kind',
  multiplierColumn = 'qty_multiplier',
): string {
  const multi = BARCODE_KIND_VALUES.filter((k) => BARCODE_KINDS[k].allowsMultiplier)
  const list = multi.map((k) => `'${k}'`).join(', ')
  return `CASE WHEN ${kindColumn} IN (${list}) THEN ${multiplierColumn} > 1 ELSE ${multiplierColumn} = 1 END`
}
