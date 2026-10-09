import { randomUUID } from 'node:crypto'
import { AppError } from '@stok/shared'
import { count, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { withTenant } from './client'
import { verifySecret } from './password'
import { PROVISION_LOCK_NAMESPACE, provisionTenant } from './provision'
import { tenants, users } from './schema'
import { TEST_DB_NAME } from './test/db-name'
import { seedTestTenant, testAdminDb, testDatabaseUrls } from './testing'

/**
 * ============================================================================
 * T162 — KİRACI AÇMA
 *
 * Gerçek PostgreSQL'de ve sahip rolüyle: aracın üretimde kullanacağı
 * bağlantının aynısı. Atomiklik ve yarış vakaları üretim koduna test kancası
 * eklenmeden, veritabanının kendisiyle kuruluyor (geçici trigger, ayrı
 * bağlantıda tutulan kilit).
 * ============================================================================
 */

const admin = testAdminDb(TEST_DB_NAME)

afterAll(async () => {
  await admin.client.end()
})

async function tenantsNamed(name: string): Promise<number> {
  const [row] = await admin.db.select({ n: count() }).from(tenants).where(eq(tenants.name, name))
  return row?.n ?? 0
}

async function tenantTotal(): Promise<number> {
  const [row] = await admin.db.select({ n: count() }).from(tenants)
  return row?.n ?? 0
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err, 'çağrı başarılı oldu, hata bekleniyordu').toBeInstanceOf(AppError)
  return err as AppError
}

describe('provisionTenant (T162)', () => {
  it('kiracıyı ve ilk ADMIN’i birlikte açıyor; parola yalnız sonuçta, özeti DB’de', async () => {
    const created = await provisionTenant(admin.db, {
      tenantName: 'Sentetik Kırtasiye A',
      adminName: 'Deneme Yönetici',
      adminEmail: 'yonetici.a@sentetik.test',
    })

    const rows = await withTenant(
      created.tenantId,
      (tx) => tx.select().from(users).where(eq(users.tenantId, created.tenantId)),
      admin.db,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(created.adminUserId)
    expect(rows[0]?.role).toBe('ADMIN')
    expect(created.initialPassword.length).toBeGreaterThanOrEqual(20)
    expect(rows[0]?.passwordHash).not.toContain(created.initialPassword)
    expect(await verifySecret(created.initialPassword, rows[0]?.passwordHash ?? '')).toBe(true)
  })

  it('e-postayı girişin eşleştirdiği biçime (küçük harf, boşluksuz) getiriyor', async () => {
    const created = await provisionTenant(admin.db, {
      tenantName: 'Sentetik Kırtasiye B',
      adminName: 'Deneme Yönetici',
      adminEmail: '  Yonetici.B@Sentetik.TEST ',
    })

    expect(created.adminEmail).toBe('yonetici.b@sentetik.test')
    // Sahip rolü RLS'i atlıyor: kiracı filtresi açıkça yazılmalı.
    const [row] = await withTenant(
      created.tenantId,
      (tx) =>
        tx.select({ email: users.email }).from(users).where(eq(users.tenantId, created.tenantId)),
      admin.db,
    )
    expect(row?.email).toBe('yonetici.b@sentetik.test')
  })

  it('aynı e-posta başka kiracıda varsa (harf farkıyla da) reddediyor ve kiracı açmıyor', async () => {
    await provisionTenant(admin.db, {
      tenantName: 'Sentetik Kırtasiye C',
      adminName: 'Deneme Yönetici',
      adminEmail: 'yonetici.c@sentetik.test',
    })

    const err = await errorOf(
      provisionTenant(admin.db, {
        tenantName: 'Sentetik Kırtasiye D',
        adminName: 'Başka Yönetici',
        adminEmail: 'YONETICI.C@sentetik.test',
      }),
    )
    expect(err.code).toBe('EMAIL_IN_OTHER_TENANT')
    expect(await tenantsNamed('Sentetik Kırtasiye D')).toBe(0)
  })

  it('uygulamadan açılmış bir kullanıcının e-postası da reddediliyor', async () => {
    const fixture = await seedTestTenant(admin.db, 'prov-fixture', [])

    const err = await errorOf(
      provisionTenant(admin.db, {
        tenantName: 'Sentetik Çakışma',
        adminName: 'Deneme',
        adminEmail: fixture.staffEmail,
      }),
    )
    expect(err.code).toBe('EMAIL_IN_OTHER_TENANT')
    expect(await tenantsNamed('Sentetik Çakışma')).toBe(0)
  })

  it('yönetici yazılamazsa kiracı da kalmıyor (tek transaction)', async () => {
    // Yalnız bu testin kullanıcısını engelleyen geçici trigger. WHEN koşulu,
    // aynı veritabanını paylaşan diğer test dosyalarını etkilemesin diye.
    await admin.db.execute(sql`
      CREATE OR REPLACE FUNCTION test_provision_fail() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test: yönetici yazımı engellendi'; END $$
    `)
    await admin.db.execute(sql`
      CREATE TRIGGER test_provision_fail BEFORE INSERT ON users
      FOR EACH ROW WHEN (NEW.name = 'Atomik Deneme') EXECUTE FUNCTION test_provision_fail()
    `)
    try {
      await expect(
        provisionTenant(admin.db, {
          tenantName: 'Sentetik Atomik',
          adminName: 'Atomik Deneme',
          adminEmail: 'atomik@sentetik.test',
        }),
      ).rejects.toThrow()
      expect(await tenantsNamed('Sentetik Atomik')).toBe(0)
    } finally {
      await admin.db.execute(sql`DROP TRIGGER IF EXISTS test_provision_fail ON users`)
      await admin.db.execute(sql`DROP FUNCTION IF EXISTS test_provision_fail()`)
    }
  })

  it.each([
    ['geçersiz e-posta', { tenantName: 'Sentetik Geçersiz', adminName: 'Ad', adminEmail: 'gecersiz-adres' }],
    ['boş işletme adı', { tenantName: '   ', adminName: 'Ad', adminEmail: 'bos.isletme@sentetik.test' }],
    ['boş yönetici adı', { tenantName: 'Sentetik Adsız', adminName: '', adminEmail: 'adsiz@sentetik.test' }],
  ])('%s: doğrulama hatası, hiçbir şey yazılmıyor', async (_vaka, input) => {
    const before = await tenantTotal()

    const err = await errorOf(provisionTenant(admin.db, input))

    expect(err.code).toBe('VALIDATION_FAILED')
    expect(await tenantTotal()).toBe(before)
  })

  it('aynı e-postayla eşzamanlı ikinci çağrı birincinin bitmesini bekleyip reddediliyor', async () => {
    const email = 'yaris@sentetik.test'
    const holder = postgres(testDatabaseUrls(TEST_DB_NAME).migrationUrl, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markLocked!: () => void
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve
    })

    try {
      // Birinci "açılış": kilidi alıp kullanıcısını yazdı ama henüz commit etmedi.
      const first = holder.begin(async (tx) => {
        const otherTenant = randomUUID()
        await tx`SELECT pg_advisory_xact_lock(${PROVISION_LOCK_NAMESPACE}, hashtext(${email}))`
        await tx`SELECT set_config('app.tenant_id', ${otherTenant}, true)`
        await tx`INSERT INTO tenants (id, name) VALUES (${otherTenant}, 'Sentetik Yarış Birinci')`
        await tx`INSERT INTO users (tenant_id, email, name, role, password_hash)
                 VALUES (${otherTenant}, ${email}, 'Birinci', 'ADMIN', 'x')`
        markLocked()
        await gate
      })
      await locked

      let settled = false
      const second = provisionTenant(admin.db, {
        tenantName: 'Sentetik Yarış İkinci',
        adminName: 'İkinci',
        adminEmail: email,
      })
        .then(
          () => undefined,
          (e: unknown) => e,
        )
        .finally(() => {
          settled = true
        })

      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(settled, 'ikinci çağrı kilidi beklemeliydi').toBe(false)

      release()
      await first
      const err = await second
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('EMAIL_IN_OTHER_TENANT')
      expect(await tenantsNamed('Sentetik Yarış İkinci')).toBe(0)
    } finally {
      release?.()
      await holder.end()
    }
  })
})
