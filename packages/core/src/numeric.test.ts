import { describe, expect, it } from 'vitest'
import {
  NumericFormatError,
  formatScaled,
  multiplyScaled,
  parseScaled,
  scaledFromNumber,
  scaledToNumber,
} from './numeric.js'

/**
 * Bu testler veritabanı gerektirmez ve saniyenin altında koşar.
 * Stok kontrolünün dayandığı aritmetik burada; hata buraya girerse
 * entegrasyon testlerinde "bazen bir kuruş fark" olarak görünür ve
 * ayıklanması günler alır.
 */

describe('parseScaled', () => {
  it.each([
    ['0', 0n],
    ['1', 1000n],
    ['12.000', 12000n],
    ['-3.5', -3500n],
    ['0.001', 1n],
    ['.5', 500n],
    ['-0.001', -1n],
    ['99999999999.999', 99_999_999_999_999n],
  ])('%s → %s', (input, expected) => {
    expect(parseScaled(input)).toBe(expected)
  })

  it('boşlukları kırpar (sürücüden gelen değer temiz olmayabilir)', () => {
    expect(parseScaled(' 4.250 ')).toBe(4250n)
  })

  it.each(['', 'abc', '1.2.3', '1e3', '0.0001', '1,5'])('%s reddedilir', (input) => {
    expect(() => parseScaled(input)).toThrow(NumericFormatError)
  })

  it('NUMERIC(14,3) sınırının üstünü reddeder', () => {
    expect(() => parseScaled('100000000000.000')).toThrow(NumericFormatError)
  })
})

describe('formatScaled', () => {
  it.each([
    [0n, '0.000'],
    [1000n, '1.000'],
    [-3500n, '-3.500'],
    [1n, '0.001'],
    [-1n, '-0.001'],
  ])('%s → %s', (input, expected) => {
    expect(formatScaled(input)).toBe(expected)
  })

  it('parseScaled ile gidiş-dönüş kayıpsız', () => {
    for (const v of ['0.000', '1.234', '-99.999', '1000000.500']) {
      expect(formatScaled(parseScaled(v))).toBe(v)
    }
  })
})

describe('kayan nokta hatası', () => {
  it('0.1 + 0.2 tam olarak 0.3 eder', () => {
    // JS'de 0.1 + 0.2 === 0.30000000000000004. Stok kontrolü bu farkla
    // "elde 0.3 yok" derdi ve çalışan haklı olarak sisteme güvenmezdi.
    const sum = parseScaled('0.1') + parseScaled('0.2')
    expect(formatScaled(sum)).toBe('0.300')
    expect(scaledToNumber(sum)).toBe(0.3)
  })

  it('bin küçük hareket birikirken sapma yok', () => {
    let total = 0n
    for (let i = 0; i < 1000; i++) total += parseScaled('0.001')
    expect(formatScaled(total)).toBe('1.000')
  })
})

describe('scaledFromNumber', () => {
  it.each([
    [12, 12000n],
    [0.5, 500n],
    [10.125, 10125n],
  ])('%s → %s', (input, expected) => {
    expect(scaledFromNumber(input)).toBe(expected)
  })

  it('sonsuz değeri reddeder', () => {
    expect(() => scaledFromNumber(Number.POSITIVE_INFINITY)).toThrow(NumericFormatError)
    expect(() => scaledFromNumber(Number.NaN)).toThrow(NumericFormatError)
  })
})

describe('multiplyScaled (koli çarpanı)', () => {
  it('5 koli x 12 = 60 adet', () => {
    expect(formatScaled(multiplyScaled(parseScaled('5'), parseScaled('12')))).toBe('60.000')
  })

  it('ondalık çarpan çalışır', () => {
    // 2.5 kg'lık paketten 4 paket = 10 kg
    expect(formatScaled(multiplyScaled(parseScaled('4'), parseScaled('2.5')))).toBe('10.000')
  })

  it('üç ondalıktan hassas sonucu sessizce yuvarlamaz', () => {
    // 0.001 x 0.5 = 0.0005: şemaya sığmıyor. Yuvarlamak, kullanıcının
    // girdiği miktarla defterdeki miktarı sessizce ayırırdı.
    expect(() => multiplyScaled(parseScaled('0.001'), parseScaled('0.5'))).toThrow(
      NumericFormatError,
    )
  })

  it('taşmayı reddeder', () => {
    expect(() => multiplyScaled(parseScaled('1000000'), parseScaled('1000000'))).toThrow(
      NumericFormatError,
    )
  })
})
