import { describe, expect, it } from 'vitest'
import { createSupplierSchema, supplierFeedItemSchema, supplierPriceSchema } from './schemas'
import {
  LINKED_MATCH_STATES,
  supplierMatchLinkCheckConstraint,
  supplierPriceTypeCheckConstraint,
} from './suppliers'

const validItem = {
  supplierCode: 'T-1',
  name: 'Kalem',
  price: 12.5,
  currency: 'TRY',
  taxMode: 'EXCLUDED',
  priceType: 'NET',
}

describe('tedarikçi fiyatı (T200, B3: NUMERIC(14,4))', () => {
  it('4 ondalığa kadar kabul eder', () => {
    expect(supplierPriceSchema.safeParse(0.0375).success).toBe(true)
    expect(supplierPriceSchema.safeParse(12.1234).success).toBe(true)
  })

  it('5 ondalığı yuvarlamaz, reddeder', () => {
    expect(supplierPriceSchema.safeParse(12.12345).success).toBe(false)
  })

  it('sıfır ve eksi fiyatı reddeder', () => {
    expect(supplierPriceSchema.safeParse(0).success).toBe(false)
    expect(supplierPriceSchema.safeParse(-1).success).toBe(false)
  })

  it('üstel yazılan çok küçük sayıyı ondalık olarak sayar (T130 dersi)', () => {
    expect(supplierPriceSchema.safeParse(1e-7).success).toBe(false)
  })
})

describe('yeni tedarikçi', () => {
  it('fiyat miktarı beyanı varsayılan olarak YOK: belirsiz (T200, B2)', () => {
    const parsed = createSupplierSchema.parse({
      name: 'Toptancı',
      defaultCurrency: 'TRY',
      defaultTaxMode: 'EXCLUDED',
      defaultPriceType: 'NET',
    })
    expect(parsed.unitPriceDeclared).toBe(false)
  })

  it('varsayılan koşullar zorunlu', () => {
    expect(createSupplierSchema.safeParse({ name: 'Toptancı' }).success).toBe(false)
  })
})

describe('tedarikçi kalemi', () => {
  it('geçerli kalemi kabul eder', () => {
    expect(supplierFeedItemSchema.safeParse(validItem).success).toBe(true)
  })

  it('eksi stoğu reddeder', () => {
    expect(supplierFeedItemSchema.safeParse({ ...validItem, stockQty: -1 }).success).toBe(false)
  })

  it('bilinmeyen para birimini reddeder', () => {
    expect(supplierFeedItemSchema.safeParse({ ...validItem, currency: 'GBP' }).success).toBe(false)
  })

  it('saat dilimsiz güncelleme zamanını reddeder (DAT-16 açık)', () => {
    const result = supplierFeedItemSchema.safeParse({
      ...validItem,
      sourceUpdatedAt: '2026-10-18T10:00:00',
    })
    expect(result.success).toBe(false)
  })
})

describe('CHECK üreticileri', () => {
  it('fiyat türü listesini yazar', () => {
    expect(supplierPriceTypeCheckConstraint()).toBe("price_type IN ('NET', 'LIST')")
  })

  it('ürün bağı ile durum iki yönlü bağlı', () => {
    expect(LINKED_MATCH_STATES).toEqual(['AUTO', 'MANUAL'])
    expect(supplierMatchLinkCheckConstraint()).toBe(
      "(product_id IS NOT NULL) = (match_state IN ('AUTO', 'MANUAL'))",
    )
  })
})
