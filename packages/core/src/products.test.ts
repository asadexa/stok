import { randomUUID } from 'node:crypto'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { AppError } from '@stok/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { createMovement } from './movements'
import {
  addBarcode,
  archiveBarcode,
  archiveProduct,
  createProduct,
  getProductDetail,
  listBarcodes,
  restoreProduct,
  updateProduct,
} from './products'
import { listStock } from './stock'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T21 — ÜRÜN TANIMI VE ÇOKLU BARKOD
 *
 * En önemli grup barkod kaldırma. Barkodsuz kalan bir ürün depoda
 * OKUTULAMAZ, yani pratikte yok olur — ve bu, kullanıcının ancak eline
 * terminali alıp raf başında fark edeceği bir hata. İkincisi arşivlenmiş
 * barkodun artık çözülmemesi: çözülmeye devam etseydi "kaldır" düğmesi
 * hiçbir şey yapmıyor olurdu.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }

let tenant: TestTenant
let other: TestTenant
let boss: Actor
let staff: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'products')
  other = await seedTestTenant(admin.db, 'products-other')
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

/** Her testin kendi ürünü olsun: paylaşılan ürün, testleri sıraya bağlar. */
let counter = 0
function draft(overrides: Record<string, unknown> = {}) {
  counter += 1
  return {
    sku: `T21-${counter}`,
    name: `Test Ürünü ${counter}`,
    barcodes: [{ barcode: `bc-${counter}-${randomUUID().slice(0, 8)}` }],
    ...overrides,
  }
}

describe('createProduct', () => {
  it('ürünü barkoduyla birlikte yaratıyor', async () => {
    const input = draft({ category: 'Kırtasiye', brand: 'Faber', minStock: 5 })
    const product = await createProduct(boss, input, opts)

    expect(product).toMatchObject({
      sku: input.sku,
      name: input.name,
      category: 'Kırtasiye',
      brand: 'Faber',
      minStock: 5,
      qty: 0,
    })
    expect(product.barcodes).toHaveLength(1)
    expect(product.barcodes[0]).toMatchObject({ kind: 'UNIT', qtyMultiplier: 1 })
  })

  it('yeni ürün stok tablosunda 0 ile görünüyor, kayıp değil', async () => {
    // Hiç hareketi olmayan ürünün current_stock satırı YOK; tablo bunu
    // "boş" değil "0" göstermeli, yoksa yeni ürün eklendiği gün listede
    // eksik görünür.
    const product = await createProduct(boss, draft(), opts)
    const page = await listStock(boss, { search: product.sku }, opts)

    expect(page.rows[0]?.qty).toBe(0)
  })

  it('aynı stok kodu ikinci kez kabul edilmiyor', async () => {
    const input = draft()
    await createProduct(boss, input, opts)

    await expect(
      createProduct(boss, { ...input, barcodes: [{ barcode: `bc-x-${randomUUID()}` }] }, opts),
    ).rejects.toMatchObject({ code: 'SKU_EXISTS', details: { sku: input.sku } })
  })

  it('barkod çakışırsa ÜRÜN DE yazılmıyor', async () => {
    // Aksi halde barkodsuz bir ürün kalırdı ve o ürün depoda hiçbir zaman
    // okutulamazdı.
    const first = await createProduct(boss, draft(), opts)
    const stolen = first.barcodes[0]!.barcode

    const second = draft({ barcodes: [{ barcode: stolen }] })
    await expect(createProduct(boss, second, opts)).rejects.toMatchObject({
      code: 'BARCODE_EXISTS',
    })

    const page = await listStock(boss, { search: second.sku, includeArchived: true }, opts)
    expect(page.total).toBe(0)
  })

  it('koli barkodunun çarpanı 1 olamaz (D7)', async () => {
    await expect(
      createProduct(
        boss,
        draft({ barcodes: [{ barcode: `k-${randomUUID()}`, kind: 'CASE', qtyMultiplier: 1 }] }),
        opts,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('tekli barkodun çarpanı 1 DIŞINDA olamaz (D7 ters yön)', async () => {
    // Çarpanı 12 olan bir TEKLİ barkod, tek kalem okutulduğunda stoğu 12
    // artırırdı; sayı makul göründüğü için kimse fark etmezdi.
    await expect(
      createProduct(
        boss,
        draft({ barcodes: [{ barcode: `u-${randomUUID()}`, kind: 'UNIT', qtyMultiplier: 12 }] }),
        opts,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('barkodsuz ürün reddediliyor', async () => {
    await expect(createProduct(boss, draft({ barcodes: [] }), opts)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('kuruştan küçük fiyat sessizce yuvarlanmıyor, reddediliyor', async () => {
    // PostgreSQL NUMERIC(12,2) fazlasını yuvarlar: 19,999 girip 20,00
    // kaydedilmesini kullanıcı ancak raporda fark ederdi.
    await expect(
      createProduct(boss, draft({ purchasePrice: 19.999 }), opts),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('olmayan konum reddediliyor', async () => {
    await expect(
      createProduct(boss, draft({ locationId: randomUUID() }), opts),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('çalışan ürün yaratamıyor', async () => {
    await expect(createProduct(staff, draft(), opts)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})

describe('updateProduct', () => {
  it('gönderilmeyen alana dokunmuyor', async () => {
    const product = await createProduct(boss, draft({ brand: 'Faber', category: 'Kalem' }), opts)
    const updated = await updateProduct(boss, product.productId, { name: 'Yeni Ad' }, opts)

    expect(updated.name).toBe('Yeni Ad')
    expect(updated.brand).toBe('Faber')
    expect(updated.category).toBe('Kalem')
  })

  it('null gönderilen alan temizleniyor', async () => {
    // `undefined` ile `null` ayrımı olmasaydı bir kez girilen alış fiyatı
    // bir daha asla boşaltılamazdı.
    const product = await createProduct(boss, draft({ brand: 'Faber', purchasePrice: 10 }), opts)
    const updated = await updateProduct(boss, product.productId, { brand: null }, opts)

    expect(updated.brand).toBeNull()
    expect(updated.purchasePrice).toBe(10)
  })

  it('stok kodu başka üründe kullanılıyorsa reddediliyor', async () => {
    const first = await createProduct(boss, draft(), opts)
    const second = await createProduct(boss, draft(), opts)

    await expect(
      updateProduct(boss, second.productId, { sku: first.sku }, opts),
    ).rejects.toMatchObject({ code: 'SKU_EXISTS' })
  })

  it('başka kiracının ürünü güncellenemiyor', async () => {
    const foreign = await createProduct(
      { tenantId: other.tenantId, userId: other.adminUserId, role: 'ADMIN' },
      draft(),
      opts,
    )

    await expect(
      updateProduct(boss, foreign.productId, { name: 'Ele geçirildi' }, opts),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('çalışan güncelleyemiyor', async () => {
    const product = await createProduct(boss, draft(), opts)
    await expect(
      updateProduct(staff, product.productId, { name: 'x' }, opts),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('arşivleme', () => {
  it('arşivlenen ürüne hareket yazılamıyor, geri alınınca yazılabiliyor', async () => {
    const product = await createProduct(boss, draft(), opts)
    const barcode = product.barcodes[0]!.barcode

    await archiveProduct(boss, product.productId, opts)
    await expect(move(barcode)).rejects.toMatchObject({ code: 'PRODUCT_ARCHIVED' })

    await restoreProduct(boss, product.productId, opts)
    await expect(move(barcode)).resolves.toMatchObject({ duplicate: false })
  })

  it('arşivli ürün varsayılan listede yok, "arşiv dahil" ile var', async () => {
    const product = await createProduct(boss, draft(), opts)
    await archiveProduct(boss, product.productId, opts)

    const visible = await listStock(boss, { search: product.sku }, opts)
    const all = await listStock(boss, { search: product.sku, includeArchived: true }, opts)

    expect(visible.total).toBe(0)
    expect(all.total).toBe(1)
  })

  it('stoğu olan ürün de arşivlenebiliyor', async () => {
    // Engellenseydi "artık satmıyoruz ama depoda 3 tane kaldı" ürününü
    // listeden çıkarmanın tek yolu sahte bir çıkış hareketi yazmak olurdu.
    const product = await createProduct(boss, draft(), opts)
    await move(product.barcodes[0]!.barcode, 3)

    const archived = await archiveProduct(boss, product.productId, opts)
    expect(archived.archivedAt).not.toBeNull()
    expect(archived.qty).toBe(3)
  })
})

describe('çoklu barkod', () => {
  it('koli barkodu okutulunca miktar çarpanla çarpılıyor (D7)', async () => {
    const product = await createProduct(boss, draft(), opts)
    await addBarcode(
      boss,
      product.productId,
      { barcode: `koli-${randomUUID()}`, kind: 'CASE', qtyMultiplier: 12 },
      opts,
    )
    const barcodes = await listBarcodes(boss, product.productId, opts)
    const koli = barcodes.find((b) => b.kind === 'CASE')!

    const result = await move(koli.barcode, 5)
    expect(result.effectiveQty).toBe(60)
  })

  it('başka ürüne ait barkod eklenemiyor', async () => {
    const a = await createProduct(boss, draft(), opts)
    const b = await createProduct(boss, draft(), opts)

    await expect(
      addBarcode(boss, b.productId, { barcode: a.barcodes[0]!.barcode }, opts),
    ).rejects.toMatchObject({ code: 'BARCODE_EXISTS' })
  })

  it('son aktif barkod kaldırılamıyor', async () => {
    // Barkodsuz ürün depoda okutulamaz, yani pratikte yok olur.
    const product = await createProduct(boss, draft(), opts)

    await expect(
      archiveBarcode(boss, product.barcodes[0]!.id, opts),
    ).rejects.toMatchObject({ code: 'LAST_BARCODE' })
  })

  it('ikinci barkod eklendikten sonra ilki kaldırılabiliyor', async () => {
    const product = await createProduct(boss, draft(), opts)
    await addBarcode(boss, product.productId, { barcode: `ek-${randomUUID()}` }, opts)

    const after = await archiveBarcode(boss, product.barcodes[0]!.id, opts)
    const active = after.filter((b) => b.archivedAt === null)

    expect(active).toHaveLength(1)
    expect(after).toHaveLength(2) // arşivli olan listede duruyor
  })

  it('kaldırılan barkod artık çözülmüyor', async () => {
    // Çözülmeye devam etseydi "kaldır" düğmesi hiçbir şey yapmıyor olurdu:
    // etiket rafta duruyor, okutan kişi yine yanlış üründen düşürüyor.
    const product = await createProduct(boss, draft(), opts)
    const extra = await addBarcode(
      boss,
      product.productId,
      { barcode: `gec-${randomUUID()}` },
      opts,
    )
    const doomed = extra.find((b) => b.barcode !== product.barcodes[0]!.barcode)!

    await expect(move(doomed.barcode)).resolves.toBeTruthy()
    await archiveBarcode(boss, doomed.id, opts)
    await expect(move(doomed.barcode)).rejects.toMatchObject({ code: 'BARCODE_UNKNOWN' })
  })

  it('kaldırılan barkodun geçmişi duruyor', async () => {
    // stock_movements.barcode_id FK ile bağlı; gerçek DELETE 23503 ile
    // patlardı ve "koli mu birim mi okutuldu" bilgisi kaybolurdu.
    const product = await createProduct(boss, draft(), opts)
    const list = await addBarcode(boss, product.productId, { barcode: `iz-${randomUUID()}` }, opts)
    const doomed = list.find((b) => b.barcode !== product.barcodes[0]!.barcode)!

    const movement = await move(doomed.barcode, 4)
    await archiveBarcode(boss, doomed.id, opts)

    const rows = await admin.db.execute<{ barcode_id: string | null }>(
      `SELECT barcode_id FROM stock_movements WHERE id = '${movement.movementId}'`,
    )
    expect([...rows][0]?.barcode_id).toBe(doomed.id)
  })

  it('kaldırılan barkod başka bir ürüne yeniden bağlanabiliyor', async () => {
    // Kısmi unique index'in sebebi bu: etiket rafın üstünde duruyor, onu
    // doğru ürüne bağlayamamak kabul edilemez.
    const wrong = await createProduct(boss, draft(), opts)
    const label = `etiket-${randomUUID()}`
    const list = await addBarcode(boss, wrong.productId, { barcode: label }, opts)
    await archiveBarcode(boss, list.find((b) => b.barcode === label)!.id, opts)

    const right = await createProduct(boss, draft(), opts)
    const moved = await addBarcode(boss, right.productId, { barcode: label }, opts)

    expect(moved.some((b) => b.barcode === label && b.archivedAt === null)).toBe(true)
    const result = await move(label, 2)
    expect(result.productId).toBe(right.productId)
  })

  it('aynı barkod iki kez kaldırılırsa ikincisi hata vermiyor', async () => {
    const product = await createProduct(boss, draft(), opts)
    const list = await addBarcode(boss, product.productId, { barcode: `cd-${randomUUID()}` }, opts)
    const target = list.find((b) => b.barcode !== product.barcodes[0]!.barcode)!

    await archiveBarcode(boss, target.id, opts)
    await expect(archiveBarcode(boss, target.id, opts)).resolves.toBeTruthy()
  })

  it('çalışan barkod ekleyemiyor ve kaldıramıyor', async () => {
    // Yanlış barkod eşlemesi SESSİZ bir stok hatası üretir: okutan kişi
    // doğru ürünü okuttuğunu sanır, sayı başka üründen düşer.
    const product = await createProduct(boss, draft(), opts)

    await expect(
      addBarcode(staff, product.productId, { barcode: `y-${randomUUID()}` }, opts),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(archiveBarcode(staff, product.barcodes[0]!.id, opts)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})

describe('getProductDetail', () => {
  it('arşivli ürünü de döndürüyor', async () => {
    const product = await createProduct(boss, draft(), opts)
    await archiveProduct(boss, product.productId, opts)

    const detail = await getProductDetail(boss, product.productId, opts)
    expect(detail.archivedAt).not.toBeNull()
    expect(detail.barcodes).toHaveLength(1)
  })

  it('çalışanın cevabında fiyat alanı yok', async () => {
    const product = await createProduct(boss, draft({ purchasePrice: 12.5 }), opts)
    const detail = await getProductDetail(staff, product.productId, opts)

    expect(Object.hasOwn(detail, 'purchasePrice')).toBe(false)
  })
})

function move(barcode: string, qty = 1) {
  return createMovement(
    boss,
    {
      idempotencyKey: randomUUID(),
      barcode,
      qty,
      reason: 'PURCHASE',
      clientCreatedAt: new Date().toISOString(),
    },
    opts,
  )
}

/**
 * ============================================================================
 * T82-T84 — ÜRÜN GÖRSELİ
 *
 * Görselin KENDİSİ değil ADRESİ saklanıyor: dosya deposu seçimi PLAN.md
 * ÇÖZÜLMEMİŞ KARAR U3'e (hosting) bağlı ve karar verilmeden bir yükleme yolu
 * gömmek U3'ü sessizce karara bağlamak olurdu.
 *
 * En kritik test şema kısıtlaması: adres arayüzde bir `<img src>` içine
 * giriyor ve toplu aktarmayla DIŞARIDAN geliyor.
 * ============================================================================
 */
describe('T82-T84 - ürün görseli', () => {
  it('görsel adresi kaydediliyor ve stok listesinde geri geliyor', async () => {
    const url = 'https://ornek-tedarikci.com/g/urun.jpg'
    const product = await createProduct(boss, draft({ imageUrl: url }), opts)

    const page = await listStock(boss, { productId: product.productId, limit: 1 }, opts)
    expect(page.rows[0]?.imageUrl).toBe(url)
  })

  it('görselsiz ürün null dönüyor — arayüz baş harf karesine düşüyor', async () => {
    const product = await createProduct(boss, draft(), opts)
    const page = await listStock(boss, { productId: product.productId, limit: 1 }, opts)
    expect(page.rows[0]?.imageUrl).toBeNull()
  })

  it('görsel KALDIRILABİLİYOR', async () => {
    // `optional` "dokunma", `null` "sil" demek. İkisi ayrılmasaydı görsel
    // bir kez konduktan sonra geri alınamazdı.
    const product = await createProduct(
      boss,
      draft({ imageUrl: 'https://ornek.com/x.png' }),
      opts,
    )
    await updateProduct(boss, product.productId, { imageUrl: null }, opts)

    const page = await listStock(boss, { productId: product.productId, limit: 1 }, opts)
    expect(page.rows[0]?.imageUrl).toBeNull()
  })

  it('http olmayan şema REDDEDİLİYOR', async () => {
    await expect(
      createProduct(boss, draft({ imageUrl: 'javascript:alert(1)' }), opts),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

    await expect(
      createProduct(boss, draft({ imageUrl: 'data:image/svg+xml,<svg/>' }), opts),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})
