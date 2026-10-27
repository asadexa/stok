import { randomUUID } from 'node:crypto'
import { depots, withTenant } from '@stok/db'
import { type TestTenant, seedOpeningStock, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { AppError, errorText } from '@stok/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import {
  appendImportRows,
  appendInventoryRows,
  beginInventoryRun,
  finalizeInventoryPreview,
  getImportRunProgress,
  getInventoryRunProgress,
  getLastInventoryFile,
  inventoryRunReport,
  processImportChunk,
  processInventoryChunk,
  pruneTenantImportRuns,
  startImportRun,
  startInventoryRun,
} from './import-runs'
import { parseInventoryFile } from './inventory-file'
import { checkStockInvariant, createMovement } from './movements'
import { createProduct } from './products'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T218 — ENVANTER DOSYASI AKTARIMI (Dilim 2)
 *
 * Dosyadaki miktar deponun YENİ TOPLAMI: fark kadar sayım düzeltmesi, diğer
 * depolar ve dosyada olmayan ürünler değişmiyor. Gerçek PostgreSQL üzerinde;
 * dosya gerçek ERP başlıklarıyla, yalnız sentetik veriyle.
 *
 *   - tek dosyadan ilk kurulum: barkodsuz, fiyatsız ürün; depo; stok
 *   - K1: yalnız dosyadaki depo değişiyor
 *   - boş / negatif / belirsiz / tekrarlı satır varsayılana dönmüyor
 *   - depoya atanmamış eski stok korunuyor (satır atlanıyor, dosya işleniyor)
 *   - teknik tekrar ve kesinti ikinci hareket yazmıyor; aynı içerik onaysız
 *     başlamıyor
 *   - önizlemeden sonra değişen stok ezilmiyor (Çakışma)
 *   - yetki, kiracı ve aktarım türü izolasyonu; temizlik
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME, 8)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }

let tenant: TestTenant // taze işletme: ürün yok, depo yok
let legacy: TestTenant // depo kavramından önce stok girilmiş işletme
let other: TestTenant
let boss: Actor
let staff: Actor
let legacyBoss: Actor
let otherBoss: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'env-taze', [])
  legacy = await seedTestTenant(admin.db, 'env-eski', [
    { sku: 'ESKI-1', name: 'Eski Stoklu Ürün', purchasePrice: '4.00' },
    { sku: 'ABC-1', name: 'Büyük Harfli Kod' },
    { sku: '123', name: 'Sıfırsız Kod' },
    { sku: 'ARS-1', name: 'Arşivli Ürün', archived: true },
    { sku: 'KG-1', name: 'Kiloyla Satılan', unit: 'KG' },
  ])
  other = await seedTestTenant(admin.db, 'env-diger', [])
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
  legacyBoss = { tenantId: legacy.tenantId, userId: legacy.adminUserId, role: 'ADMIN' }
  otherBoss = { tenantId: other.tenantId, userId: other.adminUserId, role: 'ADMIN' }

  // Depo kavramından önce girilmiş stok: deposu yok (atanmamış).
  await seedOpeningStock(admin.db, legacy, legacy.products['ESKI-1']!.id, '10.000')
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

const HEADER =
  'Malzeme Türü;Malzeme Kodu;Malzeme Açıklaması;Ambar;Envanter Miktarı;Birim;Ortalama Değer;Envanter Tutarı;Envanter Tutarı (RD)'
/** Gerçek ERP satırının biçimi; fiyat ve tutar sütunları dolu ama okunmamalı. */
const line = (sku: string, name: string, depot: string, qty: string, unit = 'AD') =>
  `Ticari Mal;${sku};${name};${depot};${qty};${unit};12,50;99,90;99,90`
const csv = (lines: string[]) => new Uint8Array(Buffer.from([HEADER, ...lines].join('\n'), 'utf8'))

/** Tarayıcının yaptığını yapar: dosyayı ayrıştırır, satırları gönderir, önizler. */
async function upload(actor: Actor, lines: string[], fileName = 'envanter.csv') {
  const file = await parseInventoryFile(csv(lines), fileName)
  const { runId } = await startInventoryRun(
    actor,
    { fileName, fileBytes: 1_000, totalRows: file.rows.length, columns: file.columns, unreadColumns: file.unreadColumns },
    opts,
  )
  await appendInventoryRows(actor, runId, { rows: file.rows }, opts)
  const preview = await finalizeInventoryPreview(actor, runId, opts)
  return { runId, preview }
}

async function runToEnd(actor: Actor, runId: string, begin: { confirmNewCount?: boolean } = {}) {
  await beginInventoryRun(actor, runId, begin, opts)
  return drain(actor, runId)
}

async function drain(actor: Actor, runId: string) {
  for (let i = 0; i < 1_000; i += 1) {
    const progress = await processInventoryChunk(actor, runId, opts)
    if (progress.status !== 'RUNNING') return progress
  }
  throw new Error('aktarım kapanmadı')
}

/** Defterden depo miktarı; `null` = depoya atanmamış. */
async function qtyIn(t: TestTenant, sku: string, depot: string | null): Promise<number> {
  const rows =
    depot === null
      ? await admin.client<{ q: string }[]>`
          SELECT COALESCE(SUM(m.delta), 0)::text AS q FROM stock_movements m JOIN products p ON p.id = m.product_id
           WHERE m.tenant_id = ${t.tenantId} AND p.sku = ${sku} AND m.depot_id IS NULL`
      : await admin.client<{ q: string }[]>`
          SELECT COALESCE(SUM(m.delta), 0)::text AS q FROM stock_movements m
            JOIN products p ON p.id = m.product_id JOIN depots d ON d.id = m.depot_id
           WHERE m.tenant_id = ${t.tenantId} AND p.sku = ${sku} AND d.name = ${depot}`
  return Number(rows[0]!.q)
}

async function total(t: TestTenant, sku: string): Promise<number> {
  const [row] = await admin.client<{ q: string | null }[]>`
    SELECT cs.qty::text AS q FROM current_stock cs JOIN products p ON p.id = cs.product_id
     WHERE p.tenant_id = ${t.tenantId} AND p.sku = ${sku}`
  return Number(row?.q ?? 0)
}

async function counts(t: TestTenant, prefix: string) {
  const [row] = await admin.client<{ products: number; barcodes: number; movements: number; depots: number }[]>`
    SELECT (SELECT count(*)::int FROM products WHERE tenant_id = ${t.tenantId} AND sku LIKE ${`${prefix}%`}) AS products,
           (SELECT count(*)::int FROM product_barcodes b JOIN products p ON p.id = b.product_id
             WHERE b.tenant_id = ${t.tenantId} AND p.sku LIKE ${`${prefix}%`}) AS barcodes,
           (SELECT count(*)::int FROM stock_movements m JOIN products p ON p.id = m.product_id
             WHERE m.tenant_id = ${t.tenantId} AND p.sku LIKE ${`${prefix}%`}) AS movements,
           (SELECT count(*)::int FROM depots WHERE tenant_id = ${t.tenantId}) AS depots
  `
  return row!
}

async function rowStatuses(runId: string): Promise<string[]> {
  const rows = await admin.client<{ status: string }[]>`
    SELECT status FROM import_run_rows WHERE run_id = ${runId} ORDER BY row_number`
  return rows.map((r) => r.status)
}

async function depotId(t: TestTenant, name: string): Promise<string> {
  const [row] = await admin.client<{ id: string }[]>`
    SELECT id FROM depots WHERE tenant_id = ${t.tenantId} AND name = ${name}`
  return row!.id
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  )
}

describe('dosya okuma', () => {
  it('gerçek başlıklar tanınıyor; fiyat ve tutar sütunlarının değeri gönderilmiyor', async () => {
    const file = await parseInventoryFile(csv([line('OK-1', 'Kalem', 'Merkez', '5')]), 'rapor.csv')
    expect([...file.columns].sort()).toEqual(['depot', 'name', 'qty', 'sku', 'unit'])
    expect(file.unreadColumns).toEqual(['Malzeme Türü', 'Ortalama Değer', 'Envanter Tutarı', 'Envanter Tutarı (RD)'])
    expect(Object.keys(file.rows[0]!.cells).sort()).toEqual(['depot', 'name', 'qty', 'sku', 'unit'])
    expect(JSON.stringify(file.rows)).not.toContain('12,50')
  })

  it('Ambar sütunu olmayan dosya sessizce geçilmiyor', async () => {
    const data = new Uint8Array(Buffer.from('Malzeme Kodu;Envanter Miktarı\nA;5', 'utf8'))
    const err = await parseInventoryFile(data, 'eksik.csv').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('INVENTORY_MISSING_COLUMN')
    expect(errorText('INVENTORY_MISSING_COLUMN', (err as AppError).details)).toContain('Eksik: Ambar (Depo)')
  })

  it('sunucu tanınmayan hücre alanını reddediyor: fiyat kayda giremiyor', async () => {
    const { runId } = await startInventoryRun(
      boss,
      { fileName: 'x.csv', fileBytes: 10, totalRows: 1, columns: ['sku', 'qty', 'depot'] },
      opts,
    )
    const rows = [{ rowNumber: 2, cells: { sku: 'X', qty: '1', depot: 'D', purchasePrice: '5' } }]
    expect(await codeOf(appendInventoryRows(boss, runId, { rows }, opts))).toBe('VALIDATION_FAILED')
  })
})

describe('ilk kurulum: tek dosyadan ürün, depo ve stok', () => {
  it('barkodsuz, fiyatsız ürünler ve depolar oluşuyor; aynı ürün iki depoda doğru miktarla', async () => {
    const { runId, preview } = await upload(boss, [
      line('ILK-A', 'Mavi Kalem', 'Merkez Depo', '5', 'AD'),
      line('ILK-A', 'Mavi Kalem', 'Şube Deposu', '7', 'AD'),
      line('ILK-B', 'Kaya Tuzu', 'Merkez Depo', '2,5', 'KG'),
      line('ILK-C', 'Zeytinyağı', 'Şube Deposu', '0', 'LT'),
      line('ILK-D', 'Bakır Kablo', '  merkez   DEPO ', '3', 'MT'),
    ])
    expect(preview.counts).toMatchObject({ newProducts: 4, create: 5, update: 0, error: 0 })
    expect(preview.depots).toEqual([
      { name: 'Merkez Depo', isNew: true },
      { name: 'Şube Deposu', isNew: true },
    ])
    expect(preview.notices[0]).toBe('Dosyada olmayan ürünlerin ve depoların stoğu değişmez.')
    expect(preview.notices[1]).toContain('Ortalama Değer')

    // Önizleme hiçbir şey yazmıyor: ne ürün, ne depo, ne hareket.
    expect(await counts(tenant, 'ILK-')).toEqual({ products: 0, barcodes: 0, movements: 0, depots: 0 })

    const progress = await runToEnd(boss, runId)
    expect(progress.status).toBe('DONE')
    expect(progress.rows.created).toBe(5)

    expect(await counts(tenant, 'ILK-')).toMatchObject({ products: 4, barcodes: 0, depots: 2 })
    expect(await qtyIn(tenant, 'ILK-A', 'Merkez Depo')).toBe(5)
    expect(await qtyIn(tenant, 'ILK-A', 'Şube Deposu')).toBe(7)
    expect(await total(tenant, 'ILK-A')).toBe(12)
    expect(await qtyIn(tenant, 'ILK-B', 'Merkez Depo')).toBe(2.5)
    expect(await qtyIn(tenant, 'ILK-D', 'Merkez Depo')).toBe(3)
    expect(await total(tenant, 'ILK-C')).toBe(0)

    const products = await admin.client<{ sku: string; unit: string; purchase: string | null; sale: string | null }[]>`
      SELECT sku, unit, purchase_price::text AS purchase, sale_price::text AS sale FROM products
       WHERE tenant_id = ${tenant.tenantId} AND sku LIKE 'ILK-%' ORDER BY sku`
    expect(products).toEqual([
      { sku: 'ILK-A', unit: 'ADET', purchase: null, sale: null },
      { sku: 'ILK-B', unit: 'KG', purchase: null, sale: null },
      { sku: 'ILK-C', unit: 'LITRE', purchase: null, sale: null },
      { sku: 'ILK-D', unit: 'METRE', purchase: null, sale: null },
    ])

    const movements = await admin.client<
      { reason: string; import_run_id: string; unit_price: string | null; barcode_id: string | null }[]
    >`
      SELECT m.reason, m.import_run_id, m.unit_price::text, m.barcode_id FROM stock_movements m
        JOIN products p ON p.id = m.product_id
       WHERE m.tenant_id = ${tenant.tenantId} AND p.sku LIKE 'ILK-%'`
    // Miktarı 0 olan yeni ürün hareket almıyor (defterde delta <> 0).
    expect(movements).toHaveLength(4)
    for (const m of movements) {
      expect(m).toEqual({ reason: 'COUNT_ADJUST_UP', import_run_id: runId, unit_price: null, barcode_id: null })
    }

    expect(await getLastInventoryFile(boss, opts)).toMatchObject({ fileName: 'envanter.csv', status: 'DONE' })
  })
})

describe('depo bazlı güncelleme (K1)', () => {
  it('yalnız dosyadaki depo değişiyor: 10 + 20 → 5 + 20 = 25; dosyada olmayan ürün korunuyor', async () => {
    const setup = await upload(boss, [
      line('K1-A', 'Defter', 'K1 Depo 1', '10'),
      line('K1-A', 'Defter', 'K1 Depo 2', '20'),
      line('K1-B', 'Silgi', 'K1 Depo 1', '4'),
    ])
    await runToEnd(boss, setup.runId)
    expect(await total(tenant, 'K1-A')).toBe(30)

    const { runId, preview } = await upload(boss, [line('K1-A', 'Defter', 'K1 Depo 1', '5')], 'depo1.csv')
    expect(preview.counts).toMatchObject({ update: 1, create: 0, unchanged: 0, error: 0 })
    await runToEnd(boss, runId)

    expect(await qtyIn(tenant, 'K1-A', 'K1 Depo 1')).toBe(5)
    expect(await qtyIn(tenant, 'K1-A', 'K1 Depo 2')).toBe(20)
    expect(await total(tenant, 'K1-A')).toBe(25)
    expect(await qtyIn(tenant, 'K1-B', 'K1 Depo 1')).toBe(4)

    const [m] = await admin.client<{ reason: string; delta: string }[]>`
      SELECT reason, delta::text FROM stock_movements WHERE import_run_id = ${runId}`
    expect(m).toEqual({ reason: 'COUNT_ADJUST_DOWN', delta: '-5.000' })
  })

  it('aynı miktar: değişiklik yok, hareket yazılmıyor', async () => {
    const before = await counts(tenant, 'K1-')
    const { runId, preview } = await upload(boss, [line('K1-A', 'Defter', 'K1 Depo 2', '20')], 'ayni.csv')
    expect(preview.counts).toMatchObject({ unchanged: 1, update: 0 })
    const progress = await runToEnd(boss, runId)
    expect(progress.rows.skipped).toBe(1)
    expect(await rowStatuses(runId)).toEqual(['SKIPPED'])
    expect((await counts(tenant, 'K1-')).movements).toBe(before.movements)
  })
})

describe('hatalı satırlar varsayılana dönmüyor', () => {
  it('boş, negatif, belirsiz, kesirli, tanınmayan ve tekrarlı satırlar hatalı; geçerli satır işleniyor', async () => {
    const { runId, preview } = await upload(boss, [
      line('HT-1', 'Boş Miktar', 'HT Depo', ''),
      line('HT-2', 'Boş Depo', '', '4'),
      line('HT-3', 'Eksi', 'HT Depo', '-2'),
      line('HT-4', 'Belirsiz Sayı', 'HT Depo', '1.234'),
      line('HT-5', 'Kesirli Adet', 'HT Depo', '2,5', 'AD'),
      line('HT-6', 'Bilinmeyen Birim', 'HT Depo', '1', 'PAKET'),
      line('HT-7', '', 'HT Depo', '1', 'AD'),
      line('HT-8', 'Çift', 'HT Depo', '1'),
      line('HT-8', 'Çift', 'HT  DEPO', '2'),
      line('HT-9', 'Geçerli', 'HT Depo', '6'),
    ])
    expect(preview.counts).toMatchObject({ error: 9, create: 1 })
    const message = (rowNumber: number) =>
      preview.errors.find((e) => e.rowNumber === rowNumber)?.issues.map((i) => i.message).join(' | ')
    expect(message(2)).toContain('boş hücre 0 sayılmaz')
    expect(message(3)).toContain('Depo (Ambar) boş')
    expect(message(4)).toContain('negatif olamaz')
    expect(message(5)).toContain('belirsiz')
    expect(message(6)).toContain('tam sayı olmalı')
    expect(message(7)).toContain('Birim tanınmadı')
    expect(message(8)).toContain('Malzeme Açıklaması gerekli')
    expect(message(9)).toContain('satır 10')
    expect(message(10)).toContain('satır 9')

    await runToEnd(boss, runId)
    const created = await admin.client<{ sku: string }[]>`
      SELECT sku FROM products WHERE tenant_id = ${tenant.tenantId} AND sku LIKE 'HT-%'`
    expect(created.map((p) => p.sku)).toEqual(['HT-9'])
    expect(await qtyIn(tenant, 'HT-9', 'HT Depo')).toBe(6)

    const report = await inventoryRunReport(boss, runId, opts)
    expect(new Set(report.map((r) => r.rowNumber))).toEqual(new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]))
  })
})

describe('eşleştirme ve ürün kuralları (eski stoklu işletme)', () => {
  it('belirsiz eşleşme ne eşleştiriliyor ne yeni ürün açıyor', async () => {
    const { runId, preview } = await upload(legacyBoss, [
      line('abc-1', 'Küçük Harf', 'Merkez Depo', '1'),
      line('00123', 'Baştaki Sıfırlar', 'Merkez Depo', '1'),
      line('YK-9', 'Yeni Kod', 'Merkez Depo', '1'),
      line('yk-9', 'Yeni Kod Küçük', 'Merkez Depo', '2'),
    ])
    expect(preview.counts).toMatchObject({ ambiguous: 4, error: 4, create: 0 })
    expect(preview.errors.every((e) => e.issues[0]!.message.startsWith('Belirsiz eşleşme'))).toBe(true)
    expect(preview.errors[0]!.issues[0]!.message).toContain('"ABC-1"')
    expect(await rowStatuses(runId)).toEqual(['INVALID', 'INVALID', 'INVALID', 'INVALID'])
  })

  it('arşivli ürün ve ürünün biriminden farklı birim hatalı', async () => {
    const { preview } = await upload(legacyBoss, [
      line('ARS-1', 'Arşivli Ürün', 'Merkez Depo', '1'),
      line('KG-1', 'Kiloyla Satılan', 'Merkez Depo', '3', 'AD'),
    ])
    expect(preview.counts.error).toBe(2)
    expect(preview.errors[0]!.issues[0]!.message).toContain('arşivlenmiş')
    expect(preview.errors[1]!.issues[0]!.message).toContain('ürünün biriminden farklı')
  })

  it('depoya atanmamış eski stok korunuyor: yalnız o satır atlanıyor, dosyanın geri kalanı işleniyor', async () => {
    const { runId, preview } = await upload(legacyBoss, [
      line('ESKI-1', 'Eski Stoklu Ürün', 'Merkez Depo', '4'),
      line('ATN-1', 'Yeni Ürün', 'Merkez Depo', '3'),
    ])
    expect(preview.counts).toMatchObject({ unassigned: 1, create: 1, error: 0 })
    expect(preview.unassigned[0]!.message).toContain('Depoya atama bekliyor')
    expect(preview.unassigned[0]!.message).toContain('10 adet')

    await runToEnd(legacyBoss, runId)
    expect(await total(legacy, 'ESKI-1')).toBe(10)
    expect(await qtyIn(legacy, 'ESKI-1', null)).toBe(10)
    expect(await qtyIn(legacy, 'ESKI-1', 'Merkez Depo')).toBe(0)
    expect(await qtyIn(legacy, 'ATN-1', 'Merkez Depo')).toBe(3)

    const report = await inventoryRunReport(legacyBoss, runId, opts)
    expect(report).toHaveLength(1)
    expect(report[0]).toMatchObject({ rowNumber: 2, status: 'Atlandı' })
  })
})

describe('tekrar ve kesinti', () => {
  it('uygulanmış satırın kesintisi DONE çözülüyor; ikinci hareket yazılmıyor', async () => {
    const { runId } = await upload(boss, [line('TK-1', 'Klasör', 'TK Depo', '8'), line('TK-2', 'Dosya', 'TK Depo', '9')])
    await runToEnd(boss, runId)
    const before = (await counts(tenant, 'TK-')).movements
    expect(before).toBe(2)

    // İşleyici satırı yazdı ama sonucunu kaydedemeden düştü.
    await admin.client`
      UPDATE import_run_rows SET status = 'IN_PROGRESS', claimed_at = now() - interval '5 minutes',
             claim_token = ${randomUUID()}, processed_at = NULL
       WHERE run_id = ${runId} AND row_number = 2`
    await admin.client`UPDATE import_runs SET status = 'RUNNING', finished_at = NULL WHERE id = ${runId}`

    const progress = await drain(boss, runId)
    expect(progress.status).toBe('DONE')
    expect(await rowStatuses(runId)).toEqual(['DONE', 'DONE'])
    expect((await counts(tenant, 'TK-')).movements).toBe(before)
    expect(await qtyIn(tenant, 'TK-1', 'TK Depo')).toBe(8)

    // Bitmiş aktarıma tekrar çağrı hata değil ve hiçbir şey yazmıyor.
    expect((await processInventoryChunk(boss, runId, opts)).status).toBe('DONE')
    expect((await counts(tenant, 'TK-')).movements).toBe(before)
  })

  it('uygulanmadan kesilen satır yeniden deneniyor ve bir kez yazılıyor', async () => {
    const { runId } = await upload(boss, [line('TK-3', 'Zımba', 'TK Depo', '4')])
    await beginInventoryRun(boss, runId, {}, opts)
    await admin.client`
      UPDATE import_run_rows SET status = 'IN_PROGRESS', claimed_at = now() - interval '5 minutes',
             claim_token = ${randomUUID()}
       WHERE run_id = ${runId} AND row_number = 2`

    const progress = await drain(boss, runId)
    expect(progress.status).toBe('DONE')
    expect(await rowStatuses(runId)).toEqual(['DONE'])
    expect(await qtyIn(tenant, 'TK-3', 'TK Depo')).toBe(4)
    expect((await counts(tenant, 'TK-3')).movements).toBe(1)
  })

  it('aynı içerik yeniden: onaysız başlamıyor; onaylanınca o anki stoğa göre çalışıyor', async () => {
    const first = await upload(boss, [line('RP-1', 'Cetvel', 'RP Depo 1', '3'), line('RP-1', 'Cetvel', 'RP Depo 2', '4')], 'sayim-ekim.csv')
    expect(first.preview.repeatOf).toBeNull()
    await runToEnd(boss, first.runId)

    // Aynı içerik: satır sırası, depo adının yazımı ve sayının yazımı farklı.
    const again = await upload(
      boss,
      [line('RP-1', 'Cetvel', 'RP Depo 2', '4,000'), line('RP-1', 'Cetvel', 'rp  depo 1', '3')],
      'baska-ad.csv',
    )
    expect(again.preview.repeatOf).toMatchObject({ fileName: 'sayim-ekim.csv' })
    expect(again.preview.counts.unchanged).toBe(2)

    expect(await codeOf(beginInventoryRun(boss, again.runId, {}, opts))).toBe('IMPORT_REPEAT_UNCONFIRMED')
    expect((await getInventoryRunProgress(boss, again.runId, opts)).status).toBe('PREVIEWED')

    const movements = (await counts(tenant, 'RP-')).movements
    const progress = await runToEnd(boss, again.runId, { confirmNewCount: true })
    expect(progress.status).toBe('DONE')
    expect((await counts(tenant, 'RP-')).movements).toBe(movements)

    // Farklı içerik meşru yeni sayım: onay istemiyor.
    const next = await upload(boss, [line('RP-1', 'Cetvel', 'RP Depo 1', '6')], 'sayim-kasim.csv')
    expect(next.preview.repeatOf).toBeNull()
    await runToEnd(boss, next.runId)
    expect(await qtyIn(tenant, 'RP-1', 'RP Depo 1')).toBe(6)
    expect(await qtyIn(tenant, 'RP-1', 'RP Depo 2')).toBe(4)
  })
})

describe('önizlemeden sonra değişen stok', () => {
  it('arada satış olduysa satır Çakışma; satış geri alınmıyor', async () => {
    const setup = await upload(boss, [line('CK-1', 'Makas', 'CK Depo', '10')])
    await runToEnd(boss, setup.runId)

    const { runId } = await upload(boss, [line('CK-1', 'Makas', 'CK Depo', '6')], 'sayim.csv')
    const [product] = await admin.client<{ id: string }[]>`
      SELECT id FROM products WHERE tenant_id = ${tenant.tenantId} AND sku = 'CK-1'`
    await createMovement(
      boss,
      {
        idempotencyKey: randomUUID(),
        productId: product!.id,
        depotId: await depotId(tenant, 'CK Depo'),
        qty: 3,
        // Fiyatsız çıkış: ürün dosyadan fiyatsız açıldı.
        reason: 'USAGE',
        clientCreatedAt: new Date().toISOString(),
      },
      opts,
    )

    const progress = await runToEnd(boss, runId)
    expect(progress.rows.conflict).toBe(1)
    expect(await qtyIn(tenant, 'CK-1', 'CK Depo')).toBe(7)
    const written = await admin.client`SELECT 1 FROM stock_movements WHERE import_run_id = ${runId}`
    expect(written).toHaveLength(0)
  })

  it('önizlemeden sonra aynı kodla açılan ürün: yeni ürün satırı Çakışma, diğer depo satırı ona yazılmıyor', async () => {
    const { runId } = await upload(boss, [
      line('CZ-1', 'Bant', 'CZ Depo A', '2'),
      line('CZ-1', 'Bant', 'CZ Depo B', '3'),
    ])
    await createProduct(boss, { sku: 'CZ-1', name: 'Başkasının Açtığı Ürün' }, opts)

    await runToEnd(boss, runId)
    expect(await rowStatuses(runId)).toEqual(['CONFLICT', 'FAILED'])
    expect(await total(tenant, 'CZ-1')).toBe(0)
    expect((await counts(tenant, 'CZ-')).movements).toBe(0)
  })
})

describe('yetki, kiracı ve aktarım türü izolasyonu', () => {
  it('çalışan envanter aktarımı başlatamıyor (count:approve)', async () => {
    const start = startInventoryRun(
      staff,
      { fileName: 'x.csv', fileBytes: 1, totalRows: 1, columns: ['sku', 'qty', 'depot'] },
      opts,
    )
    expect(await codeOf(start)).toBe('FORBIDDEN')
  })

  it('başka kiracının envanter kaydı hiçbir adımda bulunamıyor', async () => {
    const { runId } = await upload(boss, [line('IZ-1', 'Pergel', 'IZ Depo', '1')])
    const rows = [{ rowNumber: 3, cells: { sku: 'IZ-2', qty: '1', depot: 'IZ Depo' } }]
    expect(await codeOf(appendInventoryRows(otherBoss, runId, { rows }, opts))).toBe('NOT_FOUND')
    expect(await codeOf(finalizeInventoryPreview(otherBoss, runId, opts))).toBe('NOT_FOUND')
    expect(await codeOf(beginInventoryRun(otherBoss, runId, {}, opts))).toBe('NOT_FOUND')
    expect(await codeOf(processInventoryChunk(otherBoss, runId, opts))).toBe('NOT_FOUND')
    expect(await codeOf(getInventoryRunProgress(otherBoss, runId, opts))).toBe('NOT_FOUND')
    expect(await codeOf(inventoryRunReport(otherBoss, runId, opts))).toBe('NOT_FOUND')
  })

  it('ürün aktarımı işlevleri envanter kaydına, envanter işlevleri ürün kaydına dokunamıyor', async () => {
    const { runId } = await upload(boss, [line('TR-1', 'Gönye', 'TR Depo', '1')])
    await beginInventoryRun(boss, runId, {}, opts)
    const productRows = [{ rowNumber: 3, cells: { sku: 'TR-2', name: 'Ürün' } }]
    expect(await codeOf(appendImportRows(boss, runId, { rows: productRows }, opts))).toBe('NOT_FOUND')
    expect(await codeOf(processImportChunk(boss, runId, opts))).toBe('NOT_FOUND')
    expect(await codeOf(getImportRunProgress(boss, runId, opts))).toBe('NOT_FOUND')
    // Ürün işleyicisi satırı ürün diye uygulamadı.
    expect(await rowStatuses(runId)).toEqual(['PENDING'])

    const product = await startImportRun(
      boss,
      { fileName: 'urun.csv', fileBytes: 1, totalRows: 1, columns: ['sku', 'name'] },
      opts,
    )
    const inventoryRows = [{ rowNumber: 2, cells: { sku: 'TR-3', qty: '1', depot: 'TR Depo' } }]
    expect(await codeOf(appendInventoryRows(boss, product.runId, { rows: inventoryRows }, opts))).toBe('NOT_FOUND')
    expect(await codeOf(getInventoryRunProgress(boss, product.runId, opts))).toBe('NOT_FOUND')
  })

  it('açılan depolar yalnız kendi kiracısında görünüyor', async () => {
    const { runId } = await upload(otherBoss, [line('OT-1', 'Başka Ürün', 'Merkez Depo', '2')])
    await runToEnd(otherBoss, runId)
    // Uygulama rolüyle, kiracı süzgeci yazmadan: yalnız RLS.
    const visible = await withTenant(tenant.tenantId, (tx) => tx.select({ tenantId: depots.tenantId }).from(depots), app.db)
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.every((d) => d.tenantId === tenant.tenantId)).toBe(true)
    expect(await qtyIn(other, 'OT-1', 'Merkez Depo')).toBe(2)
  })
})

describe('temizlik', () => {
  it('başlamış envanter kaydının başlığı 30 gün sonra kalıyor, satırları siliniyor; başlamamışı siliniyor', async () => {
    // Hiç hareket yazmamış ama başlamış aktarım: miktarı 0 olan yeni ürün.
    const started = await upload(boss, [line('TM-1', 'Pul', 'TM Depo', '0')], 'eski-sayim.csv')
    await runToEnd(boss, started.runId)
    const previewOnly = await upload(boss, [line('TM-2', 'Mühür', 'TM Depo', '1')])
    await admin.client`
      UPDATE import_runs SET created_at = now() - interval '31 days'
       WHERE id IN (${started.runId}, ${previewOnly.runId})`

    await pruneTenantImportRuns(tenant.tenantId, opts)

    const runs = await admin.client<{ id: string }[]>`
      SELECT id FROM import_runs WHERE id IN (${started.runId}, ${previewOnly.runId})`
    expect(runs.map((r) => r.id)).toEqual([started.runId])
    const rows = await admin.client`SELECT 1 FROM import_run_rows WHERE run_id = ${started.runId}`
    expect(rows).toHaveLength(0)

    // Başlık kaldığı için aynı içerik uyarısı 30 günden sonra da çalışıyor.
    const again = await upload(boss, [line('TM-1', 'Pul', 'TM Depo', '0')])
    expect(again.preview.repeatOf).toMatchObject({ fileName: 'eski-sayim.csv' })
  })
})

describe('defter', () => {
  it('bütün bu aktarımlardan sonra defter ile projeksiyon eşit', async () => {
    for (const t of [tenant, legacy, other]) {
      expect(await checkStockInvariant(t.tenantId, opts)).toEqual([])
    }
  })
})
