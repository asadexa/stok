import { describe, expect, it } from 'vitest'
import { centsToNumber, centsToTurkish, roundTurkishPriceToCents } from './sheet'

/**
 * ============================================================================
 * PRC-15 — ÜRÜN DOSYASINDA FİYATIN KURUŞA YARIM YUKARI YUVARLANMASI (birim)
 *
 * Kuralın sayısal sınırları: kullanıcı örnekleri, tam yarım, kayan noktanın
 * yanıldığı değerler, binlik ayırıcı, değişmeyen fiyatlar ve yuvarlanmayan
 * (normal doğrulamaya bırakılan) yazımlar. Önizleme ve uygulama davranışı
 * `price-rounding-import.test.ts`'te, gerçek veritabanıyla.
 * ============================================================================
 */

const round = (raw: string) => {
  const r = roundTurkishPriceToCents(raw)
  return r === undefined ? undefined : { to: centsToTurkish(r.cents), changed: r.changed }
}

describe('yarım yukarı, kuruşa', () => {
  it('kullanıcı örnekleri', () => {
    expect(round('3,0451')).toEqual({ to: '3,05', changed: true })
    expect(round('2,9949')).toEqual({ to: '2,99', changed: true })
    expect(round('2,9950')).toEqual({ to: '3,00', changed: true })
    expect(round('3,0050')).toEqual({ to: '3,01', changed: true })
    expect(round('9,5049')).toEqual({ to: '9,50', changed: true })
  })

  it('kayan noktanın yanıldığı tam yarımlar doğru: 1,005 → 1,01; 8,675 → 8,68', () => {
    // Math.round(1.005 * 100) / 100 = 1 ve 8.675 → 8.67 olurdu.
    expect(round('1,005')).toEqual({ to: '1,01', changed: true })
    expect(round('8,675')).toEqual({ to: '8,68', changed: true })
  })

  it('binlik ayırıcılı ve üst basamağa taşan değer', () => {
    expect(round('1.234,5678')).toEqual({ to: '1234,57', changed: true })
    expect(round('99.999.999,995')).toEqual({ to: '100000000,00', changed: true })
    expect(round('0,995')).toEqual({ to: '1,00', changed: true })
  })

  it('sıfıra inen pozitif fiyat yuvarlanıyor ama çağıran reddediyor (0,0049 → 0,00)', () => {
    expect(round('0,0049')).toEqual({ to: '0,00', changed: true })
    expect(round('0,005')).toEqual({ to: '0,01', changed: true })
  })

  it('iki ondalıklı ve kuruştan sonrası sıfır olan fiyat değişmiyor', () => {
    expect(round('9,50')).toEqual({ to: '9,50', changed: false })
    expect(round('9,5')).toEqual({ to: '9,50', changed: false })
    expect(round('9,5000')).toEqual({ to: '9,50', changed: false })
    expect(round('12')).toEqual({ to: '12,00', changed: false })
    expect(round('0')).toEqual({ to: '0,00', changed: false })
  })

  it('xlsx sayı hücresi metni ("9,5049", virgülle) ve noktalı ondalık ("9.5049") aynı', () => {
    expect(round('9.5049')).toEqual({ to: '9,50', changed: true })
  })
})

describe('yuvarlanmayan yazımlar: normal doğrulamaya kalıyor', () => {
  it('eksi, belirsiz, üstel, bozuk ve boş', () => {
    for (const raw of ['-3,0451', '1.234', '1e-7', '1,5e3', 'abc', '3,04,51', '+3,0451', '', '  ']) {
      expect(roundTurkishPriceToCents(raw), raw).toBeUndefined()
    }
  })
})

describe('kuruş dönüşümü', () => {
  it('sayı ve metin kesin', () => {
    expect(centsToNumber(301n)).toBe(3.01)
    expect(centsToNumber(5n)).toBe(0.05)
    expect(centsToNumber(9999999999n)).toBe(99999999.99)
    expect(centsToTurkish(5n)).toBe('0,05')
  })
})
