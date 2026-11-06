import { randomUUID } from 'node:crypto'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { planExport } from './exports'
import { transferStock } from './movements'
import { listStock } from './stock'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T221 — STOK LİSTESİNDE "DEPOYA ATAMA BEKLİYOR" ROZETİ VE SÜZGECİ
 *
 * Sınanan: rozet yalnız depolu işletmede ve yalnız ARTI atanmamış stokta;
 * deposuz işletmede rozet ve eşleşme yok; tam atamadan sonra rozet kalkıyor;
 * süzgeç sayfalamadan önce uygulanıyor, sayı ile satırlar aynı koşuldan;
 * arama ve kritik süzgeciyle birlikte doğru; çalışan rozeti görüyor ama
 * fiyat görmüyor; Excel dışa aktarımının sayısı ekranla aynı; başka kiracının
 * ürünü karışmıyor.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME, 4)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }

const SPECS = ['ATA-BEKLER', 'ATA-BEKLER-2', 'ATA-ATANDI', 'ATA-EKSI', 'ATA-DEPODA', 'ATA-HIC'].map((sku) => ({
  sku,
  name: `Atama ${sku}`,
  purchasePrice: '5.00',
  salePrice: '9.00',
}))

let withDepots: TestTenant
let noDepots: TestTenant
let boss: Actor
let staff: Actor
let plainBoss: Actor
let depot: string

const id = (t: TestTenant, sku: string) => t.products[sku]!.id

/** Doğrudan deftere (projeksiyonu tetikleyici güncelliyor); `depotId` boşsa atanmamış. */
async function move(t: TestTenant, sku: string, delta: number, depotId: string | null = null) {
  await admin.client`
    INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, reason, idempotency_key, depot_id)
    VALUES (${t.tenantId}, ${id(t, sku)}, ${t.adminUserId}, ${delta}, ${delta > 0 ? 'PURCHASE' : 'SALE'},
            ${randomUUID()}, ${depotId})
  `
}

beforeAll(async () => {
  withDepots = await seedTestTenant(admin.db, 'atama-rozet', SPECS)
  noDepots = await seedTestTenant(admin.db, 'atama-rozet-deposuz', SPECS)
  boss = { tenantId: withDepots.tenantId, userId: withDepots.adminUserId, role: 'ADMIN' }
  staff = { tenantId: withDepots.tenantId, userId: withDepots.staffUserId, role: 'STAFF' }
  plainBoss = { tenantId: noDepots.tenantId, userId: noDepots.adminUserId, role: 'ADMIN' }

  // Depolar gelmeden önceki eski stok: ikisinde de atanmamış.
  for (const t of [withDepots, noDepots]) {
    await move(t, 'ATA-BEKLER', 10)
    await move(t, 'ATA-BEKLER-2', 4)
    await move(t, 'ATA-ATANDI', 6)
    await move(t, 'ATA-EKSI', -3)
  }
  const [row] = await admin.client<{ id: string }[]>`
    INSERT INTO depots (tenant_id, name) VALUES (${withDepots.tenantId}, 'Ana Depo') RETURNING id
  `
  depot = row!.id
  await move(withDepots, 'ATA-DEPODA', 7, depot)
  // Tam atama: rozet kalkmalı.
  await transferStock(
    boss,
    {
      idempotencyKey: randomUUID(),
      productId: id(withDepots, 'ATA-ATANDI'),
      fromDepotId: null,
      toDepotId: depot,
      qty: 6,
      clientCreatedAt: new Date().toISOString(),
    },
    opts,
  )
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

const awaitingSkus = (rows: { sku: string; awaitingAssignment: boolean }[]) =>
  rows
    .filter((r) => r.awaitingAssignment)
    .map((r) => r.sku)
    .sort()

describe('rozet', () => {
  it('depolu işletmede yalnız artı atanmamış stokta; atanmış, eksi, depoda ve hareketsiz üründe yok', async () => {
    const page = await listStock(boss, { search: 'ATA-', limit: 50 }, opts)
    expect(page.usesDepots).toBe(true)
    expect(awaitingSkus(page.rows)).toEqual(['ATA-BEKLER', 'ATA-BEKLER-2'])
  })

  it('deposuz işletmede rozet yok ve süzgeç hiçbir şey döndürmüyor', async () => {
    const page = await listStock(plainBoss, { search: 'ATA-', limit: 50 }, opts)
    expect(page.usesDepots).toBe(false)
    expect(awaitingSkus(page.rows)).toEqual([])

    const filtered = await listStock(plainBoss, { awaitingAssignment: true }, opts)
    expect(filtered).toMatchObject({ rows: [], total: 0 })
  })

  it('çalışan rozeti görüyor, fiyat görmüyor', async () => {
    const page = await listStock(staff, { search: 'ATA-', limit: 50 }, opts)
    expect(awaitingSkus(page.rows)).toEqual(['ATA-BEKLER', 'ATA-BEKLER-2'])
    expect(page.rows.every((r) => r.purchasePrice === undefined && r.salePrice === undefined)).toBe(true)
  })
})

describe('süzgeç', () => {
  it('yalnız bekleyenler; sayı satırlarla aynı koşuldan, başka kiracı karışmıyor', async () => {
    const page = await listStock(boss, { awaitingAssignment: true, limit: 50 }, opts)
    expect(page.rows.map((r) => r.sku).sort()).toEqual(['ATA-BEKLER', 'ATA-BEKLER-2'])
    expect(page.total).toBe(2)
    expect(page.rows.every((r) => r.awaitingAssignment)).toBe(true)
  })

  it('sayfalamadan önce uygulanıyor: 1 satırlık iki sayfa, toplam 2', async () => {
    const first = await listStock(boss, { awaitingAssignment: true, limit: 1, offset: 0 }, opts)
    const second = await listStock(boss, { awaitingAssignment: true, limit: 1, offset: 1 }, opts)
    expect([first.total, second.total]).toEqual([2, 2])
    expect([...first.rows, ...second.rows].map((r) => r.sku).sort()).toEqual(['ATA-BEKLER', 'ATA-BEKLER-2'])
  })

  it('arama ve kritik süzgeciyle kesişiyor', async () => {
    const searched = await listStock(boss, { awaitingAssignment: true, search: 'BEKLER-2' }, opts)
    expect(searched.rows.map((r) => r.sku)).toEqual(['ATA-BEKLER-2'])
    expect(searched.total).toBe(1)

    // ATA-BEKLER kritik değil (10 > 0), ATA-BEKLER-2 kritik eşiğe çekiliyor.
    await admin.client`
      UPDATE products SET min_stock = 100 WHERE id = ${id(withDepots, 'ATA-BEKLER-2')}
    `
    const critical = await listStock(boss, { awaitingAssignment: true, onlyCritical: true }, opts)
    expect(critical.rows.map((r) => r.sku)).toEqual(['ATA-BEKLER-2'])
    expect(critical.total).toBe(1)
  })

  it('Excel dışa aktarımının satır sayısı ekrandakiyle aynı', async () => {
    const page = await listStock(boss, { awaitingAssignment: true }, opts)
    const plan = await planExport(boss, 'STOCK_EXPORT', { awaitingAssignment: true }, opts)
    expect(plan.rowCount).toBe(page.total)
  })
})
