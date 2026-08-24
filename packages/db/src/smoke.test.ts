import { afterAll, describe, expect, it } from 'vitest'
import {
  asTenant,
  closeTestDbs,
  createTenantFixture,
  dropTenantFixture,
  insertMovement,
  invariantDrift,
  withoutTenant,
} from './test-support.js'

/**
 * Test iskelesinin kendisinin çalıştığını doğrular.
 *
 * Bu dosya asıl garantileri test etmiyor; onlar ayrı dosyalarda. Buradaki
 * amaç, iskele bozuksa onu diğer testlerin yanlış pozitifleri arasında
 * aramak zorunda kalmamak.
 */

afterAll(async () => {
  await closeTestDbs()
})

describe('test iskelesi', () => {
  it('fixture kurulup silinebiliyor', async () => {
    const f = await createTenantFixture('smoke')
    expect(f.tenantId).toMatch(/^[0-9a-f-]{36}$/)
    await dropTenantFixture(f.tenantId)
  })

  it('tenant bağlamında yazılan hareket projeksiyona yansıyor', async () => {
    const f = await createTenantFixture('smoke')
    try {
      await asTenant(f.tenantId, async (tx) => {
        await insertMovement(tx, f, 20, 'PURCHASE')
        await insertMovement(tx, f, -5, 'SALE')
      })

      const rows = await asTenant(f.tenantId, (tx) =>
        tx`SELECT qty FROM current_stock WHERE product_id = ${f.productId}`,
      )
      expect(Number(rows[0]?.qty)).toBe(15)
      expect(await invariantDrift(f.tenantId)).toBe(0)
    } finally {
      await dropTenantFixture(f.tenantId)
    }
  })

  it('tenant bağlamı kurulmadan hiçbir satır görünmüyor', async () => {
    const f = await createTenantFixture('smoke')
    try {
      await asTenant(f.tenantId, (tx) => insertMovement(tx, f, 7, 'PURCHASE'))

      const rows = await withoutTenant(
        (tx) => tx`SELECT id FROM products WHERE id = ${f.productId}`,
      )
      // Güvenli varsayılan: yanlış yapılandırmada veri sızmaz, boş döner.
      expect(rows).toHaveLength(0)
    } finally {
      await dropTenantFixture(f.tenantId)
    }
  })

  it('temizlik ledger trigger.ını global olarak kapatmıyor', async () => {
    // dropTenantFixture SET LOCAL session_replication_role kullanıyor.
    // ALTER TABLE DISABLE TRIGGER kullansaydı, bu test sırasında paralel
    // koşan bir değiştirilemezlik testi sahte geçerdi.
    const a = await createTenantFixture('smoke-a')
    const b = await createTenantFixture('smoke-b')
    try {
      await asTenant(b.tenantId, (tx) => insertMovement(tx, b, 5, 'PURCHASE'))
      // A temizlenirken B'nin ledger trigger'ı hâlâ görevde olmalı.
      await dropTenantFixture(a.tenantId)

      await expect(
        asTenant(b.tenantId, (tx) => tx`DELETE FROM stock_movements WHERE tenant_id=${b.tenantId}`),
      ).rejects.toThrow()
    } finally {
      await dropTenantFixture(b.tenantId)
    }
  })
})
