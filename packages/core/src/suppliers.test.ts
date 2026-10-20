import { type TestTenant, seedOpeningStock, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { AppError } from '@stok/shared'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import type { FeedField, ParsedSupplierFile } from './supplier-feed'
import {
  bindSupplierItem,
  createSupplier,
  getSupplier,
  ignoreSupplierItem,
  listPriceChanges,
  listProductOffers,
  listSupplierItems,
  listSuppliers,
  previewSupplierRefresh,
  refreshSupplier,
  updateSupplier,
} from './suppliers'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T200 — B2B V1 TEDARİKÇİ VERİSİ, GERÇEK POSTGRESQL VE `stok_app` ROLÜYLE
 *
 * Sınanan iddialar (F-12 kabul kriterleri ve T200 PLAN kararları):
 *   - yenileme stok defterine ve ürün kartı fiyatlarına DOKUNMAZ
 *   - değişmeyen fiyat geçmiş üretmez; yüzde yalnız karşılaştırılabilir değişimde
 *   - fiyat miktarı barkoddan türetilmez, yalnız açık beyandan (B2)
 *   - önizleme hiçbir şey yazmaz ve kayıtla aynı sonucu verir (B1)
 *   - dosyada olmayan kalem değişmez; hatalı yenileme hiçbir şey yazmaz
 *   - kiracı dışı kimlikle okuma ya da bağlama yok; çalışan hiçbirini çağıramaz
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }

let tenant: TestTenant
let other: TestTenant
let boss: Actor
let staff: Actor
let otherBoss: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'sup', [
    { sku: 'P-1', name: 'Tükenmez Kalem', caseMultiplier: '12', purchasePrice: '8.00', salePrice: '12.00' },
    { sku: 'P-2', name: 'Defter', purchasePrice: '20.00', salePrice: '30.00' },
    // Yalnız karşılaştırma testinin ürünü: başka testlerin teklifleri grubu bozmasın.
    { sku: 'CMP', name: 'Karşılaştırma Ürünü' },
    { sku: 'ARS', name: 'Arşivli Ürün', archived: true },
  ])
  other = await seedTestTenant(admin.db, 'sup-b', [{ sku: 'B-1', name: 'Başka Kiracı Ürünü' }])
  await seedOpeningStock(admin.db, tenant, tenant.products['P-1']!.id, '50')
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
  otherBoss = { tenantId: other.tenantId, userId: other.adminUserId, role: 'ADMIN' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

type Cells = Partial<Record<FeedField, string>>

function feed(...rows: Cells[]): ParsedSupplierFile {
  return {
    rows: rows.map((cells, i) => ({ rowNumber: i + 2, cells })),
    columns: [],
    ignoredColumns: [],
  }
}

const unitBarcode = (sku: string) => tenant.products[sku]!.barcode
const caseBarcode = (sku: string) => tenant.products[sku]!.caseBarcode!

let supplierSeq = 0
async function newSupplier(unitPriceDeclared: boolean, currency = 'TRY'): Promise<string> {
  supplierSeq += 1
  const created = await createSupplier(
    boss,
    {
      name: `Toptancı ${supplierSeq}`,
      defaultCurrency: currency,
      defaultTaxMode: 'EXCLUDED',
      defaultPriceType: 'NET',
      unitPriceDeclared,
    },
    opts,
  )
  return created.id
}

async function errorOf(fn: () => Promise<unknown>): Promise<AppError> {
  const err = await fn().then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err, 'reddedilmesi gerekirken kabul edildi').toBeInstanceOf(AppError)
  return err as AppError
}

/** Stok defteri, projeksiyon ve ürün kartı fiyatlarının parmak izi (INV-1, INV-3). */
async function ledgerFingerprint(): Promise<unknown> {
  const rows = await admin.db.execute(sql`
    SELECT
      (SELECT count(*) FROM stock_movements WHERE tenant_id = ${tenant.tenantId})::int AS movements,
      (SELECT string_agg(product_id || ':' || qty, ',' ORDER BY product_id)
         FROM current_stock WHERE tenant_id = ${tenant.tenantId}) AS stock,
      (SELECT string_agg(id || ':' || coalesce(purchase_price::text, '-') || ':' ||
                         coalesce(sale_price::text, '-'), ',' ORDER BY id)
         FROM products WHERE tenant_id = ${tenant.tenantId}) AS prices
  `)
  return [...rows][0]
}

/** Bir tedarikçinin bütün kalıcı izi: kalemler, geçmiş, son yenileme. */
async function supplierState(supplierId: string): Promise<unknown> {
  const rows = await admin.db.execute(sql`
    SELECT
      (SELECT last_refreshed_at::text FROM suppliers WHERE id = ${supplierId}) AS refreshed,
      (SELECT json_agg(json_build_array(supplier_code, price::text, currency, price_qty::text,
                       match_state, product_id, fetched_at::text) ORDER BY supplier_code)
         FROM supplier_items WHERE supplier_id = ${supplierId}) AS items,
      (SELECT count(*) FROM supplier_price_changes c JOIN supplier_items i ON i.id = c.supplier_item_id
        WHERE i.supplier_id = ${supplierId})::int AS changes
  `)
  return [...rows][0]
}

async function itemId(supplierId: string, code: string): Promise<string> {
  const rows = await admin.db.execute<{ id: string }>(sql`
    SELECT id FROM supplier_items WHERE supplier_id = ${supplierId} AND supplier_code = ${code}
  `)
  return [...rows][0]!.id
}

async function changeCount(supplierId: string): Promise<number> {
  const state = (await supplierState(supplierId)) as { changes: number }
  return state.changes
}

describe('tedarikçi açma', () => {
  it('fiyat miktarı beyanı varsayılan olarak yok: belirsiz (B2)', async () => {
    const created = await createSupplier(
      boss,
      { name: 'Beyansız Toptan', defaultCurrency: 'TRY', defaultTaxMode: 'EXCLUDED', defaultPriceType: 'NET' },
      opts,
    )
    expect(created.unitPriceDeclared).toBe(false)
    expect(created.lastRefreshedAt).toBeNull()
    expect(created.itemCount).toBe(0)
  })

  it('aynı ad büyük/küçük harf ve Türkçe harf farkıyla da reddedilir', async () => {
    await createSupplier(
      boss,
      { name: 'Işık Gıda', defaultCurrency: 'TRY', defaultTaxMode: 'EXCLUDED', defaultPriceType: 'NET' },
      opts,
    )
    const err = await errorOf(() =>
      createSupplier(
        boss,
        { name: 'ışık gıda', defaultCurrency: 'TRY', defaultTaxMode: 'EXCLUDED', defaultPriceType: 'NET' },
        opts,
      ),
    )
    expect(err.code).toBe('SUPPLIER_NAME_EXISTS')
  })
})

describe('yenileme: kayıt, tekrar ve fiyat değişimi', () => {
  let supplierId: string

  beforeAll(async () => {
    supplierId = await newSupplier(true)
  })

  it('önizleme hiçbir şey yazmaz ve kayıtla aynı sonucu verir (B1)', async () => {
    const file = feed(
      { supplierCode: 'A', barcode: unitBarcode('P-1'), name: 'Kalem', price: '10', stockQty: '500' },
      { supplierCode: 'B', name: 'Bilinmeyen', price: '5' },
      { supplierCode: 'C', name: 'Bozuk', price: 'yok' },
    )
    const before = await supplierState(supplierId)
    const preview = await previewSupplierRefresh(boss, supplierId, file, opts)
    expect(await supplierState(supplierId)).toEqual(before)

    const saved = await refreshSupplier(boss, supplierId, file, opts)
    expect(saved).toEqual(preview)
    expect(saved).toMatchObject({
      received: 3,
      valid: 2,
      created: 2,
      updated: 0,
      autoMatched: 1,
      unmatched: 1,
      priceQtyUnknown: 0,
    })
    expect(saved.errors.map((e) => e.rowNumber)).toEqual([4])
  })

  it('stok defteri, projeksiyon ve ürün kartı fiyatları değişmez (F-12, INV-3)', async () => {
    const before = await ledgerFingerprint()
    await refreshSupplier(
      boss,
      supplierId,
      feed({ supplierCode: 'A', barcode: unitBarcode('P-1'), name: 'Kalem', price: '9', stockQty: '999' }),
      opts,
    )
    expect(await ledgerFingerprint()).toEqual(before)
  })

  it('aynı dosya tekrar: değişim satırı oluşmaz', async () => {
    const file = feed({ supplierCode: 'A', barcode: unitBarcode('P-1'), name: 'Kalem', price: '9' })
    const before = await changeCount(supplierId)
    const summary = await refreshSupplier(boss, supplierId, file, opts)
    expect(summary).toMatchObject({ updated: 1, unchanged: 1, priceUp: 0, priceDown: 0 })
    expect(await changeCount(supplierId)).toBe(before)
  })

  it('9 → 9,90: artış ve yüzde; 10.5 ile 10,50 aynı fiyat', async () => {
    const up = await refreshSupplier(
      boss,
      supplierId,
      feed({ supplierCode: 'A', barcode: unitBarcode('P-1'), name: 'Kalem', price: '9,90' }),
      opts,
    )
    expect(up).toMatchObject({ priceUp: 1, conditionChanged: 0 })

    const [latest] = await listPriceChanges(boss, supplierId, 1, opts)
    expect(latest).toMatchObject({
      kind: 'PRICE',
      direction: 1,
      changePct: '10.0',
      oldPrice: '9.0000',
      newPrice: '9.9000',
    })

    const same = await refreshSupplier(
      boss,
      supplierId,
      feed({ supplierCode: 'A', barcode: unitBarcode('P-1'), name: 'Kalem', price: '9.9' }),
      opts,
    )
    expect(same.unchanged).toBe(1)
  })

  it('para birimi değişirse koşul değişimi: yüzde ve yön yok', async () => {
    const summary = await refreshSupplier(
      boss,
      supplierId,
      feed({ supplierCode: 'A', barcode: unitBarcode('P-1'), name: 'Kalem', price: '0,35', currency: 'USD' }),
      opts,
    )
    expect(summary).toMatchObject({ conditionChanged: 1, priceUp: 0, priceDown: 0 })
    const [latest] = await listPriceChanges(boss, supplierId, 1, opts)
    expect(latest).toMatchObject({ kind: 'CONDITION', direction: null, changePct: null })
    expect(latest?.oldCurrency).toBe('TRY')
    expect(latest?.newCurrency).toBe('USD')
  })
})

describe('önizleme örnek satırları (T200 1b)', () => {
  it('ilk satırları okunduğu ve yazılacağı hâliyle taşır: fiyat, miktar, eşleşme', async () => {
    const supplierId = await newSupplier(true)
    const summary = await previewSupplierRefresh(
      boss,
      supplierId,
      feed(
        { supplierCode: 'S1', barcode: unitBarcode('P-1'), name: 'Kalem', price: '1.234,5', stockQty: '40' },
        { supplierCode: 'S2', name: 'Bilinmeyen', price: '7' },
        { supplierCode: 'S3', name: 'Bozuk', price: '' },
      ),
      opts,
    )
    expect(summary.sample).toEqual([
      {
        rowNumber: 2,
        supplierCode: 'S1',
        barcode: unitBarcode('P-1'),
        name: 'Kalem',
        price: '1234.5000',
        currency: 'TRY',
        taxMode: 'EXCLUDED',
        priceType: 'NET',
        priceQty: '1.000',
        stockQty: '40.000',
        matchState: 'AUTO',
        productName: 'Tükenmez Kalem',
        productSku: 'P-1',
      },
      expect.objectContaining({ rowNumber: 3, matchState: 'UNMATCHED', productName: null }),
    ])
  })

  it('daha önce elle bağlanmış kalemin ürün adı da gelir', async () => {
    const supplierId = await newSupplier(false)
    const file = feed({ supplierCode: 'M', name: 'Elle', price: '3' })
    await refreshSupplier(boss, supplierId, file, opts)
    await bindSupplierItem(boss, await itemId(supplierId, 'M'), tenant.products['P-2']!.id, opts)

    const summary = await previewSupplierRefresh(boss, supplierId, file, opts)
    expect(summary.sample[0]).toMatchObject({ matchState: 'MANUAL', productName: 'Defter', priceQty: null })
  })
})

describe('tedarikçi ayarlarını düzenleme (K1)', () => {
  const settings = {
    name: 'Düzenlenecek Toptan',
    defaultCurrency: 'TRY',
    defaultTaxMode: 'EXCLUDED',
    defaultPriceType: 'NET',
  }

  it('yalnız SONRAKİ yenilemeyi etkiler; saklı kalem ve fiyat geçmişi değişmez', async () => {
    const created = await createSupplier(boss, settings, opts)
    const file = feed({ supplierCode: 'A', name: 'a', price: '10' })
    await refreshSupplier(boss, created.id, file, opts)
    await refreshSupplier(boss, created.id, feed({ supplierCode: 'A', name: 'a', price: '12' }), opts)
    const before = (await supplierState(created.id)) as { items: unknown[][]; changes: number }

    const updated = await updateSupplier(
      boss,
      created.id,
      { ...settings, defaultCurrency: 'USD', unitPriceDeclared: true },
      opts,
    )
    expect(updated).toMatchObject({ defaultCurrency: 'USD', unitPriceDeclared: true })

    // Geriye dönük hiçbir şey değişmedi: kalem hâlâ TL ve miktarı belirsiz.
    const after = (await supplierState(created.id)) as { items: unknown[][]; changes: number }
    expect(after.items).toEqual(before.items)
    expect(after.changes).toBe(before.changes)

    // Sonraki yenileme yeni varsayılanı kullanır ve bunu koşul değişimi yazar.
    const next = await refreshSupplier(boss, created.id, feed({ supplierCode: 'A', name: 'a', price: '12' }), opts)
    expect(next).toMatchObject({ conditionChanged: 1, priceUp: 0, priceQtyUnknown: 0 })
    const [latest] = await listPriceChanges(boss, created.id, 1, opts)
    expect(latest).toMatchObject({
      kind: 'CONDITION',
      oldCurrency: 'TRY',
      newCurrency: 'USD',
      oldPriceQty: null,
      newPriceQty: '1.000',
      changePct: null,
    })
  })

  it('başka bir tedarikçinin adı alınamaz', async () => {
    const first = await createSupplier(boss, { ...settings, name: 'Ad Çakışması A' }, opts)
    await createSupplier(boss, { ...settings, name: 'Ad Çakışması B' }, opts)
    const err = await errorOf(() =>
      updateSupplier(boss, first.id, { ...settings, name: 'ad çakışması b' }, opts),
    )
    expect(err.code).toBe('SUPPLIER_NAME_EXISTS')
  })

  it('seçilmeyen koşul Türkçe doğrulama hatası verir', async () => {
    const supplierId = await newSupplier(false)
    const err = await errorOf(() =>
      updateSupplier(boss, supplierId, { ...settings, name: 'X', defaultTaxMode: '' }, opts),
    )
    expect(err.code).toBe('VALIDATION_FAILED')
    expect(err.details.issues).toEqual([{ path: 'defaultTaxMode', message: 'KDV durumunu seçin' }])
  })
})

describe('fiyat miktarı: eşleşmeden ayrı, yalnız açık beyandan (B2)', () => {
  it('beyansız tedarikçide miktar belirsiz; fiyat değişimi yüzdesiz', async () => {
    const supplierId = await newSupplier(false)
    const first = await refreshSupplier(
      boss,
      supplierId,
      feed({ supplierCode: 'A', barcode: unitBarcode('P-2'), name: 'Defter', price: '20' }),
      opts,
    )
    expect(first).toMatchObject({ autoMatched: 1, priceQtyUnknown: 1 })

    const second = await refreshSupplier(
      boss,
      supplierId,
      feed({ supplierCode: 'A', barcode: unitBarcode('P-2'), name: 'Defter', price: '22' }),
      opts,
    )
    expect(second).toMatchObject({ qtyUnknownChanged: 1, priceUp: 0 })
    const [latest] = await listPriceChanges(boss, supplierId, 1, opts)
    expect(latest).toMatchObject({ kind: 'QTY_UNKNOWN', direction: null, changePct: null })
  })

  it('koli barkodu eşleşir ama fiyat miktarı ÜRETMEZ; beyan o satır için askıya alınır', async () => {
    const supplierId = await newSupplier(true)
    const summary = await refreshSupplier(
      boss,
      supplierId,
      feed({ supplierCode: 'K', barcode: caseBarcode('P-1'), name: 'Kalem 12li', price: '100' }),
      opts,
    )
    expect(summary).toMatchObject({ autoMatched: 1, priceQtyUnknown: 1 })
    expect(summary.warnings[0]?.messages).toEqual([
      'Koli barkoduyla eşleşti; fiyat miktarı belirsiz bırakıldı',
    ])
    const { rows } = await listSupplierItems(boss, supplierId, {}, opts)
    expect(rows[0]).toMatchObject({
      matchState: 'AUTO',
      productId: tenant.products['P-1']!.id,
      priceQty: null,
    })
  })

  it('satırdaki açık "Fiyat Miktarı" kullanılır, koli çarpanı değil', async () => {
    const supplierId = await newSupplier(true)
    await refreshSupplier(
      boss,
      supplierId,
      feed({ supplierCode: 'K', barcode: caseBarcode('P-1'), name: 'Kalem 12li', price: '100', priceQty: '10' }),
      opts,
    )
    const { rows } = await listSupplierItems(boss, supplierId, {}, opts)
    expect(rows[0]?.priceQty).toBe('10.000')
  })
})

describe('eşleşme kararları yenilemede korunur', () => {
  it('arşivli ürünün barkodu eşleşmez', async () => {
    const supplierId = await newSupplier(true)
    const summary = await refreshSupplier(
      boss,
      supplierId,
      feed({ supplierCode: 'X', barcode: unitBarcode('ARS'), name: 'Arşivli', price: '1' }),
      opts,
    )
    expect(summary).toMatchObject({ autoMatched: 0, unmatched: 1 })
  })

  it('elle bağlama (MANUAL) ve yok sayma (IGNORED) sonraki yenilemede değişmez', async () => {
    const supplierId = await newSupplier(true)
    const file = feed(
      { supplierCode: 'M', name: 'Elle bağlanacak', price: '5' },
      { supplierCode: 'I', barcode: unitBarcode('P-1'), name: 'Yok sayılacak', price: '6' },
    )
    await refreshSupplier(boss, supplierId, file, opts)

    await bindSupplierItem(boss, await itemId(supplierId, 'M'), tenant.products['P-2']!.id, opts)
    await ignoreSupplierItem(boss, await itemId(supplierId, 'I'), opts)

    const again = await refreshSupplier(boss, supplierId, file, opts)
    expect(again).toMatchObject({ autoMatched: 0, unmatched: 0 })

    const { rows } = await listSupplierItems(boss, supplierId, {}, opts)
    const byCode = Object.fromEntries(rows.map((r) => [r.supplierCode, r]))
    expect(byCode.M).toMatchObject({ matchState: 'MANUAL', productId: tenant.products['P-2']!.id })
    expect(byCode.I).toMatchObject({ matchState: 'IGNORED', productId: null })

    const pending = await listSupplierItems(boss, supplierId, { matchState: 'IGNORED' }, opts)
    expect(pending.total).toBe(1)
  })

  it('arşivli ürüne elle bağlanamaz', async () => {
    const supplierId = await newSupplier(true)
    await refreshSupplier(boss, supplierId, feed({ supplierCode: 'Z', name: 'z', price: '1' }), opts)
    const id = await itemId(supplierId, 'Z')
    const err = await errorOf(() => bindSupplierItem(boss, id, tenant.products.ARS!.id, opts))
    expect(err.code).toBe('NOT_FOUND')
  })
})

describe('kısmi ve hatalı yenileme', () => {
  it('dosyada olmayan kalem değişmez: fiyatı, zamanı ve eşleşmesi aynı kalır', async () => {
    const supplierId = await newSupplier(true)
    await refreshSupplier(
      boss,
      supplierId,
      feed(
        { supplierCode: '1', name: 'bir', price: '1' },
        { supplierCode: '2', barcode: unitBarcode('P-2'), name: 'iki', price: '2' },
        { supplierCode: '3', name: 'üç', price: '3' },
      ),
      opts,
    )
    const before = (await supplierState(supplierId)) as { items: unknown[][] }

    await refreshSupplier(boss, supplierId, feed({ supplierCode: '1', name: 'bir', price: '1,5' }), opts)
    const after = (await supplierState(supplierId)) as { items: unknown[][] }

    expect(after.items[1]).toEqual(before.items[1])
    expect(after.items[2]).toEqual(before.items[2])
    expect(after.items[0]?.[1]).toBe('1.5000')
  })

  it('yazma sırasında hata: hiçbir şey kalıcı olmaz (tek transaction)', async () => {
    const supplierId = await newSupplier(true)
    await refreshSupplier(boss, supplierId, feed({ supplierCode: 'A', name: 'a', price: '1' }), opts)
    const before = await supplierState(supplierId)

    // Gerçek bir veritabanı hatası: geçmiş satırı yazılırken düşen bir tetikleyici.
    await admin.db.execute(sql`
      CREATE FUNCTION t200_fail_change() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'T200 test: yazma hatası'; END $$
    `)
    await admin.db.execute(sql`
      CREATE TRIGGER t200_fail_change BEFORE INSERT ON supplier_price_changes
      FOR EACH ROW EXECUTE FUNCTION t200_fail_change()
    `)
    try {
      const failed = await refreshSupplier(
        boss,
        supplierId,
        feed({ supplierCode: 'A', name: 'a', price: '2' }, { supplierCode: 'B', name: 'b', price: '3' }),
        opts,
      ).then(
        () => 'yazıldı',
        () => 'düştü',
      )
      expect(failed).toBe('düştü')
    } finally {
      await admin.db.execute(sql`DROP TRIGGER t200_fail_change ON supplier_price_changes`)
      await admin.db.execute(sql`DROP FUNCTION t200_fail_change()`)
    }
    expect(await supplierState(supplierId)).toEqual(before)
  })

  it('geçerli satır yoksa kayıt reddedilir; önizleme hataları gösterir; son yenileme ilerlemez', async () => {
    const supplierId = await newSupplier(true)
    const file = feed({ supplierCode: 'A', name: 'a', price: '0' })

    const preview = await previewSupplierRefresh(boss, supplierId, file, opts)
    expect(preview.valid).toBe(0)
    expect(preview.errors).toHaveLength(1)

    const err = await errorOf(() => refreshSupplier(boss, supplierId, file, opts))
    expect(err.code).toBe('SUPPLIER_FEED_NO_VALID_ROWS')
    expect((await getSupplier(boss, supplierId, opts)).lastRefreshedAt).toBeNull()
  })
})

/** Tedarikçi sorgusu çalıştırırken kilit bekleyen uygulama oturumu sayısına ulaşılana kadar bekler. */
async function waitForSupplierLockWaiters(count: number): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const rows = await admin.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND usename = 'stok_app'
         AND wait_event_type = 'Lock' AND query ILIKE '%supplier%'
    `)
    if ([...rows][0]!.n >= count) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${count} kilit bekleyişi oluşmadı`)
}

describe('eşzamanlılık', () => {
  /**
   * Zamanlamaya bırakılmış bir paralel test (10 istek, Promise.all) kilit
   * kaldırıldığında da yeşil kaldı: iki yenilemenin aynı eski fiyatı okuması
   * dar bir pencereye bağlı. Bu test pencereyi ZORLA açıyor: kalem satırı
   * dışarıdan kilitliyken iki yenileme başlatılıyor ve ikisinin de beklemeye
   * girdiği görülmeden kilit bırakılmıyor.
   *
   *   kilitli kod   ikinci yenileme tedarikçi kilidinde bekler, birinci
   *                 yazdıktan SONRA yeni fiyatı okur → 1 geçmiş satırı
   *   kilitsiz kod  ikisi de eski fiyatı okuyup yazma noktasında bekler
   *                 → aynı değişim için 2 geçmiş satırı
   */
  it('aynı değişimi taşıyan iki eşzamanlı yenileme tek geçmiş satırı yazar', async () => {
    const supplierId = await newSupplier(true)
    await refreshSupplier(boss, supplierId, feed({ supplierCode: 'A', name: 'a', price: '10' }), opts)
    const id = await itemId(supplierId, 'A')
    const file = feed({ supplierCode: 'A', name: 'a', price: '11' })

    let runs: Promise<PromiseSettledResult<unknown>[]> | undefined
    await admin.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM supplier_items WHERE id = ${id} FOR UPDATE`)
      runs = Promise.allSettled([
        refreshSupplier(boss, supplierId, file, opts),
        refreshSupplier(boss, supplierId, file, opts),
      ])
      await waitForSupplierLockWaiters(2)
    })

    const results = await runs!
    expect(results.filter((r) => r.status === 'rejected')).toEqual([])
    expect(await changeCount(supplierId)).toBe(1)
  })
})

describe('ürün sayfasında karşılaştırma', () => {
  it('yalnız aynı koşul ve bilinen miktar aynı grupta; belirsiz ayrı ve sırasız', async () => {
    const cheap = await newSupplier(true)
    const dear = await newSupplier(true)
    const dollar = await newSupplier(true, 'USD')
    const vague = await newSupplier(false)
    const code = unitBarcode('CMP')
    await refreshSupplier(boss, dear, feed({ supplierCode: 'D', barcode: code, name: 'Ürün', price: '21' }), opts)
    await refreshSupplier(boss, cheap, feed({ supplierCode: 'D', barcode: code, name: 'Ürün', price: '18' }), opts)
    // Daha ucuz görünen USD ve miktarı belirsiz teklif TRY grubunun sırasına girmemeli.
    await refreshSupplier(boss, dollar, feed({ supplierCode: 'D', barcode: code, name: 'Ürün', price: '0,60' }), opts)
    await refreshSupplier(boss, vague, feed({ supplierCode: 'D', barcode: code, name: 'Ürün', price: '1' }), opts)

    const offers = await listProductOffers(boss, tenant.products.CMP!.id, opts)
    expect(offers.groups.map((g) => [g.currency, g.taxMode, g.priceType, g.priceQty])).toEqual([
      ['TRY', 'EXCLUDED', 'NET', '1.000'],
      ['USD', 'EXCLUDED', 'NET', '1.000'],
    ])
    expect(offers.groups[0]?.offers.map((o) => [o.supplierId, o.price, o.isLowest])).toEqual([
      [cheap, '18.0000', true],
      [dear, '21.0000', false],
    ])
    // Tek teklifli grupta "en düşük" anlamsız.
    expect(offers.groups[1]?.offers.map((o) => o.isLowest)).toEqual([false])
    expect(offers.uncertain).toHaveLength(1)
    expect(offers.uncertain[0]).toMatchObject({ supplierId: vague, price: '1.0000', isLowest: false })
  })
})

describe('kiracı izolasyonu ve yetki', () => {
  let supplierId: string
  let item: string

  beforeAll(async () => {
    supplierId = await newSupplier(true)
    await refreshSupplier(boss, supplierId, feed({ supplierCode: 'A', name: 'a', price: '1' }), opts)
    item = await itemId(supplierId, 'A')
  })

  it('başka kiracı tedarikçiyi okuyamaz, yenileyemez, kalemini bağlayamaz', async () => {
    expect((await errorOf(() => getSupplier(otherBoss, supplierId, opts))).code).toBe('NOT_FOUND')
    expect(
      (
        await errorOf(() =>
          updateSupplier(
            otherBoss,
            supplierId,
            { name: 'Ele geçirme', defaultCurrency: 'TRY', defaultTaxMode: 'EXCLUDED', defaultPriceType: 'NET' },
            opts,
          ),
        )
      ).code,
    ).toBe('NOT_FOUND')
    expect(
      (await errorOf(() => refreshSupplier(otherBoss, supplierId, feed({ supplierCode: 'A', name: 'a', price: '9' }), opts))).code,
    ).toBe('NOT_FOUND')
    expect(
      (await errorOf(() => bindSupplierItem(otherBoss, item, other.products['B-1']!.id, opts))).code,
    ).toBe('NOT_FOUND')
    expect((await listSuppliers(otherBoss, opts)).some((s) => s.id === supplierId)).toBe(false)
  })

  it('kendi kalemi başka kiracının ürününe bağlanamaz (FK RLS\'i atlar, T153)', async () => {
    const err = await errorOf(() => bindSupplierItem(boss, item, other.products['B-1']!.id, opts))
    expect(err.code).toBe('NOT_FOUND')
    const { rows } = await listSupplierItems(boss, supplierId, {}, opts)
    expect(rows[0]?.productId).toBeNull()
  })

  it('bozuk kimlik 500 değil NOT_FOUND', async () => {
    expect((await errorOf(() => getSupplier(boss, 'kimlik-değil', opts))).code).toBe('NOT_FOUND')
  })

  it('çalışan hiçbir tedarikçi fonksiyonunu çağıramaz (INV-10)', async () => {
    const productId = tenant.products['P-1']!.id
    const calls: [string, () => Promise<unknown>][] = [
      ['listSuppliers', () => listSuppliers(staff, opts)],
      ['getSupplier', () => getSupplier(staff, supplierId, opts)],
      ['createSupplier', () => createSupplier(staff, { name: 'x', defaultCurrency: 'TRY', defaultTaxMode: 'EXCLUDED', defaultPriceType: 'NET' }, opts)],
      ['previewSupplierRefresh', () => previewSupplierRefresh(staff, supplierId, feed({ supplierCode: 'A', name: 'a', price: '1' }), opts)],
      ['refreshSupplier', () => refreshSupplier(staff, supplierId, feed({ supplierCode: 'A', name: 'a', price: '1' }), opts)],
      ['bindSupplierItem', () => bindSupplierItem(staff, item, productId, opts)],
      ['ignoreSupplierItem', () => ignoreSupplierItem(staff, item, opts)],
      ['updateSupplier', () => updateSupplier(staff, supplierId, { name: 'x', defaultCurrency: 'TRY', defaultTaxMode: 'EXCLUDED', defaultPriceType: 'NET' }, opts)],
      ['listSupplierItems', () => listSupplierItems(staff, supplierId, {}, opts)],
      ['listPriceChanges', () => listPriceChanges(staff, supplierId, 10, opts)],
      ['listProductOffers', () => listProductOffers(staff, productId, opts)],
    ]
    for (const [name, call] of calls) {
      const err = await errorOf(call)
      expect(err.code, name).toBe('FORBIDDEN')
    }
  })
})
