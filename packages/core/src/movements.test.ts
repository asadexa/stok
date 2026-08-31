import { randomUUID } from 'node:crypto'
import { AppError } from '@stok/shared'
import { stockMovements, withTenant } from '@stok/db'
import {
  type TestTenant,
  seedOpeningStock,
  seedTestTenant,
  testAdminDb,
  testAppDb,
} from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkStockInvariant, createMovement, getStockQty } from './movements.js'
import type { Actor } from './authz.js'
import { TEST_DB_NAME } from './test/db-name.js'

/**
 * T9 doğrulaması: `createMovement()` tek yazma kapısının HER hata yolu.
 *
 * PLAN.md Bölüm 3'te sayılan yolların hepsi burada bir teste karşılık
 * geliyor. Hata modu kaydında "yakalanır: E" yazıp testini yazmamak,
 * kendini kandırmaktır.
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

let tenant: TestTenant
let staff: Actor
let boss: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'mv')
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

/** Geçerli bir istek gövdesi. Testler sadece değiştirdikleri alanı yazar. */
function req(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    barcode: tenant.products['KAL-001']!.barcode,
    qty: 1,
    reason: 'PURCHASE',
    clientCreatedAt: new Date().toISOString(),
    ...overrides,
  }
}

const call = (actor: Actor, body: Record<string, unknown>) =>
  createMovement(actor, body, { db: app.db })

/** Hata kodunu ve detayını birlikte doğrular. Sadece "throw etti" yetmez. */
async function expectAppError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err, `beklenen hata: ${code}, ama istek başarılı oldu`).toBeInstanceOf(AppError)
  expect((err as AppError).code).toBe(code)
  return err as AppError
}

describe('createMovement - mutlu yol', () => {
  it('giriş yazar, projeksiyonu günceller', async () => {
    const p = tenant.products['DEF-001']!
    const res = await call(staff, req({ barcode: p.barcode, qty: 20, reason: 'PURCHASE' }))

    expect(res.duplicate).toBe(false)
    expect(res.productId).toBe(p.id)
    expect(res.productName).toBe('Çizgili Defter 80 Yaprak')
    expect(res.effectiveQty).toBe(20)
    expect(res.delta).toBe(20)
    expect(res.newQty).toBe(20)
    expect(await getStockQty(staff, p.id, { db: app.db })).toBe(20)
  })

  it('işaret sebepten gelir, kullanıcıdan değil', async () => {
    const p = tenant.products['DEF-001']!
    // Kullanıcı POZİTİF 5 giriyor; çıkışa çeviren SALE sebebi.
    const res = await call(staff, req({ barcode: p.barcode, qty: 5, reason: 'SALE' }))

    expect(res.delta).toBe(-5)
    expect(res.newQty).toBe(15)
  })

  it('koli barkodu çarpanı uygular (D7)', async () => {
    const p = tenant.products['KAL-001']!
    // 12'li koliden 5 koli = 60 adet. Çarpan olmasaydı sistem 5 yazardı
    // ve sayı makul göründüğü için kimse fark etmezdi.
    const res = await call(staff, req({ barcode: p.caseBarcode, qty: 5, reason: 'PURCHASE' }))

    expect(res.effectiveQty).toBe(60)
    expect(res.newQty).toBe(60)
  })

  it('ondalık miktarı bozmadan yazar (NUMERIC 14,3)', async () => {
    const p = tenant.products['ISI-001']!
    await call(boss, req({ barcode: p.barcode, qty: 10.5, reason: 'PURCHASE' }))
    await call(boss, req({ barcode: p.barcode, qty: 0.2, reason: 'PURCHASE' }))
    const res = await call(boss, req({ barcode: p.barcode, qty: 0.1, reason: 'PURCHASE' }))

    // 10.5 + 0.2 + 0.1: kayan noktada 10.799999999999999 çıkardı.
    expect(res.newQty).toBe(10.8)
  })

  it('not, konum ve alış fiyatını kaydeder', async () => {
    const p = tenant.products['DEF-001']!
    const res = await call(
      boss,
      req({
        barcode: p.barcode,
        qty: 3,
        reason: 'PURCHASE',
        note: 'Cuma sevkiyatı',
        locationId: tenant.locationId,
        unitPrice: 12.5,
      }),
    )

    const [row] = await admin.db.execute<{ note: string; location_id: string; unit_price: string }>(
      // Test doğrulaması: ham SQL en okunaklısı.
      `SELECT note, location_id, unit_price FROM stock_movements WHERE id = '${res.movementId}'`,
    )
    expect(row?.note).toBe('Cuma sevkiyatı')
    expect(row?.location_id).toBe(tenant.locationId)
    expect(row?.unit_price).toBe('12.50')
  })
})

describe('createMovement - NIL yolu: barkod yok', () => {
  it('BARCODE_UNKNOWN döner ve hareket yazmaz', async () => {
    const err = await expectAppError(call(staff, req({ barcode: 'yok-boyle-barkod' })), 'BARCODE_UNKNOWN')
    expect(err.details.barcode).toBe('yok-boyle-barkod')
    expect(err.http).toBe(404)
  })

  it('başka tenantın barkodu da tanımsızdır', async () => {
    const other = await seedTestTenant(admin.db, 'mv-other', [
      { sku: 'X-1', name: 'Yabancı Ürün' },
    ])
    await expectAppError(
      call(staff, req({ barcode: other.products['X-1']!.barcode })),
      'BARCODE_UNKNOWN',
    )
  })
})

describe('createMovement - iş kuralı reddi', () => {
  it('arşivlenmiş ürüne hareket yazılamaz', async () => {
    const p = tenant.products['ARS-001']!
    const err = await expectAppError(call(staff, req({ barcode: p.barcode })), 'PRODUCT_ARCHIVED')
    expect(err.details.name).toBe('Arşivlenmiş Ürün')
  })

  it('yetersiz stokta çıkış reddedilir, eldeki miktarı söyler', async () => {
    const p = tenant.products['DEF-001']!
    const before = await getStockQty(staff, p.id, { db: app.db })

    const err = await expectAppError(
      call(staff, req({ barcode: p.barcode, qty: before + 1, reason: 'SALE' })),
      'INSUFFICIENT_STOCK',
    )
    expect(err.details.available).toBe(before)
    expect(err.details.requested).toBe(before + 1)
    // Reddedilen istek defteri kirletmemeli.
    expect(await getStockQty(staff, p.id, { db: app.db })).toBe(before)
  })

  it('başka tenantın konumu NOT_FOUND', async () => {
    const other = await seedTestTenant(admin.db, 'mv-loc', [{ sku: 'Y-1', name: 'Konum Testi' }])
    await expectAppError(
      call(staff, req({ locationId: other.locationId })),
      'NOT_FOUND',
    )
  })
})

describe('createMovement - negatif stok politikası (U1)', () => {
  it('çalışan negatife düşüremez', async () => {
    const p = tenant.products['ISI-001']!
    await expectAppError(
      call(staff, req({ barcode: p.barcode, qty: 9999, reason: 'SALE', allowNegative: true })),
      'FORBIDDEN',
    )
  })

  it('admin bilerek negatife düşürebilir', async () => {
    const p = tenant.products['ISI-001']!
    const before = await getStockQty(boss, p.id, { db: app.db })
    const res = await call(
      boss,
      req({ barcode: p.barcode, qty: before + 4, reason: 'SALE', allowNegative: true }),
    )

    expect(res.newQty).toBe(-4)
  })

  it('negatif konumdayken GİRİŞ serbest, düzeltme yolu kapanmıyor', async () => {
    // Ürün -4'te (yukarıdaki test bilerek düşürdü). Mal kabulü yapmak
    // stoğu gerçeğe yaklaştırıyor; sonuç hâlâ negatif diye reddetmek,
    // negatife düşmüş bir ürünü düzeltmeyi imkansız kılardı.
    const p = tenant.products['ISI-001']!
    const before = await getStockQty(boss, p.id, { db: app.db })
    expect(before).toBeLessThan(0)

    const res = await call(staff, req({ barcode: p.barcode, qty: 1, reason: 'PURCHASE' }))

    expect(res.newQty).toBe(before + 1)
    expect(res.newQty).toBeLessThan(0)
  })

  it('admin de bayrağı kaldırmadan negatife düşemez', async () => {
    const p = tenant.products['ISI-001']!
    await expectAppError(
      call(boss, req({ barcode: p.barcode, qty: 1000, reason: 'SALE' })),
      'INSUFFICIENT_STOCK',
    )
  })
})

describe('createMovement - BOŞ yolu: doğrulama', () => {
  const invalidQuantities = [0, -5, 0.0001, Number.POSITIVE_INFINITY, 2_000_000]

  it.each(invalidQuantities)('qty=%s INVALID_QUANTITY', async (qty) => {
    await expectAppError(call(staff, req({ qty })), 'INVALID_QUANTITY')
  })

  it('metin miktar reddedilir (coerce yok, bilerek)', async () => {
    await expectAppError(call(staff, req({ qty: '12' })), 'INVALID_QUANTITY')
  })

  it('bozuk idempotency anahtarı VALIDATION_FAILED', async () => {
    await expectAppError(call(staff, req({ idempotencyKey: 'anahtar-degil' })), 'VALIDATION_FAILED')
  })

  it('elle seçilemeyen sebep reddedilir', async () => {
    // Sayım düzeltmelerini sadece sayım akışı üretir. Elle seçilebilseydi
    // denetim izi anlamını kaybederdi.
    await expectAppError(call(boss, req({ reason: 'COUNT_ADJUST_UP' })), 'VALIDATION_FAILED')
  })

  it('bilinmeyen sebep reddedilir', async () => {
    await expectAppError(call(boss, req({ reason: 'HEDIYE' })), 'VALIDATION_FAILED')
  })

  it('cihaz saati olmadan istek kabul edilmez', async () => {
    const body = req()
    delete (body as Record<string, unknown>).clientCreatedAt
    await expectAppError(call(staff, body), 'VALIDATION_FAILED')
  })
})

describe('createMovement - çift gönderim (idempotency)', () => {
  it('aynı anahtar ikinci kez gelirse yeni hareket YAZILMAZ', async () => {
    const p = tenant.products['DEF-001']!
    const body = req({ barcode: p.barcode, qty: 7, reason: 'PURCHASE' })

    const first = await call(staff, body)
    const second = await call(staff, body)

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.movementId).toBe(first.movementId)
    expect(second.delta).toBe(7)
    expect(await getStockQty(staff, p.id, { db: app.db })).toBe(first.newQty)
  })

  it('aynı anahtar AYNI ANDA iki kez gelirse de tek hareket olur', async () => {
    const p = tenant.products['DEF-001']!
    const body = req({ barcode: p.barcode, qty: 4, reason: 'PURCHASE' })
    const before = await getStockQty(staff, p.id, { db: app.db })

    // Bu yarışı 3. adımdaki okuma yakalayamaz; çözen UNIQUE index.
    const results = await Promise.all([call(staff, body), call(staff, body)])

    expect(results.map((r) => r.movementId)).toEqual([
      results[0]!.movementId,
      results[0]!.movementId,
    ])
    expect(results.filter((r) => r.duplicate)).toHaveLength(1)
    expect(await getStockQty(staff, p.id, { db: app.db })).toBe(before + 4)
  })

  it('UNIQUE ihlali yoluna düşse bile duplicate döner, 500 değil', async () => {
    // Yukarıdaki Promise.all testi bu yolu ÇOĞU ZAMAN tetikler ama
    // garanti etmez. Burada yarışı elle kuruyoruz: bir transaction
    // hareketi yazıp COMMIT etmeden bekliyor, ikinci istek aynı anahtarla
    // geliyor. İkincinin ilk okuması hiçbir şey görmez (henüz commit
    // yok), INSERT'i UNIQUE index'te bloke olur, ilk commit edince
    // 23505 alır.
    //
    // Bu yol Drizzle'ın hatayı `cause` içine sarması yüzünden sessizce
    // kırılabiliyor. Kırıldığında kullanıcı 500 görür ve mobil outbox
    // kaydı sonsuza kadar tekrar dener.
    const p = tenant.products['DEF-001']!
    const key = randomUUID()
    const body = req({ idempotencyKey: key, barcode: p.barcode, qty: 6, reason: 'PURCHASE' })

    let release!: () => void
    let inserted!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const rowWritten = new Promise<void>((resolve) => {
      inserted = resolve
    })

    const holder = withTenant(
      tenant.tenantId,
      async (tx) => {
        await tx.insert(stockMovements).values({
          tenantId: tenant.tenantId,
          productId: p.id,
          userId: tenant.adminUserId,
          delta: '6',
          reason: 'PURCHASE',
          idempotencyKey: key,
        })
        inserted()
        await held
      },
      app.db,
    )

    // Rakip, tutucunun satırı yazmasından SONRA başlamalı. Ters sırada
    // başlarsa iki transaction kilitleri ters sırada alır ve test ölçmek
    // istediği yol yerine deadlock üretir.
    await rowWritten
    const contender = call(staff, body)
    await new Promise((r) => setTimeout(r, 250))
    release()
    await holder

    const res = await contender
    expect(res.duplicate).toBe(true)
    expect(res.delta).toBe(6)
  })

  it('anahtar tenant başına tekildir, tenantlar arası değil', async () => {
    const other = await seedTestTenant(admin.db, 'mv-idem', [{ sku: 'Z-1', name: 'Paylaşılan Anahtar' }])
    const otherBoss: Actor = {
      tenantId: other.tenantId,
      userId: other.adminUserId,
      role: 'ADMIN',
    }
    const key = randomUUID()

    const a = await call(staff, req({ idempotencyKey: key, qty: 2 }))
    const b = await call(
      otherBoss,
      req({ idempotencyKey: key, barcode: other.products['Z-1']!.barcode, qty: 2 }),
    )

    expect(a.duplicate).toBe(false)
    expect(b.duplicate).toBe(false)
    expect(a.movementId).not.toBe(b.movementId)
  })
})

describe('createMovement - ilk hareket', () => {
  it('projeksiyon satırı yokken de çalışır', async () => {
    const fresh = await seedTestTenant(admin.db, 'mv-first', [{ sku: 'F-1', name: 'İlk Hareket' }])
    const actor: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }

    const res = await createMovement(
      actor,
      {
        idempotencyKey: randomUUID(),
        barcode: fresh.products['F-1']!.barcode,
        qty: 3,
        // `OPENING` değil: T89 devirde birim fiyat zorunlu kıldı ve bu test
        // "projeksiyon satırı yokken ilk hareket yazılabiliyor mu" diye
        // soruyor, fiyat kuralını değil.
        reason: 'PURCHASE',
        clientCreatedAt: new Date().toISOString(),
      },
      { db: app.db },
    )

    expect(res.newQty).toBe(3)
  })

  it('elle yazılan başlangıç stoğu da projeksiyona işler', async () => {
    // Trigger uygulama kodundan bağımsız: psql'den atılan INSERT bile
    // projeksiyonu günceller.
    const fresh = await seedTestTenant(admin.db, 'mv-manual', [{ sku: 'M-1', name: 'Elle Giriş' }])
    const p = fresh.products['M-1']!
    await seedOpeningStock(admin.db, fresh, p.id, '42')

    expect(await getStockQty({ tenantId: fresh.tenantId }, p.id, { db: app.db })).toBe(42)
  })
})

describe('invariant', () => {
  it('bu dosyadaki tüm hareketlerden sonra defter ile projeksiyon eşit', async () => {
    expect(await checkStockInvariant(tenant.tenantId, { db: app.db })).toEqual([])
  })
})
