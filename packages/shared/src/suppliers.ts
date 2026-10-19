/**
 * ============================================================================
 * TEDARİKÇİ VERİSİ SÖZLÜKLERİ (T200, PRD-14). TEK KAYNAK.
 *
 * Tedarikçi fiyatı ancak para birimi, KDV durumu, fiyat türü ve fiyatın ait
 * olduğu miktar aynıysa başka bir fiyatla karşılaştırılabilir. Bu dört koşul
 * serbest metin olsaydı "TL" ile "TRY" ayrı grup sayılır, karşılaştırma
 * sessizce bölünürdü. Değerler İngilizce kod (API'ye ve dosya sözleşmesine
 * gidiyor), Türkçe etiketler aynı yerde. DB CHECK'leri buradan üretilir ve
 * `schema-sync.test.ts` ikisini karşılaştırır (INV-9).
 * ============================================================================
 */

export const CURRENCIES = {
  TRY: { tr: 'Türk lirası', short: 'TL' },
  USD: { tr: 'ABD doları', short: 'USD' },
  EUR: { tr: 'Euro', short: 'EUR' },
} as const

export type Currency = keyof typeof CURRENCIES
export const CURRENCY_VALUES = Object.keys(CURRENCIES) as Currency[]

export const TAX_MODES = {
  INCLUDED: { tr: 'KDV dahil' },
  EXCLUDED: { tr: 'KDV hariç' },
} as const

export type TaxMode = keyof typeof TAX_MODES
export const TAX_MODE_VALUES = Object.keys(TAX_MODES) as TaxMode[]

/**
 * Tedarikçinin bildirdiği fiyatın türü. Ürün kartındaki alış/satış
 * fiyatından AYRI bir sözlük: tedarikçi verisi kartın fiyatını değiştirmez
 * (PRD-14) ve aynı adı taşısalardı biri ötekinin yerine okunabilirdi.
 */
export const SUPPLIER_PRICE_TYPES = {
  NET: { tr: 'Net alış' },
  LIST: { tr: 'Liste' },
} as const

export type SupplierPriceType = keyof typeof SUPPLIER_PRICE_TYPES
export const SUPPLIER_PRICE_TYPE_VALUES = Object.keys(SUPPLIER_PRICE_TYPES) as SupplierPriceType[]

/**
 * Tedarikçi kaleminin işletme ürünüyle eşleşme durumu.
 *
 * Otomatik eşleşme YALNIZ barkodla (`AUTO`). Kod ya da ad benzerliğiyle
 * otomatik bağlamak, iki tedarikçide aynı kodu taşıyan farklı ürünleri
 * sessizce aynı ürüne bağlardı. `IGNORED`: kullanıcı "bu kalem bizim değil"
 * dedi; sonraki yenilemelerde otomatik eşleşme bir daha denenmez.
 */
export const SUPPLIER_MATCH_STATES = {
  AUTO: { tr: 'Barkodla eşleşti', linked: true },
  MANUAL: { tr: 'Elle bağlandı', linked: true },
  UNMATCHED: { tr: 'Eşleşmedi', linked: false },
  IGNORED: { tr: 'Yok sayıldı', linked: false },
} as const

export type SupplierMatchState = keyof typeof SUPPLIER_MATCH_STATES
export const SUPPLIER_MATCH_STATE_VALUES = Object.keys(SUPPLIER_MATCH_STATES) as SupplierMatchState[]
export const LINKED_MATCH_STATES = SUPPLIER_MATCH_STATE_VALUES.filter(
  (s) => SUPPLIER_MATCH_STATES[s].linked,
)

/**
 * Fiyat geçmişi satırının türü. Saklanmaz; karşılaştırılabilirlik
 * veritabanında üretilen sütundan (`is_comparable`) okunur, tür ondan türer.
 * Yüzde ve artış/azalış yalnız `PRICE`'ta anlamlı: koşulu değişen ya da
 * miktarı belirsiz iki fiyat arasında yüzde, yanlış bir kıyas olurdu.
 */
export const SUPPLIER_CHANGE_KINDS = {
  PRICE: { tr: 'Fiyat değişimi' },
  CONDITION: { tr: 'Koşul değişimi' },
  QTY_UNKNOWN: { tr: 'Fiyat değişti, miktar belirsiz' },
} as const

export type SupplierChangeKind = keyof typeof SUPPLIER_CHANGE_KINDS

export function currencyLabel(currency: Currency): string {
  return CURRENCIES[currency].tr
}

export function taxModeLabel(mode: TaxMode): string {
  return TAX_MODES[mode].tr
}

export function supplierPriceTypeLabel(type: SupplierPriceType): string {
  return SUPPLIER_PRICE_TYPES[type].tr
}

export function supplierMatchStateLabel(state: SupplierMatchState): string {
  return SUPPLIER_MATCH_STATES[state].tr
}

export function supplierChangeKindLabel(kind: SupplierChangeKind): string {
  return SUPPLIER_CHANGE_KINDS[kind].tr
}

function inList(column: string, values: readonly string[]): string {
  return `${column} IN (${values.map((v) => `'${v}'`).join(', ')})`
}

export function currencyCheckConstraint(column = 'currency'): string {
  return inList(column, CURRENCY_VALUES)
}

export function taxModeCheckConstraint(column = 'tax_mode'): string {
  return inList(column, TAX_MODE_VALUES)
}

export function supplierPriceTypeCheckConstraint(column = 'price_type'): string {
  return inList(column, SUPPLIER_PRICE_TYPE_VALUES)
}

export function supplierMatchStateCheckConstraint(column = 'match_state'): string {
  return inList(column, SUPPLIER_MATCH_STATE_VALUES)
}

/**
 * Ürün bağı ile eşleşme durumu iki yönlü tutarlı: bağlı durumda ürün dolu,
 * bağsız durumda boş. Tek yönlü olsaydı `UNMATCHED` görünen bir kalem yine de
 * ürüne bağlı kalabilir ve karşılaştırmaya girerdi.
 */
export function supplierMatchLinkCheckConstraint(
  productColumn = 'product_id',
  stateColumn = 'match_state',
): string {
  return `(${productColumn} IS NOT NULL) = (${inList(stateColumn, LINKED_MATCH_STATES)})`
}
