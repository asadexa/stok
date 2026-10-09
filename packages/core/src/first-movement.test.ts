import { randomUUID } from 'node:crypto'
import { AppError } from '@stok/shared'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { checkStockInvariant, createMovement } from './movements'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T128 — "YALNIZ İLK HAREKET" (`requireFirstMovement`)
 *
 * Toplu açılış stoğu ürünün ilk hareketi olmak zorunda: sonradan yazılan bir
 * devir, arada satılan malı stoğa ikinci kez koyardı. Kontrol satır
 * kilidinden SONRA yapılıyor; kilit testi bunu yarışa güvenmeden, beklemeyi
 * `pg_locks` üzerinden görerek sınıyor.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME, 8)
const admin = testAdminDb(TEST_DB_NAME)
let tenant: TestTenant
let boss: Actor

const PRODUCT_COUNT = 30

beforeAll(async () => {
  tenant = await seedTestTenant(
    admin.db,
    'firstmv',
    Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
      sku: `FM-${String(i).padStart(2, '0')}`,
      name: `İlk Hareket Ürünü ${i}`,
      purchasePrice: '10.00',
    })),
  )
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

let next = 0
/** Her test kendi ürününü alıyor: paylaşılan ürün testleri sıraya bağlar. */
const freshProduct = () => tenant.products[`FM-${String(next++).padStart(2, '0')}`]!

function opening(barcode: string, idempotencyKey = randomUUID()) {
  return {
    idempotencyKey,
    barcode,
    qty: 5,
    reason: 'OPENING',
    unitPrice: 10,
    clientCreatedAt: new Date().toISOString(),
  }
}

function purchase(barcode: string) {
  return {
    idempotencyKey: randomUUID(),
    barcode,
    qty: 1,
    reason: 'PURCHASE',
    clientCreatedAt: new Date().toISOString(),
  }
}

const first = { db: app.db, requireFirstMovement: true }

async function movements(productId: string) {
  return admin.client<{ reason: string }[]>`
    SELECT reason FROM stock_movements
     WHERE tenant_id = ${tenant.tenantId} AND product_id = ${productId}
     ORDER BY created_at, id
  `
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  )
}

describe('requireFirstMovement', () => {
  it('seçenek verilmezse hareketli ürüne de normal yazılıyor', async () => {
    const p = freshProduct()
    await createMovement(boss, purchase(p.barcode), { db: app.db })
    await createMovement(boss, purchase(p.barcode), { db: app.db })

    expect((await movements(p.id)).length).toBe(2)
  })

  it('hareketsiz üründe devir yazılıyor', async () => {
    const p = freshProduct()
    const res = await createMovement(boss, opening(p.barcode), first)

    expect(res.duplicate).toBe(false)
    expect(res.newQty).toBe(5)
  })

  it('hareketli üründe PRODUCT_HAS_MOVEMENTS ve defter değişmiyor', async () => {
    const p = freshProduct()
    await createMovement(boss, purchase(p.barcode), { db: app.db })

    expect(await codeOf(createMovement(boss, opening(p.barcode), first))).toBe(
      'PRODUCT_HAS_MOVEMENTS',
    )
    expect((await movements(p.id)).map((m) => m.reason)).toEqual(['PURCHASE'])
  })

  it('aynı anahtarla tekrar: kendi yazdığı devri "duplicate" görüyor, hata değil', async () => {
    const p = freshProduct()
    const key = randomUUID()
    await createMovement(boss, opening(p.barcode, key), first)

    const again = await createMovement(boss, opening(p.barcode, key), first)
    expect(again.duplicate).toBe(true)
    expect((await movements(p.id)).length).toBe(1)
  })
})

describe('kilit sonrası kontrol (deterministik)', () => {
  /** Uygulama bağlantılarından biri kilit beklerken döner; 5 sn içinde beklemezse hata. */
  async function waitForBlockedLock() {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const [row] = await admin.client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks l
          JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE NOT l.granted AND a.datname = current_database()
      `
      if (row!.n > 0) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('devir çağrısı kilitte beklemedi')
  }

  it('kilit tutulurken araya giren hareket COMMIT edilince devir reddediliyor', async () => {
    const p = freshProduct()
    let pending: Promise<string | null> | undefined

    // Başka bir yazanı taklit ediyoruz: satırı kilitleyip bir giriş yazıyor
    // ve devir çağrısı kilitte beklerken COMMIT ediyor.
    await admin.client.begin(async (sql) => {
      await sql`
        INSERT INTO current_stock (tenant_id, product_id, qty)
        VALUES (${tenant.tenantId}, ${p.id}, 0)
        ON CONFLICT DO NOTHING
      `
      await sql`
        SELECT qty FROM current_stock
         WHERE tenant_id = ${tenant.tenantId} AND product_id = ${p.id}
           FOR UPDATE
      `
      await sql`
        INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, reason, idempotency_key)
        VALUES (${tenant.tenantId}, ${p.id}, ${tenant.adminUserId}, 3, 'PURCHASE', ${randomUUID()})
      `
      pending = codeOf(createMovement(boss, opening(p.barcode), first))
      await waitForBlockedLock()
    })

    expect(await pending).toBe('PRODUCT_HAS_MOVEMENTS')
    expect((await movements(p.id)).map((m) => m.reason)).toEqual(['PURCHASE'])
  })
})

describe('eşzamanlılık', () => {
  /**
   * Sıralama `created_at` ile ölçülemez: o sütun transaction'ın BAŞLADIĞI an
   * (`now()`), yani erken başlayıp geç COMMIT eden giriş devirden önce
   * görünebilir. Ölçüt devrin GÖRDÜĞÜ stok: devir yazıldıysa yeni stok tam 5
   * olmalı, yani kilit sırasında önceden uygulanmış hiçbir hareket yoktu.
   */
  it('devir ile giriş aynı anda: devir ya hareketsiz ürüne yazılıyor ya da hiç', async () => {
    for (let i = 0; i < 10; i++) {
      const p = freshProduct()
      const [open] = await Promise.all([
        createMovement(boss, opening(p.barcode), first).then(
          (r) => r,
          (e: unknown) => {
            if (e instanceof AppError && e.code === 'PRODUCT_HAS_MOVEMENTS') return null
            throw e
          },
        ),
        createMovement(boss, purchase(p.barcode), { db: app.db }),
      ])

      const reasons = (await movements(p.id)).map((m) => m.reason)
      // İki sonuç da meşru (kilidi kim önce aldıysa); yanlış olan, devrin
      // başka bir hareketin üstüne yazılması.
      if (open) {
        expect(open.newQty, 'devir başka bir hareketin üstüne yazıldı').toBe(5)
        expect(reasons.sort()).toEqual(['OPENING', 'PURCHASE'])
      } else {
        expect(reasons).toEqual(['PURCHASE'])
      }
    }
  })

  it('aynı devir anahtarıyla iki eşzamanlı çağrı tek kayıt yazıyor', async () => {
    const p = freshProduct()
    const key = randomUUID()
    const [a, b] = await Promise.all([
      createMovement(boss, opening(p.barcode, key), first),
      createMovement(boss, opening(p.barcode, key), first),
    ])

    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true])
    expect((await movements(p.id)).length).toBe(1)
  })

  it('bütün bu hareketlerden sonra defter ile projeksiyon eşit', async () => {
    expect(await checkStockInvariant(tenant.tenantId, { db: app.db })).toEqual([])
  })
})
