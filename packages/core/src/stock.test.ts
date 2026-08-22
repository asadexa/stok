import { randomUUID } from 'node:crypto'
import { AppError } from '@stok/shared'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz.js'
import { createMovement } from './movements.js'
import { dashboardSummary, getProduct, listCategories, listStock } from './stock.js'
import { TEST_DB_NAME } from './test/db-name.js'

/**
 * ============================================================================
 * T19 — STOK TABLOSU
 *
 * En kritik grup Türkçe arama. `lower()` + `unaccent` ile yazılsaydı
 * "ısıtıcı" arayan kullanıcı "Isıtıcı" ürününü BULAMAZDI ve bulamayınca
 * ürünün sistemde olmadığını sanıp bir kopyasını daha eklerdi — yani
 * arama hatası veri hatasına dönüşürdü. Bu yüzden testler sadece
 * "arama çalışıyor mu" değil, Türkçe'ye özgü dört harf çiftini tek tek
 * sınıyor.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

let tenant: TestTenant
let boss: Actor
let staff: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'stock', [
    { sku: 'ISI-001', name: 'Isıtıcı Şerit', unit: 'METRE', minStock: '10' },
    { sku: 'KAL-001', name: 'Kırmızı Tükenmez Kalem', minStock: '5' },
    { sku: 'SER-001', name: 'ŞERİT BANT 50mm' },
    { sku: 'CAK-001', name: 'Çakı Paslanmaz' },
    { sku: 'ARS-001', name: 'Arşivli Ürün', archived: true },
  ])
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }

  // ISI-001: 3 adet → kritik (eşik 10). KAL-001: 40 adet → normal.
  await move(tenant.products['ISI-001']!.barcode, 3)
  await move(tenant.products['KAL-001']!.barcode, 40)
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

const opts = { db: app.db }

async function move(barcode: string, qty: number, unitCost?: number) {
  return createMovement(
    boss,
    {
      idempotencyKey: randomUUID(),
      barcode,
      qty,
      reason: 'PURCHASE',
      ...(unitCost === undefined ? {} : { unitCost }),
      clientCreatedAt: new Date().toISOString(),
    },
    opts,
  )
}

const names = (rows: { name: string }[]) => rows.map((r) => r.name)

describe('T19 - Türkçe arama (D-4.1)', () => {
  it.each([
    ['ısıtıcı', 'Isıtıcı Şerit'],
    ['Isıtıcı', 'Isıtıcı Şerit'],
    ['ISITICI', 'Isıtıcı Şerit'],
    ['isitici', 'Isıtıcı Şerit'],
  ])('"%s" araması "%s" ürününü buluyor', async (search, expected) => {
    // ı/I/i/İ dört ayrı harf. Hangi biçimde yazılırsa yazılsın aynı
    // ürüne ulaşmalı; aksi halde kullanıcı ürünü yok sanıp kopyasını ekler.
    const page = await listStock(boss, { search }, opts)
    expect(names(page.rows)).toContain(expected)
  })

  it.each([
    ['şerit', ['Isıtıcı Şerit', 'ŞERİT BANT 50mm']],
    ['SERIT', ['Isıtıcı Şerit', 'ŞERİT BANT 50mm']],
    ['serit', ['Isıtıcı Şerit', 'ŞERİT BANT 50mm']],
  ])('"%s" araması ş/S ayrımını yutuyor', async (search, expected) => {
    const page = await listStock(boss, { search }, opts)
    for (const name of expected) expect(names(page.rows)).toContain(name)
  })

  it('ç/c ve ğ/g de normalize ediliyor', async () => {
    expect(names((await listStock(boss, { search: 'cakı' }, opts)).rows)).toContain(
      'Çakı Paslanmaz',
    )
    expect(names((await listStock(boss, { search: 'ÇAKI' }, opts)).rows)).toContain(
      'Çakı Paslanmaz',
    )
  })

  it('stok kodu da aranıyor (barkod okuyucu klavye emülasyonu)', async () => {
    const page = await listStock(boss, { search: 'KAL-001' }, opts)
    expect(names(page.rows)).toEqual(['Kırmızı Tükenmez Kalem'])
  })

  it('eşleşme yoksa boş sonuç, hata değil', async () => {
    // "'defter' bulunamadı" ekranı bir boş durum, bir hata değil
    // (PLAN.md Bölüm 11).
    const page = await listStock(boss, { search: 'kesinlikle-yok' }, opts)
    expect(page.rows).toEqual([])
    expect(page.total).toBe(0)
  })
})

describe('T19 - filtreler ve sayfalama', () => {
  it('arşivli ürün varsayılan olarak GİZLİ', async () => {
    const page = await listStock(boss, {}, opts)
    expect(names(page.rows)).not.toContain('Arşivli Ürün')
  })

  it('istenirse arşivli de geliyor', async () => {
    const page = await listStock(boss, { includeArchived: true }, opts)
    expect(names(page.rows)).toContain('Arşivli Ürün')
  })

  it('sadece kritik seviyedekiler süzülebiliyor', async () => {
    const page = await listStock(boss, { onlyCritical: true }, opts)
    expect(names(page.rows)).toContain('Isıtıcı Şerit')
    expect(names(page.rows)).not.toContain('Kırmızı Tükenmez Kalem')
  })

  it('kritik bayrağı sunucuda hesaplanıyor', async () => {
    // İki ayrı yerde hesaplanırsa tablo ile uyarı sayacı ayrışır ve
    // kullanıcı hangisine güveneceğini bilemez.
    const page = await listStock(boss, {}, opts)
    const isitici = page.rows.find((r) => r.sku === 'ISI-001')
    const kalem = page.rows.find((r) => r.sku === 'KAL-001')

    expect(isitici?.critical).toBe(true)
    expect(kalem?.critical).toBe(false)
  })

  it('kritik ürünler listenin BAŞINDA', async () => {
    const page = await listStock(boss, {}, opts)
    const firstNonCritical = page.rows.findIndex((r) => !r.critical)
    const lastCritical = page.rows.map((r) => r.critical).lastIndexOf(true)

    expect(lastCritical).toBeLessThan(firstNonCritical === -1 ? Number.MAX_SAFE_INTEGER : firstNonCritical)
  })

  it('hiç hareketi olmayan ürün 0 gösteriyor, boş değil', async () => {
    const page = await listStock(boss, { search: 'ŞERİT BANT' }, opts)
    expect(page.rows[0]?.qty).toBe(0)
  })

  it('sayfalama toplam sayıyı ayrıca döndürüyor', async () => {
    const first = await listStock(boss, { limit: 2, offset: 0 }, opts)
    const second = await listStock(boss, { limit: 2, offset: 2 }, opts)

    expect(first.rows).toHaveLength(2)
    expect(first.total).toBe(4) // arşivli hariç
    expect(second.total).toBe(4)
    // Sayfalar örtüşmüyor.
    const overlap = first.rows.filter((r) => second.rows.some((s) => s.sku === r.sku))
    expect(overlap).toEqual([])
  })

  it('limit üst sınırı zorlanıyor', async () => {
    await expect(listStock(boss, { limit: 5000 }, opts)).rejects.toBeInstanceOf(AppError)
  })

  it('kategori listesi arşivlileri saymıyor ve Türkçe sırada geliyor', async () => {
    const fresh = await seedTestTenant(admin.db, 'stock-kategori', [
      { sku: 'K-1', name: 'Bir' },
      { sku: 'K-2', name: 'İki' },
      { sku: 'K-3', name: 'Üç' },
      { sku: 'K-4', name: 'Dört', archived: true },
    ])
    const freshBoss: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    await admin.db.execute(
      `UPDATE products SET category = CASE sku
         WHEN 'K-1' THEN 'Zımba'
         WHEN 'K-2' THEN 'Çelik'
         WHEN 'K-3' THEN 'Ahşap'
         ELSE 'Arşivdeki Kategori' END
       WHERE tenant_id = '${fresh.tenantId}'`,
    )

    const categories = await listCategories(freshBoss, opts)

    // Sıra Türkçe: A < Ç < Z. Veritabanı collation'ı C.UTF-8 olduğu için
    // ham `ORDER BY category` "Çelik"i "Zımba"dan SONRA koyardı — açılır
    // kutuda Türkçe baş harfli her kategori listenin dibinde kalırdı.
    expect(categories).toEqual(['Ahşap', 'Çelik', 'Zımba'])
    // Arşivli ürünün kategorisi listede yok: bugünkü stoğun kategorileri.
    expect(categories).not.toContain('Arşivdeki Kategori')
  })

  it('ürünler Türkçe alfabe sırasında listeleniyor', async () => {
    // Aynı sorun ürün adında: 'Ç' baytı 'Z'den büyük olduğu için
    // C.UTF-8 collation'ında "Çelik" listenin en altına inerdi. Sıralama
    // `name_norm` (stored generated column, tr_norm(name)) üzerinden.
    const fresh = await seedTestTenant(admin.db, 'stock-sira', [
      { sku: 'S-Z', name: 'Zeytin Yağı' },
      { sku: 'S-C', name: 'Çelik Vida' },
      { sku: 'S-U', name: 'Ütü Masası' },
      { sku: 'S-A', name: 'Ahşap Kalem' },
    ])
    const freshBoss: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }

    // Hepsi aynı kritiklik grubunda (stok 0, eşik 0), yani sıra tamamen
    // ada göre belirleniyor.
    const page = await listStock(freshBoss, { limit: 10 }, opts)

    expect(names(page.rows)).toEqual([
      'Ahşap Kalem',
      'Çelik Vida',
      'Ütü Masası',
      'Zeytin Yağı',
    ])
  })
})

describe('T19 - fiyat gizleme (tehdit S7)', () => {
  beforeAll(async () => {
    await admin.db.execute(
      `UPDATE products SET purchase_price = 12.34, sale_price = 19.99
        WHERE tenant_id = '${tenant.tenantId}' AND sku = 'KAL-001'`,
    )
  })

  it('admin fiyatları görüyor', async () => {
    const page = await listStock(boss, { search: 'KAL-001' }, opts)
    expect(page.rows[0]?.purchasePrice).toBe(12.34)
    expect(page.rows[0]?.salePrice).toBe(19.99)
  })

  it('çalışanın cevabında fiyat ALANI HİÇ YOK', async () => {
    const page = await listStock(staff, { search: 'KAL-001' }, opts)
    const row = page.rows[0]!

    expect(Object.hasOwn(row, 'purchasePrice')).toBe(false)
    expect(Object.hasOwn(row, 'salePrice')).toBe(false)
    expect(JSON.stringify(page)).not.toContain('12.34')
  })

  it('çalışan stok tablosunu yine de görebiliyor', async () => {
    // Fiyatı gizlemek listeyi kapatmak değil: çalışan ürün arayabilmeli.
    const page = await listStock(staff, {}, opts)
    expect(page.rows.length).toBeGreaterThan(0)
  })
})

describe('T18 - dashboard özeti', () => {
  it('kritik ürün sayısı tabloyla tutarlı', async () => {
    const summary = await dashboardSummary(boss, new Date(0), opts)
    const critical = await listStock(boss, { onlyCritical: true, limit: 200 }, opts)

    expect(summary.criticalCount).toBe(critical.total)
  })

  it('bugünkü giriş ve çıkış ayrı sayılıyor', async () => {
    const fresh = await seedTestTenant(admin.db, 'stock-today', [{ sku: 'T-1', name: 'Bugün' }])
    const freshBoss: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    const barcode = fresh.products['T-1']!.barcode

    for (const qty of [10, 5]) {
      await createMovement(
        freshBoss,
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
    await createMovement(
      freshBoss,
      {
        idempotencyKey: randomUUID(),
        barcode,
        qty: 4,
        reason: 'SALE',
        clientCreatedAt: new Date().toISOString(),
      },
      opts,
    )

    const summary = await dashboardSummary(freshBoss, new Date(0), opts)
    expect(summary.today).toEqual({ inCount: 2, inQty: 15, outCount: 1, outQty: 4 })
  })

  it('zaman aralığı dışındaki hareket sayılmıyor', async () => {
    // "Bugün" kullanıcının saat diliminde başlıyor; sınır dışarıdan geliyor.
    const summary = await dashboardSummary(boss, new Date(Date.now() + 60_000), opts)
    expect(summary.today).toEqual({ inCount: 0, inQty: 0, outCount: 0, outQty: 0 })
  })

  it('başarısız iş sayısı G4 uyarısını besliyor', async () => {
    const summary = await dashboardSummary(boss, new Date(0), opts)
    expect(summary.failedJobCount).toBe(0)
  })

  it('çalışan da özeti görebiliyor (stok:read yeter)', async () => {
    await expect(dashboardSummary(staff, new Date(0), opts)).resolves.toBeTruthy()
  })

  it('çalışanın günlük özeti SADECE kendi hareketlerini sayıyor', async () => {
    // Rol matrisi çalışana "hareket geçmişi (tüm kullanıcılar)" vermiyor.
    // Listeyi kısıtlayıp özeti kısıtlamasaydık, çalışan gün boyu kaç
    // satış yapıldığını sayaç üzerinden yine öğrenirdi.
    const fresh = await seedTestTenant(admin.db, 'stock-scope', [{ sku: 'S-1', name: 'Kapsam' }])
    const freshBoss: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    const freshStaff: Actor = { tenantId: fresh.tenantId, userId: fresh.staffUserId, role: 'STAFF' }
    const barcode = fresh.products['S-1']!.barcode

    const push = (actor: Actor, qty: number) =>
      createMovement(
        actor,
        {
          idempotencyKey: randomUUID(),
          barcode,
          qty,
          reason: 'PURCHASE',
          clientCreatedAt: new Date().toISOString(),
        },
        opts,
      )

    await push(freshBoss, 7)
    await push(freshStaff, 2)

    const bossView = await dashboardSummary(freshBoss, new Date(0), opts)
    const staffView = await dashboardSummary(freshStaff, new Date(0), opts)

    expect(bossView.today).toEqual({ inCount: 2, inQty: 9, outCount: 0, outQty: 0 })
    expect(staffView.today).toEqual({ inCount: 1, inQty: 2, outCount: 0, outQty: 0 })
  })

  it('çalışana başarısız iş sayısı alanı HİÇ konulmuyor', async () => {
    // 0 döndürmek "hata yok" demek olurdu; doğrusu "bu kullanıcı bilmiyor".
    // Fiyat alanlarındaki kalıbın aynısı (redactPrices).
    const summary = await dashboardSummary(staff, new Date(0), opts)
    expect('failedJobCount' in summary).toBe(false)

    const bossSummary = await dashboardSummary(boss, new Date(0), opts)
    expect('failedJobCount' in bossSummary).toBe(true)
  })

  it('kritik ürün sayısı çalışan için de görünüyor', async () => {
    // Kritik stok herkesin işi: çalışan "bu ürün bitmek üzere" bilgisini
    // görmezse depoda eksik kalan şeyi kimse fark etmez.
    const summary = await dashboardSummary(staff, new Date(0), opts)
    expect(summary.criticalCount).toBeGreaterThan(0)
  })
})

describe('getProduct', () => {
  it('arşivli ürünü de döndürüyor', async () => {
    // "Bu ürün arşivde" ile "bulunamadı" kullanıcı için farklı durumlar.
    const archived = tenant.products['ARS-001']!
    const row = await getProduct(boss, archived.id, opts)

    expect(row.name).toBe('Arşivli Ürün')
    expect(row.archivedAt).toBeInstanceOf(Date)
  })

  it('olmayan ürün NOT_FOUND', async () => {
    const err = await getProduct(boss, randomUUID(), opts).then(
      () => undefined,
      (e: unknown) => e as AppError,
    )
    expect(err?.code).toBe('NOT_FOUND')
  })

  it('başka tenantın ürünü NOT_FOUND (RLS)', async () => {
    const other = await seedTestTenant(admin.db, 'stock-other', [{ sku: 'O-1', name: 'Yabancı' }])
    const err = await getProduct(boss, other.products['O-1']!.id, opts).then(
      () => undefined,
      (e: unknown) => e as AppError,
    )
    expect(err?.code).toBe('NOT_FOUND')
  })
})
