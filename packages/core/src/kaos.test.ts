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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { createMovement } from './movements'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T40 — KAOS TESTİ (PLAN.md Bölüm 6, "Cuma gecesi 02:00" maddesi 5)
 *
 * PLAN'daki cümle şu: "Senkron ortasında DB'yi kapat. Sonuç: kuyruk korunur,
 * ağ dönünce tamamlanır, hiçbir kayıt kaybolmaz."
 *
 * O CÜMLENİN İKİ YARISI VAR ve bugün yalnızca biri sınanabiliyor:
 *
 *   • CİHAZ TARAFI (kuyruk korunur, ağ dönünce tamamlanır) — mobil outbox'a
 *     bağlı, Faz 5. Ortada kuyruk yok; yazılacak test de yok. Sahte bir
 *     kuyrukla sınamak, var olmayan kodun testi olurdu.
 *
 *   • SUNUCU TARAFI (hiçbir kayıt kaybolmaz, YARIM kayıt oluşmaz) — bugün
 *     sınanabilir ve ASIL TEHLİKELİ OLAN BU. Cihaz kuyruğu kaybolursa
 *     kullanıcı okutmayı tekrarlar; ama sunucuda YARIM bir yazma olursa
 *     defter ile projeksiyon ayrışır ve kimse fark etmez.
 *
 * SINANAN ŞEY: bağlantı yazmanın ORTASINDA koparsa ne oluyor. Beklenen,
 * `createMovement`'ın tek transaction olması sayesinde ya hep ya hiç.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

const URUNLER: TestProductSpec[] = [{ sku: 'KAOS-001', name: 'Kaos Ürünü' }]

let tenant: TestTenant
let boss: Actor
let urunId: string

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'kaos', URUNLER)
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  urunId = tenant.products['KAOS-001']!.id
  await seedOpeningStock(admin.db, tenant, urunId, '500')
})

afterAll(async () => {
  /**
   * `end({ timeout })` — diğer test dosyalarından farklı, bilerek.
   *
   * Bu dosya bir bağlantıyı sunucudan öldürüyor. postgres.js kapanışta o
   * ölü sokete hâlâ yazmaya çalışıyor ve düz `end()` 60 saniyelik hook
   * zaman aşımına kadar asılı kalıyor (ölçüldü). Zaman aşımı, havuza
   * "beklemeyi bırak" diyor.
   *
   * Testin kendisi bundan ETKİLENMİYOR: iddiaların hepsi kapanıştan önce
   * çalışıyor. Burada çözülen şey yalnızca temizlik.
   */
  await app.client.end({ timeout: 5 }).catch(() => undefined)
  await admin.client.end({ timeout: 5 }).catch(() => undefined)
})

async function durum(): Promise<{ defter: string; projeksiyon: string; satir: number }> {
  const rows = await admin.db.execute<{ defter: string; projeksiyon: string; satir: string }>(sql`
    SELECT
      COALESCE((SELECT sum(delta)::text FROM stock_movements
                 WHERE tenant_id = ${tenant.tenantId} AND product_id = ${urunId}), '0') AS defter,
      COALESCE((SELECT qty::text FROM current_stock
                 WHERE tenant_id = ${tenant.tenantId} AND product_id = ${urunId}), '0') AS projeksiyon,
      (SELECT count(*)::text FROM stock_movements
        WHERE tenant_id = ${tenant.tenantId} AND product_id = ${urunId}) AS satir
  `)
  const r = rows[0]!
  return { defter: r.defter, projeksiyon: r.projeksiyon, satir: Number(r.satir) }
}

function hareket(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    barcode: tenant.products['KAOS-001']!.barcode,
    qty: 3,
    reason: 'DAMAGE',
    clientCreatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('bağlantı yazmanın ORTASINDA koparsa (T40)', () => {
  /**
   * Bağlantıyı sunucudan öldürüyoruz, istemciden değil.
   *
   * `pg_terminate_backend`, PostgreSQL'in kendi yolu ve gerçek arızaya en
   * yakın olanı: ağ kablosu çekilmiş gibi. İstemci tarafında `client.end()`
   * çağırmak "düzgün kapanış" olurdu ve transaction'ı zaten temiz
   * sonlandırırdı — yani sınamak istediğimiz şeyi hiç üretmezdi.
   */
  async function bagimsizHavuzdaOldur(pid: number) {
    await admin.db.execute(sql`SELECT pg_terminate_backend(${pid})`)
  }

  it('YARIM KAYIT OLUŞMUYOR: defter ile projeksiyon ayrışmıyor', async () => {
    const once = await durum()

    /**
     * Kendi bağlantımızın pid'ini alıp transaction'ın ORTASINDA kendimizi
     * öldürüyoruz. `createMovement` tek transaction içinde hem deftere
     * yazıyor hem (trigger yoluyla) projeksiyonu güncelliyor; kopma anı
     * ikisinin arasına düşerse ya ikisi de olacak ya hiçbiri.
     */
    const pidRows = await app.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
    const pid = pidRows[0]!.pid

    // Yazma başlar başlamaz bağlantıyı kopar. Zamanlama kesin değil ve
    // KESİN OLMASI GEREKMİYOR: hangi ana denk gelirse gelsin sonuç
    // değişmemeli. Zamanlamaya bağımlı bir test, bir gün "bazen yeşil"
    // olurdu — bu depoda o hatanın bedeli T109'da ölçüldü.
    const yazma = createMovement(boss, hareket(), { db: app.db })
    void bagimsizHavuzdaOldur(pid)

    // Yazma ya başarılı olur ya hata verir; ikisi de KABUL EDİLEBİLİR.
    // Kabul EDİLEMEZ olan, aşağıdaki iki iddianın bozulması.
    await yazma.catch(() => undefined)

    const sonra = await durum()

    // 1. INVARIANT: defter toplamı ile projeksiyon HÂLÂ eşit.
    expect(sonra.defter, 'defter ile projeksiyon AYRIŞTI').toBe(sonra.projeksiyon)

    // 2. YA HEP YA HİÇ: ya hiç satır eklenmemiş ya tam bir satır.
    const eklenen = sonra.satir - once.satir
    expect(eklenen, 'yarım kayıt oluştu').toBeLessThanOrEqual(1)
    expect(eklenen).toBeGreaterThanOrEqual(0)

    // 3. Satır eklendiyse etkisi TAM. Yarım delta olamaz.
    if (eklenen === 1) {
      expect(Number(sonra.defter)).toBe(Number(once.defter) - 3)
    } else {
      expect(sonra.defter).toBe(once.defter)
    }
  })

  it('kopmadan SONRA sistem çalışmaya devam ediyor', async () => {
    // Havuz kopan bağlantıyı yenisiyle değiştirebilmeli. Değiştiremezse
    // tek bir ağ arızası uygulamayı kalıcı olarak öldürürdü — ve bu,
    // "yeniden başlatınca düzeliyor" diye yıllarca yaşanan arıza tipidir.
    const once = await durum()
    await createMovement(boss, hareket({ qty: 1 }), { db: app.db })
    const sonra = await durum()

    expect(sonra.satir).toBe(once.satir + 1)
    expect(sonra.defter).toBe(sonra.projeksiyon)
  })

  it('AYNI ANAHTAR kopmadan sonra tekrar gönderilirse ÇİFT KAYIT olmuyor', async () => {
    /**
     * Gerçek senaryo: cihaz gönderdi, cevabı alamadan bağlantı koptu.
     * Kullanıcı ya da outbox aynı kaydı tekrar gönderiyor. Sunucu ilk
     * isteği İŞLEMİŞ olabilir — bunu istemci bilmiyor.
     *
     * Bu, mobil outbox'ın (ADR-003) tamamının dayandığı garanti. Outbox
     * henüz yazılmadı ama garantinin KENDİSİ bugün sınanabilir.
     */
    const istek = hareket({ qty: 2 })
    const ilk = await createMovement(boss, istek, { db: app.db })
    const once = await durum()

    const ikinci = await createMovement(boss, istek, { db: app.db })

    expect(ikinci.movementId, 'ikinci istek YENİ hareket üretti').toBe(ilk.movementId)
    expect(ikinci.duplicate, 'tekrar olduğu istemciye söylenmiyor').toBe(true)
    const sonra = await durum()
    expect(sonra.satir, 'çift kayıt oluştu').toBe(once.satir)
    expect(sonra.defter).toBe(once.defter)
  })
})
