/**
 * NUMERIC(14,3) aritmetiği. Kayan noktalı sayı YOK.
 *
 * Neden: miktar `NUMERIC(14,3)` ve stok kontrolü bu sayıya bakarak
 * "çıkışa izin var mı" kararı veriyor. JavaScript'te `0.1 + 0.2 === 0.3`
 * yanlıştır; bu hata stok kontrolünde bir milyonda bir "elde 0 var ama
 * -0.0000000001 yazdı" durumu üretir ve invariant testi kırmızı yanar.
 * Böyle bir hatayı üretimde ayıklamak günler alır, burada engellemek
 * elli satır.
 *
 * Yaklaşım: her miktar 1000 ile ölçeklenmiş `bigint` olarak taşınır.
 * 14 hane, 3 ondalık → en büyük değer 99_999_999_999.999 → ölçekli
 * 99_999_999_999_999n. bigint'te üst sınır yok, taşma da yok.
 *
 * Sayıya (`number`) dönüşüm SADECE API cevabının kenarında yapılır;
 * orada değer zaten en fazla 1e6 mertebesinde ve gösterim amaçlıdır.
 */

export const QTY_SCALE = 3
const FACTOR = 1000n

/** NUMERIC(14,3)'ün taşımadan tutabileceği en büyük ölçekli değer. */
const MAX_SCALED = 99_999_999_999_999n

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?$/

export class NumericFormatError extends Error {
  constructor(value: string) {
    super(`NUMERIC(14,3) olarak okunamayan değer: ${JSON.stringify(value)}`)
    this.name = 'NumericFormatError'
  }
}

/**
 * Ondalık metni ölçekli bigint'e çevirir. Veritabanından gelen
 * `"12.000"`, `"-3.5"`, `"0"` biçimlerinin hepsini kabul eder.
 *
 * Üçten fazla ondalık basamak HATA verir, sessizce yuvarlanmaz:
 * yuvarlama burada olsaydı kullanıcının girdiği miktarla defterdeki
 * miktar sessizce ayrışırdı.
 */
export function parseScaled(value: string): bigint {
  const m = DECIMAL_RE.exec(value.trim())
  if (!m) throw new NumericFormatError(value)

  const [, sign = '', int = '', frac = ''] = m
  if (int === '' && frac === '') throw new NumericFormatError(value)
  if (frac.length > QTY_SCALE) throw new NumericFormatError(value)

  const scaled = BigInt(int === '' ? '0' : int) * FACTOR + BigInt(frac.padEnd(QTY_SCALE, '0') || '0')
  const signed = sign === '-' ? -scaled : scaled
  if (signed > MAX_SCALED || signed < -MAX_SCALED) throw new NumericFormatError(value)
  return signed
}

/**
 * Doğrulanmış bir JS sayısını ölçekli bigint'e çevirir.
 *
 * Girdi `qtySchema`'dan geçmiş olmalı (sonlu, en fazla 3 ondalık).
 * `toFixed(3)` burada güvenli: sayı zaten üç basamağa sığdığı için
 * yuvarlama gerçekleşmez, sadece metne dönüşür.
 */
export function scaledFromNumber(value: number): bigint {
  if (!Number.isFinite(value)) throw new NumericFormatError(String(value))
  return parseScaled(value.toFixed(QTY_SCALE))
}

/** Ölçekli bigint'i veritabanına yazılacak ondalık metne çevirir. */
export function formatScaled(value: bigint): string {
  const neg = value < 0n
  const abs = neg ? -value : value
  const int = abs / FACTOR
  const frac = (abs % FACTOR).toString().padStart(QTY_SCALE, '0')
  return `${neg ? '-' : ''}${int}.${frac}`
}

/**
 * Ölçekli bigint'i `number`'a çevirir. SADECE API cevabı ve gösterim için.
 * Karar veren hiçbir kod yolu bu değeri kullanmaz.
 */
export function scaledToNumber(value: bigint): number {
  return Number(value) / Number(FACTOR)
}

/**
 * İki ölçekli değerin çarpımı. Miktar x koli çarpanı için.
 * İkisi de 1000 ile ölçekli olduğundan sonuç 1_000_000 ile ölçekli olur;
 * tekrar 1000'e bölünür. Bölme kesirli çıkarsa HATA verir: bir koli
 * çarpanı miktarı üç ondalıktan hassas bir sayıya götürüyorsa bu bir
 * veri hatasıdır, sessizce yuvarlanacak bir durum değildir.
 */
export function multiplyScaled(a: bigint, b: bigint): bigint {
  const product = a * b
  if (product % FACTOR !== 0n) {
    throw new NumericFormatError(`${formatScaled(a)} x ${formatScaled(b)}`)
  }
  const result = product / FACTOR
  if (result > MAX_SCALED || result < -MAX_SCALED) {
    throw new NumericFormatError(`${formatScaled(a)} x ${formatScaled(b)}`)
  }
  return result
}
