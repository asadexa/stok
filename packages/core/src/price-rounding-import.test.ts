import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { commitImport, parseProductFile, previewImport } from './import'
import {
  appendImportRows,
  beginImportRun,
  finalizeImportPreview,
  processImportChunk,
  startImportRun,
} from './import-runs'
import { checkStockInvariant } from './movements'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * PRC-15 — ÜRÜN DOSYASI AKTARIMINDA FİYATIN KURUŞA YUVARLANMASI
 *
 * Sınanan, iki yoldan (tek istekli önizleme + uygulama ve kayıtlı aktarım):
 * kullanıcı örnekleri; önizlemede dosyadaki ve kaydedilecek değer; alış ve
 * satış birlikte değişince iki hücre; iki ondalıklı fiyat değişmiyor; boş
 * hücre fiyatı koruyor, `0` kabul; 0,00'a inen pozitif fiyat satır hatası ve
 * ürün yazılmıyor; üst sınır, eksi ve belirsiz yazım yuvarlamayla aşılamıyor;
 * devir yuvarlanmış alış fiyatıyla, ürün ve hareket fiyatı aynı.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME, 4)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }

let t: TestTenant
let boss: Actor

beforeAll(async () => {
  t = await seedTestTenant(admin.db, 'fiyat-yuvarlama', [
    { sku: 'YV-VAR', name: 'Var Olan', purchasePrice: '7.00', salePrice: '12.00' },
    { sku: 'YV-SIFIR', name: 'Sıfırlanacak', purchasePrice: '7.00', salePrice: '12.00' },
    { sku: 'YV-KORU', name: 'Korunacak', purchasePrice: '7.00', salePrice: '12.00' },
  ])
  boss = { tenantId: t.tenantId, userId: t.adminUserId, role: 'ADMIN' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

const HEADER = 'Stok Kodu;Ürün Adı;Alış Fiyatı;Satış Fiyatı'

async function file(lines: string[]) {
  return parseProductFile(Buffer.from([HEADER, ...lines].join('\n'), 'utf8'), 'fiyat.csv')
}

async function prices(sku: string) {
  const [row] = await admin.client<{ purchase_price: string | null; sale_price: string | null }[]>`
    SELECT purchase_price::text, sale_price::text FROM products WHERE tenant_id = ${t.tenantId} AND sku = ${sku}
  `
  return row
}

const issues = (row: { issues: { column: string; message: string }[] }) =>
  row.issues.map((i) => `${i.column}: ${i.message}`)

describe('önizleme ve uygulama (tek istek)', () => {
  it('kullanıcı örnekleri: alış ve satış birlikte, iki hücre; kaydedilen kuruş', async () => {
    const preview = await previewImport(
      boss,
      await file(['YV-1;Bir;3,0451;2,9949', 'YV-2;İki;2,9950;3,0050']),
      opts,
    )
    expect(preview.rows.map((r) => r.roundedPrices)).toEqual([
      [
        { column: 'Alış Fiyatı', from: '3,0451', to: '3,05' },
        { column: 'Satış Fiyatı', from: '2,9949', to: '2,99' },
      ],
      [
        { column: 'Alış Fiyatı', from: '2,9950', to: '3,00' },
        { column: 'Satış Fiyatı', from: '3,0050', to: '3,01' },
      ],
    ])

    await commitImport(boss, preview, opts)
    expect(await prices('YV-1')).toEqual({ purchase_price: '3.05', sale_price: '2.99' })
    expect(await prices('YV-2')).toEqual({ purchase_price: '3.00', sale_price: '3.01' })
  })

  it('iki ondalıklı fiyat değişmiyor ve yuvarlama sayılmıyor; "9,5000" da değişmiyor', async () => {
    const preview = await previewImport(boss, await file(['YV-3;Üç;9,50;9,5000']), opts)
    expect(preview.rows[0]!.roundedPrices).toBeUndefined()
    expect(preview.rows[0]!.data).toMatchObject({ purchasePrice: 9.5, salePrice: 9.5 })
  })

  it('güncellemede: boş hücre fiyatı koruyor, 0 kabul, 4 ondalık yuvarlanıyor', async () => {
    const preview = await previewImport(
      boss,
      await file(['YV-KORU;Korunacak;;12,3456', 'YV-SIFIR;Sıfırlanacak;0;0']),
      opts,
    )
    expect(preview.rows.map((r) => r.action)).toEqual(['update', 'update'])
    await commitImport(boss, preview, opts)
    expect(await prices('YV-KORU')).toEqual({ purchase_price: '7.00', sale_price: '12.35' })
    expect(await prices('YV-SIFIR')).toEqual({ purchase_price: '0.00', sale_price: '0.00' })
  })

  it("pozitif olup 0,00'a inen fiyat satır hatası; ürün açılmıyor ve güncellenmiyor", async () => {
    const preview = await previewImport(
      boss,
      await file(['YV-YOK;Yeni;0,0049;5', 'YV-VAR;Var Olan;8;0,0012']),
      opts,
    )
    expect(preview.rows.map((r) => r.action)).toEqual(['error', 'error'])
    expect(issues(preview.rows[0]!)).toEqual(['Alış Fiyatı: 0,0049 kuruşa yuvarlanınca 0,00 oluyor; fiyat en az 0,01 olmalı'])
    expect(issues(preview.rows[1]!)).toEqual(['Satış Fiyatı: 0,0012 kuruşa yuvarlanınca 0,00 oluyor; fiyat en az 0,01 olmalı'])

    await commitImport(boss, preview, opts)
    expect(await prices('YV-YOK')).toBeUndefined()
    expect(await prices('YV-VAR')).toEqual({ purchase_price: '7.00', sale_price: '12.00' })
  })

  it('üst sınır, eksi ve belirsiz yazım yuvarlamayla aşılamıyor', async () => {
    const preview = await previewImport(
      boss,
      await file(['YV-UST;Üst;99.999.999,995;1', 'YV-EKSI;Eksi;-3,0451;1', 'YV-BEL;Belirsiz;3.045;1']),
      opts,
    )
    expect(preview.rows.map((r) => r.action)).toEqual(['error', 'error', 'error'])
    expect(preview.rows.every((r) => r.roundedPrices === undefined)).toBe(true)
    expect(issues(preview.rows[2]!)[0]).toContain('belirsiz')
  })

  it('devir yuvarlanmış alış fiyatıyla: ürün, hareket birim ve liste fiyatı aynı', async () => {
    const devir = await parseProductFile(
      Buffer.from(['Stok Kodu;Ürün Adı;Alış Fiyatı;Açılış Stoğu', 'YV-DVR;Devirli;9,5049;10'].join('\n'), 'utf8'),
      'devir.csv',
    )
    const preview = await previewImport(boss, devir, opts)
    expect(preview.rows[0]!.opening).toMatchObject({ qty: 10, unitPrice: 9.5 })
    const result = await commitImport(boss, preview, opts)
    expect(result.openings).toEqual({ written: 1, skipped: 0, failed: 0 })

    const [m] = await admin.client<{ unit_price: string; list_price: string; purchase_price: string }[]>`
      SELECT m.unit_price::text, m.list_price::text, p.purchase_price::text
        FROM stock_movements m JOIN products p ON p.id = m.product_id
       WHERE m.tenant_id = ${t.tenantId} AND p.sku = 'YV-DVR' AND m.reason = 'OPENING'
    `
    expect(m).toEqual({ unit_price: '9.50', list_price: '9.50', purchase_price: '9.50' })
    expect(await checkStockInvariant(t.tenantId, opts)).toEqual([])
  })
})

describe('kayıtlı aktarım (T171 yolu)', () => {
  it('hücre sayısı ürün sayısıyla karışmıyor; hatalı satır sayılmıyor; uygulama aynı değeri yazıyor', async () => {
    const parsed = await file(['YV-K1;Kayıt Bir;3,0451;2,9949', 'YV-K2;Kayıt İki;5;7,125', 'YV-K3;Hatalı;0,0001;1'])
    const { runId } = await startImportRun(
      boss,
      { fileName: 'fiyat.csv', fileBytes: 100, totalRows: 3, columns: parsed.columns, ignoredQtyColumns: [] },
      opts,
    )
    await appendImportRows(boss, runId, { rows: parsed.rows }, opts)
    const preview = await finalizeImportPreview(boss, runId, opts)

    expect(preview).toMatchObject({ roundedPriceCells: 3, roundedPriceRows: 2, counts: { error: 1 } })
    expect(preview.roundings.map((r) => r.message)).toEqual([
      'Alış Fiyatı: 3,0451 → 3,05; Satış Fiyatı: 2,9949 → 2,99',
      'Satış Fiyatı: 7,125 → 7,13',
    ])

    let progress = await beginImportRun(boss, runId, opts)
    while (progress.status === 'RUNNING') progress = await processImportChunk(boss, runId, opts)
    expect(progress.status).toBe('DONE')
    expect(await prices('YV-K1')).toEqual({ purchase_price: '3.05', sale_price: '2.99' })
    expect(await prices('YV-K2')).toEqual({ purchase_price: '5.00', sale_price: '7.13' })
    expect(await prices('YV-K3')).toBeUndefined()
  })
})
