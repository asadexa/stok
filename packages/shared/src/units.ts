/**
 * Ölçü birimleri.
 *
 * PLAN.md kararı: miktar NUMERIC(14,3), INTEGER değil. Bugün sadece adet
 * satılıyor olabilir ama kg/metre/litre gelen ilk müşteride migration yazmak
 * zorunda kalmamak için. Maliyeti bugün sıfır.
 */

export interface UnitMeta {
  tr: string
  /** Kaç ondalık basamağa izin verilir. Adet için 0, ağırlık için 3. */
  decimals: 0 | 3
  /** Arayüzde miktar gösterimi: "12 adet", "3,5 kg" */
  short: string
}

export const UNITS = {
  ADET: { tr: 'Adet', decimals: 0, short: 'adet' },
  KG: { tr: 'Kilogram', decimals: 3, short: 'kg' },
  METRE: { tr: 'Metre', decimals: 3, short: 'm' },
  LITRE: { tr: 'Litre', decimals: 3, short: 'L' },
} as const satisfies Record<string, UnitMeta>

export type Unit = keyof typeof UNITS

export const UNIT_VALUES = Object.keys(UNITS) as Unit[]

export function unitDecimals(unit: Unit): number {
  return UNITS[unit].decimals
}

/** "55 adet", "3,5 kg". Türkçe ondalık ayırıcı virgül. */
export function formatQty(qty: number, unit: Unit): string {
  const d = unitDecimals(unit)
  const n = qty.toFixed(d).replace('.', ',')
  return `${n} ${UNITS[unit].short}`
}

export function unitsCheckConstraint(column = 'unit'): string {
  return `${column} IN (${UNIT_VALUES.map((u) => `'${u}'`).join(', ')})`
}
