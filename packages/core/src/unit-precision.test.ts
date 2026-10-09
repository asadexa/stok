import { randomUUID } from 'node:crypto'
import { AppError, errorText } from '@stok/shared'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { createMovement, getStockQty } from './movements'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T130 — BİRİM HASSASİYETİ, TEK YAZMA KAPISINDA
 *
 * Kural yazılan sayıya bakıyor: girilen miktar × barkod çarpanı, ürünün
 * biriminde. Adet tam sayı, kg/metre/litre en fazla 3 ondalık. Her ret
 * "defter ve stok değişmedi" ile birlikte sınanıyor: reddedilen istek iz
 * bırakmamalı.
 *
 * `1e-7` testi asıl hatanın kanıtı: eskiden şemadan geçip 0.000'a ölçekleniyor
 * ve veritabanının `delta <> 0` CHECK'ine 500 olarak çarpıyordu.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)
let tenant: TestTenant
let boss: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'unitprec', [
    { sku: 'ADT-001', name: 'Adetli Kalem', unit: 'ADET', caseMultiplier: '12' },
    { sku: 'KG-001', name: 'Dökme Çivi', unit: 'KG', caseMultiplier: '2.5' },
    { sku: 'MT-001', name: 'Kablo', unit: 'METRE' },
  ])
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

const product = (sku: string) => tenant.products[sku]!

function req(barcode: string, qty: unknown) {
  return {
    idempotencyKey: randomUUID(),
    barcode,
    qty,
    reason: 'OTHER_IN',
    clientCreatedAt: new Date().toISOString(),
  }
}

async function movementCount(): Promise<number> {
  const [row] = await admin.client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_movements WHERE tenant_id = ${tenant.tenantId}
  `
  return row!.n
}

/** Ret bekleniyor: kodu ve Türkçe metni döndürür, defterin değişmediğini doğrular. */
async function rejected(barcode: string, qty: unknown, productId: string) {
  const movementsBefore = await movementCount()
  const stockBefore = await getStockQty(boss, productId, { db: app.db })
  const err = await createMovement(boss, req(barcode, qty), { db: app.db }).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err, 'istek reddedilmeliydi').toBeInstanceOf(AppError)
  expect(await movementCount()).toBe(movementsBefore)
  expect(await getStockQty(boss, productId, { db: app.db })).toBe(stockBefore)
  const appErr = err as AppError
  return { code: appErr.code, text: errorText(appErr.code, appErr.details) }
}

describe('adetle sayılan ürün', () => {
  it('tekli barkodla 0,5 adet reddediliyor ve sebep Türkçe söyleniyor', async () => {
    const p = product('ADT-001')
    const { code, text } = await rejected(p.barcode, 0.5, p.id)

    expect(code).toBe('INVALID_QUANTITY')
    expect(text).toBe('Bu ürün adetle sayılıyor; miktar tam sayı olmalı')
  })

  it('koli barkodunda 0,5 koli × 12 = 6 adet yazılıyor (kural efektif miktarda)', async () => {
    const p = product('ADT-001')
    const res = await createMovement(boss, req(p.caseBarcode!, 0.5), { db: app.db })

    expect(res.effectiveQty).toBe(6)
  })

  it('koli barkodunda 0,1 koli × 12 = 1,2 adet reddediliyor', async () => {
    const p = product('ADT-001')
    const { code, text } = await rejected(p.caseBarcode!, 0.1, p.id)

    expect(code).toBe('INVALID_QUANTITY')
    expect(text).toContain('koli içi 12 ile 1,2 adet')
  })
})

describe('ondalıklı birimler', () => {
  it('kg 0,5 ve metre 0,001 yazılıyor', async () => {
    const kg = await createMovement(boss, req(product('KG-001').barcode, 0.5), { db: app.db })
    const mt = await createMovement(boss, req(product('MT-001').barcode, 0.001), { db: app.db })

    expect(kg.effectiveQty).toBe(0.5)
    expect(mt.effectiveQty).toBe(0.001)
  })

  it('çarpım 3 ondalığı aşarsa (0,001 × 2,5) 500 değil INVALID_QUANTITY', async () => {
    const p = product('KG-001')
    const { code, text } = await rejected(p.caseBarcode!, 0.001, p.id)

    expect(code).toBe('INVALID_QUANTITY')
    expect(text).toBe('En fazla 3 ondalık basamak')
  })
})

describe('üstel gösterimli sayılar (asıl hata)', () => {
  it.each([1e-7, 1.5e-7, 2.5e-4])('%s veritabanına gitmeden INVALID_QUANTITY', async (qty) => {
    const p = product('KG-001')
    const { code, text } = await rejected(p.barcode, qty, p.id)

    expect(code).toBe('INVALID_QUANTITY')
    expect(text).toBe('En fazla 3 ondalık basamak')
  })
})
