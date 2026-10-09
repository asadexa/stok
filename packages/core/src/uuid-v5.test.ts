import { createMovementSchema } from '@stok/shared'
import { describe, expect, it } from 'vitest'
import { uuidV5 } from './uuid-v5'

const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

describe('uuidV5 (RFC 9562)', () => {
  it('standart test vektörlerini üretiyor', () => {
    // RFC 9562 Ek A.4
    expect(uuidV5('www.example.com', DNS)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
    // Python belgelerindeki örnek: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
    expect(uuidV5('python.org', DNS)).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d')
  })

  it('aynı girdi her zaman aynı, farklı girdi farklı UUID', () => {
    expect(uuidV5('a:b', DNS)).toBe(uuidV5('a:b', DNS))
    expect(uuidV5('a:b', DNS)).not.toBe(uuidV5('a:c', DNS))
    expect(uuidV5('a:b', DNS)).not.toBe(uuidV5('a:b', '00000000-0000-4000-8000-000000000000'))
  })

  it('sürüm 5, varyant 10 ve hareket şemasının uuid kuralından geçiyor', () => {
    const id = uuidV5('tenant:product', DNS)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const movement = {
      idempotencyKey: id,
      barcode: '8690000000001',
      qty: 1,
      reason: 'OTHER_IN',
      clientCreatedAt: new Date().toISOString(),
    }
    expect(createMovementSchema.safeParse(movement).success).toBe(true)
  })

  it('ad alanı UUID değilse fırlatıyor', () => {
    expect(() => uuidV5('x', 'uuid-degil')).toThrow()
  })
})
