import { randomUUID } from 'node:crypto'
import { AppError, DEFAULT_MIN_STOCK, isCriticalStock, isOutOfStock } from '@stok/shared'
import { type TestTenant, seedOpeningStock, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { createLowStockHandler, dailySummary, dayKey, lowStockProducts } from './cron'
import { planExport } from './exports'
import type { JobRecord } from './jobs'
import { createInMemoryTransport } from './mail'
import { createMovement } from './movements'
import { createProduct, getProductDetail, setProductThreshold, updateProduct } from './products'
import { alertSummary, categorySummary, dashboardSummary, listStock } from './stock'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T244 — KRİTİK STOK VE "STOK YOK" (PRD-25)
 *
 * Kural: stok ≤ 0 "Stok yok"; 0 < stok ≤ eşik "Kritik". Eskiden kritik
 * `stok ≤ eşik` idi ve eşiği 0 olan her tükenmiş ürün zili, paneli ve kritik
 * stok e-postasını dolduruyordu.
 *
 * Asıl risk kuralın bir yüzeyde eski kalması: zil "3" derken liste iki satır
 * göstermek ya da e-postanın tükenmiş ürünü yine yollaması. Bu yüzden her
 * yüzey AYNI örnek tablosuna karşı sınanıyor.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }

let tenant: TestTenant
let boss: Actor
let staff: Actor

// Örnek tablo (PLAN v3): sku → [stok, eşik].
const EXAMPLES = {
  'SL-ZERO': { qty: '0', min: '3', critical: false, out: true }, // stok 0, eşik 3
  'SL-EQ': { qty: '3', min: '3', critical: true, out: false }, // stok 3, eşik 3
  'SL-BELOW': { qty: '2', min: '3', critical: true, out: false }, // stok 2, eşik 3
  'SL-ABOVE': { qty: '4', min: '3', critical: false, out: false }, // stok 4, eşik 3
  'SL-NOTRACK': { qty: '5', min: '0', critical: false, out: false }, // eşik 0 = takip yok
  'SL-ZERO0': { qty: '0', min: '0', critical: false, out: true }, // eşik 0, stok 0
  'SL-NEG': { qty: '-2', min: '3', critical: false, out: true }, // eksi stok
} as const

const CRITICAL = Object.entries(EXAMPLES)
  .filter(([, e]) => e.critical)
  .map(([sku]) => sku)
  .sort()
const OUT = Object.entries(EXAMPLES)
  .filter(([, e]) => e.out)
  .map(([sku]) => sku)
  .sort()

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'stock-levels', [
    ...Object.entries(EXAMPLES).map(([sku, e]) => ({
      sku,
      name: `Örnek ${sku}`,
      minStock: e.min,
      category: 'Örnek',
    })),
    // Arşivli ürünler hiçbir kümeye girmiyor.
    { sku: 'SL-ARCH-0', name: 'Arşiv Sıfır', minStock: '3', archived: true, category: 'Örnek' },
    { sku: 'SL-ARCH-2', name: 'Arşiv İki', minStock: '3', archived: true, category: 'Örnek' },
  ])
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }

  for (const [sku, e] of Object.entries(EXAMPLES)) {
    if (e.qty === '0') continue
    if (e.qty.startsWith('-')) {
      // Eksi stok gerçek yazma kapısından, yöneticinin bilinçli izniyle.
      await createMovement(
        boss,
        {
          idempotencyKey: randomUUID(),
          barcode: tenant.products[sku]!.barcode,
          qty: Number(e.qty.slice(1)),
          reason: 'SALE',
          allowNegative: true,
          clientCreatedAt: new Date().toISOString(),
        },
        opts,
      )
    } else {
      await seedOpeningStock(admin.db, tenant, tenant.products[sku]!.id, e.qty)
    }
  }
  await seedOpeningStock(admin.db, tenant, tenant.products['SL-ARCH-2']!.id, '2')
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

async function skus(q: Record<string, unknown>): Promise<string[]> {
  const page = await listStock(boss, { ...q, limit: 200 }, opts)
  return page.rows.map((r) => r.sku).sort()
}

describe('T244 - kural, TS yarısı', () => {
  it('örnek tablosunun her satırı', () => {
    for (const [sku, e] of Object.entries(EXAMPLES)) {
      expect(isCriticalStock(Number(e.qty), Number(e.min)), `${sku} kritik`).toBe(e.critical)
      expect(isOutOfStock(Number(e.qty)), `${sku} stok yok`).toBe(e.out)
    }
  })
})

describe('T244 - kritik kümesi bütün yüzeylerde aynı', () => {
  it('stok listesi süzgeci örnek tablosunu veriyor', async () => {
    expect(await skus({ onlyCritical: true })).toEqual(CRITICAL)
  })

  it('satırdaki kritik bayrağı süzgeçle aynı', async () => {
    const page = await listStock(boss, { search: 'SL-', limit: 200 }, opts)
    const flagged = page.rows.filter((r) => r.critical).map((r) => r.sku).sort()
    expect(flagged).toEqual(CRITICAL)
  })

  it('zil, panel, kategori, Excel ve gün sonu raporu aynı sayıyı veriyor', async () => {
    const n = CRITICAL.length
    expect((await alertSummary(boss, opts)).criticalCount).toBe(n)
    expect((await dashboardSummary(boss, new Date(), opts)).criticalCount).toBe(n)
    const categories = await categorySummary(boss, opts)
    expect(categories.reduce((s, c) => s + c.criticalCount, 0)).toBe(n)
    expect((await planExport(boss, 'STOCK_EXPORT', { onlyCritical: true }, opts)).rowCount).toBe(n)
    expect((await dailySummary(tenant.tenantId, dayKey(new Date()), opts)).criticalCount).toBe(n)
  })

  it('kritik stok e-postası listesi aynı küme; stoğu biten ürün yok', async () => {
    const rows = await lowStockProducts(tenant.tenantId, opts)
    expect(rows.map((r) => r.sku).sort()).toEqual(CRITICAL)
  })

  it('e-posta gövdesi stoğu biten ürünü içermiyor', async () => {
    const mail = createInMemoryTransport()
    const job = {
      id: randomUUID(),
      tenantId: tenant.tenantId,
      notifyEmail: 'patron@stock-levels.test',
    } as unknown as JobRecord
    const result = await createLowStockHandler(mail, opts)(job)
    expect(result).toMatchObject({ criticalCount: CRITICAL.length, sent: true })
    const body = mail.sent[0]!.text
    expect(mail.sent[0]!.subject).toBe(`Kritik stok: ${CRITICAL.length} ürün`)
    for (const sku of CRITICAL) expect(body).toContain(sku)
    for (const sku of OUT) expect(body).not.toContain(`(${sku})`)
  })

  it('yalnız stoğu biten ürünler varsa kritik e-postası gönderilmiyor', async () => {
    const t = await seedTestTenant(admin.db, 'stock-levels-bos', [
      { sku: 'BOS-1', name: 'Bitti', minStock: '3' },
    ])
    const mail = createInMemoryTransport()
    const job = { id: randomUUID(), tenantId: t.tenantId, notifyEmail: 'x@y.test' } as unknown as JobRecord
    expect(await createLowStockHandler(mail, opts)(job)).toMatchObject({ criticalCount: 0, sent: false })
    expect(mail.sent).toHaveLength(0)
    const tBoss: Actor = { tenantId: t.tenantId, userId: t.adminUserId, role: 'ADMIN' }
    expect((await alertSummary(tBoss, opts)).criticalCount).toBe(0)
  })
})

describe('T244 - "Stok yok" kümesi', () => {
  it('stok listesi ve Excel aynı kümeyi veriyor; arşivli yok', async () => {
    expect(await skus({ onlyOutOfStock: true })).toEqual(OUT)
    const page = await listStock(boss, { onlyOutOfStock: true }, opts)
    expect(page.total).toBe(OUT.length)
    expect((await planExport(boss, 'STOCK_EXPORT', { onlyOutOfStock: true }, opts)).rowCount).toBe(
      OUT.length,
    )
  })

  it('kritik ve stok yok kümeleri kesişmiyor', () => {
    expect(CRITICAL.filter((s) => OUT.includes(s))).toEqual([])
  })

  it('sıralama: önce kritik, sonra stok yok, sonra diğerleri', async () => {
    const page = await listStock(boss, { search: 'SL-', limit: 200 }, opts)
    const order = page.rows.map((r) => (r.critical ? 0 : isOutOfStock(r.qty) ? 1 : 2))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order[0]).toBe(0)
  })
})

describe('T244 - yeni ürünün varsayılan eşiği (yalnız yeni ürünler)', () => {
  it('eşik gönderilmezse 3', async () => {
    const p = await createProduct(boss, { sku: `VE-${randomUUID().slice(0, 8)}`, name: 'Yeni' }, opts)
    expect(p.minStock).toBe(DEFAULT_MIN_STOCK)
    expect(DEFAULT_MIN_STOCK).toBe(3)
  })

  it('açıkça 0 korunuyor ("takip yok")', async () => {
    const p = await createProduct(
      boss,
      { sku: `VE-${randomUUID().slice(0, 8)}`, name: 'Takipsiz', minStock: 0 },
      opts,
    )
    expect(p.minStock).toBe(0)
  })

  it('mevcut ürünün eşiği başka alan güncellenince değişmiyor', async () => {
    const id = tenant.products['SL-NOTRACK']!.id
    await updateProduct(boss, id, { name: 'Örnek SL-NOTRACK' }, opts)
    expect((await getProductDetail(boss, id, opts)).minStock).toBe(0)
  })
})

describe('T244 - çalışanın dar eşik izni (setProductThreshold)', () => {
  async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
    return p.then(
      () => undefined,
      (e: unknown) => (e instanceof AppError ? e.code : String(e)),
    )
  }

  it('çalışan eşiği değiştirebiliyor; kritik hesabı hemen yeni eşiği kullanıyor', async () => {
    const id = tenant.products['SL-ABOVE']!.id
    await setProductThreshold(staff, id, { minStock: 4 }, opts)
    const after = await getProductDetail(staff, id, opts)
    expect(after.minStock).toBe(4)
    expect(after.critical).toBe(true)
    await setProductThreshold(staff, id, { minStock: 3 }, opts)
    expect((await getProductDetail(staff, id, opts)).critical).toBe(false)
  })

  it('yönetici de bu yolu kullanabiliyor', async () => {
    const id = tenant.products['SL-ABOVE']!.id
    await setProductThreshold(boss, id, { minStock: 3 }, opts)
    expect((await getProductDetail(boss, id, opts)).minStock).toBe(3)
  })

  it('çalışan genel ürün güncellemesini kullanamıyor; eşik dahil hiçbir alan değişmiyor', async () => {
    const id = tenant.products['SL-ABOVE']!.id
    expect(await codeOf(updateProduct(staff, id, { minStock: 9 }, opts))).toBe('FORBIDDEN')
    expect(await codeOf(updateProduct(staff, id, { name: 'Çalınmış Ad' }, opts))).toBe('FORBIDDEN')
    const p = await getProductDetail(boss, id, opts)
    expect(p.minStock).toBe(3)
    expect(p.name).toBe('Örnek SL-ABOVE')
  })

  it('eşik dışında bir alan gönderilirse istek reddediliyor ve hiçbir şey yazılmıyor', async () => {
    const id = tenant.products['SL-ABOVE']!.id
    for (const extra of [{ name: 'Yeni Ad' }, { purchasePrice: 1 }, { unit: 'KG' }]) {
      expect(await codeOf(setProductThreshold(staff, id, { minStock: 8, ...extra }, opts))).toBe(
        'VALIDATION_FAILED',
      )
    }
    const p = await getProductDetail(boss, id, opts)
    expect(p.minStock).toBe(3)
    expect(p.name).toBe('Örnek SL-ABOVE')
    expect(p.unit).toBe('ADET')
  })

  it('eksi ve fazla ondalıklı eşik reddediliyor (yöneticiyle aynı doğrulayıcı)', async () => {
    const id = tenant.products['SL-ABOVE']!.id
    expect(await codeOf(setProductThreshold(staff, id, { minStock: -1 }, opts))).toBe('VALIDATION_FAILED')
    expect(await codeOf(setProductThreshold(staff, id, { minStock: 1.2345 }, opts))).toBe(
      'VALIDATION_FAILED',
    )
    expect(await codeOf(setProductThreshold(staff, id, {}, opts))).toBe('VALIDATION_FAILED')
  })

  it('başka kiracının ürününe eşik yazılamıyor (RLS)', async () => {
    const other = await seedTestTenant(admin.db, 'stock-levels-diger', [
      { sku: 'DG-1', name: 'Diğer', minStock: '1' },
    ])
    const otherId = other.products['DG-1']!.id
    expect(await codeOf(setProductThreshold(staff, otherId, { minStock: 50 }, opts))).toBe('NOT_FOUND')
    const otherBoss: Actor = { tenantId: other.tenantId, userId: other.adminUserId, role: 'ADMIN' }
    expect((await getProductDetail(otherBoss, otherId, opts)).minStock).toBe(1)
  })

  it('olmayan ürün NOT_FOUND', async () => {
    expect(await codeOf(setProductThreshold(staff, randomUUID(), { minStock: 1 }, opts))).toBe('NOT_FOUND')
  })
})
