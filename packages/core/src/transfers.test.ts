import { randomUUID } from 'node:crypto'
import { AppError } from '@stok/shared'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { dailySummary } from './cron'
import { checkStockInvariant, createMovement, getStockQty, transferStock } from './movements'
import { dashboardSummary } from './stock'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T223 — ATANMAMIŞ STOĞU DEPOYA ATAMA (`transferStock`)
 *
 * Sınananlar: kısmi ve tam atama; iki satır aynı transaction'da ve aynı
 * `transfer_id` ile; toplam, fiyat ve göstergeler değişmiyor; yetersiz ve eksi
 * kaynak; yetki ve kiracı izolasyonu; kilit altında araya giren çıkış;
 * sıralı ve eşzamanlı çift gönderim; ikinci satır yazılamazsa kısmi kayıt
 * yok; DB CHECK'leri; tam atamadan sonra T232 düzeltmesi geçiyor.
 * Eski stok, depolar gelmeden önce yazılmış gibi doğrudan deftere ekleniyor.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME, 8)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }

const PRODUCTS = Array.from({ length: 30 }, (_, i) => ({
  sku: `TR-${String(i).padStart(2, '0')}`,
  name: `Transfer Ürünü ${i}`,
  purchasePrice: '5.00',
  salePrice: '9.00',
}))

let t: TestTenant
let other: TestTenant
let boss: Actor
let staff: Actor
let depotA: string
let depotB: string
let otherDepot: string

async function addDepot(tenantId: string, name: string): Promise<string> {
  const [row] = await admin.client<{ id: string }[]>`
    INSERT INTO depots (tenant_id, name) VALUES (${tenantId}, ${name}) RETURNING id
  `
  return row!.id
}

beforeAll(async () => {
  t = await seedTestTenant(admin.db, 'transfer', PRODUCTS)
  other = await seedTestTenant(admin.db, 'transfer-diger', PRODUCTS.slice(0, 2))
  boss = { tenantId: t.tenantId, userId: t.adminUserId, role: 'ADMIN' }
  staff = { tenantId: t.tenantId, userId: t.staffUserId, role: 'STAFF' }
  depotA = await addDepot(t.tenantId, 'Depo A')
  depotB = await addDepot(t.tenantId, 'Depo B')
  otherDepot = await addDepot(other.tenantId, 'Diğer Depo')
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

let next = 0
const fresh = () => t.products[`TR-${String(next++).padStart(2, '0')}`]!

/** Depolardan önce yazılmış eski hareket: deposu NULL (trigger projeksiyonu günceller). */
async function legacy(productId: string, delta: number, reason = 'PURCHASE') {
  await admin.client`
    INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, reason, idempotency_key)
    VALUES (${t.tenantId}, ${productId}, ${t.adminUserId}, ${delta}, ${reason}, ${randomUUID()})
  `
}

function assign(productId: string, qty: number, extra: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    productId,
    fromDepotId: null,
    toDepotId: depotA,
    qty,
    clientCreatedAt: new Date().toISOString(),
    ...extra,
  }
}

async function bucket(productId: string, depotId: string | null): Promise<number> {
  const [row] = await admin.client<{ q: string }[]>`
    SELECT COALESCE(SUM(delta), 0)::text AS q FROM stock_movements
     WHERE product_id = ${productId} AND depot_id IS NOT DISTINCT FROM ${depotId}
  `
  return Number(row!.q)
}

async function transferRows(productId: string) {
  return admin.client<
    { reason: string; delta: string; depot_id: string | null; transfer_id: string | null; unit_price: string | null; list_price: string | null; note: string | null; xmin: string }[]
  >`
    SELECT reason, delta::text, depot_id, transfer_id, unit_price::text, list_price::text, note, xmin::text
      FROM stock_movements
     WHERE product_id = ${productId} AND reason IN ('TRANSFER_OUT', 'TRANSFER_IN')
     ORDER BY reason DESC
  `
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  )
}

async function waitForBlocked(count: number) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const [row] = await admin.client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE NOT l.granted AND a.datname = current_database()
    `
    if (row!.n >= count) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`${count} istek kilitte beklemedi`)
}

describe('atama', () => {
  it('kısmi: atanmamış 10 → 6, Depo A +4; iki satır tek transaction ve tek transfer_id, fiyatsız', async () => {
    const p = fresh()
    await legacy(p.id, 10)

    const res = await transferStock(boss, assign(p.id, 4, { note: 'raf sayımı' }), opts)

    expect(res).toMatchObject({ qty: 4, newQty: 10, duplicate: false })
    expect(await bucket(p.id, null)).toBe(6)
    expect(await bucket(p.id, depotA)).toBe(4)
    expect(await getStockQty(boss, p.id, opts)).toBe(10)

    const rows = await transferRows(p.id)
    expect(rows.map((r) => [r.reason, Number(r.delta), r.depot_id])).toEqual([
      ['TRANSFER_OUT', -4, null],
      ['TRANSFER_IN', 4, depotA],
    ])
    expect(new Set(rows.map((r) => r.transfer_id))).toEqual(new Set([res.transferId]))
    // Aynı transaction: iki satırın xmin'i (yazan transaction kimliği) aynı.
    expect(rows[0]!.xmin).toBe(rows[1]!.xmin)
    expect(rows.every((r) => r.unit_price === null && r.list_price === null)).toBe(true)
    expect(rows[0]!.note).toBe('Depoya atama: Atanmamış stok → Depo A: raf sayımı')
    expect(await checkStockInvariant(t.tenantId, opts)).toEqual([])
  })

  it('tam atama sonrası atanmamış 0; T232 sayım düzeltmesi artık geçiyor', async () => {
    const p = fresh()
    await legacy(p.id, 10)
    const before = await codeOf(
      createMovement(
        boss,
        { idempotencyKey: randomUUID(), productId: p.id, depotId: depotA, expectedQty: 0, targetQty: 7, clientCreatedAt: new Date().toISOString() },
        { db: app.db, inventory: true },
      ),
    )
    expect(before).toBe('STOCK_CHANGED')

    await transferStock(boss, assign(p.id, 10), opts)
    expect(await bucket(p.id, null)).toBe(0)

    const adjusted = await createMovement(
      boss,
      { idempotencyKey: randomUUID(), productId: p.id, depotId: depotA, expectedQty: 10, targetQty: 7, clientCreatedAt: new Date().toISOString() },
      { db: app.db, inventory: true },
    )
    expect(adjusted).toMatchObject({ delta: -3, newQty: 7 })
  })

  it('yetersiz ve eksi kaynak: INSUFFICIENT_STOCK, hiçbir satır yok', async () => {
    const p = fresh()
    await legacy(p.id, 10)
    expect(await codeOf(transferStock(boss, assign(p.id, 11), opts))).toBe('INSUFFICIENT_STOCK')

    const n = fresh()
    await legacy(n.id, -3, 'SALE')
    expect(await codeOf(transferStock(boss, assign(n.id, 1), opts))).toBe('INSUFFICIENT_STOCK')

    expect(await transferRows(p.id)).toEqual([])
    expect(await transferRows(n.id)).toEqual([])
    expect(await bucket(p.id, null)).toBe(10)
  })

  it('miktar ve girdi: 0, eksi, birime uymayan, depodan kaynak ve uzun not reddediliyor', async () => {
    const p = fresh()
    await legacy(p.id, 10)

    expect(await codeOf(transferStock(boss, assign(p.id, 0), opts))).toBe('INVALID_QUANTITY')
    expect(await codeOf(transferStock(boss, assign(p.id, -1), opts))).toBe('INVALID_QUANTITY')
    expect(await codeOf(transferStock(boss, assign(p.id, 2.5), opts))).toBe('INVALID_QUANTITY')
    // Depodan depoya transfer bu sürümde yok (T233).
    expect(await codeOf(transferStock(boss, assign(p.id, 1, { fromDepotId: depotB }), opts))).toBe(
      'VALIDATION_FAILED',
    )
    // Kullanıcı notu tek başına 500'e sığsa da sabit açıklamayla birlikte sığmıyor.
    expect(await codeOf(transferStock(boss, assign(p.id, 1, { note: 'x'.repeat(480) }), opts))).toBe(
      'VALIDATION_FAILED',
    )
    expect(await transferRows(p.id)).toEqual([])
  })

  it('çalışan, başka kiracının deposu ve ürünü reddediliyor', async () => {
    const p = fresh()
    await legacy(p.id, 5)

    expect(await codeOf(transferStock(staff, assign(p.id, 1), opts))).toBe('FORBIDDEN')
    expect(await codeOf(transferStock(boss, assign(p.id, 1, { toDepotId: otherDepot }), opts))).toBe(
      'NOT_FOUND',
    )
    const foreign = other.products['TR-00']!
    expect(await codeOf(transferStock(boss, assign(foreign.id, 1), opts))).toBe('NOT_FOUND')

    expect(await transferRows(p.id)).toEqual([])
    expect(await bucket(p.id, null)).toBe(5)
  })

  it('TRANSFER_* normal hareket şemasından seçilemiyor', async () => {
    const p = fresh()
    for (const reason of ['TRANSFER_IN', 'TRANSFER_OUT']) {
      expect(
        await codeOf(
          createMovement(
            boss,
            { idempotencyKey: randomUUID(), barcode: p.barcode, qty: 1, reason, depotId: depotA, clientCreatedAt: new Date().toISOString() },
            opts,
          ),
        ),
      ).toBe('VALIDATION_FAILED')
    }
  })

  it('DB CHECK: transfer sebebi transfer_id olmadan, transfer_id başka sebeple yazılamıyor', async () => {
    const p = fresh()
    const insert = (reason: string, transferId: string | null) =>
      admin.client`
        INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, reason, idempotency_key, transfer_id)
        VALUES (${t.tenantId}, ${p.id}, ${t.adminUserId}, 1, ${reason}, ${randomUUID()}, ${transferId})
      `.then(
        () => 'OK',
        (e: { constraint_name?: string }) => e.constraint_name ?? String(e),
      )

    expect(await insert('TRANSFER_IN', null)).toBe('movements_transfer_id_ck')
    expect(await insert('PURCHASE', randomUUID())).toBe('movements_transfer_id_ck')
  })
})

describe('tekrar ve eşzamanlılık', () => {
  it('sıralı çift gönderim: aynı anahtar ikinci çift yazmıyor, aynı sonucu dönüyor', async () => {
    const p = fresh()
    await legacy(p.id, 10)
    const body = assign(p.id, 3)

    const first = await transferStock(boss, body, opts)
    const again = await transferStock(boss, body, opts)

    expect(again).toMatchObject({ transferId: first.transferId, qty: 3, duplicate: true })
    expect(await transferRows(p.id)).toHaveLength(2)
    expect(await bucket(p.id, null)).toBe(7)
  })

  it('eşzamanlı çift gönderim (tam atama): tek çift; iki istek de aynı transferi dönüyor', async () => {
    const p = fresh()
    await legacy(p.id, 10)
    const body = assign(p.id, 10)

    let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof transferStock>>>[]> | undefined
    // İki istek ürün kilidinde birlikte bekliyor; kilit bırakılınca biri yazıyor,
    // diğeri kilit altında onun çiftini buluyor. Kilit altındaki ikinci bakış
    // olmasaydı ikinci istek "yetersiz stok" alırdı.
    await admin.client.begin(async (sql) => {
      await sql`SELECT qty FROM current_stock WHERE tenant_id = ${t.tenantId} AND product_id = ${p.id} FOR UPDATE`
      pending = Promise.allSettled([transferStock(boss, body, opts), transferStock(boss, body, opts)])
      await waitForBlocked(2)
    })
    const results = await pending!

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof transferStock>>>).value)
    expect(values.map((v) => v.transferId)).toEqual([body.idempotencyKey, body.idempotencyKey])
    expect(values.map((v) => v.duplicate).sort()).toEqual([false, true])
    expect(await transferRows(p.id)).toHaveLength(2)
    expect(await bucket(p.id, null)).toBe(0)
    expect(await bucket(p.id, depotA)).toBe(10)
  })

  it('eşzamanlı iki farklı tam atama: biri geçiyor, diğeri INSUFFICIENT_STOCK', async () => {
    const p = fresh()
    await legacy(p.id, 10)

    const codes = await Promise.all([
      codeOf(transferStock(boss, assign(p.id, 10), opts)),
      codeOf(transferStock(boss, assign(p.id, 10, { toDepotId: depotB }), opts)),
    ])

    expect(codes.sort()).toEqual(['INSUFFICIENT_STOCK', null].sort())
    expect(await transferRows(p.id)).toHaveLength(2)
    expect(await getStockQty(boss, p.id, opts)).toBe(10)
  })

  it('kilit tutulurken atanmamıştan çıkış COMMIT edilince atama yetersiz kalıyor', async () => {
    const p = fresh()
    await legacy(p.id, 10)
    let pending: Promise<string | null> | undefined

    await admin.client.begin(async (sql) => {
      await sql`SELECT qty FROM current_stock WHERE tenant_id = ${t.tenantId} AND product_id = ${p.id} FOR UPDATE`
      await sql`
        INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, reason, idempotency_key)
        VALUES (${t.tenantId}, ${p.id}, ${t.adminUserId}, -5, 'SALE', ${randomUUID()})
      `
      pending = codeOf(transferStock(boss, assign(p.id, 10), opts))
      await waitForBlocked(1)
    })

    expect(await pending).toBe('INSUFFICIENT_STOCK')
    expect(await bucket(p.id, null)).toBe(5)
    expect(await transferRows(p.id)).toEqual([])
  })

  it('ikinci satır yazılamazsa birincisi de yok (atomiklik)', async () => {
    const p = fresh()
    await legacy(p.id, 10)
    const body = assign(p.id, 4)
    // `:in` anahtarını önceden başka bir satır tutuyor: ikinci insert UNIQUE ihlali.
    await admin.client`
      INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, reason, idempotency_key)
      VALUES (${t.tenantId}, ${fresh().id}, ${t.adminUserId}, 1, 'PURCHASE', ${`${body.idempotencyKey}:in`})
    `

    expect(await codeOf(transferStock(boss, body, opts))).toBe('SERVER_ERROR')
    expect(await transferRows(p.id)).toEqual([])
    expect(await bucket(p.id, null)).toBe(10)
    expect(await bucket(p.id, depotA)).toBe(0)
  })
})

describe('göstergeler', () => {
  it('panel, 14 günlük grafik ve gün sonu özeti transferi saymıyor', async () => {
    const p = fresh()
    await legacy(p.id, 10)
    const [today] = await admin.client<{ day: string }[]>`SELECT current_date::text AS day`
    const day = today!.day
    const since = new Date(Date.now() - 24 * 3600 * 1000)

    const panelBefore = await dashboardSummary(boss, since, opts)
    const dailyBefore = await dailySummary(t.tenantId, day, opts)

    await transferStock(boss, assign(p.id, 6), opts)

    const panelAfter = await dashboardSummary(boss, since, opts)
    const dailyAfter = await dailySummary(t.tenantId, day, opts)

    expect(panelAfter.today).toEqual(panelBefore.today)
    expect(panelAfter.activity).toEqual(panelBefore.activity)
    expect(panelAfter.stockValue).toBe(panelBefore.stockValue)
    expect({ n: dailyAfter.movementCount, i: dailyAfter.inQty, o: dailyAfter.outQty }).toEqual({
      n: dailyBefore.movementCount,
      i: dailyBefore.inQty,
      o: dailyBefore.outQty,
    })
    // Ayrıntı listesinde ise iki bacak da duruyor.
    expect(dailyAfter.rows.length).toBe(dailyBefore.rows.length + 2)
  })
})
