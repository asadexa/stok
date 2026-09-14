import { AppError } from '@stok/shared'
import { randomUUID } from 'node:crypto'
import {
  type TestProductSpec,
  type TestTenant,
  seedOpeningStock,
  seedTestTenant,
  testAdminDb,
  testAppDb,
} from '@stok/db/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { createMovement } from './movements'
import { logEvent, logged, setLogSink } from './observability'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T36 — YAPISAL LOG
 *
 * NEDEN LOG'UN TESTİ VAR. Log burada süs değil: PLAN Bölüm 8'in iki metriği
 * ("reddedilen hareket oranı", "`BARCODE_UNKNOWN` oranı") YALNIZCA buradan
 * çıkabiliyor — reddedilen bir hareket hiçbir tabloya yazılmıyor. Log satırı
 * eksikse o metrik sessizce %0 görünür, yani "her şey yolunda" der.
 *
 * SINANAN ÜÇ ŞEY:
 *   1. Reddedilen hareket log'a DÜŞÜYOR ve hata kodu satırda
 *   2. Fiyat ve barkod log'a SIZMIYOR (D7 arkadan dolanılmasın)
 *   3. Log yazmak davranışı DEĞİŞTİRMİYOR (hata olduğu gibi yeniden fırlıyor)
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

const URUNLER: TestProductSpec[] = [
  { sku: 'LOG-001', name: 'Log Ürünü', purchasePrice: '10.00', salePrice: '25.00' },
]

let tenant: TestTenant
let boss: Actor
let satirlar: string[]

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'gozlem', URUNLER)
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  await seedOpeningStock(admin.db, tenant, tenant.products['LOG-001']!.id, '100')
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

beforeEach(() => {
  satirlar = []
  setLogSink({ write: (line) => satirlar.push(line) })
})

// Kurulum dosyası log'u susturuyor; her testten sonra oraya DÖNÜLÜYOR.
// Dönülmezse bu dosyanın yazıcısı sonraki test dosyalarında da kalır ve
// onların çıktısını bu dizide biriktirir — sessiz bir bellek sızıntısı.
afterEach(() => {
  setLogSink(null)
  setLogSink({ write() {} })
})

const cozumle = () => satirlar.map((l) => JSON.parse(l) as Record<string, unknown>)

describe('logEvent', () => {
  it('tek satır JSON yazıyor, alan adları sabit', () => {
    logEvent('info', 'deneme', { tenantId: 'a', latencyMs: 12 })

    expect(satirlar).toHaveLength(1)
    expect(satirlar[0]!.includes('\n'), 'satır bölünmüş — toplayıcı iki kayıt sayar').toBe(false)
    const kayit = cozumle()[0]!
    expect(kayit.event).toBe('deneme')
    expect(kayit.level).toBe('info')
    expect(kayit.tenantId).toBe('a')
    expect(kayit.latencyMs).toBe(12)
    expect(typeof kayit.ts).toBe('string')
  })

  it('tanımsız alanlar SATIRA GİRMİYOR', () => {
    // "alan yok" ile "alan null" farklı şeyler; ikisini karıştıran bir
    // sorgu yanlış sayım üretir.
    logEvent('info', 'deneme', { tenantId: undefined, userId: 'u' })
    expect(Object.keys(cozumle()[0]!)).not.toContain('tenantId')
  })
})

describe('logged', () => {
  it('HATAYI YUTMUYOR, olduğu gibi yeniden fırlatıyor', async () => {
    // Gözlem katmanının davranışı değiştirmesi, arızanın kendisi olurdu.
    const hata = new AppError('NOT_FOUND', 'yok')
    await expect(logged('is', {}, async () => Promise.reject(hata))).rejects.toBe(hata)
  })

  it('hata kodunu satıra yazıyor, tanımadığını UNKNOWN sayıyor', async () => {
    await expect(logged('is', {}, async () => Promise.reject(new Error('düz')))).rejects.toThrow()
    expect(cozumle()[0]!.errorCode, 'tanınmayan hata ayrı sayılabilmeli').toBe('UNKNOWN')
  })
})

describe('createMovement log satırı (PLAN Bölüm 8)', () => {
  const hareket = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: randomUUID(),
    barcode: tenant.products['LOG-001']!.barcode,
    qty: 1,
    reason: 'DAMAGE',
    clientCreatedAt: new Date().toISOString(),
    ...overrides,
  })

  it('başarılı hareket ölçülüyor', async () => {
    await createMovement(boss, hareket(), { db: app.db })

    const kayit = cozumle().find((k) => k.event === 'hareket')
    expect(kayit, 'başarılı hareket log satırı yok').toBeDefined()
    expect(kayit!.reason).toBe('DAMAGE')
    expect(kayit!.delta).toBe('-1')
    expect(typeof kayit!.latencyMs).toBe('number')
    expect(kayit!.source, 'kanal yazılmamış — web/mobil ayrımı yapılamaz').toBe('web')
  })

  it('REDDEDİLEN hareket log satırı bırakıyor — tek izi bu', async () => {
    // Reddedilen hareket hiçbir tabloya yazılmıyor. Bu satır olmazsa
    // "reddedilen hareket oranı" metriği her zaman %0 görünür.
    await expect(
      createMovement(boss, hareket({ barcode: '8690000000000' }), { db: app.db }),
    ).rejects.toThrow()

    const kayit = cozumle().find((k) => k.event === 'hareket.reddedildi')
    expect(kayit, 'reddedilen hareket log satırı yok').toBeDefined()
    expect(kayit!.errorCode).toBe('BARCODE_UNKNOWN')
    expect(kayit!.reason, 'sebep reddedilen satırda da olmalı').toBe('DAMAGE')
  })

  it('doğrulama hatası da ölçülüyor — çözümlemeden ÖNCE düşenler dahil', async () => {
    await expect(createMovement(boss, { bozuk: true }, { db: app.db })).rejects.toThrow()

    const kayit = cozumle().find((k) => k.event === 'hareket.reddedildi')
    expect(kayit?.errorCode).toBe('VALIDATION_FAILED')
    expect(kayit?.tenantId).toBe(tenant.tenantId)
  })

  it('FİYAT VE BARKOD LOG A SIZMIYOR (D7)', async () => {
    await createMovement(
      boss,
      hareket({ reason: 'SALE', unitPrice: 25, qty: 2 }),
      { db: app.db },
    )

    /**
     * ALAN ADLARINA ve DEĞERLERE bakılıyor, ham metinde arama YAPILMIYOR.
     * "satırda '25' geçmesin" demek kırılgan olurdu: `latencyMs` 25 olabilir,
     * zaman damgasında 25 geçebilir, UUID'de 25 geçebilir. O test bir gün
     * sebepsiz kırmızı yanar ve sonra "kararsız" diye kapı dışına konur —
     * bu depoda bunun bedeli T109'da görüldü.
     */
    const fiyatAlanlari = ['unitPrice', 'listPrice', 'price', 'barcode', 'barkod']
    for (const kayit of cozumle()) {
      for (const alan of fiyatAlanlari) {
        expect(Object.keys(kayit), `${alan} log a sızmış`).not.toContain(alan)
      }
      // Log satırları çoğu kurulumda üçüncü taraf bir toplayıcıya gidiyor.
      // Fiyatı oraya göndermek, fiyat gizlemenin (D7) arkadan dolanılmasıdır.
      const degerler = Object.values(kayit).map(String)
      expect(degerler, 'birim fiyat değer olarak log a sızmış').not.toContain('25')
      expect(degerler, 'barkod log a sızmış').not.toContain(
        tenant.products['LOG-001']!.barcode,
      )
    }
  })
})
