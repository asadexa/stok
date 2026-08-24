import { randomUUID } from 'node:crypto'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz.js'
import { systemHealth } from './health.js'
import { enqueueJob } from './jobs.js'
import { createMovement } from './movements.js'
import { TEST_DB_NAME } from './test/db-name.js'

/**
 * ============================================================================
 * T25 — SİSTEM SAĞLIĞI
 *
 * Bu kartın tek işi SESSİZ bozulmayı görünür kılmak, o yüzden testler
 * "kart açılıyor mu" değil "bozukken bozuk diyor mu" sorusunu soruyor.
 * Sağlıklı bir sistemde yeşil göstermek kolay; asıl değer bozuk durumu
 * yakalamakta.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }

let tenant: TestTenant
let boss: Actor
let staff: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'health')
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

const find = (h: Awaited<ReturnType<typeof systemHealth>>, key: string) =>
  h.checks.find((c) => c.key === key)!

describe('yetki', () => {
  it('çalışan sistem sağlığını göremiyor', async () => {
    // Altyapı durumu çalışanın işine yaramaz; göstermek "bir şeyler
    // bozuk" paniğinden başka bir şey üretmez.
    await expect(systemHealth(staff, opts)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('defter / projeksiyon ayrışması', () => {
  it('tutarlı veride sorun bildirmiyor', async () => {
    const health = await systemHealth(boss, opts)
    expect(find(health, 'invariant').level).toBe('ok')
  })

  it('projeksiyon elle bozulduğunda HATA veriyor', async () => {
    // Bu ürünün en temel garantisi: SUM(delta) == current_stock.qty.
    // Bozulursa ekrandaki her stok sayısı yalan olur ve hiç kimse hata
    // almaz — tam olarak bu kartın var olma sebebi.
    const fresh = await seedTestTenant(admin.db, 'health-broken')
    const freshBoss: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    await createMovement(
      freshBoss,
      {
        idempotencyKey: randomUUID(),
        barcode: fresh.products['KAL-001']!.barcode,
        qty: 10,
        reason: 'PURCHASE',
        clientCreatedAt: new Date().toISOString(),
      },
      opts,
    )

    expect(find(await systemHealth(freshBoss, opts), 'invariant').level).toBe('ok')

    // Projeksiyonu sahip rolüyle bozuyoruz: uygulama rolü bunu YAPAMAZ,
    // zaten mesele de bir hata veya dış müdahale sonucu oluşan durumu
    // yakalayabilmek.
    await admin.db.execute(sql`
      UPDATE current_stock SET qty = qty + 5
       WHERE tenant_id = ${fresh.tenantId}
         AND product_id = ${fresh.products['KAL-001']!.id}
    `)

    const broken = find(await systemHealth(freshBoss, opts), 'invariant')
    expect(broken.level).toBe('error')
    expect(broken.summary).toContain('AYRIŞMIŞ')
    expect(broken.hint).toContain('durdurun')
  })
})

describe('kuyruk', () => {
  it('boş kuyrukta sorun yok', async () => {
    const fresh = await seedTestTenant(admin.db, 'health-queue-empty')
    const a: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    expect(find(await systemHealth(a, opts), 'queue').level).toBe('ok')
  })

  it('yeni kuyruğa girmiş iş uyarı DEĞİL', async () => {
    // Kuyrukta iş olması normaldir; uyarı vermek her rapor isteğinde
    // yanlış alarm üretirdi.
    const fresh = await seedTestTenant(admin.db, 'health-queue-fresh')
    const a: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    await enqueueJob(a, { kind: 'STOCK_EXPORT', params: {} }, opts)

    const check = find(await systemHealth(a, opts), 'queue')
    expect(check.level).toBe('ok')
    expect(check.summary).toContain('işleniyor')
  })

  it('uzun süredir bekleyen iş UYARI veriyor', async () => {
    // İşçi hiç çalışmıyorsa iş sonsuza kadar durur ve kullanıcı beklediği
    // e-postayı hiç almaz.
    const fresh = await seedTestTenant(admin.db, 'health-queue-stuck')
    const a: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    await enqueueJob(a, { kind: 'STOCK_EXPORT', params: {} }, opts)

    // Saati üç saat ileri alıyoruz; beklemek yerine saati enjekte etmek
    // testin ölçtüğü şeyi (gecikmenin VARLIĞI) değiştirmiyor.
    const check = find(
      await systemHealth(a, { ...opts, now: () => Date.now() + 3 * 3_600_000 }),
      'queue',
    )
    expect(check.level).toBe('warn')
    expect(check.summary).toContain('saattir bekliyor')
    expect(check.hint).toContain('işçisi')
  })

  it('başarısız iş HATA veriyor ve kuyruk uyarısını bastırıyor', async () => {
    const fresh = await seedTestTenant(admin.db, 'health-queue-failed')
    const a: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    const { job } = await enqueueJob(a, { kind: 'STOCK_EXPORT', params: {} }, opts)
    await admin.db.execute(sql`UPDATE background_jobs SET status = 'FAILED' WHERE id = ${job.id}`)

    const check = find(await systemHealth(a, opts), 'queue')
    expect(check.level).toBe('error')
    expect(check.summary).toContain('başarısız')
  })
})

describe('hareketsizlik', () => {
  it('hiç hareket yoksa bu HATA değil', async () => {
    // Kurulum günü tam olarak bu durumda; uyarı vermek ilk izlenimi
    // "sistem bozuk" yapardı.
    const fresh = await seedTestTenant(admin.db, 'health-quiet-new')
    const a: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }

    const check = find(await systemHealth(a, opts), 'activity')
    expect(check.level).toBe('ok')
    expect(check.summary).toContain('Henüz hiç')
  })

  it('taze hareket varsa aktif kullanıcı sayılıyor', async () => {
    const fresh = await seedTestTenant(admin.db, 'health-active')
    const a: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    await createMovement(
      a,
      {
        idempotencyKey: randomUUID(),
        barcode: fresh.products['KAL-001']!.barcode,
        qty: 1,
        reason: 'PURCHASE',
        clientCreatedAt: new Date().toISOString(),
      },
      opts,
    )

    const check = find(await systemHealth(a, opts), 'activity')
    expect(check.level).toBe('ok')
    expect(check.summary).toContain('1 kullanıcı')
  })

  it('uzun sessizlik UYARI veriyor', async () => {
    // Depo çalışıyor ama kayıt gelmiyorsa ya mobil bağlanamıyor ya da
    // kimse okutmuyor; ikisi de yöneticinin bilmesi gereken şeyler.
    const fresh = await seedTestTenant(admin.db, 'health-quiet-old')
    const a: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    await createMovement(
      a,
      {
        idempotencyKey: randomUUID(),
        barcode: fresh.products['KAL-001']!.barcode,
        qty: 1,
        reason: 'PURCHASE',
        clientCreatedAt: new Date().toISOString(),
      },
      opts,
    )

    const check = find(
      await systemHealth(a, { ...opts, now: () => Date.now() + 30 * 3_600_000 }),
      'activity',
    )
    expect(check.level).toBe('warn')
    expect(check.summary).toContain('saattir hiç hareket')
  })
})

describe('genel seviye', () => {
  it('en kötü kontrolün seviyesini alıyor', async () => {
    // Bir tanesi hata ise kart yeşil görünemez; yöneticinin tek bakışta
    // "bir sorun var" görmesi gerekiyor.
    const fresh = await seedTestTenant(admin.db, 'health-worst')
    const a: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    const { job } = await enqueueJob(a, { kind: 'STOCK_EXPORT', params: {} }, opts)
    await admin.db.execute(sql`UPDATE background_jobs SET status = 'FAILED' WHERE id = ${job.id}`)

    const health = await systemHealth(a, opts)
    expect(health.level).toBe('error')
    expect(find(health, 'activity').level).toBe('ok')
  })
})
