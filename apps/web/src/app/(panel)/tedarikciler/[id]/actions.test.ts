import { createSupplier, listSupplierItems } from '@stok/core'
import { closeAppDb } from '@stok/db'
import { TEST_PASSWORD, type TestTenant, seedTestTenant, testAdminDb } from '@stok/db/testing'
import { revalidatePath } from 'next/cache'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Actor } from '@stok/core'
import { MAX_UPLOAD_BYTES, SUPPLIER_SAVE_BLOB_LIMIT } from '@/server/config'
import { startSession } from '@/server/session'
import { resetCookieJar } from '@/test/cookie-jar'
import { TEST_DB_NAME } from '@/test/db-name'
import { previewRefreshAction, saveRefreshAction } from './actions'

/**
 * ============================================================================
 * T200 1b — "VERİLERİ GETİR" EYLEMLERİ, GERÇEK OTURUM VE GERÇEK VERİTABANIYLA
 *
 * Sahte olan tek şey Next'in önbellek sınırı (`revalidatePath`): Next'in istek
 * bağlamı dışında çağrılamıyor. Çerezler `setup.ts`'teki kavanozdan; core,
 * yetki ve veritabanı gerçek.
 * ============================================================================
 */
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const admin = testAdminDb(TEST_DB_NAME)
let tenant: TestTenant
let boss: Actor
let supplierId: string

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'tedarikcieylem', [{ sku: 'TE-1', name: 'Eylem Ürünü' }])
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  const created = await createSupplier(boss, {
    name: 'Eylem Toptan',
    defaultCurrency: 'TRY',
    defaultTaxMode: 'EXCLUDED',
    defaultPriceType: 'NET',
    unitPriceDeclared: true,
  })
  supplierId = created.id
  resetCookieJar()
  await startSession(tenant.adminEmail, TEST_PASSWORD)
})

afterAll(async () => {
  await admin.client.end()
  await closeAppDb()
})

function uploadForm(content: string | Uint8Array<ArrayBuffer>, name = 'liste.csv'): FormData {
  const form = new FormData()
  form.set('tedarikciId', supplierId)
  form.set('dosya', new File([content], name))
  return form
}

function saveForm(fileJson: string): FormData {
  const form = new FormData()
  form.set('tedarikciId', supplierId)
  form.set('dosyaJson', fileJson)
  form.set('dosyaAdi', 'liste.csv')
  return form
}

const csv = () =>
  [
    'Kod;Barkod;Ürün Adı;Fiyat;Koli İçi Adet',
    `E-1;${tenant.products['TE-1']!.barcode};Kalem;12,50;12`,
    'E-2;;Silgi;3;1',
    'E-3;;Bozuk;;1',
  ].join('\n')

describe('önizleme (previewRefreshAction)', () => {
  it('dosya yoksa ne yapılacağını söylüyor', async () => {
    const state = await previewRefreshAction({}, new FormData())
    expect(state.error).toBe('Önce bir dosya seçin.')
  })

  it('sınırın üstündeki dosya çözümlenmeden reddediliyor', async () => {
    const state = await previewRefreshAction({}, uploadForm(new Uint8Array(MAX_UPLOAD_BYTES + 1)))
    expect(state.error).toMatch(/çok büyük/i)
    expect(state.error).toMatch(/4 MB/)
    expect(state.preview).toBeUndefined()
  })

  it('okunan ve okunmayan sütunları, örnek satırları gösteriyor; hiçbir şey yazmıyor', async () => {
    const state = await previewRefreshAction({}, uploadForm(csv()))

    expect(state.error).toBeUndefined()
    expect(state.columns).toContainEqual({ label: 'Tedarikçi Kodu', header: 'Kod' })
    expect(state.ignoredColumns).toEqual(['Koli İçi Adet'])
    expect(state.preview).toMatchObject({ valid: 2, errorCount: 1, autoMatched: 1, unmatched: 1 })
    expect(state.preview?.sample[0]).toMatchObject({
      price: '12.5000',
      matchState: 'AUTO',
      productName: 'Eylem Ürünü',
      priceQty: '1.000',
    })
    expect(state.saveBlocked).toBe(false)

    const items = await listSupplierItems(boss, supplierId)
    expect(items.total, 'önizleme kalem yazdı').toBe(0)
  })
})

describe('kayıt (saveRefreshAction)', () => {
  it('önizlenen içeriği kaydediyor ve sayfayı yeniliyor', async () => {
    const previewed = await previewRefreshAction({}, uploadForm(csv()))
    const state = await saveRefreshAction({}, saveForm(previewed.fileJson!))

    expect(state.error).toBeUndefined()
    expect(state.saved).toMatchObject({ valid: 2, created: 2, errorCount: 1 })
    expect((await listSupplierItems(boss, supplierId)).total).toBe(2)
    expect(revalidatePath).toHaveBeenCalledWith(`/tedarikciler/${supplierId}`)
  })

  it('önizlemenin kabul ettiği dosya kayıtta uzunluk kuralı yüzünden reddedilmiyor (REVIEW B1)', async () => {
    // 1.260 karakterlik ad ve 210 okunmayan sütun: eskiden önizleme "1 geçerli"
    // diyor, kayıt bütün dosyayı VALIDATION_FAILED ile reddediyordu.
    const extra = Array.from({ length: 210 }, (_, i) => `Ek ${i + 1}`)
    const file = [
      ['Kod', 'Ürün Adı', 'Fiyat', ...extra].join(';'),
      ['B1-GEC', 'Geçerli', '7', ...extra.map(() => 'x')].join(';'),
      ['B1-UZN', 'Uzun ürün adı '.repeat(90), '8', ...extra.map(() => 'x')].join(';'),
    ].join('\n')

    const previewed = await previewRefreshAction({}, uploadForm(file))
    expect(previewed.preview).toMatchObject({ valid: 1, errorCount: 1 })
    expect(previewed.ignoredColumnsOmitted).toBe(10)

    const state = await saveRefreshAction({}, saveForm(previewed.fileJson!))
    expect(state.error).toBeUndefined()
    expect(state.saved).toMatchObject({ valid: 1, errorCount: 1 })
  })

  it('bozuk JSON doğrulama hatası, istisna değil', async () => {
    const state = await saveRefreshAction({}, saveForm('{bozuk'))
    expect(state.error).toBe('Girilen bilgilerde hata var')
  })

  it('kurcalanmış blob (bilinmeyen alan) doğrulama hatası veriyor ve yazmıyor', async () => {
    const before = (await listSupplierItems(boss, supplierId)).total
    const blob = JSON.stringify({
      rows: [{ rowNumber: 2, cells: { productId: 'x' } }],
      columns: [],
      ignoredColumns: [],
    })
    const state = await saveRefreshAction({}, saveForm(blob))
    expect(state.error).toBeDefined()
    expect(state.saved).toBeUndefined()
    expect((await listSupplierItems(boss, supplierId)).total).toBe(before)
  })

  it('sınırın üstündeki blob ayrıştırılmadan reddediliyor', async () => {
    const state = await saveRefreshAction({}, saveForm('x'.repeat(SUPPLIER_SAVE_BLOB_LIMIT + 1)))
    expect(state.error).toMatch(/çok büyük/)
  })
})

describe('yetki', () => {
  it('çalışan önizleyemez ve kaydedemez (dosya okunmadan)', async () => {
    resetCookieJar()
    await startSession(tenant.staffEmail, TEST_PASSWORD)

    expect((await previewRefreshAction({}, uploadForm(csv()))).error).toBe('Bu işlem için yetkiniz yok')
    expect((await saveRefreshAction({}, saveForm('{}'))).error).toBe('Bu işlem için yetkiniz yok')
  })
})
