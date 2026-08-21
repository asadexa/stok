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
}

export const MOVEMENT_REASONS = {
  // --- GİRİŞ ---
  PURCHASE: { direction: 'IN', tr: 'Satın alma', userSelectable: true },
  RETURN_IN: { direction: 'IN', tr: 'İade (giriş)', userSelectable: true },
  OPENING: { direction: 'IN', tr: 'Devir / açılış', userSelectable: true },
  OTHER_IN: { direction: 'IN', tr: 'Diğer giriş', userSelectable: true },
  COUNT_ADJUST_UP: { direction: 'IN', tr: 'Sayım düzeltmesi (+)', userSelectable: false },

  // --- ÇIKIŞ ---
  SALE: { direction: 'OUT', tr: 'Satış', userSelectable: true },
  DAMAGE: { direction: 'OUT', tr: 'Fire / hasar', userSelectable: true },
  RETURN_OUT: { direction: 'OUT', tr: 'İade (çıkış)', userSelectable: true },
  USAGE: { direction: 'OUT', tr: 'Kullanım', userSelectable: true },
  OTHER_OUT: { direction: 'OUT', tr: 'Diğer çıkış', userSelectable: true },
  COUNT_ADJUST_DOWN: { direction: 'OUT', tr: 'Sayım düzeltmesi (-)', userSelectable: false },
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
