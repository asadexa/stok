import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from './client.js'
import { TEST_DB_NAME } from './test/db-name.js'
import {
  type TestTenant,
  detUuid,
  seedOpeningStock,
  seedTestTenant,
  testAdminDb,
  testAppDb,
} from './testing.js'

/**
 * ============================================================================
 * TEST İSKELESİNİN KENDİSİ
 *
 * Bu dosya ürünün hiçbir garantisini sınamıyor; onlar rls.test.ts,
 * invariant.test.ts ve movements.test.ts'de. Buradaki amaç, İSKELE
 * bozulduğunda bunu diğer testlerin kafa karıştırıcı hataları arasında
 * aramak zorunda kalmamak.
 *
 * Somut senaryo: `resetTestDatabase()` migration'ları uygulamayı atlarsa
 * projeksiyon tetikleyicisi hiç kurulmaz. O durumda onlarca test
 * "beklenen 50, gelen 0" diye düşer ve hepsi ürün kodunu suçlar. Buradaki
 * tek satır ise doğrudan "tetikleyici yok" der.
 *
 * NEDEN YENİDEN YAZILDI: bu dosya master'a `test-support.ts` iskelesine
 * dayanarak eklendi, ama o iskele 134cb32'de kaldırılmıştı (iki ayrı test
 * önyüklemesi vardı ve biri kullanılmıyordu). Dosyanın fikri doğruydu,
 * dayandığı temel yoktu. Dört testinden ikisi kaldırılan iskelenin kendi
 * temizlik mekanizmasını sınıyordu; kalan ikisinin karşılığı zaten
 * rls.test.ts'te var. Bu yüzden "port" değil, aynı amaca hizmet eden yeni
 * bir dosya.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

let tenant: TestTenant

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'smoke', [
    { sku: 'SMK-1', name: 'Duman Testi Ürünü', caseMultiplier: '6' },
  ])
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

describe('test iskelesi', () => {
  it('fixture beklenen kullanıcı, konum ve ürünleri kuruyor', () => {
    expect(tenant.tenantId).toMatch(/^[0-9a-f-]{36}$/)
    expect(tenant.adminUserId).not.toBe(tenant.staffUserId)
    expect(tenant.locationId).toMatch(/^[0-9a-f-]{36}$/)

    const product = tenant.products['SMK-1']
    expect(product).toBeDefined()
    // Koli çarpanı istendiğinde İKİ barkod oluşmalı: adet ve koli. Biri
    // eksik kalırsa D7 (koli çarpanı) testleri sessizce kapsamsız kalır.
    expect(product?.barcode).toBeTruthy()
    expect(product?.caseBarcode).toBeTruthy()
  })

  it('kimlikler kararlı: aynı etiket aynı UUID', () => {
    // Fixture'ların tekrar üretilebilirliği buna dayanıyor. Rastgele
    // kimliğe kayarsa, başarısız bir testi aynı veriyle tekrar koşturmak
    // imkânsızlaşır.
    expect(detUuid('tenant:smoke')).toBe(detUuid('tenant:smoke'))
    expect(detUuid('tenant:smoke')).not.toBe(detUuid('tenant:baska'))
  })

  it('defter yazınca projeksiyon tetikleyicisi çalışıyor', async () => {
    // ASIL SORU: `resetTestDatabase()` migration'ları gerçekten uyguladı mı?
    // Tetikleyici 0002 migration'ında kuruluyor; uygulanmadıysa burada
    // satır hiç oluşmaz.
    const productId = tenant.products['SMK-1']!.id
    await seedOpeningStock(admin.db, tenant, productId, '50')

    const rows = await withTenant(
      tenant.tenantId,
      (tx) =>
        tx.execute<{ qty: string }>(
          sql`SELECT qty FROM current_stock WHERE product_id = ${productId}`,
        ),
      app.db,
    )
    expect(Number([...rows][0]?.qty)).toBe(50)
  })

  it('uygulama bağlantısı RLS uyguluyor, admin bağlantısı atlıyor', async () => {
    // İkisi karışırsa tenant izolasyonu testlerinin TAMAMI yeşil yanar ve
    // hiçbir şey ispat etmez — RLS testlerinin en sinsi yanlış pozitifi.
    const withoutContext = await app.db.execute<{ id: string }>(
      sql`SELECT id FROM products WHERE tenant_id = ${tenant.tenantId}`,
    )
    expect([...withoutContext]).toHaveLength(0)

    const asAdmin = await admin.db.execute<{ id: string }>(
      sql`SELECT id FROM products WHERE tenant_id = ${tenant.tenantId}`,
    )
    expect([...asAdmin].length).toBeGreaterThan(0)
  })
})
