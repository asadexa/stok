/**
 * Fiyat sözlüğü. TEK KAYNAK.
 *
 * `reasons.ts` ile aynı örüntü ve aynı gerekçe (PLAN.md D-2.3 / D-2.4):
 * değerler İngilizce çünkü API'ye ve Excel'e gidiyorlar; Türkçe etiketler
 * burada duruyor; DB CHECK metni bu listelerden ÜRETİLİYOR. Üç yerde ayrı
 * ayrı yazılırsa drift kaçınılmaz — T44 testi zaten bunu sınıyor.
 *
 * ============================================================================
 * KASA AÇIĞI KONTROLÜ (T88)
 *
 * Senaryo: kırtasiyede çalışan A4 satıyor, fiş liste fiyatından 110 ₺
 * yazıyor, müşteri tanıdık diye 100 ₺ alınıyor, kasada 10 ₺ açık kalıyor.
 *
 * Amaç açığı ENGELLEMEK DEĞİL, GİZLENEMEZ yapmak:
 *
 *     list_price   sistemin "olması gereken" dediği     110
 *     unit_price   gerçekte ne olduğu                   100
 *     fark         10 ₺ — ürün sonradan düzenlense de değişmez
 *
 * Fark varsa sebep ZORUNLU ve sebep SERBEST METİN DEĞİL. Takip
 * toplanabilirlik demek: serbest metin "bu ay tanıdık indirimine kaç lira
 * gitti" sorusunu cevaplayamaz.
 * ============================================================================
 */

export interface PriceOverrideReasonMeta {
  /** Arayüzde gösterilen Türkçe etiket. */
  tr: string
  /** Seçildiğinde serbest metin açıklama da zorunlu mu? */
  requiresNote: boolean
}

export const PRICE_OVERRIDE_REASONS = {
  TANIDIK: { tr: 'Tanıdık indirimi', requiresNote: false },
  TOPTAN: { tr: 'Toptan / miktar indirimi', requiresNote: false },
  KAMPANYA: { tr: 'Kampanya', requiresNote: false },
  HASARLI: { tr: 'Hasarlı ürün', requiresNote: false },
  ESKI_STOK: { tr: 'Eski stok', requiresNote: false },
  // Listede ama uygulama tarafından OTOMATİK doldurulmuyor: yuvarlamak da
  // satıcının kararıdır ve seçilerek işaretlenir. Otomatik doldurulsaydı
  // "kim karar verdi" sorusu cevapsız kalırdı.
  YUVARLAMA: { tr: 'Yuvarlama', requiresNote: false },
  YONETICI_ONAYLI: { tr: 'Yönetici onaylı', requiresNote: false },
  // Serbest metin YALNIZCA burada: listede karşılığı olmayan durum da
  // kaydedilebilmeli, ama açıklamasız değil.
  DIGER: { tr: 'Diğer', requiresNote: true },
} as const satisfies Record<string, PriceOverrideReasonMeta>

export type PriceOverrideReason = keyof typeof PRICE_OVERRIDE_REASONS

export const PRICE_OVERRIDE_REASON_VALUES = Object.keys(
  PRICE_OVERRIDE_REASONS,
) as PriceOverrideReason[]

export function priceOverrideReasonLabel(reason: PriceOverrideReason): string {
  return PRICE_OVERRIDE_REASONS[reason].tr
}

export function priceOverrideReasonRequiresNote(reason: PriceOverrideReason): boolean {
  return PRICE_OVERRIDE_REASONS[reason].requiresNote
}

/**
 * Fiyatın NEREDEN geldiği.
 *
 * Bugün yalnızca `LIST` ve `MANUAL` üretiliyor. Diğer üçü bugünden duruyor
 * çünkü kullanıcı ileride muhasebe uygulamasını entegre edip fiş okutacak;
 * kaynak o gün eklenirse ikinci bir migration ve geçmiş veride kalıcı bir
 * boşluk demek olur — eski satırların kaynağı sonsuza kadar bilinmez kalır.
 */
export const PRICE_SOURCES = {
  LIST: { tr: 'Liste fiyatı' },
  MANUAL: { tr: 'Elle girildi' },
  RECEIPT: { tr: 'Fişten okundu' },
  INDEXED: { tr: 'Endeksle hesaplandı' },
  ESTIMATED: { tr: 'Tahmini' },
} as const satisfies Record<string, { tr: string }>

export type PriceSource = keyof typeof PRICE_SOURCES

export const PRICE_SOURCE_VALUES = Object.keys(PRICE_SOURCES) as PriceSource[]

export function priceSourceLabel(source: PriceSource): string {
  return PRICE_SOURCES[source].tr
}

/**
 * DB CHECK metnini listeden üretir. Migration bunu çağırıyor, T44 testi de
 * aynı fonksiyonu çağırıp veritabanındaki gerçek constraint ile
 * karşılaştırıyor — kod ile şema birbirinden ayrı düşemiyor.
 */
export function priceOverrideReasonsCheckConstraint(column = 'price_override_reason'): string {
  const list = PRICE_OVERRIDE_REASON_VALUES.map((r) => `'${r}'`).join(', ')
  return `${column} IS NULL OR ${column} IN (${list})`
}

export function priceSourcesCheckConstraint(column = 'price_source'): string {
  const list = PRICE_SOURCE_VALUES.map((r) => `'${r}'`).join(', ')
  return `${column} IS NULL OR ${column} IN (${list})`
}

/**
 * SAPMA SEBEBİ ZORUNLU MU?
 *
 * Veritabanındaki `movements_price_override_ck` ile AYNI mantık, kasten
 * ikizlenmiş: kullanıcı formu göndermeden önce anlaşılır bir hata görsün,
 * ama kural yine de satırı kimin yazdığından bağımsız korunsun. DB tek
 * başına yeterli olsaydı kullanıcı ham bir constraint hatası görürdü;
 * uygulama tek başına yeterli olsaydı `/api/v1` veya seed onu atlardı.
 *
 * Eşitlik NUMERIC karşılaştırması: her iki değer de kuruşa yuvarlanmış
 * gelmeli (money alanları `numeric(12,2)`). Epsilon YOK — tolerans D6 ile
 * iptal edildi: fiyat elle yazılmıyor, barkoddan geliyor; otorite sistemde
 * olduğu için kazara sapma diye bir şey yok, her sapma bilinçli bir karar.
 */
export function priceOverrideRequiresReason(
  unitPrice: number | null | undefined,
  listPrice: number | null | undefined,
): boolean {
  if (unitPrice == null || listPrice == null) return false
  return unitPrice !== listPrice
}
