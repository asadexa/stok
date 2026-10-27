import { randomUUID } from 'node:crypto'
import { AppError, errorText } from '@stok/shared'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { depots, withTenant } from '@stok/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { checkStockInvariant, createMovement, getStockQty, listMovements } from './movements'
import { createProduct } from './products'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * DEPO BAZLI STOK — Dilim 1
 *
 * Depo miktarı defterden türüyor (ürün + depo bazında `SUM(delta)`); toplam
 * `current_stock`'ta kalıyor. Sınananlar:
 *
 *   - depo kuralı: depo yok → atanmamış (bugünkü davranış), tek depo → o
 *     depo, birden çok depo → DEPOT_REQUIRED
 *   - depo bazlı yetersiz stok: toplam yetse de depo yetmiyorsa çıkış yok
 *   - envanter düzeltmesi: dosyadaki miktar deponun yeni toplamı, fark
 *     kadar COUNT_ADJUST; diğer depolar ve toplam doğru
 *   - önizleme sonrası değişen depo ve atanmamış stok → STOCK_CHANGED
 *   - barkodsuz ürün: ürün kimliğiyle hareket, sahte barkod yok
 *   - kiracı izolasyonu: başka kiracının depo, ürün ve aktarım kimliği
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME, 8)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }
const inv = { db: app.db, inventory: true }

const PRODUCTS = Array.from({ length: 40 }, (_, i) => ({
  sku: `DP-${String(i).padStart(2, '0')}`,
  name: `Depo Ürünü ${i}`,
  salePrice: '20.00',
}))

let plain: TestTenant // deposu olmayan işletme
let single: TestTenant // tek depolu
let multi: TestTenant // iki depolu
let other: TestTenant // başka kiracı
let plainBoss: Actor
let singleBoss: Actor
let boss: Actor
let staff: Actor
let singleDepot: string
let d1: string
let d2: string
let otherDepot: string

async function addDepot(tenantId: string, name: string): Promise<string> {
  const [row] = await admin.client<{ id: string }[]>`
    INSERT INTO depots (tenant_id, name) VALUES (${tenantId}, ${name}) RETURNING id
  `
  return row!.id
}

beforeAll(async () => {
  plain = await seedTestTenant(admin.db, 'depo-yok', PRODUCTS.slice(0, 5))
  single = await seedTestTenant(admin.db, 'depo-tek', PRODUCTS.slice(0, 5))
  multi = await seedTestTenant(admin.db, 'depo-cok', PRODUCTS)
  other = await seedTestTenant(admin.db, 'depo-diger', PRODUCTS.slice(0, 2))

  plainBoss = { tenantId: plain.tenantId, userId: plain.adminUserId, role: 'ADMIN' }
  singleBoss = { tenantId: single.tenantId, userId: single.adminUserId, role: 'ADMIN' }
  boss = { tenantId: multi.tenantId, userId: multi.adminUserId, role: 'ADMIN' }
  staff = { tenantId: multi.tenantId, userId: multi.staffUserId, role: 'STAFF' }

  singleDepot = await addDepot(single.tenantId, 'Merkez Depo')
  d1 = await addDepot(multi.tenantId, 'Depo 1')
  d2 = await addDepot(multi.tenantId, 'Depo 2')
  otherDepot = await addDepot(other.tenantId, 'Depo 1')
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

let next = 0
/** Her test kendi ürününü alıyor: paylaşılan ürün testleri sıraya bağlar. */
const fresh = () => multi.products[`DP-${String(next++).padStart(2, '0')}`]!

function move(
  target: { barcode: string } | { productId: string },
  reason: string,
  qty: number,
  extra: Record<string, unknown> = {},
) {
  return {
    idempotencyKey: randomUUID(),
    ...target,
    qty,
    reason,
    clientCreatedAt: new Date().toISOString(),
    ...extra,
  }
}

function count(
  productId: string,
  depotId: string,
  expectedQty: number,
  targetQty: number,
  idempotencyKey = randomUUID(),
) {
  return {
    idempotencyKey,
    productId,
    depotId,
    expectedQty,
    targetQty,
    clientCreatedAt: new Date().toISOString(),
  }
}

/** Defterden depo miktarı; `null` = depoya atanmamış. */
async function depotQty(productId: string, depotId: string | null): Promise<number> {
  const [row] = await admin.client<{ q: string }[]>`
    SELECT COALESCE(SUM(delta), 0)::text AS q FROM stock_movements
     WHERE product_id = ${productId} AND depot_id IS NOT DISTINCT FROM ${depotId}
  `
  return Number(row!.q)
}

async function ledger(productId: string) {
  return admin.client<
    { reason: string; delta: string; depot_id: string | null; unit_price: string | null; barcode_id: string | null }[]
  >`
    SELECT reason, delta::text, depot_id, unit_price::text, barcode_id
      FROM stock_movements WHERE product_id = ${productId}
     ORDER BY created_at, id
  `
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  )
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (e) {
    if (e instanceof AppError) return e
    throw e
  }
  throw new Error('hata bekleniyordu')
}

describe('depo kuralı', () => {
  it('deposu olmayan işletme: hareket bugünkü gibi depoya atanmamış yazılıyor', async () => {
    const p = plain.products['DP-00']!
    await createMovement(plainBoss, move({ barcode: p.barcode }, 'PURCHASE', 5), opts)
    await createMovement(plainBoss, move({ barcode: p.barcode }, 'SALE', 2), opts)

    expect((await ledger(p.id)).map((m) => m.depot_id)).toEqual([null, null])
    expect(await getStockQty(plainBoss, p.id, opts)).toBe(3)
  })

  it('deposu olmayan işletmede depo kimliği gönderilirse NOT_FOUND', async () => {
    const p = plain.products['DP-01']!
    expect(
      await codeOf(
        createMovement(plainBoss, move({ barcode: p.barcode }, 'PURCHASE', 1, { depotId: d1 }), opts),
      ),
    ).toBe('NOT_FOUND')
  })

  it('tek depo: depo verilmezse hareket o depoya yazılıyor', async () => {
    const p = single.products['DP-00']!
    await createMovement(singleBoss, move({ barcode: p.barcode }, 'PURCHASE', 4), opts)

    expect((await ledger(p.id)).map((m) => m.depot_id)).toEqual([singleDepot])
  })

  it('birden çok depo: depo verilmezse DEPOT_REQUIRED ve defter boş', async () => {
    const p = fresh()
    const err = await errorOf(createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 1), opts))

    expect(err.code).toBe('DEPOT_REQUIRED')
    expect(errorText(err.code, err.details)).toBe(
      'Bu işletmede birden fazla depo var; hareket için depo seçilmeli',
    )
    expect(await ledger(p.id)).toEqual([])
  })

  it('başka kiracının depo kimliği NOT_FOUND; varlığı sızmıyor', async () => {
    const p = fresh()
    expect(
      await codeOf(
        createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 1, { depotId: otherDepot }), opts),
      ),
    ).toBe('NOT_FOUND')
    expect(
      await codeOf(
        createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 1, { depotId: randomUUID() }), opts),
      ),
    ).toBe('NOT_FOUND')
    expect(await ledger(p.id)).toEqual([])
  })
})

describe('depo bazlı yetersiz stok', () => {
  it('toplam yetse de depo yetmiyorsa çıkış reddediliyor; diğer depo değişmiyor', async () => {
    const p = fresh()
    await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 3, { depotId: d1 }), opts)
    await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 10, { depotId: d2 }), opts)

    const err = await errorOf(
      createMovement(staff, move({ barcode: p.barcode }, 'SALE', 5, { depotId: d1 }), opts),
    )
    expect(err.code).toBe('INSUFFICIENT_STOCK')
    expect(err.details).toMatchObject({ depotId: d1, available: 3, requested: 5 })
    expect(errorText(err.code, err.details)).toBe('Depo 1 deposunda 3 adet var, 5 adet çıkışı yapılamaz')

    expect(await depotQty(p.id, d1)).toBe(3)
    expect(await depotQty(p.id, d2)).toBe(10)
  })

  it('aynı depodan yetecek kadar çıkış yazılıyor', async () => {
    const p = fresh()
    await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 3, { depotId: d1 }), opts)
    await createMovement(staff, move({ barcode: p.barcode }, 'SALE', 3, { depotId: d1 }), opts)

    expect(await depotQty(p.id, d1)).toBe(0)
  })

  it('yönetici allowNegative ile depoyu eksiye düşürebiliyor (bugünkü yetki)', async () => {
    const p = fresh()
    await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 10, { depotId: d2 }), opts)
    await createMovement(
      boss,
      move({ barcode: p.barcode }, 'SALE', 2, { depotId: d1, allowNegative: true }),
      opts,
    )

    expect(await depotQty(p.id, d1)).toBe(-2)
    expect(await getStockQty(boss, p.id, opts)).toBe(8)
  })

  it('aynı depodan eşzamanlı iki çıkış: depo hiçbir sırada eksiye düşmüyor', async () => {
    for (let i = 0; i < 5; i++) {
      const p = fresh()
      await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 5, { depotId: d1 }), opts)
      await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 50, { depotId: d2 }), opts)

      const results = await Promise.all(
        [0, 1].map(() =>
          codeOf(createMovement(staff, move({ barcode: p.barcode }, 'SALE', 3, { depotId: d1 }), opts)),
        ),
      )
      // Biri yazılıyor, diğeri depo kilidin arkasında 2 adet görüp reddediliyor.
      expect(results.sort()).toEqual(['INSUFFICIENT_STOCK', null].sort())
      expect(await depotQty(p.id, d1)).toBe(2)
    }
  })
})

describe('envanter düzeltmesi (COUNT_ADJUST)', () => {
  it('K1: 10 + 20 → yalnız depo 1 sayımı 5 → 5 + 20 = 25', async () => {
    const p = fresh()
    await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 10, { depotId: d1 }), opts)
    await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 20, { depotId: d2 }), opts)

    const res = await createMovement(boss, count(p.id, d1, 10, 5), inv)

    expect(res).toMatchObject({ delta: -5, newQty: 25, duplicate: false })
    expect(await depotQty(p.id, d1)).toBe(5)
    expect(await depotQty(p.id, d2)).toBe(20)
    expect(await getStockQty(boss, p.id, opts)).toBe(25)
    const last = (await ledger(p.id)).at(-1)!
    // Sebep ve işaret sunucudan; fiyat yok (sayım para el değiştirmiyor).
    expect(last).toMatchObject({ reason: 'COUNT_ADJUST_DOWN', depot_id: d1, unit_price: null })
    expect(Number(last.delta)).toBe(-5)
  })

  it('artış: işaret ve sebep farktan türüyor', async () => {
    const p = fresh()
    await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 2, { depotId: d2 }), opts)

    const res = await createMovement(boss, count(p.id, d2, 2, 9), inv)

    expect(res.delta).toBe(7)
    expect((await ledger(p.id)).at(-1)!.reason).toBe('COUNT_ADJUST_UP')
    expect(await depotQty(p.id, d2)).toBe(9)
  })

  it('hiç hareketi olmayan, fiyatsız ürüne ilk hareket fiyatsız COUNT_ADJUST_UP', async () => {
    // Fiyatı bilinmeyen ürünün miktarı güncellenebilmeli (K2). PRC-05 yalnız
    // OPENING'i bağlıyor; sonraki devir denemesi "üründe hareket var" ile atlanıyor.
    const created = await createProduct(
      boss,
      { sku: `FIYATSIZ-${randomUUID().slice(0, 8)}`, name: 'Fiyatsız Barkodsuz Ürün' },
      opts,
    )
    const id = created.productId

    const res = await createMovement(boss, count(id, d1, 0, 7), inv)
    expect(res).toMatchObject({ delta: 7, newQty: 7 })
    expect(await ledger(id)).toEqual([
      { reason: 'COUNT_ADJUST_UP', delta: '7.000', depot_id: d1, unit_price: null, barcode_id: null },
    ])

    expect(
      await codeOf(
        createMovement(
          boss,
          move({ productId: id }, 'OPENING', 3, { depotId: d1, unitPrice: 4 }),
          { db: app.db, requireFirstMovement: true },
        ),
      ),
    ).toBe('PRODUCT_HAS_MOVEMENTS')
  })

  it('önizlemeden sonra depo değiştiyse STOCK_CHANGED ve hareket yazılmıyor', async () => {
    const p = fresh()
    await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 10, { depotId: d1 }), opts)
    // Önizleme 10 gördü; o arada 3 satıldı.
    await createMovement(staff, move({ barcode: p.barcode }, 'SALE', 3, { depotId: d1 }), opts)

    const err = await errorOf(createMovement(boss, count(p.id, d1, 10, 5), inv))

    expect(err.code).toBe('STOCK_CHANGED')
    expect(err.details).toMatchObject({ reason: 'DEPOT_QTY', expected: 10, actual: 7 })
    expect(await depotQty(p.id, d1)).toBe(7)
  })

  it('depoya atanmamış eski stok varken satır yazılmıyor (çift sayım yok)', async () => {
    const p = fresh()
    // Depolardan ÖNCE yazılmış eski hareket: deposu NULL. Trigger projeksiyonu
    // güncelliyor, yani toplam 6.
    await admin.client`
      INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, reason, idempotency_key)
      VALUES (${multi.tenantId}, ${p.id}, ${multi.adminUserId}, 6, 'PURCHASE', ${randomUUID()})
    `

    const err = await errorOf(createMovement(boss, count(p.id, d1, 0, 4), inv))

    expect(err.code).toBe('STOCK_CHANGED')
    expect(err.details).toMatchObject({ reason: 'UNASSIGNED', unassigned: 6 })
    expect(errorText(err.code, err.details)).toBe(
      'Bu üründe depoya atama bekleyen stok var; envanter satırı yazılmadı',
    )
    expect(await depotQty(p.id, null)).toBe(6)
    expect(await depotQty(p.id, d1)).toBe(0)
  })

  it('aynı anahtarla tekrar: duplicate, ikinci hareket yok (beklenen artık eski olsa da)', async () => {
    const p = fresh()
    await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 10, { depotId: d1 }), opts)
    const key = randomUUID()

    await createMovement(boss, count(p.id, d1, 10, 4, key), inv)
    const again = await createMovement(boss, count(p.id, d1, 10, 4, key), inv)

    expect(again.duplicate).toBe(true)
    expect((await ledger(p.id)).filter((m) => m.reason.startsWith('COUNT_ADJUST'))).toHaveLength(1)
    expect(await depotQty(p.id, d1)).toBe(4)
  })

  it('çalışan envanter düzeltmesi yapamıyor (count:approve)', async () => {
    const p = fresh()
    expect(await codeOf(createMovement(staff, count(p.id, d1, 0, 5), inv))).toBe('FORBIDDEN')
    expect(await ledger(p.id)).toEqual([])
  })

  it('COUNT_ADJUST normal hareket şemasından geçemiyor', async () => {
    const p = fresh()
    expect(
      await codeOf(
        createMovement(boss, move({ barcode: p.barcode }, 'COUNT_ADJUST_UP', 5, { depotId: d1 }), opts),
      ),
    ).toBe('VALIDATION_FAILED')
    expect(await ledger(p.id)).toEqual([])
  })

  it('negatif hedef, sıfır fark ve adetli üründe kesirli hedef reddediliyor', async () => {
    const p = fresh()
    await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 3, { depotId: d1 }), opts)

    expect(await codeOf(createMovement(boss, count(p.id, d1, 3, -1), inv))).toBe('INVALID_QUANTITY')
    expect(await codeOf(createMovement(boss, count(p.id, d1, 3, 3), inv))).toBe('VALIDATION_FAILED')
    // Fark (2) tam sayı ama hedef 2,5 adet olurdu.
    expect(await codeOf(createMovement(boss, count(p.id, d1, 0.5, 2.5), inv))).toBe(
      'INVALID_QUANTITY',
    )
    expect(await depotQty(p.id, d1)).toBe(3)
  })

  it('depo zorunlu: depo kimliği başka kiracınınsa NOT_FOUND', async () => {
    const p = fresh()
    expect(await codeOf(createMovement(boss, count(p.id, otherDepot, 0, 5), inv))).toBe('NOT_FOUND')
    expect(await ledger(p.id)).toEqual([])
  })

  describe('kilit sonrası kontrol (deterministik)', () => {
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
      throw new Error('envanter çağrısı kilitte beklemedi')
    }

    it('kilit tutulurken araya giren satış COMMIT edilince envanter STOCK_CHANGED', async () => {
      const p = fresh()
      await createMovement(boss, move({ barcode: p.barcode }, 'PURCHASE', 10, { depotId: d1 }), opts)
      let pending: Promise<string | null> | undefined

      // Başka bir yazanı taklit ediyoruz: ürün satırını kilitleyip depo 1'den
      // satış yazıyor; envanter çağrısı kilitte beklerken COMMIT ediyor.
      await admin.client.begin(async (sql) => {
        await sql`
          SELECT qty FROM current_stock
           WHERE tenant_id = ${multi.tenantId} AND product_id = ${p.id}
             FOR UPDATE
        `
        await sql`
          INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, reason, idempotency_key, depot_id)
          VALUES (${multi.tenantId}, ${p.id}, ${multi.adminUserId}, -3, 'SALE', ${randomUUID()}, ${d1})
        `
        pending = codeOf(createMovement(boss, count(p.id, d1, 10, 5), inv))
        await waitForBlockedLock()
      })

      expect(await pending).toBe('STOCK_CHANGED')
      expect(await depotQty(p.id, d1)).toBe(7)
    })
  })
})

describe('barkodsuz ürün ve ürün kimliğiyle hareket', () => {
  it('barkodsuz ürün kimlikle hareket alıyor; barkod alanı boş, geçmişte görünüyor', async () => {
    const created = await createProduct(
      boss,
      { sku: `BARKODSUZ-${randomUUID().slice(0, 8)}`, name: 'Barkodsuz Ürün', barcodes: [] },
      opts,
    )
    const id = created.productId

    await createMovement(boss, move({ productId: id }, 'PURCHASE', 4, { depotId: d2 }), opts)
    await createMovement(staff, move({ productId: id }, 'SALE', 1, { depotId: d2 }), opts)

    expect((await ledger(id)).map((m) => m.barcode_id)).toEqual([null, null])
    expect(await depotQty(id, d2)).toBe(3)
    const rows = await listMovements(boss, {}, opts)
    expect(rows.filter((r) => r.productId === id)).toHaveLength(2)
  })

  it('barkod ve kimlik birlikte ya da hiçbiri: VALIDATION_FAILED', async () => {
    const p = fresh()
    expect(
      await codeOf(
        createMovement(
          boss,
          { ...move({ barcode: p.barcode }, 'PURCHASE', 1, { depotId: d1 }), productId: p.id },
          opts,
        ),
      ),
    ).toBe('VALIDATION_FAILED')
    const neither = {
      idempotencyKey: randomUUID(),
      qty: 1,
      reason: 'PURCHASE',
      depotId: d1,
      clientCreatedAt: new Date().toISOString(),
    }
    expect(await codeOf(createMovement(boss, neither, opts))).toBe('VALIDATION_FAILED')
    expect(await ledger(p.id)).toEqual([])
  })

  it('başka kiracının ürün kimliği NOT_FOUND', async () => {
    const foreign = other.products['DP-00']!
    expect(
      await codeOf(
        createMovement(boss, move({ productId: foreign.id }, 'PURCHASE', 1, { depotId: d1 }), opts),
      ),
    ).toBe('NOT_FOUND')
    expect(await ledger(foreign.id)).toEqual([])
  })
})

describe('depo adı ve kiracı izolasyonu', () => {
  it('ad kırpılıp boşlukları teklenerek tekil: "  MERKEZ   depo " ile "Merkez Depo" aynı', async () => {
    const t = single.tenantId
    await expect(addDepot(t, '  MERKEZ   depo ')).rejects.toMatchObject({ code: '23505' })
    const [row] = await admin.client<{ name_key: string }[]>`
      SELECT name_key FROM depots WHERE id = ${singleDepot}
    `
    expect(row!.name_key).toBe('merkez depo')
  })

  it('boş ya da kontrol karakterli ad veritabanında reddediliyor', async () => {
    await expect(addDepot(single.tenantId, '   ')).rejects.toMatchObject({ code: '23514' })
    await expect(addDepot(single.tenantId, 'Depo\tA')).rejects.toMatchObject({ code: '23514' })
  })

  it('başka kiracının deposu uygulama rolüyle görünmüyor', async () => {
    const seen = await withTenant(
      multi.tenantId,
      (tx) => tx.select({ id: depots.id }).from(depots),
      app.db,
    )
    expect(seen.map((r) => r.id).sort()).toEqual([d1, d2].sort())
  })

  it('hareket başka kiracının aktarımına bağlanamıyor (kiracı + aktarım yabancı anahtarı)', async () => {
    const p = fresh()
    const [run] = await admin.client<{ id: string }[]>`
      INSERT INTO import_runs (tenant_id, created_by, file_name, file_bytes, total_rows, columns)
      VALUES (${other.tenantId}, ${other.adminUserId}, 'x.csv', 1, 1, '[]'::jsonb)
      RETURNING id
    `
    await expect(
      admin.client`
        INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, reason, idempotency_key, import_run_id)
        VALUES (${multi.tenantId}, ${p.id}, ${multi.adminUserId}, 1, 'COUNT_ADJUST_UP', ${randomUUID()}, ${run!.id})
      `,
    ).rejects.toMatchObject({ code: '23503' })
  })
})

describe('defter', () => {
  it('bütün bu hareketlerden sonra defter ile projeksiyon eşit', async () => {
    for (const t of [plain, single, multi, other]) {
      expect(await checkStockInvariant(t.tenantId, opts)).toEqual([])
    }
  })
})
