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
import type { Db } from '@stok/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createInMemoryTransport } from './mail.js'
import { createMovement } from './movements.js'
import {
  dailyReportText,
  dailySummary,
  dayKey,
  lowStockProducts,
  runCron,
  runCronAllTenants,
} from './cron.js'
import { listJobs } from './jobs.js'
import type { Actor } from './authz.js'
import { TEST_DB_NAME } from './test/db-name.js'

/**
 * ============================================================================
 * T34 / T35 / T37 / T88.1 — CRON
 *
 * `runQueuedJobs()` T14'te yazılmıştı ama çağıranı yoktu: kuyruğa giren
 * rapor sonsuza kadar QUEUED'da bekliyordu. Bu dosya o yolun UÇTAN UCA
 * yürüdüğünü sınıyor — sahte bir mail taşıyıcısıyla, gerçek veritabanında.
 *
 * En kritik iki soru:
 *   1. Cron İKİ KEZ çalışırsa rapor iki kez gider mi? (PLAN Bölüm 5)
 *   2. Kasa açığı e-postanın GÖVDESİNDE görünüyor mu? (T88.1 —
 *      "okunmayan kayıt kontrol değildir")
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

const URUNLER: TestProductSpec[] = [
  { sku: 'A4-001', name: 'A4 Kağıt', purchasePrice: '80.00', salePrice: '110.00' },
  { sku: 'KRT-001', name: 'Kritik Ürün', minStock: '50', purchasePrice: '5.00', salePrice: '9.00' },
]

let tenant: TestTenant
let boss: Actor
let staff: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'cron', URUNLER)
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
  await seedOpeningStock(admin.db, tenant, tenant.products['A4-001']!.id, '500')
  // Kritik ürün eşiğin ALTINDA: 10 < 50.
  await seedOpeningStock(admin.db, tenant, tenant.products['KRT-001']!.id, '10')
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

/** Her testin kendi kuyruğu olsun; işler testler arasında sızmasın. */
beforeEach(async () => {
  await admin.db.execute(sql`DELETE FROM background_jobs WHERE tenant_id = ${tenant.tenantId}`)
})

const bugun = () => dayKey(new Date())

function satis(sku: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    barcode: tenant.products[sku]!.barcode,
    qty: 1,
    reason: 'SALE',
    clientCreatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('gün sonu raporu (E6)', () => {
  it('kuyruğa alıyor, çalıştırıyor ve e-postayı GÖNDERİYOR', async () => {
    const mail = createInMemoryTransport()
    const sonuc = await runCron(boss, { mail }, { db: app.db })

    expect(sonuc.day).toBe(bugun())
    expect(sonuc.scheduled.map((s) => s.kind)).toEqual(['DAILY_REPORT', 'LOW_STOCK_SCAN'])
    expect(sonuc.failed, 'hiçbir iş başarısız olmamalı').toBe(0)

    const rapor = mail.sent.find((m) => m.subject.startsWith('Gün sonu raporu'))
    expect(rapor, 'gün sonu raporu gönderilmedi').toBeDefined()
    // Ek GERÇEKTEN var: rapor metni "hazır" deyip dosyayı unutursa
    // kullanıcı boş bir mail alır ve bunu kimse fark etmez.
    expect(rapor!.attachments?.[0]?.filename).toMatch(/^gun-sonu-\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(rapor!.attachments![0]!.content.length).toBeGreaterThan(1000)
  })

  it('CRON İKİ KEZ ÇALIŞIRSA RAPOR İKİ KEZ GİTMİYOR', async () => {
    // PLAN Bölüm 5'teki uç durum. Kuyruk `dedupeKey` ile koruyor; bu test
    // o korumanın gerçekten bağlı olduğunu sınıyor.
    const mail = createInMemoryTransport()
    const bir = await runCron(boss, { mail }, { db: app.db })
    const iki = await runCron(boss, { mail }, { db: app.db })

    expect(bir.scheduled.every((s) => s.duplicate)).toBe(false)
    expect(iki.scheduled.every((s) => s.duplicate), 'ikinci tur yeni iş üretmemeli').toBe(true)
    expect(iki.ran, 'ikinci turda çalışacak iş kalmamalı').toBe(0)

    const raporlar = mail.sent.filter((m) => m.subject.startsWith('Gün sonu raporu'))
    expect(raporlar).toHaveLength(1)
  })

  it('alıcı yoksa iş SESSİZCE başarılı olmuyor', async () => {
    // G4'ün kalbi: "rapor gitmedi ama kimse bilmiyor" durumu.
    // Tenant'ın tek yöneticisini pasifleştirip alıcıyı yok ediyoruz.
    await admin.db.execute(sql`
      UPDATE users SET active = false
       WHERE tenant_id = ${tenant.tenantId} AND role = 'ADMIN'
    `)
    const mail = createInMemoryTransport()
    await runCron(boss, { mail }, { db: app.db })

    expect(mail.sent).toHaveLength(0)

    // TAM OLARAK GÜN SONU İŞİNE bakıyoruz. "bir iş başarısız oldu" demek
    // YETMEZ: bu tenant'ta kritik ürün de var, yani LOW_STOCK_SCAN zaten
    // alıcısızlıktan patlıyor ve gevşek bir kontrol onun sayesinde yeşil
    // yanıyordu — gün sonu işi sessizce başarılı sayılsa bile. (Mutasyon
    // testinde yakalandı: koruma kaldırıldı, test yine geçti.)
    const isler = await listJobs(boss, {}, { db: app.db })
    const gunSonu = isler.find((j) => j.kind === 'DAILY_REPORT')
    expect(gunSonu, 'gün sonu işi kuyrukta yok').toBeDefined()
    expect(gunSonu!.status, 'gün sonu işi başarılı sayılmamalı').not.toBe('SUCCEEDED')
    expect(gunSonu!.lastErrorCode, 'hata kodu satıra yazılmalı').toBeTruthy()

    await admin.db.execute(sql`
      UPDATE users SET active = true
       WHERE tenant_id = ${tenant.tenantId} AND role = 'ADMIN'
    `)
  })
})

describe('kasa açığı gün sonu raporuna biniyor (T88.1)', () => {
  it('açık e-postanın GÖVDESİNDE, ekin içinde değil', async () => {
    // "Okunmayan kayıt kontrol değildir": eki açmayan patron da görmeli.
    await createMovement(
      staff,
      satis('A4-001', { qty: 5, unitPrice: 100, priceOverrideReason: 'TANIDIK' }),
      { db: app.db },
    )

    const ozet = await dailySummary(tenant.tenantId, bugun(), { db: app.db })
    // 5 adet × (110 − 100) = 50 TL
    expect(ozet.gapCount).toBe(1)
    expect(ozet.gapTotal).toBe(50)
    expect(ozet.topGapUser?.total).toBe(50)

    const metin = dailyReportText(ozet)
    expect(metin).toContain('KASA AÇIĞI')
    expect(metin).toContain('50.00 TL')
    expect(metin).toContain(ozet.topGapUser!.name)
  })

  it('açık yoksa metin bunu AÇIKÇA söylüyor', async () => {
    // Sessizlik yetmez: "açık yok" ile "rapor çalışmadı" ayırt edilebilmeli.
    const ozet = await dailySummary(tenant.tenantId, '2020-01-01', { db: app.db })
    expect(ozet.gapCount).toBe(0)
    expect(dailyReportText(ozet)).toContain('Liste fiyatının altında satış yok')
  })

  it('sapma miktarla ÇARPILIYOR, satır başına sayılmıyor', async () => {
    // 1 adet 10 TL sapma ile 5 adet 10 TL sapma aynı şey değil; kasadan
    // çıkan para 10 değil 50 TL. Satır başına saymak açığı beşte bire
    // indirirdi.
    const gun = bugun()
    const once = await dailySummary(tenant.tenantId, gun, { db: app.db })
    await createMovement(
      staff,
      satis('A4-001', { qty: 3, unitPrice: 100, priceOverrideReason: 'TOPTAN' }),
      { db: app.db },
    )
    const sonra = await dailySummary(tenant.tenantId, gun, { db: app.db })
    expect(sonra.gapTotal - once.gapTotal).toBe(30)
  })
})

describe('kritik stok taraması (E7)', () => {
  it('kritik ürünü buluyor ve uyarı gönderiyor', async () => {
    // Yöneticinin aktif olduğundan EMİN OL: önceki test onu pasifleştirip
    // geri açıyor ve testler arası sıra bağımlılığı bırakmak, bu dosyayı
    // ileride sebepsiz kırmızı yanan bir kümeye çevirirdi.
    await admin.db.execute(sql`
      UPDATE users SET active = true
       WHERE tenant_id = ${tenant.tenantId} AND role = 'ADMIN'
    `)
    const kritik = await lowStockProducts(tenant.tenantId, { db: app.db })
    expect(kritik.some((r) => r.sku === 'KRT-001')).toBe(true)

    const mail = createInMemoryTransport()
    await runCron(boss, { mail }, { db: app.db })
    const uyari = mail.sent.find((m) => m.subject.startsWith('Kritik stok'))
    expect(uyari, 'kritik stok uyarısı gönderilmedi').toBeDefined()
    expect(uyari!.text).toContain('Kritik Ürün')
  })

  it('kritik ürün YOKSA e-posta gönderilmiyor', async () => {
    // Her gün "her şey yolunda" maili atmak, birkaç hafta içinde okunmadan
    // silinen bir maile dönüşür — ve gerçek uyarı da onunla silinir.
    const bos = await seedTestTenant(admin.db, 'cron-bos', [
      { sku: 'BOL-001', name: 'Bol Stoklu', minStock: '1' },
    ])
    const bosBoss: Actor = { tenantId: bos.tenantId, userId: bos.adminUserId, role: 'ADMIN' }
    await seedOpeningStock(admin.db, bos, bos.products['BOL-001']!.id, '999')

    const mail = createInMemoryTransport()
    await runCron(bosBoss, { mail }, { db: app.db })
    expect(mail.sent.filter((m) => m.subject.startsWith('Kritik stok'))).toHaveLength(0)
  })
})

describe('bakım adımı', () => {
  it('invariant sağlamken alarm YOK (T37)', async () => {
    const mail = createInMemoryTransport()
    const sonuc = await runCron(boss, { mail }, { db: app.db })
    expect(sonuc.invariantBreaches).toEqual([])
  })

  it('INVARIANT KIRILIRSA alarm dönüyor (T37)', async () => {
    // Projeksiyonu defterden ayırıyoruz. Bu, kullanıcının fark etmeden
    // yanlış sayıya bakması demek — sessiz kalabilecek en pahalı hata.
    const urun = tenant.products['KRT-001']!.id
    await admin.db.execute(sql`
      UPDATE current_stock SET qty = qty + 7
       WHERE tenant_id = ${tenant.tenantId} AND product_id = ${urun}
    `)
    const mail = createInMemoryTransport()
    const sonuc = await runCron(boss, { mail }, { db: app.db })

    expect(sonuc.invariantBreaches.length).toBeGreaterThan(0)
    expect(sonuc.invariantBreaches.some((b) => b.productId === urun)).toBe(true)

    await admin.db.execute(sql`
      UPDATE current_stock SET qty = qty - 7
       WHERE tenant_id = ${tenant.tenantId} AND product_id = ${urun}
    `)
  })

  it('eski kaba kuvvet sayaçları budanıyor', async () => {
    const mail = createInMemoryTransport()
    const sonuc = await runCron(boss, { mail }, { db: app.db })
    expect(sonuc.prunedAuthAttempts).toBeGreaterThanOrEqual(0)
  })
})

describe('bütün tenant listesi (T34)', () => {
  /**
   * G4'ün cron ayağı: "yeni müşteri eklendi, raporu SESSİZCE çıkmıyor".
   * Tenant listesi elle tutulsaydı (ortam değişkeni, sabit dizi) bu hata
   * hiçbir yerde patlamaz, sadece rapor gelmezdi.
   */
  let ikinci: TestTenant

  beforeAll(async () => {
    ikinci = await seedTestTenant(admin.db, 'cron-ikinci', URUNLER)
    await seedOpeningStock(admin.db, ikinci, ikinci.products['A4-001']!.id, '20')
  })

  /**
   * Bu blok BÜTÜN tenant'lara dokunuyor — diğer test dosyalarının
   * kiracıları dahil. Bıraktığı kuyruk satırları onların testlerine
   * sızmasın diye tur boyunca oluşan işler siliniyor.
   */
  async function turdanKalanlariSil(baslangic: string): Promise<void> {
    await admin.db.execute(
      sql`DELETE FROM background_jobs WHERE created_at >= ${baslangic}::timestamptz`,
    )
  }

  it('HER tenant için rapor çıkıyor', async () => {
    const baslangic = new Date().toISOString()
    const mail = createInMemoryTransport()
    const sonuc = await runCronAllTenants({ mail }, { db: app.db })
    await turdanKalanlariSil(baslangic)

    const alicilar = mail.sent.map((m) => m.to)
    expect(alicilar).toContain(`admin@cron.test`)
    expect(alicilar, 'ikinci tenant atlandı').toContain(`admin@cron-ikinci.test`)

    const kimlikler = sonuc.tenants.map((t) => t.tenantId)
    expect(kimlikler).toContain(tenant.tenantId)
    expect(kimlikler).toContain(ikinci.tenantId)
  })

  it('deneme hakkı bitince tur BAŞARISIZ dönüyor', async () => {
    // Alarm eşiği burada: ilk hata `retried`, hakkı biten hata `failed`.
    // Route bu ayrımı HTTP durumuna çeviriyor (200 / 500). Eşik yanlış
    // olsaydı ya her geçici SMTP hatası alarm çalar (operatör alarmı yok
    // saymayı öğrenir) ya da hiç çalmaz (G4).
    const baslangic = new Date().toISOString()
    const bozuk = {
      async send() {
        throw new Error('smtp yok')
      },
    }

    const ilk = await runCronAllTenants({ mail: bozuk }, { db: app.db })
    expect(ilk.tenants.every((t) => (t.result?.failed ?? 0) === 0), 'ilk turda hak bitti').toBe(true)
    expect(ilk.failed, 'ilk tur alarm çaldı').toBe(false)

    // Tekrar gecikmesinin (60 sn) ötesine geçiyoruz: ikinci deneme
    // yapılabilsin. Gerçek zamanı beklemek testi 60 saniye uzatırdı.
    const sonra = Date.now() + 5 * 60_000
    const ikinci = await runCronAllTenants({ mail: bozuk }, { db: app.db, now: () => sonra })
    await turdanKalanlariSil(baslangic)

    expect(ikinci.failed, 'hak bittiği halde alarm çalmadı').toBe(true)
  })

  it('bir tenant DÜŞERSE diğerleri yine çalışıyor', async () => {
    const baslangic = new Date().toISOString()
    const mail = createInMemoryTransport()
    const sonuc = await runCronAllTenants({ mail }, { db: dbThatFailsFor(app.db, tenant.tenantId) })
    await turdanKalanlariSil(baslangic)

    const dusen = sonuc.tenants.find((t) => t.tenantId === tenant.tenantId)
    expect(dusen?.error, 'düşen tenant hatasız görünüyor').toBeTruthy()
    expect(sonuc.failed).toBe(true)

    // ASIL KONTROL: listenin başındaki bozuk tenant turu bitirmedi.
    const digeri = sonuc.tenants.find((t) => t.tenantId === ikinci.tenantId)
    expect(digeri?.result, 'ikinci tenant hiç işlenmemiş').toBeDefined()
    expect(mail.sent.map((m) => m.to)).toContain(`admin@cron-ikinci.test`)
  })
})

/**
 * Tek bir tenant'ın veritabanı işlemini düşüren sarmalayıcı.
 *
 * Hata `withTenant`'ın İÇİNDEN atılıyor: ilk ifade her zaman
 * `set_config('app.tenant_id', …)` olduğu için, o çalıştıktan sonra
 * `current_setting` ile hangi tenant'ta olduğumuzu okuyup karar veriyoruz.
 * Drizzle'ın sorgu nesnesini deşmek yerine bu yol seçildi: sorgu
 * parametrelerinin iç yapısı drizzle sürümüyle değişir, `current_setting`
 * değişmez.
 */
function dbThatFailsFor(db: Db, tenantId: string): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'transaction') return Reflect.get(target, prop, receiver)
      return (fn: (tx: unknown) => Promise<unknown>) =>
        // biome-ignore lint/suspicious/noExplicitAny: test sarmalayıcısı, drizzle Tx tipi dışa açık değil
        (target as any).transaction(async (tx: any) => {
          let bakildi = false
          const sarmal = new Proxy(tx, {
            get(t, p, r) {
              if (p !== 'execute') return Reflect.get(t, p, r)
              // biome-ignore lint/suspicious/noExplicitAny: aynı sebep
              return async (q: any) => {
                const sonuc = await t.execute(q)
                if (!bakildi) {
                  bakildi = true
                  const [row] = await t.execute(
                    sql`SELECT current_setting('app.tenant_id', true) AS t`,
                  )
                  if (row?.t === tenantId) throw new Error('bağlantı düştü (test)')
                }
                return sonuc
              }
            },
          })
          return fn(sarmal)
        })
    },
  }) as Db
}
