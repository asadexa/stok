/**
 * Stok hareketi sebep kodları. TEK KAYNAK.
 *
 * PLAN.md D-2.3 / D-2.4:
 *   - Değerler İngilizce. API cevaplarına ve Excel'e gidiyorlar; ileride
 *     Logo/Mikro entegrasyonu bunları tüketecek.
 *   - Türkçe etiketler burada, arayüzde sabit metin yazılmaz.
 *   - DB CHECK constraint bu listeden ÜRETİLİR (bkz. reasonsCheckConstraint).
 *     Üç yerde ayrı ayrı yazılırsa drift kaçınılmaz.
 *
 * `delta`'nın işareti kullanıcıdan DEĞİL, sebebin yönünden türetilir.
 * Kullanıcı her zaman pozitif miktar girer. Bu, "-5 girmek isterken 5 girdi"
 * hatasını yapısal olarak imkansız kılar.
 *
 *   ┌─────────────┐  reason=PURCHASE   ┌──────────────┐
 *   │ qty = 20    │ ─────────────────▶ │ delta = +20  │
 *   │ (her zaman  │                    └──────────────┘
 *   │  pozitif)   │  reason=SALE       ┌──────────────┐
 *   └─────────────┘ ─────────────────▶ │ delta = -20  │
 *                                      └──────────────┘
 */

export type MovementDirection = 'IN' | 'OUT'

/**
 * Bu sebepte "olması gereken fiyat" hangi ürün alanından okunur (T88).
 *
 *   'SALE'     → products.sale_price      — para kasaya giriyor
 *   'PURCHASE' → products.purchase_price  — para kasadan çıkıyor
 *   null       → liste fiyatı YOK
 *
 * `null` olan sebeplerde para el değiştirmiyor (fire, kullanım, sayım
 * düzeltmesi). Onlara liste fiyatı yazmak kasa açığı raporunu çöpe
 * çevirirdi: kırılan bir malın "liste fiyatının altında verildiği" diye
 * bir şey yok, o mal hiç satılmadı.
 */
export type PriceBasis = 'SALE' | 'PURCHASE' | null

export interface MovementReasonMeta {
  /** Stoğu artırır mı azaltır mı. delta'nın işaretini bu belirler. */
  direction: MovementDirection
  /** Arayüzde gösterilen Türkçe etiket. */
  tr: string
  /**
   * Kullanıcı bu sebebi giriş/çıkış ekranından seçebilir mi?
   * Sayım düzeltmeleri false: onları sadece sayım akışı üretir, elle
   * seçilebilseydi denetim izi anlamını kaybederdi.
   */
  userSelectable: boolean
  /** Liste fiyatının kaynağı. Kural sebeple birlikte duruyor ki ikisi
      ayrı düşemesin — `direction` ile aynı gerekçe. */
  priceBasis: PriceBasis
}

export const MOVEMENT_REASONS = {
  // --- GİRİŞ ---
  PURCHASE: { direction: 'IN', tr: 'Satın alma', userSelectable: true, priceBasis: 'PURCHASE' },
  // Müşteri malı geri getirdi: kasadan para ÇIKIYOR ve çıkan tutar malın
  // satıldığı tutar. Bu yüzden dayanak alış değil SATIŞ fiyatı.
  RETURN_IN: { direction: 'IN', tr: 'İade (giriş)', userSelectable: true, priceBasis: 'SALE' },
  OPENING: { direction: 'IN', tr: 'Devir / açılış', userSelectable: true, priceBasis: 'PURCHASE' },
  OTHER_IN: { direction: 'IN', tr: 'Diğer giriş', userSelectable: true, priceBasis: null },
  COUNT_ADJUST_UP: {
    direction: 'IN',
    tr: 'Sayım düzeltmesi (+)',
    userSelectable: false,
    priceBasis: null,
  },

  // --- ÇIKIŞ ---
  SALE: { direction: 'OUT', tr: 'Satış', userSelectable: true, priceBasis: 'SALE' },
  // Fire ve kullanımda para el değiştirmiyor (tasarım açık soru 3).
  DAMAGE: { direction: 'OUT', tr: 'Fire / hasar', userSelectable: true, priceBasis: null },
  // Tedarikçiye geri gönderim: alış fiyatı geri geliyor.
  RETURN_OUT: { direction: 'OUT', tr: 'İade (çıkış)', userSelectable: true, priceBasis: 'PURCHASE' },
  USAGE: { direction: 'OUT', tr: 'Kullanım', userSelectable: true, priceBasis: null },
  OTHER_OUT: { direction: 'OUT', tr: 'Diğer çıkış', userSelectable: true, priceBasis: null },
  COUNT_ADJUST_DOWN: {
    direction: 'OUT',
    tr: 'Sayım düzeltmesi (-)',
    userSelectable: false,
    priceBasis: null,
  },
} as const satisfies Record<string, MovementReasonMeta>

export type MovementReason = keyof typeof MOVEMENT_REASONS

/** Tüm sebep kodları, sabit sırayla. DB constraint ve testler bunu kullanır. */
export const MOVEMENT_REASON_VALUES = Object.keys(MOVEMENT_REASONS) as MovementReason[]

export function reasonDirection(reason: MovementReason): MovementDirection {
  return MOVEMENT_REASONS[reason].direction
}

export function reasonLabel(reason: MovementReason): string {
  return MOVEMENT_REASONS[reason].tr
}

/** Bu sebepte liste fiyatı hangi üründen okunur — yoksa `null` (T88). */
export function reasonPriceBasis(reason: MovementReason): PriceBasis {
  return MOVEMENT_REASONS[reason].priceBasis
}

/** Giriş/çıkış ekranında gösterilecek sebepler. Sayım düzeltmeleri hariç. */
export function selectableReasons(direction: MovementDirection): MovementReason[] {
  return MOVEMENT_REASON_VALUES.filter(
    (r) => MOVEMENT_REASONS[r].direction === direction && MOVEMENT_REASONS[r].userSelectable,
  )
}

/**
 * Kullanıcının girdiği pozitif miktarı, sebebe göre işaretli delta'ya çevirir.
 * Miktar doğrulaması burada YAPILMAZ; bunu zod şeması yapar (schemas.ts).
 */
export function toDelta(qty: number, reason: MovementReason): number {
  return reasonDirection(reason) === 'IN' ? qty : -qty
}

/**
 * DB CHECK constraint metnini bu listeden üretir.
 * Migration bunu çağırır, T44 testi de aynı fonksiyonu çağırıp
 * veritabanındaki gerçek constraint ile karşılaştırır. Böylece kod ve
 * şema birbirinden ayrı düşemez.
 */
export function reasonsCheckConstraint(column = 'reason'): string {
  const list = MOVEMENT_REASON_VALUES.map((r) => `'${r}'`).join(', ')
  return `${column} IN (${list})`
}
