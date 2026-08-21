import { describe, expect, it } from 'vitest'
import { barcodeSchema, createMovementSchema, createProductSchema, qtySchema } from './schemas.js'

/** Geçerli bir temel istek. Testler bunun üstüne tek alan değiştirir. */
const validMovement = {
  idempotencyKey: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  barcode: '8690000000001',
  qty: 20,
  reason: 'PURCHASE' as const,
  clientCreatedAt: '2026-08-22T11:30:00+03:00',
}

describe('miktar doğrulaması: düşman QA (T39)', () => {
  it('1e999 reddedilir (Infinity)', () => {
    expect(qtySchema.safeParse(1e999).success).toBe(false)
  })

  it('negatif reddedilir', () => {
    expect(qtySchema.safeParse(-5).success).toBe(false)
  })

  it('sıfır reddedilir', () => {
    expect(qtySchema.safeParse(0).success).toBe(false)
    expect(qtySchema.safeParse(-0).success).toBe(false)
  })

  it('NaN reddedilir', () => {
    expect(qtySchema.safeParse(NaN).success).toBe(false)
  })

  it('3 ondalıktan fazlası reddedilir (NUMERIC(14,3))', () => {
    expect(qtySchema.safeParse(0.0001).success).toBe(false)
    expect(qtySchema.safeParse(1.2345).success).toBe(false)
  })

  it('3 ondalık kabul edilir (kg, metre, litre için)', () => {
    expect(qtySchema.safeParse(1.5).success).toBe(true)
    expect(qtySchema.safeParse(0.125).success).toBe(true)
  })

  it('string sayıya çevrilmez, reddedilir', () => {
    // coerce bilerek kullanılmıyor: "12abc" gibi girdiler sessizce
    // 12 olmasın diye. Açık olan, zekice olana tercih edilir.
    expect(qtySchema.safeParse('12').success).toBe(false)
  })

  it('makul üst sınır var', () => {
    expect(qtySchema.safeParse(999_999_999_999).success).toBe(false)
  })
})

describe('barkod normalizasyonu', () => {
  it('okuyucunun eklediği boşluk ve satır sonu temizlenir', () => {
    const r = barcodeSchema.safeParse('  8690000000001\n')
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toBe('8690000000001')
  })

  it('sadece boşluktan oluşan barkod reddedilir', () => {
    expect(barcodeSchema.safeParse('   ').success).toBe(false)
  })
})

describe('hareket oluşturma isteği', () => {
  it('geçerli istek kabul edilir', () => {
    expect(createMovementSchema.safeParse(validMovement).success).toBe(true)
  })

  it('idempotencyKey uuid olmalı (D-1.3)', () => {
    const r = createMovementSchema.safeParse({ ...validMovement, idempotencyKey: 'abc' })
    expect(r.success).toBe(false)
  })

  it('sayım düzeltmesi API üzerinden gönderilemez', () => {
    const r = createMovementSchema.safeParse({ ...validMovement, reason: 'COUNT_ADJUST_UP' })
    expect(r.success).toBe(false)
  })

  it('bilinmeyen sebep reddedilir', () => {
    const r = createMovementSchema.safeParse({ ...validMovement, reason: 'satin_alma' })
    expect(r.success).toBe(false)
  })

  it('allowNegative varsayılanı false', () => {
    const r = createMovementSchema.safeParse(validMovement)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.allowNegative).toBe(false)
  })

  it('clientCreatedAt saat dilimi içermeli', () => {
    // Cihaz saati UTC ofseti olmadan gelirse hangi saat dilimi olduğu
    // belirsiz kalır ve "Ahmet 14:30'da giriş yaptı" logu yalan söyler.
    const r = createMovementSchema.safeParse({
      ...validMovement,
      clientCreatedAt: '2026-08-22T11:30:00',
    })
    expect(r.success).toBe(false)
  })
})

describe('ürün oluşturma: koli çarpanı (D7)', () => {
  const base = { sku: 'DFT-001', name: 'Kırmızı Defter' }

  it('koli barkodu çarpansız kabul edilmez', () => {
    const r = createProductSchema.safeParse({
      ...base,
      barcodes: [{ barcode: '8690000000002', kind: 'CASE', qtyMultiplier: 1 }],
    })
    expect(r.success).toBe(false)
  })

  it('koli barkodu çarpanla kabul edilir', () => {
    const r = createProductSchema.safeParse({
      ...base,
      barcodes: [{ barcode: '8690000000002', kind: 'CASE', qtyMultiplier: 12 }],
    })
    expect(r.success).toBe(true)
  })

  it('birim barkodun çarpanı varsayılan 1', () => {
    const r = createProductSchema.safeParse({
      ...base,
      barcodes: [{ barcode: '8690000000001', kind: 'UNIT' }],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.barcodes[0]?.qtyMultiplier).toBe(1)
  })

  it('en az bir barkod zorunlu', () => {
    expect(createProductSchema.safeParse({ ...base, barcodes: [] }).success).toBe(false)
  })
})
