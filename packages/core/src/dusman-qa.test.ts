import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  type TestProductSpec,
  type TestTenant,
  seedOpeningStock,
  seedTestTenant,
  testAdminDb,
  testAppDb,
} from '@stok/db/testing'
import { AppError } from '@stok/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { createMovement } from './movements'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T39 — DÜŞMAN QA (PLAN.md Bölüm 6, "Cuma gecesi 02:00" maddesi 4)
 *
 * NORMAL TESTLERDEN FARKI. Diğer testler "doğru girdi doğru sonucu veriyor
 * mu" diye soruyor. Bu dosya tersini soruyor: **kötü girdi SESSİZCE kabul
 * ediliyor mu.**
 *
 * En tehlikeli sonuç 500 değil, **200**. Reddedilmesi gereken bir miktar
 * kabul edilirse depoda yanlış sayı oluşur ve fark sayım gününe kadar
 * görünmez. Bu yüzden her iddia "hata döndü" değil, **"stok DEĞİŞMEDİ"**
 * diye de kontrol ediliyor.
 *
 * DEĞERLER NEDEN BUNLAR. Hepsi arayüzden gerçekten gelebilir:
 *   - `1e999`      → sayıya çevrilince Infinity; formdan metin olarak gelir
 *   - `-0`         → JavaScript'te 0'a eşit ama işareti farklı
 *   - `0.0001`     → NUMERIC(14,3) ölçeğinin altında; PostgreSQL yuvarlar
 *   - `999999999999` → tek başına geçerli sayı, iş kuralı açısından saçma
 *   - boşluk       → `Number(' ')` sıfır verir, `Number('')` de
 *   - emoji        → `Number('🙂')` NaN verir
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

const URUNLER: TestProductSpec[] = [
  { sku: 'QA-001', name: 'Düşman QA Ürünü', purchasePrice: '10.00', salePrice: '20.00' },
]

let tenant: TestTenant
let boss: Actor
let urunId: string

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'dusman', URUNLER)
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  urunId = tenant.products['QA-001']!.id
  await seedOpeningStock(admin.db, tenant, urunId, '1000')
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

async function stok(): Promise<string> {
  const rows = await admin.db.execute<{ qty: string }>(sql`
    SELECT qty::text FROM current_stock
     WHERE tenant_id = ${tenant.tenantId} AND product_id = ${urunId}
  `)
  return rows[0]?.qty ?? '0'
}

function hareket(overrides: Record<string, unknown>) {
  return {
    idempotencyKey: randomUUID(),
    barcode: tenant.products['QA-001']!.barcode,
    qty: 1,
    reason: 'DAMAGE',
    clientCreatedAt: new Date().toISOString(),
    ...overrides,
  }
}

/**
 * Formdan gelen METNİ sayıya çeviren adım.
 *
 * `apps/web/src/server/form.ts` → `optionalNumber` ile AYNI dönüşüm.
 * Kopyalanmasının sebebi: bu paket `apps/web`e bağımlı değil ve olmamalı.
 * Dönüşüm burada bozulursa test yanlış şeyi sınar — bu yüzden aşağıda ilk
 * `describe` bloğu dönüşümün kendisini de sınıyor.
 */
const formdan = (metin: string): number => Number(metin.replace(',', '.'))

describe('form metni → sayı dönüşümü (arayüzün gerçek yolu)', () => {
  it('düşman metinler beklenen sayısal değerlere çevriliyor', () => {
    // Bu blok "dönüşüm ne yapıyor" sorusunu KAYIT ALTINA alıyor. Aşağıdaki
    // testler bu değerlerin reddedildiğini varsayıyor; varsayım burada
    // görünür olsun ki dönüşüm bir gün değişirse fark edilsin.
    expect(formdan('1e999')).toBe(Number.POSITIVE_INFINITY)
    expect(Object.is(formdan('-0'), -0)).toBe(true)
    expect(formdan('')).toBe(0)
    expect(formdan(' ')).toBe(0)
    expect(Number.isNaN(formdan('🙂'))).toBe(true)
    expect(Number.isNaN(formdan('abc'))).toBe(true)
    // Türkçe klavyede ondalık ayırıcı virgül; reddetmek anlamsız engel olurdu.
    expect(formdan('3,5')).toBe(3.5)
  })
})

describe('MİKTAR — düşman değerler (T39)', () => {
  const KOTU: { ad: string; qty: unknown }[] = [
    { ad: 'Infinity (1e999)', qty: formdan('1e999') },
    { ad: '-Infinity', qty: -formdan('1e999') },
    { ad: 'NaN (emoji)', qty: formdan('🙂') },
    { ad: 'NaN (harf)', qty: formdan('abc') },
    { ad: 'eksi sıfır', qty: formdan('-0') },
    { ad: 'sıfır (boş alan)', qty: formdan('') },
    { ad: 'sıfır (boşluk)', qty: formdan(' ') },
    { ad: 'negatif', qty: -5 },
    { ad: 'ölçek altı (0.0001)', qty: 0.0001 },
    { ad: 'üst sınır üstü (999999999999)', qty: 999_999_999_999 },
    { ad: 'metin ("12")', qty: '12' },
    { ad: 'null', qty: null },
    { ad: 'dizi', qty: [1] },
    { ad: 'nesne', qty: { valueOf: () => 5 } },
  ]

  for (const { ad, qty } of KOTU) {
    it(`${ad} REDDEDİLİYOR ve stok değişmiyor`, async () => {
      const once = await stok()

      await expect(createMovement(boss, hareket({ qty }), { db: app.db })).rejects.toThrow(AppError)

      // ASIL KONTROL. Hata dönmesi yetmez: hata dönüp yine de yazan bir
      // kod yolu, sessiz veri bozulmasının ta kendisi olurdu.
      expect(await stok(), `${ad} stoğu değiştirdi`).toBe(once)
    })
  }

  it('ölçek SINIRINDAKİ değer (0.001) KABUL EDİLİYOR', async () => {
    // Ters yön: düşman testleri kapıyı fazla kapatmış olabilir. NUMERIC(14,3)
    // üç basamağa izin veriyor ve gram/metre satan bir depo bunu kullanır.
    const once = Number(await stok())
    await createMovement(boss, hareket({ qty: 0.001 }), { db: app.db })
    expect(Number(await stok())).toBeCloseTo(once - 0.001, 3)
  })
})

describe('BARKOD — düşman değerler (T39)', () => {
  const KOTU: { ad: string; barcode: unknown }[] = [
    { ad: 'boş', barcode: '' },
    { ad: 'yalnızca boşluk', barcode: '   ' },
    { ad: '64 karakterden uzun', barcode: '8'.repeat(65) },
    { ad: 'sayı', barcode: 8690000000000 },
    { ad: 'null', barcode: null },
    { ad: 'SQL kaçırma denemesi', barcode: "'; DROP TABLE stock_movements; --" },
  ]

  for (const { ad, barcode } of KOTU) {
    it(`${ad} REDDEDİLİYOR`, async () => {
      const once = await stok()
      await expect(
        createMovement(boss, hareket({ barcode }), { db: app.db }),
      ).rejects.toThrow(AppError)
      expect(await stok(), `${ad} stoğu değiştirdi`).toBe(once)
    })
  }

  it('SQL kaçırma denemesinden sonra tablo HÂLÂ DURUYOR', async () => {
    // Parametreli sorgu kullanıldığı için beklenen bu; ama "beklenen" ile
    // "doğrulanmış" arasındaki fark tam olarak bu satır.
    const rows = await admin.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM stock_movements`,
    )
    expect(Number(rows[0]!.n)).toBeGreaterThan(0)
  })

  it('okuyucunun eklediği satır sonu ve boşluk TEMİZLENİYOR', async () => {
    // El terminalleri barkodun sonuna \r\n ekliyor. Reddetmek, gerçek bir
    // cihazla ürünü kullanılamaz yapardı.
    const once = Number(await stok())
    await createMovement(
      boss,
      hareket({ barcode: `  ${tenant.products['QA-001']!.barcode}\r\n` }),
      { db: app.db },
    )
    expect(Number(await stok())).toBe(once - 1)
  })
})

describe('SEBEP ve NOT — düşman değerler (T39)', () => {
  it('listede olmayan sebep REDDEDİLİYOR', async () => {
    await expect(
      createMovement(boss, hareket({ reason: 'HEDİYE' }), { db: app.db }),
    ).rejects.toThrow(AppError)
  })

  it('elle seçilemeyen sebep (sayım düzeltmesi) REDDEDİLİYOR', async () => {
    // Sunucu tarafı kontrol: arayüzde bu seçenek yok ama istemci adresi
    // doğrudan çağırabilir.
    await expect(
      createMovement(boss, hareket({ reason: 'COUNT_ADJUST_UP' }), { db: app.db }),
    ).rejects.toThrow(AppError)
  })

  it('500 karakterden uzun not REDDEDİLİYOR', async () => {
    await expect(
      createMovement(boss, hareket({ note: 'a'.repeat(501) }), { db: app.db }),
    ).rejects.toThrow(AppError)
  })

  it('emoji ve Türkçe karakter içeren not KABUL EDİLİYOR', async () => {
    // Ters yön: not alanı serbest metin ve depoda "kırık paket ⚠ Ağustos'ta
    // geldi" gibi girdiler gerçek.
    const once = Number(await stok())
    await createMovement(
      boss,
      hareket({ note: 'kırık paket ⚠ Ağustos’ta geldi — İĞÜŞÇÖ' }),
      { db: app.db },
    )
    expect(Number(await stok())).toBe(once - 1)
  })
})

describe('FİYAT — düşman değerler (T39, T88 kontrolünün yüzeyi)', () => {
  // Fiyat alanı kasa açığı kontrolünün (T88) girdisi. Buraya sızan bir
  // değer, kontrolü değersizleştirir: sapma yanlış hesaplanır ve açık
  // "yok" görünür.
  const KOTU: { ad: string; unitPrice: unknown }[] = [
    { ad: 'Infinity', unitPrice: formdan('1e999') },
    { ad: '-Infinity', unitPrice: -formdan('1e999') },
    { ad: 'NaN (emoji)', unitPrice: formdan('🙂') },
    { ad: 'negatif', unitPrice: -1 },
    { ad: 'kuruş altı (0.001)', unitPrice: 0.001 },
    { ad: 'üst sınır üstü', unitPrice: 100_000_000 },
    { ad: 'metin', unitPrice: '20.00' },
  ]

  for (const { ad, unitPrice } of KOTU) {
    it(`${ad} ŞEMADA reddediliyor`, async () => {
      const once = await stok()

      /**
       * HATA KODU TAM OLARAK KONTROL EDİLİYOR, "bir AppError fırladı"
       * yetmiyor — ve bu MUTASYONLA yakalandı.
       *
       * `SALE` sebebinde liste fiyatından sapan her tutar zaten sapma
       * sebebi istiyor (T88). Yani gevşek bir iddia, para şemasının bütün
       * kontrollerini kaldırdığımızda BİLE yeşil yanıyordu: reddeden şey
       * şema değil, kasa açığı kontrolüydü. Test korumayı değil, komşusunu
       * ölçüyordu.
       */
      await expect(
        createMovement(boss, hareket({ reason: 'SALE', unitPrice }), { db: app.db }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

      expect(await stok(), `${ad} stoğu değiştirdi`).toBe(once)
    })
  }

  it('SIFIR fiyat KABUL EDİLİYOR ama sapma sebebi İSTİYOR', async () => {
    // Bedava verilen numune gerçek bir iş durumu. Reddetmek yanlış olurdu;
    // ama sessizce geçirmek kasa açığı kontrolünün (T88) delinmesi demek.
    await expect(
      createMovement(boss, hareket({ reason: 'SALE', unitPrice: 0 }), { db: app.db }),
    ).rejects.toMatchObject({ code: 'PRICE_OVERRIDE_REASON_REQUIRED' })

    const once = Number(await stok())
    await createMovement(
      boss,
      hareket({ reason: 'SALE', unitPrice: 0, priceOverrideReason: 'KAMPANYA' }),
      { db: app.db },
    )
    expect(Number(await stok())).toBe(once - 1)
  })
})

describe('IDEMPOTENCY ANAHTARI — düşman değerler (T39)', () => {
  const KOTU: { ad: string; key: unknown }[] = [
    { ad: 'UUID olmayan metin', key: 'anahtar-1' },
    { ad: 'boş', key: '' },
    { ad: 'sayı', key: 1 },
    { ad: 'null', key: null },
  ]

  for (const { ad, key } of KOTU) {
    it(`${ad} REDDEDİLİYOR`, async () => {
      const once = await stok()
      await expect(
        createMovement(boss, hareket({ idempotencyKey: key }), { db: app.db }),
      ).rejects.toThrow(AppError)
      expect(await stok(), `${ad} stoğu değiştirdi`).toBe(once)
    })
  }
})

describe('GÖVDE — düşman şekiller (T39)', () => {
  const KOTU: { ad: string; govde: unknown }[] = [
    { ad: 'null', govde: null },
    { ad: 'undefined', govde: undefined },
    { ad: 'boş nesne', govde: {} },
    { ad: 'dizi', govde: [] },
    { ad: 'metin', govde: 'hareket' },
    { ad: 'sayı', govde: 42 },
  ]

  for (const { ad, govde } of KOTU) {
    it(`${ad} REDDEDİLİYOR`, async () => {
      const once = await stok()
      await expect(createMovement(boss, govde, { db: app.db })).rejects.toThrow(AppError)
      expect(await stok(), `${ad} stoğu değiştirdi`).toBe(once)
    })
  }

  it('__proto__ kirletmesi ETKİSİZ', async () => {
    // Gövde JSON'dan geliyor ve `__proto__` anahtarı taşıyabilir. zod
    // bilinmeyen alanı zaten atıyor; asıl kontrol prototipin BOZULMAMASI.
    await expect(
      createMovement(
        boss,
        JSON.parse('{"__proto__":{"kirli":true},"qty":1}'),
        { db: app.db },
      ),
    ).rejects.toThrow(AppError)
    expect(({} as Record<string, unknown>).kirli).toBeUndefined()
  })
})
