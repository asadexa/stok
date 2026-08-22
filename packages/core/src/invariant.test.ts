import { randomUUID } from 'node:crypto'
import { AppError, type MovementReason } from '@stok/shared'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Actor, checkStockInvariant, createMovement } from './movements.js'
import { TEST_DB_NAME } from './test/db-name.js'

/**
 * ============================================================================
 * T11 — INVARIANT
 *
 *   her (tenant, ürün) için:  SUM(stock_movements.delta) == current_stock.qty
 *
 * PLAN.md Bölüm 6: "bu geçmiyorsa sistem yalan söylüyor". Diğer bütün
 * testler bir özelliğin çalıştığını gösterir; bu test verinin DOĞRU
 * olduğunu gösterir. Stok tablosu ile hareket logu ayrışmışsa kullanıcı
 * ekranda gördüğü sayıya güvenemez ve ürünün ana vaadi çöker.
 *
 * 1000 hareket deterministik bir üreteçle yazılıyor: aynı komut aynı
 * veriyi üretir, kırmızı yanan bir koşu tekrar üretilebilir olur.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME, 12)
const admin = testAdminDb(TEST_DB_NAME)

const PRODUCT_COUNT = 25
const MOVEMENT_COUNT = 1000

let tenant: TestTenant

beforeAll(async () => {
  tenant = await seedTestTenant(
    admin.db,
    'inv',
    Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
      sku: `INV-${String(i).padStart(3, '0')}`,
      name: `Rastgele Ürün ${i}`,
      // Her üçüncü ürün ondalıklı birimde: kayan nokta hatası varsa
      // invariant'ı en hızlı bunlar kırar.
      unit: i % 3 === 0 ? ('KG' as const) : ('ADET' as const),
      caseMultiplier: i % 4 === 0 ? '6' : undefined,
    })),
  )
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

/** mulberry32. Math.random YOK: kırmızı yanan koşu tekrar üretilebilmeli. */
function makeRng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const IN_REASONS: MovementReason[] = ['PURCHASE', 'RETURN_IN', 'OPENING', 'OTHER_IN']
const OUT_REASONS: MovementReason[] = ['SALE', 'DAMAGE', 'RETURN_OUT', 'USAGE', 'OTHER_OUT']

describe('T11 - invariant', () => {
  it(`${MOVEMENT_COUNT} rastgele hareketten sonra defter ile projeksiyon eşit`, async () => {
    const rng = makeRng(20260822)
    const skus = Object.keys(tenant.products)
    const actor: Actor = {
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
      role: 'ADMIN',
    }

    let written = 0
    let rejected = 0

    for (let i = 0; i < MOVEMENT_COUNT; i++) {
      const product = tenant.products[skus[Math.floor(rng() * skus.length)]!]!
      const isIn = rng() < 0.55 // girişler biraz ağır bassın, stok tükenmesin
      const reasons = isIn ? IN_REASONS : OUT_REASONS
      const reason = reasons[Math.floor(rng() * reasons.length)]!
      // Koli barkodu her beş harekette bir: çarpan yolu da invariant'a girsin.
      const useCase = product.caseBarcode !== undefined && rng() < 0.2
      // Tam sayı bin'de bir üretiliyor: `x/1000 + 0.001` yazsaydık kayan
      // nokta 3.5720000000000005 üretir ve şemanın üç ondalık kuralına
      // takılırdı — testin kendisi gerçek bir hata gibi görünürdü.
      const qty = (Math.floor(rng() * 7999) + 1) / 1000 // 0.001 - 8.000

      try {
        await createMovement(
          actor,
          {
            idempotencyKey: randomUUID(),
            barcode: useCase ? product.caseBarcode : product.barcode,
            qty,
            reason,
            clientCreatedAt: new Date().toISOString(),
          },
          { db: app.db },
        )
        written++
      } catch (err) {
        // Yetersiz stok BEKLENEN bir sonuç: rastgele trafik ürünü
        // tüketebilir. Başka her hata testi kırmalı.
        if (err instanceof AppError && err.code === 'INSUFFICIENT_STOCK') {
          rejected++
          continue
        }
        throw err
      }
    }

    expect(written).toBeGreaterThan(MOVEMENT_COUNT * 0.7)
    expect(written + rejected).toBe(MOVEMENT_COUNT)

    const breaches = await checkStockInvariant(tenant.tenantId, { db: app.db })
    expect(breaches).toEqual([])
  })

  it('invariant kontrolü gerçekten ihlal görebiliyor', async () => {
    // Kontrolün kendisini test ediyoruz. Her zaman boş dizi dönen bir
    // fonksiyon da yukarıdaki testi geçerdi; o zaman invariant'ı değil
    // hiçbir şeyi doğrulamış olurduk.
    const p = tenant.products['INV-001']!
    // Testin kendi hareketini yazıyoruz: bu test yukarıdaki testin
    // yazdıklarına bağlı olmamalı, tek başına koşturulabilmeli.
    await createMovement(
      { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' },
      {
        idempotencyKey: randomUUID(),
        barcode: p.barcode,
        qty: 5,
        reason: 'OPENING',
        clientCreatedAt: new Date().toISOString(),
      },
      { db: app.db },
    )

    // Projeksiyonu SAHİP rolüyle elle bozuyoruz. Uygulama rolü bunu
    // yapamaz ama sahip yapabilir; kontrol ikisini de yakalamalı.
    await admin.db.execute(
      `UPDATE current_stock SET qty = qty + 1
        WHERE tenant_id = '${tenant.tenantId}' AND product_id = '${p.id}'`,
    )

    const breaches = await checkStockInvariant(tenant.tenantId, { db: app.db })
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.productId).toBe(p.id)

    await admin.db.execute(
      `UPDATE current_stock SET qty = qty - 1
        WHERE tenant_id = '${tenant.tenantId}' AND product_id = '${p.id}'`,
    )
    expect(await checkStockInvariant(tenant.tenantId, { db: app.db })).toEqual([])
  })
})
