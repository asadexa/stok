import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { AppError } from '@stok/shared'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz.js'
import { login, refreshSession } from './auth.js'
import {
  createUser,
  getTenantUser,
  listTenantUsers,
  setUserPassword,
  updateUser,
} from './users.js'
import { TEST_DB_NAME } from './test/db-name.js'

/**
 * ============================================================================
 * KULLANICI LİSTESİ (T20 filtresi)
 *
 * İki şeyi sınıyor: kimin görebildiği ve NE göremediği. İkincisi daha
 * önemli — `select().from(users)` yazılsaydı parola ve PIN hash'leri
 * sessizce cevaba düşerdi ve hiçbir davranış testi bunu fark etmezdi.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }

let tenant: TestTenant
let other: TestTenant
let boss: Actor
let staff: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'users-a')
  other = await seedTestTenant(admin.db, 'users-b')
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

describe('listTenantUsers', () => {
  it('yönetici kiracının kullanıcılarını Türkçe sırayla alıyor', async () => {
    // "Test Çalışan" < "Test Yönetici". Veritabanı collation'ı C.UTF-8 ve
    // ham `ORDER BY name` bayt sırasına düşüyor: 'Ç' (0xC3 0x87) 'Y'den
    // (0x59) büyük olduğu için Türkçe baş harfli her isim listenin dibine
    // inerdi. `tr_norm` bunu collation'dan bağımsız düzeltiyor.
    const rows = await listTenantUsers(boss, opts)

    expect(rows.map((r) => r.name)).toEqual(['Test Çalışan', 'Test Yönetici'])
    expect(rows.map((r) => r.id)).toEqual([tenant.staffUserId, tenant.adminUserId])
  })

  it('parola ve PIN hash cevaba GİRMİYOR', async () => {
    const rows = await listTenantUsers(boss, opts)

    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['active', 'id', 'name', 'role'])
    }
  })

  it('çalışan listeyi alamıyor', async () => {
    // Göremediği hareketlerin sahiplerini isim isim saymasına gerek yok.
    await expect(listTenantUsers(staff, opts)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(listTenantUsers(staff, opts)).rejects.toBeInstanceOf(AppError)
  })

  it('başka kiracının kullanıcıları görünmüyor', async () => {
    const rows = await listTenantUsers(boss, opts)
    const ids = rows.map((r) => r.id)

    expect(ids).not.toContain(other.adminUserId)
    expect(ids).not.toContain(other.staffUserId)
  })
})

describe('getTenantUser', () => {
  it('kendi kiracısındaki kullanıcıyı buluyor', async () => {
    const row = await getTenantUser(boss, tenant.staffUserId, opts)
    expect(row).toMatchObject({ id: tenant.staffUserId, role: 'STAFF' })
  })

  it('başka kiracının kullanıcısı için null dönüyor', async () => {
    // Fırlatmıyor: "yok" ile "senin değil" ayrımı, saldırgana kimlik
    // doğrulama yapmadan kiracı keşfi imkanı verirdi.
    expect(await getTenantUser(boss, other.adminUserId, opts)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// T24 — KULLANICI YÖNETİMİ
// ---------------------------------------------------------------------------

let counter = 0
function email(prefix: string) {
  counter += 1
  return `${prefix}${counter}@users-a.test`
}

const draft = (over: Record<string, unknown> = {}) => ({
  email: email('yeni'),
  name: 'Yeni Kullanıcı',
  role: 'STAFF',
  password: 'parola1234',
  ...over,
})

describe('T24 - kullanıcı ekleme', () => {
  it('yönetici kullanıcı ekliyor ve o kullanıcı giriş yapabiliyor', async () => {
    // Asıl iddia burada: eklenen kullanıcı GERÇEKTEN giriş yapabilmeli.
    // Sadece satırın yazıldığını doğrulamak, parola hash'i yanlış
    // kaydedilse bile yeşil kalırdı.
    const input = draft()
    const created = await createUser(boss, input, opts)

    expect(created).toMatchObject({ name: input.name, role: 'STAFF', active: true })
    await expect(
      login({ email: input.email, password: input.password }, opts),
    ).resolves.toMatchObject({ user: { userId: created.id, role: 'STAFF' } })
  })

  it('aynı e-posta ikinci kez eklenemiyor', async () => {
    const input = draft()
    await createUser(boss, input, opts)
    await expect(createUser(boss, input, opts)).rejects.toMatchObject({
      code: 'EMAIL_EXISTS',
      details: { email: input.email },
    })
  })

  it('kısa parola reddediliyor', async () => {
    await expect(createUser(boss, draft({ password: 'kisa' }), opts)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('çalışan kullanıcı ekleyemiyor', async () => {
    await expect(createUser(staff, draft(), opts)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('T24 - kendini kilitleme koruması', () => {
  it('yönetici kendi rolünü düşüremiyor', async () => {
    // Düşürebilseydi bir sonraki sayfa yenilemesinde dışarıda kalırdı ve
    // geri dönüş veritabanına elle müdahale gerektirirdi.
    await expect(
      updateUser(boss, boss.userId, { role: 'STAFF' }, opts),
    ).rejects.toMatchObject({ code: 'SELF_LOCKOUT' })
  })

  it('yönetici kendini pasifleştiremiyor', async () => {
    await expect(
      updateUser(boss, boss.userId, { active: false }, opts),
    ).rejects.toMatchObject({ code: 'SELF_LOCKOUT' })
  })

  it('kendi adını değiştirebiliyor', async () => {
    // Koruma rol ve aktifliğe özgü; ada dokunmayı engellemek anlamsız
    // bir engel olurdu.
    const updated = await updateUser(boss, boss.userId, { name: 'Patron' }, opts)
    expect(updated.name).toBe('Patron')
  })
})

describe('T24 - son yönetici koruması', () => {
  it('geriye yönetici kalmıyorsa rol düşürme reddediliyor', async () => {
    // Kendini kilitleme koruması tek başına yetmez: iki yönetici
    // birbirini düşürebilirdi.
    const fresh = await seedTestTenant(admin.db, 'users-last')
    const a: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    const second = await createUser(
      a,
      { email: 'ikinci@users-last.test', name: 'İkinci', role: 'ADMIN', password: 'parola1234' },
      opts,
    )

    // İkisi de yönetici: biri düşürülebilir.
    await updateUser(a, second.id, { role: 'STAFF' }, opts)

    // Artık tek yönetici kaldı; onu da düşürmeye çalışan bir başkası
    // olsaydı reddedilmeli. Kendisi zaten SELF_LOCKOUT alıyor, bu yüzden
    // ikinci yöneticiyi geri alıp asıl yöneticiyi düşürmeyi deniyoruz.
    await updateUser(a, second.id, { role: 'ADMIN' }, opts)
    const b: Actor = { tenantId: fresh.tenantId, userId: second.id, role: 'ADMIN' }
    await updateUser(b, fresh.adminUserId, { active: false }, opts)

    await expect(updateUser(b, second.id, { active: false }, opts)).rejects.toMatchObject({
      code: 'SELF_LOCKOUT',
    })
    // Pasifleştirilmiş yönetici "aktif yönetici" sayılmıyor.
    await expect(
      updateUser(b, fresh.adminUserId, { role: 'STAFF' }, opts),
    ).resolves.toBeTruthy()
  })

  it('pasif yönetici son admin sayımına GİRMİYOR', async () => {
    const fresh = await seedTestTenant(admin.db, 'users-inactive')
    const a: Actor = { tenantId: fresh.tenantId, userId: fresh.adminUserId, role: 'ADMIN' }
    const other = await createUser(
      a,
      { email: 'pasif@users-inactive.test', name: 'Pasif', role: 'ADMIN', password: 'parola1234' },
      opts,
    )
    await updateUser(a, other.id, { active: false }, opts)

    // Geriye sadece `a` kaldı; ikinci yönetici pasif olduğu için sayılmıyor.
    const b: Actor = { tenantId: fresh.tenantId, userId: other.id, role: 'ADMIN' }
    await expect(updateUser(b, fresh.adminUserId, { role: 'STAFF' }, opts)).rejects.toMatchObject({
      code: 'LAST_ADMIN',
    })
  })
})

describe('T24 - pasifleştirme ve parola', () => {
  it('pasifleştirilen kullanıcı giriş yapamıyor', async () => {
    const input = draft()
    const created = await createUser(boss, input, opts)
    await updateUser(boss, created.id, { active: false }, opts)

    await expect(
      login({ email: input.email, password: input.password }, opts),
    ).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' })
  })

  it('pasifleştirilen kullanıcının refresh token\'ı çalışmıyor', async () => {
    // İKİ BAĞIMSIZ KATMAN bu yolu kapatıyor ve ikisi de tek başına
    // yeterli: `refreshSession` hem AKTİFLİK bayrağına hem
    // `token_version`'a bakıyor, `updateUser` da pasifleştirirken sürümü
    // artırıyor. Deneyle doğrulandı — birini kaldırdığımızda bu test
    // yeşil kalıyor, çünkü diğeri yakalıyor.
    //
    // Bu yüzden burası "hangi mekanizma" testi değil, DAVRANIŞ testi:
    // pasifleştirilen kullanıcı devam edemez. Mekanizmaların kendi
    // testleri ayrı: aktiflik kontrolünü auth.test.ts, sürüm artışını
    // aşağıdaki rol değişikliği testi tutuyor.
    const input = draft()
    const created = await createUser(boss, input, opts)
    const before = await login({ email: input.email, password: input.password }, opts)

    await updateUser(boss, created.id, { active: false }, opts)

    await expect(
      refreshSession({ refreshToken: before.tokens.refreshToken }, opts),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('rol değişikliği de oturumları iptal ediyor', async () => {
    // Access token rolü İÇİNDE taşıyor; yenilenmezse eski rol 15 dk daha
    // geçerli kalırdı.
    const input = draft()
    const created = await createUser(boss, input, opts)
    const before = await login({ email: input.email, password: input.password }, opts)

    await updateUser(boss, created.id, { role: 'ADMIN' }, opts)

    await expect(
      refreshSession({ refreshToken: before.tokens.refreshToken }, opts),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('parola sıfırlama yeni parolayı geçerli, eskisini geçersiz kılıyor', async () => {
    const input = draft()
    const created = await createUser(boss, input, opts)

    await setUserPassword(boss, created.id, { password: 'yeniparola99' }, opts)

    await expect(
      login({ email: input.email, password: input.password }, opts),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
    await expect(
      login({ email: input.email, password: 'yeniparola99' }, opts),
    ).resolves.toBeTruthy()
  })

  it('parola sıfırlama eski oturumları kapatıyor', async () => {
    // Parolayı değiştirmenin sebebi çoğu zaman "başkasının eline geçti";
    // eski oturumlar ayakta kalsaydı değişiklik hiçbir şeyi düzeltmezdi.
    const input = draft()
    const created = await createUser(boss, input, opts)
    const before = await login({ email: input.email, password: input.password }, opts)

    await setUserPassword(boss, created.id, { password: 'yeniparola99' }, opts)

    await expect(
      refreshSession({ refreshToken: before.tokens.refreshToken }, opts),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('başka kiracının kullanıcısı güncellenemiyor', async () => {
    await expect(
      updateUser(boss, other.adminUserId, { name: 'Ele geçirildi' }, opts),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('çalışan başkasının parolasını değiştiremiyor', async () => {
    await expect(
      setUserPassword(staff, tenant.adminUserId, { password: 'parola1234' }, opts),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
