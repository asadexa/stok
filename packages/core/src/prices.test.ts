import { randomUUID } from 'node:crypto'
import { AppError, errorText } from '@stok/shared'
import { sql } from 'drizzle-orm'
import { isCheckViolation, pgConstraint } from '@stok/db'
import {
  type TestProductSpec,
  type TestTenant,
  seedOpeningStock,
  seedTestTenant,
  testAdminDb,
  testAppDb,
} from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMovement, listMovements, lookupBarcode } from './movements'
import type { Actor } from './authz'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T88 — KASA AÇIĞI KONTROLÜ
 *
 * Senaryo (tasarım: docs/designs/fiyat-defteri.md): kırtasiyede çalışan A4
 * satıyor, fiş liste fiyatından 110 ₺ yazıyor, müşteri tanıdık diye 100 ₺
 * alınıyor, kasada 10 ₺ açık kalıyor.
 *
 * Bu dosyanın sınadığı tek şey: O 10 ₺ GİZLENEBİLİYOR MU.
 *
 * Kontrolü çürütmenin üç yolu var ve üçünün de kapalı olduğu ayrı ayrı
 * sınanıyor:
 *
 *   1. İSTEMCİ LİSTE FİYATINI KENDİ SÖYLER  → sapma sıfırlanır, sebep hiç
 *      sorulmaz. Sunucu liste fiyatını üründen KENDİSİ okuyor.
 *   2. ÜRÜN SONRADAN DÜZENLENİR              → geçmişteki fark değişir.
 *      Liste fiyatı harekete DONDURULUYOR.
 *   3. KURAL YALNIZCA UYGULAMADA DURUR       → seed, import ve /api/v1 onu
 *      atlar. Kural veritabanında da CHECK olarak duruyor.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

/** Fiyatlı ürünler: varsayılan fixture'da fiyat NULL ve kural hiç işlemezdi. */
const PRICED_PRODUCTS: TestProductSpec[] = [
  { sku: 'A4-001', name: 'A4 Fotokopi Kağıdı', purchasePrice: '80.00', salePrice: '110.00' },
  { sku: 'KAL-001', name: 'Kırmızı Tükenmez Kalem', purchasePrice: '12.50', salePrice: '19.90' },
  // Fiyatsız ürün: liste fiyatı yoksa sapma diye bir şey de yok.
  { sku: 'YOK-001', name: 'Fiyatsız Ürün' },
]

let tenant: TestTenant
let staff: Actor
let boss: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'fiyat', PRICED_PRODUCTS)
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }

  // Satış testleri için stok. `createMovement` ile yazsaydık kurulum,
  // test ettiğimiz fonksiyonun doğru çalışmasına bağlı olurdu.
  for (const p of Object.values(tenant.products)) {
    await seedOpeningStock(admin.db, tenant, p.id, '1000')
  }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

function req(sku: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    barcode: tenant.products[sku]!.barcode,
    qty: 1,
    reason: 'SALE',
    clientCreatedAt: new Date().toISOString(),
    ...overrides,
  }
}

const call = (actor: Actor, body: Record<string, unknown>) =>
  createMovement(actor, body, { db: app.db })

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err, `beklenen ${code} hatası atılmadı`).toBeInstanceOf(AppError)
  expect((err as AppError).code).toBe(code)
  return err as AppError
}

/**
 * Beklenen CHECK ihlalini doğrular.
 *
 * Hata metnine bakmak yetmez: drizzle sürücü hatasını KENDİ hatasına
 * sarıyor ve dıştaki mesajda yalnızca sorgu metni var — constraint adı
 * `cause` zincirinde. Metne bakan bir test bu yüzden her CHECK ihlalinde
 * yeşil yanardı, hatta yanlış constraint tetiklense bile.
 */
async function expectCheckViolation(promise: Promise<unknown>, constraint: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err, `beklenen ${constraint} ihlali olmadı`).toBeDefined()
  expect(isCheckViolation(err)).toBe(true)
  expect(pgConstraint(err)).toBe(constraint)
}

/** Hareketin ham fiyat sütunlarını okur — yetki katmanından GEÇMEDEN. */
async function rawPrices(movementId: string) {
  const rows = await admin.db.execute<{
    unit_price: string | null
    list_price: string | null
    client_list_price: string | null
    price_source: string | null
    price_override_reason: string | null
    price_date: string | null
  }>(sql`
    SELECT unit_price, list_price, client_list_price, price_source,
           price_override_reason, price_date::text AS price_date
      FROM stock_movements WHERE id = ${movementId}
  `)
  return [...rows][0]!
}

describe('liste fiyatının otoritesi SUNUCUDA', () => {
  it('sapma sebepsiz REDDEDİLİYOR', async () => {
    // Kontrolün tamamı bu satırda: 110 ₺'lik mal 100 ₺'ye yazılıyor ve
    // sebep yok. Kabul edilseydi kasa açığı hiçbir yerde görünmezdi.
    const err = await expectAppError(
      call(staff, req('A4-001', { unitPrice: 100 })),
      'PRICE_OVERRIDE_REASON_REQUIRED',
    )
    // Hata metni iki sayıyı da taşımalı: kullanıcı "hangi sapma?" diye
    // soracak ve cevabı hata mesajında bulmalı.
    expect(err.details).toMatchObject({ unitPrice: 100, listPrice: 110 })
    // Ve metin TÜRKÇE BİÇİMDE olmalı: uygulamanın geri kalanı "110,00"
    // yazarken bu tek ekranda "110" görünmesi tarayıcı testinde yakalandı.
    expect(errorText(err.code, err.details)).toContain('110,00 ₺')
    expect(errorText(err.code, err.details)).toContain('100,00 ₺')
  })

  it('ALIŞ fiyatı hata metninden SIZMIYOR (tehdit S7)', async () => {
    // Detaylar Türkçe hata metnine, oradan da adres çubuğuna ve ağ
    // sekmesine düşüyor. Listeden gizlediğimiz alış fiyatı, forma
    // kasten yanlış fiyat yazılarak sorgulanabilir olurdu.
    const err = await expectAppError(
      call(staff, req('A4-001', { reason: 'PURCHASE', unitPrice: 1 })),
      'PRICE_OVERRIDE_REASON_REQUIRED',
    )
    expect(Object.hasOwn(err.details, 'listPrice')).toBe(false)
    expect(errorText(err.code, err.details)).not.toContain('80')
    // Metin sayı olmadan da anlamlı kalmalı; yoksa kullanıcı ne
    // yapacağını bilemez.
    expect(errorText(err.code, err.details)).toContain('Sapma sebebi')

    // Aynı sapmayı ADMIN yaparsa sayı görünüyor: gizleme yetkiye bağlı.
    const bossErr = await expectAppError(
      call(boss, req('A4-001', { reason: 'PURCHASE', unitPrice: 1 })),
      'PRICE_OVERRIDE_REASON_REQUIRED',
    )
    expect(bossErr.details).toMatchObject({ listPrice: 80 })
  })

  it('İSTEMCİNİN GÖNDERDİĞİ LİSTE FİYATI SAPMAYI SIFIRLAYAMIYOR', async () => {
    // Kontrolü çürütmenin en kolay yolu bu: istemci "liste zaten 100'dü"
    // der, sapma sıfırlanır, sebep hiç sorulmaz. Sunucu istemcinin
    // sayısını KARŞILAŞTIRMAYA HİÇ SOKMUYOR.
    await expectAppError(
      call(staff, req('A4-001', { unitPrice: 100, clientListPrice: 100 })),
      'PRICE_OVERRIDE_REASON_REQUIRED',
    )
  })

  it('istemci fiyat kaynağını LIST diye etiketleyemiyor', async () => {
    // `LIST` sunucunun TÜRETTİĞİ bir değer. İstemci gönderebilseydi elle
    // yazılmış bir fiyat "liste fiyatından satıldı" diye kaydedilir ve
    // rapor yalan söylerdi.
    await expectAppError(
      call(staff, req('A4-001', { unitPrice: 110, priceSource: 'LIST' })),
      'VALIDATION_FAILED',
    )
  })

  it('sapma sebebiyle birlikte kabul ediliyor ve İKİ SAYI DA saklanıyor', async () => {
    const result = await call(
      staff,
      req('A4-001', { unitPrice: 100, clientListPrice: 110, priceOverrideReason: 'TANIDIK' }),
    )
    const row = await rawPrices(result.movementId)

    expect(row.unit_price).toBe('100.00')
    // Sunucunun okuduğu liste fiyatı — istemcinin dediği değil.
    expect(row.list_price).toBe('110.00')
    expect(row.client_list_price).toBe('110.00')
    expect(row.price_override_reason).toBe('TANIDIK')
    expect(row.price_source).toBe('MANUAL')
  })

  it('istemcinin BAYAT liste fiyatı ayrı sütunda kanıt olarak duruyor', async () => {
    // Fiş 100 ₺ yazarken sistemdeki liste 110 ₺ ise ekran bayat demektir.
    // Sunucununkiyle sessizce değiştirilseydi müşteriye yanlış fiş
    // kesildiği hiç fark edilmezdi.
    const result = await call(
      staff,
      req('A4-001', { unitPrice: 100, clientListPrice: 100, priceOverrideReason: 'TANIDIK' }),
    )
    const row = await rawPrices(result.movementId)

    expect(row.list_price).toBe('110.00')
    expect(row.client_list_price).toBe('100.00')
  })

  it('liste fiyatına eşit satışta sebep DÜŞÜYOR, kaynak LIST oluyor', async () => {
    // "110'a sattım ama tanıdık indirimi yaptım" diyen bir satır rapora
    // girer ve indirim toplamını şişirirdi. DB CHECK bunu yakalamaz:
    // sapma yokken sebep fazlalık, constraint'e göre geçerli.
    const result = await call(
      staff,
      req('A4-001', { unitPrice: 110, priceOverrideReason: 'TANIDIK' }),
    )
    const row = await rawPrices(result.movementId)

    expect(row.unit_price).toBe('110.00')
    expect(row.price_override_reason).toBeNull()
    expect(row.price_source).toBe('LIST')
  })

  it('liste fiyatı YOKSA sapma da yok — fiyat serbestçe yazılıyor', async () => {
    const result = await call(staff, req('YOK-001', { unitPrice: 55 }))
    const row = await rawPrices(result.movementId)

    expect(row.unit_price).toBe('55.00')
    expect(row.list_price).toBeNull()
  })

  it('fiyat hiç girilmezse hareket yine yazılıyor', async () => {
    // Fiyatı zorunlu kılmak bugünün akışını kırardı; T88 veriyi toplamaya
    // başlıyor, kullanıcıyı formdan kaçırmıyor.
    const result = await call(staff, req('A4-001'))
    const row = await rawPrices(result.movementId)

    expect(row.unit_price).toBeNull()
    // Tek başına bir liste fiyatı "bu fiyattan işlem gördü" gibi okunurdu.
    expect(row.list_price).toBeNull()
  })
})

describe('liste fiyatı harekete DONDURULUYOR', () => {
  it('ürünün satış fiyatı sonradan değişse de geçmişteki fark değişmiyor', async () => {
    const result = await call(
      staff,
      req('KAL-001', { unitPrice: 15, priceOverrideReason: 'TOPTAN' }),
    )
    expect((await rawPrices(result.movementId)).list_price).toBe('19.90')

    // Ürün zamlanıyor: 19,90 → 24,90.
    await admin.db.execute(sql`
      UPDATE products SET sale_price = '24.90'
       WHERE tenant_id = ${tenant.tenantId} AND sku = 'KAL-001'
    `)

    // Liste fiyatı harekete dondurulmasaydı bu satır artık 9,90 ₺'lik bir
    // açık gösterirdi — oysa o gün 4,90 ₺'ydi. Defter tam da bunun için
    // append-only.
    expect((await rawPrices(result.movementId)).list_price).toBe('19.90')

    await admin.db.execute(sql`
      UPDATE products SET sale_price = '19.90'
       WHERE tenant_id = ${tenant.tenantId} AND sku = 'KAL-001'
    `)
  })
})

describe('sebep listeden, serbest metin değil', () => {
  it('listede olmayan sebep reddediliyor', async () => {
    await expectAppError(
      call(staff, req('A4-001', { unitPrice: 100, priceOverrideReason: 'CUNKU_ISTEDIM' })),
      'VALIDATION_FAILED',
    )
  })

  it('"Diğer" açıklama olmadan reddediliyor', async () => {
    // Açıklamasız "Diğer", raporda "bu ay 4.200 ₺ Diğer" satırı demek —
    // ve kimse nedenini öğrenemez.
    await expectAppError(
      call(staff, req('A4-001', { unitPrice: 100, priceOverrideReason: 'DIGER' })),
      'VALIDATION_FAILED',
    )
  })

  it('"Diğer" açıklamayla kabul ediliyor', async () => {
    const result = await call(
      staff,
      req('A4-001', {
        unitPrice: 100,
        priceOverrideReason: 'DIGER',
        note: 'Müşteri şikayeti sonrası indirim',
      }),
    )
    expect((await rawPrices(result.movementId)).price_override_reason).toBe('DIGER')
  })
})

describe('fiyatın dayanağı sebepten türüyor', () => {
  it('satın almada liste fiyatı ALIŞ fiyatından okunuyor', async () => {
    const result = await call(
      boss,
      req('A4-001', { reason: 'PURCHASE', unitPrice: 80 }),
    )
    const row = await rawPrices(result.movementId)

    expect(row.list_price).toBe('80.00')
    expect(row.price_source).toBe('LIST')
  })

  it('müşteri iadesinde dayanak SATIŞ fiyatı', async () => {
    // İade edilen tutar malın satıldığı tutardır; alış fiyatını dayanak
    // almak müşteriye ödenen parayı yanlış ölçerdi.
    const result = await call(boss, req('A4-001', { reason: 'RETURN_IN', unitPrice: 110 }))
    expect((await rawPrices(result.movementId)).list_price).toBe('110.00')
  })

  it('fire/kullanımda fiyat REDDEDİLİYOR, sessizce yutulmuyor', async () => {
    // Sessizce yutulsaydı kullanıcı yazdığı tutarın kaydedildiğini sanır,
    // oysa rapora hiç girmezdi.
    await expectAppError(
      call(boss, req('A4-001', { reason: 'DAMAGE', unitPrice: 80 })),
      'PRICE_NOT_APPLICABLE',
    )
  })
})

describe('yetki: hangi fiyat kime görünüyor (D7)', () => {
  it('çalışan KENDİ SATIŞININ fiyatını görüyor', async () => {
    // Satış fiyatı ticari sır değil: müşteri zaten biliyor, fiyatı
    // çalışanın kendisi söyledi. Gizlemek, çalışanın kendi yazdığı satırı
    // okuyamaması demek olurdu.
    const result = await call(
      staff,
      req('KAL-001', { unitPrice: 15, priceOverrideReason: 'TOPTAN' }),
    )
    const rows = await listMovements(staff, { productId: tenant.products['KAL-001']!.id }, {
      db: app.db,
    })
    const row = rows.find((r) => r.id === result.movementId)

    expect(row?.unitPrice).toBe(15)
    expect(row?.listPrice).toBe(19.9)
    expect(row?.priceOverrideReason).toBe('TOPTAN')
  })

  it('çalışan cevabında ALIŞ fiyatı ALANI HİÇ YOK', async () => {
    // `null` bırakmak yetmez: arayüz "fiyat girilmemiş" ile "görmeye
    // yetkin yok" durumlarını ayırt edemez (tehdit S7). `OPENING` de
    // dahil — devir bir alış değerlemesidir.
    // Hareketi ÇALIŞANIN KENDİSİ yazıyor: rol matrisi çalışana yalnızca
    // kendi hareketlerini gösteriyor (satır 3), yani patronun yazdığı bir
    // satırla sınamak gizlemeyi değil kapsam kısıtını ölçerdi.
    await call(staff, req('KAL-001', { reason: 'PURCHASE', unitPrice: 12.5 }))
    const rows = await listMovements(staff, { productId: tenant.products['KAL-001']!.id }, {
      db: app.db,
    })
    const purchases = rows.filter((r) => r.reason === 'PURCHASE')

    expect(purchases.length).toBeGreaterThan(0)
    for (const row of purchases) {
      expect(Object.hasOwn(row, 'unitPrice')).toBe(false)
      expect(Object.hasOwn(row, 'listPrice')).toBe(false)
      expect(Object.values(row)).not.toContain(12.5)
    }
  })

  it('admin her iki fiyatı da görüyor', async () => {
    const rows = await listMovements(boss, { productId: tenant.products['KAL-001']!.id }, {
      db: app.db,
    })
    expect(rows.some((r) => r.reason === 'PURCHASE' && r.unitPrice === 12.5)).toBe(true)
  })

  it('barkod önizlemesi çalışana SATIŞ fiyatını veriyor, alışı vermiyor', async () => {
    // Satış fiyatı raf etiketinde yazıyor. Gizlenseydi çalışan sapmayı
    // hesaplayamaz, formda ne yazdığını bilemezdi.
    const seen = await lookupBarcode(staff, tenant.products['A4-001']!.barcode, { db: app.db })
    expect(seen.salePrice).toBe(110)
    expect(Object.hasOwn(seen, 'purchasePrice')).toBe(false)

    const bossSees = await lookupBarcode(boss, tenant.products['A4-001']!.barcode, { db: app.db })
    expect(bossSees.purchasePrice).toBe(80)
  })
})

/**
 * ============================================================================
 * T89 — AÇILIŞ DEĞERLEMESİ
 *
 * Müşteri 5 yıldır elinde tuttuğu malı sisteme girerken fiyat alanında
 * tıkanıyor: eski fatura yok, bugünkü fiyat da doğru değil.
 *
 * Kritik alan fiyat değil TARİH. Bu bloğun sınadığı şey, o tarihin
 * T88'in kasa açığı kontrolünde bir KAÇAK açmadığı.
 * ============================================================================
 */
describe('açılış değerlemesi: fiyatın ekonomik tarihi', () => {
  /**
   * Tarihler YEREL saatten üretiliyor, `toISOString()` ile DEĞİL.
   *
   * `toISOString()` UTC'ye çevirir ve UTC'den sapmalı saat dilimlerinde
   * günün bir bölümünde BAŞKA BİR GÜN döndürür (Türkiye'de 00:00–03:00
   * arası dünü). Testin kendisi bunu yaparsa, sunucudaki aynı hatayı
   * yakalayamaz: iki taraf da aynı yanlış günü hesaplar ve test yeşil
   * yanar. Mutasyon testinde tam olarak bu yaşandı.
   */
  const gunFarki = (n: number) => {
    const d = new Date()
    d.setDate(d.getDate() + n)
    const p = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const gunOnce = (n: number) => gunFarki(-n)

  it('devirde birim fiyat ZORUNLU', async () => {
    // Defter append-only: fiyatsız yazılan bir devir satırının değeri
    // sonradan eklenemez, o stok sonsuza kadar değersiz görünür.
    await expectAppError(
      call(boss, req('A4-001', { reason: 'OPENING' })),
      'PRICE_REQUIRED',
    )
  })

  it('geçmiş tarihli devir liste fiyatıyla KARŞILAŞTIRILMIYOR', async () => {
    // 5 yıl önceki 45 ₺'yi bugünkü 80 ₺'lik listeyle kıyaslamak kategori
    // hatası: aradaki fark indirim değil enflasyon. Sebep sorulsaydı
    // kullanıcı her devir satırında anlamsız bir seçime zorlanırdı.
    const result = await call(
      boss,
      req('A4-001', { reason: 'OPENING', unitPrice: 45, priceDate: gunOnce(1800) }),
    )
    const row = await rawPrices(result.movementId)

    expect(row.unit_price).toBe('45.00')
    expect(row.price_date).toBe(gunOnce(1800))
    // Liste fiyatı DONMUYOR: kıyaslanacak bir "olması gereken" yok.
    expect(row.list_price).toBeNull()
    expect(row.price_override_reason).toBeNull()
  })

  it('"tahmini" işareti fiyat kaynağına yazılıyor', async () => {
    // Faturası olmayan kullanıcı bugünkü yenileme bedelini yazıyor.
    // Ayrı boolean tutulsaydı kaynak iki yerden okunur ve "fişten okundu
    // ama tahmini" gibi anlamsız bir durum temsil edilebilirdi.
    const result = await call(
      boss,
      req('A4-001', { reason: 'OPENING', unitPrice: 60, priceEstimated: true }),
    )
    const row = await rawPrices(result.movementId)

    expect(row.price_source).toBe('ESTIMATED')
    expect(row.list_price).toBeNull()
    expect(row.price_date).toBeNull()
  })

  it('bugün tarihli devir NORMAL kurala tabi: sapma sebebi isteniyor', async () => {
    // Geçmiş tarih yoksa fiyat BUGÜNÜN parası demektir ve listeden sapması
    // bilinçli bir karardır. Aksi halde "tarihi boş bırak" tek başına
    // kontrolü kapatan bir düğme olurdu.
    await expectAppError(
      call(boss, req('A4-001', { reason: 'OPENING', unitPrice: 45 })),
      'PRICE_OVERRIDE_REASON_REQUIRED',
    )
  })

  it('SATIŞTA GEÇMİŞ TARİH REDDEDİLİYOR — kasa açığı kaçağı kapalı', async () => {
    // Bu testin varlık sebebi: geçmiş tarih serbest bırakılsaydı T88 tek
    // alanla atlanırdı. Çalışan fiyat tarihine dünü yazar, karşılaştırma
    // düşer, 10 ₺'lik açık sebepsiz kaydedilirdi.
    const err = await expectAppError(
      call(staff, req('A4-001', { unitPrice: 1, priceDate: gunOnce(1) })),
      'PRICE_DATE_INVALID',
    )
    expect(err.details).toMatchObject({ reason: 'PAST_ON_SALE' })
  })

  it('ileri tarihli fiyat reddediliyor', async () => {
    const err = await expectAppError(
      call(boss, req('A4-001', { reason: 'OPENING', unitPrice: 45, priceDate: gunFarki(1) })),
      'PRICE_DATE_INVALID',
    )
    expect(err.details).toMatchObject({ reason: 'FUTURE' })
  })

  it('bugün tarihi sütuna YAZILMIYOR: boş = hareket tarihi', async () => {
    // Bu test aynı zamanda saat dilimi korumasını sınıyor: sunucu "bugün"ü
    // UTC'den okusaydı, UTC'den sapmalı bir saat diliminde günün bir
    // bölümünde bu tarih ya GEÇMİŞ (sessizce sütuna yazılır) ya da
    // GELECEK (reddedilir) sayılırdı. Türkiye'de o pencere her gece
    // 00:00–03:00 — kasa açığı kontrolünün her gece üç saat kapalı
    // kalması demek.
    const result = await call(
      boss,
      req('A4-001', { reason: 'OPENING', unitPrice: 80, priceDate: gunFarki(0) }),
    )
    expect((await rawPrices(result.movementId)).price_date).toBeNull()
  })
})

describe('kural veritabanında da duruyor (son savunma)', () => {
  it('createMovement ATLANARAK yazılan sebepsiz sapma CHECK ile reddediliyor', async () => {
    // Uygulama katmanı tek başına yeterli olsaydı seed, toplu içe aktarma
    // ve ileride yazılacak /api/v1 ucu kuralı ayrı ayrı atlardı.
    const insert = admin.db.execute(sql`
      INSERT INTO stock_movements
        (tenant_id, product_id, user_id, delta, reason, idempotency_key,
         unit_price, list_price)
      VALUES
        (${tenant.tenantId}, ${tenant.products['A4-001']!.id}, ${tenant.adminUserId},
         '-1', 'SALE', ${randomUUID()}, '100.00', '110.00')
    `)

    await expectCheckViolation(insert, 'movements_price_override_ck')
  })

  it('listede olmayan sebep de veritabanı seviyesinde reddediliyor', async () => {
    const insert = admin.db.execute(sql`
      INSERT INTO stock_movements
        (tenant_id, product_id, user_id, delta, reason, idempotency_key,
         unit_price, list_price, price_override_reason)
      VALUES
        (${tenant.tenantId}, ${tenant.products['A4-001']!.id}, ${tenant.adminUserId},
         '-1', 'SALE', ${randomUUID()}, '100.00', '110.00', 'CUNKU_ISTEDIM')
    `)

    await expectCheckViolation(insert, 'movements_price_reason_ck')
  })
})
