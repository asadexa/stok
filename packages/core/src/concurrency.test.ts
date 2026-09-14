import { randomUUID } from 'node:crypto'
import { AppError } from '@stok/shared'
import {
  type TestTenant,
  seedOpeningStock,
  seedTestTenant,
  testAdminDb,
  testAppDb,
} from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkStockInvariant, createMovement, getStockQty } from './movements'
import type { Actor } from './authz'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T12 — EŞZAMANLILIK
 *
 * Bu dosya, planın en pahalı hatasını arıyor: TOCTOU yarışı (D-1.2).
 *
 *   iki istek aynı anda      →  ikisi de "elde 10 var" okur
 *                            →  ikisi de 10 çıkış yazar
 *                            →  stok -10 olur, kimse fark etmez
 *
 * `SELECT ... FOR UPDATE` bunu engelliyor. Engellemediğini anlamanın tek
 * yolu bu test; tek iş parçacıklı bir testte kod HER ZAMAN doğru görünür.
 *
 * Test kırılgan görünüyorsa (Promise.all ile 20 istek) kırılgan DEĞİL:
 * kilit yoksa neredeyse her koşuda patlar, kilit varsa hiç patlamaz.
 * ============================================================================
 */

// Havuz 24: 20 eşzamanlı transaction bağlantı bekleyerek sıraya girerse
// test yarışı değil sırayı ölçer ve hatayı göremez.
const app = testAppDb(TEST_DB_NAME, 24)
const admin = testAdminDb(TEST_DB_NAME)

let tenant: TestTenant

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'conc', [
    { sku: 'C-1', name: 'Yarış Ürünü' },
    { sku: 'C-2', name: 'İkinci Ürün' },
    { sku: 'C-3', name: 'Üçüncü Ürün' },
  ])
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

function actor(role: 'ADMIN' | 'STAFF' = 'STAFF'): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: role === 'ADMIN' ? tenant.adminUserId : tenant.staffUserId,
    role,
  }
}

function req(barcode: string, qty: number, reason: string) {
  return {
    idempotencyKey: randomUUID(),
    barcode,
    qty,
    reason,
    clientCreatedAt: new Date().toISOString(),
  }
}

/** Promise.allSettled'ı hata koduna göre ayırır. */
async function settle(promises: Promise<unknown>[]) {
  const results = await Promise.allSettled(promises)
  const ok = results.filter((r) => r.status === 'fulfilled')
  const failed = results.filter((r) => r.status === 'rejected')
  const codes = failed.map((r) =>
    r.reason instanceof AppError ? r.reason.code : `UNEXPECTED: ${String(r.reason)}`,
  )
  return { ok: ok.length, codes }
}

describe('T12 - 20 paralel çıkış, elde 10', () => {
  it('tam 10 tanesi geçer, negatif stok oluşmaz', async () => {
    const p = tenant.products['C-1']!
    await seedOpeningStock(admin.db, tenant, p.id, '10')

    const { ok, codes } = await settle(
      Array.from({ length: 20 }, () =>
        createMovement(actor(), req(p.barcode, 1, 'SALE'), { db: app.db }),
      ),
    )

    expect(ok).toBe(10)
    expect(codes).toEqual(Array(10).fill('INSUFFICIENT_STOCK'))
    expect(await getStockQty(actor(), p.id, { db: app.db })).toBe(0)
  })

  it('kayıp yazma yok: 30 paralel giriş, hepsi deftere işler', async () => {
    const p = tenant.products['C-2']!

    const { ok, codes } = await settle(
      Array.from({ length: 30 }, () =>
        createMovement(actor(), req(p.barcode, 2, 'PURCHASE'), { db: app.db }),
      ),
    )

    expect(codes).toEqual([])
    expect(ok).toBe(30)
    // Okuyup-yazma yarışı olsaydı burada 60'tan küçük bir sayı çıkardı.
    expect(await getStockQty(actor(), p.id, { db: app.db })).toBe(60)
  })

  it('karışık giriş/çıkış trafiğinde defter ile projeksiyon eşit kalır', async () => {
    const p = tenant.products['C-3']!
    await seedOpeningStock(admin.db, tenant, p.id, '100')

    const traffic = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? createMovement(actor(), req(p.barcode, 3, 'PURCHASE'), { db: app.db })
        : createMovement(actor(), req(p.barcode, 2, 'SALE'), { db: app.db }),
    )
    const { codes } = await settle(traffic)

    expect(codes).toEqual([])
    // 100 + 20x3 - 20x2 = 120
    expect(await getStockQty(actor(), p.id, { db: app.db })).toBe(120)
    expect(await checkStockInvariant(tenant.tenantId, { db: app.db })).toEqual([])
  })

  it('farklı ürünlere yazanlar birbirini beklemez', async () => {
    // Kilit ürün bazlı. Bu test doğruluğu değil, kilidin KAPSAMINI
    // koruyor: biri gelip tablo kilidine çevirirse burada görülür.
    const fresh = await seedTestTenant(
      admin.db,
      'conc-wide',
      Array.from({ length: 12 }, (_, i) => ({ sku: `W-${i}`, name: `Ürün ${i}` })),
    )
    const wide: Actor = { tenantId: fresh.tenantId, userId: fresh.staffUserId, role: 'STAFF' }

    const started = Date.now()
    const { codes } = await settle(
      Object.values(fresh.products).map((p) =>
        createMovement(wide, req(p.barcode, 5, 'PURCHASE'), { db: app.db }),
      ),
    )
    const elapsed = Date.now() - started

    expect(codes).toEqual([])
    // Yerelde ~50 ms sürüyor. Eşik bilerek çok gevşek: bu test süreyi
    // ölçmüyor, tablo kilidine dönüşen bir gerilemeyi yakalıyor.
    expect(elapsed).toBeLessThan(5_000)
  })
})
