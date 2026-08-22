import { AppError } from '@stok/shared'
import { users } from '@stok/db'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  TOKEN_TTL,
  actorFromAccessToken,
  bearerToken,
  login,
  refreshSession,
  revokeSessions,
} from './auth.js'
import type { Actor } from './authz.js'
import { TEST_DB_NAME } from './test/db-name.js'

/**
 * T13 — kimlik doğrulama.
 *
 * Tehdit S5 (çalınan token) ve S9'un bir kısmı burada sınanıyor. Testlerin
 * çoğu "yanlış girdi reddediliyor mu" değil, "yanlış girdi DOĞRU KODLA
 * reddediliyor mu": mobil outbox `retryable` bayrağını hata koduna göre
 * okuyor, yanlış kod kaydı sonsuz döngüye ya da veri kaybına sokar.
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

let tenant: TestTenant

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'auth', [{ sku: 'AU-1', name: 'Giriş Ürünü' }])
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

const opts = { db: app.db }

async function expectAppError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err, `beklenen hata: ${code}, ama çağrı başarılı oldu`).toBeInstanceOf(AppError)
  expect((err as AppError).code).toBe(code)
  return err as AppError
}

describe('login - mutlu yol', () => {
  it('doğru parolayla token çifti ve kullanıcı bilgisi döner', async () => {
    const res = await login(
      { email: tenant.adminEmail, password: tenant.password },
      opts,
    )

    expect(res.user.userId).toBe(tenant.adminUserId)
    expect(res.user.tenantId).toBe(tenant.tenantId)
    expect(res.user.role).toBe('ADMIN')
    expect(res.tokens.accessToken).toBeTruthy()
    expect(res.tokens.refreshToken).not.toBe(res.tokens.accessToken)
    expect(res.tokens.accessExpiresAt).toBeLessThan(res.tokens.refreshExpiresAt)
  })

  it('e-posta büyük/küçük harf ve boşluktan bağımsız', async () => {
    // Depoda telefon klavyesi ilk harfi otomatik büyütüyor. Girişin
    // bu yüzden başarısız olması, kullanıcının parolasını unuttuğunu
    // sanmasına yol açardı.
    const res = await login(
      { email: `  ${tenant.adminEmail.toUpperCase()}  `, password: tenant.password },
      opts,
    )
    expect(res.user.userId).toBe(tenant.adminUserId)
  })

  it('access token doğru Actor üretiyor', async () => {
    const { tokens } = await login({ email: tenant.staffEmail, password: tenant.password }, opts)
    const actor = await actorFromAccessToken(tokens.accessToken)

    expect(actor).toEqual<Actor>({
      tenantId: tenant.tenantId,
      userId: tenant.staffUserId,
      role: 'STAFF',
    })
  })
})

describe('login - reddedilen girişler', () => {
  it('yanlış parola INVALID_CREDENTIALS', async () => {
    await expectAppError(
      login({ email: tenant.adminEmail, password: 'yanlis-parola' }, opts),
      'INVALID_CREDENTIALS',
    )
  })

  it('olmayan e-posta da AYNI kodu döner', async () => {
    // Farklı kod dönseydi saldırgan hangi e-postaların kayıtlı olduğunu
    // öğrenir ve kaba kuvvet için hedef listesi çıkarırdı.
    const err = await expectAppError(
      login({ email: 'kimse@yok.test', password: 'herhangi' }, opts),
      'INVALID_CREDENTIALS',
    )
    expect(err.http).toBe(401)
  })

  it('kullanıcı sayımı zaman farkından okunamıyor', async () => {
    // Olmayan kullanıcıda parola doğrulaması atlanırsa cevap belirgin
    // şekilde hızlı döner ve bu fark bir oracle'dır.
    const time = async (email: string) => {
      const t0 = performance.now()
      await login({ email, password: 'yanlis-parola' }, opts).catch(() => {})
      return performance.now() - t0
    }
    // Isınma: ilk scrypt çağrısı yer tutucu özeti üretiyor.
    await time('kimse@yok.test')

    const missing = await time('kimse@yok.test')
    const existing = await time(tenant.adminEmail)

    // Eşik gevşek; ölçülen şey "biri diğerinin kat kat altında mı".
    const ratio = Math.max(missing, existing) / Math.max(1, Math.min(missing, existing))
    expect(ratio).toBeLessThan(5)
  })

  it('pasif kullanıcı ACCOUNT_INACTIVE', async () => {
    const passive = await seedTestTenant(admin.db, 'auth-off', [{ sku: 'P-1', name: 'Pasif' }])
    await admin.db
      .update(users)
      .set({ active: false })
      .where(eq(users.id, passive.staffUserId))

    await expectAppError(
      login({ email: passive.staffEmail, password: passive.password }, opts),
      'ACCOUNT_INACTIVE',
    )
  })

  it('parolası olmayan hesap (sadece PIN) giriş yapamaz', async () => {
    const pinOnly = await seedTestTenant(admin.db, 'auth-pin', [{ sku: 'N-1', name: 'PIN' }])
    await admin.db
      .update(users)
      .set({ passwordHash: null })
      .where(eq(users.id, pinOnly.staffUserId))

    await expectAppError(
      login({ email: pinOnly.staffEmail, password: 'herhangi' }, opts),
      'INVALID_CREDENTIALS',
    )
  })

  it('bozuk e-posta VALIDATION_FAILED', async () => {
    await expectAppError(login({ email: 'eposta-degil', password: 'x' }, opts), 'VALIDATION_FAILED')
  })

  it('boş parola VALIDATION_FAILED', async () => {
    await expectAppError(
      login({ email: tenant.adminEmail, password: '' }, opts),
      'VALIDATION_FAILED',
    )
  })
})

describe('login - aynı e-posta iki işletmede', () => {
  it('tenant belirtilmezse TENANT_AMBIGUOUS ve seçenekler döner', async () => {
    // Birini tahmin etmek, kullanıcıya BAŞKA bir müşterinin deposunu
    // açmak demek olurdu.
    const label = 'auth-dup'
    const a = await seedTestTenant(admin.db, `${label}-a`, [{ sku: 'D-1', name: 'A' }])
    const b = await seedTestTenant(admin.db, `${label}-b`, [{ sku: 'D-1', name: 'B' }])
    const shared = 'ayni@iki-isletme.test'
    await admin.db.update(users).set({ email: shared }).where(eq(users.id, a.adminUserId))
    await admin.db.update(users).set({ email: shared }).where(eq(users.id, b.adminUserId))

    const err = await expectAppError(
      login({ email: shared, password: a.password }, opts),
      'TENANT_AMBIGUOUS',
    )
    expect(err.details.tenantIds).toHaveLength(2)

    // Tenant seçilince giriş normal şekilde tamamlanıyor.
    const res = await login({ email: shared, password: a.password, tenantId: b.tenantId }, opts)
    expect(res.user.tenantId).toBe(b.tenantId)
    expect(res.user.userId).toBe(b.adminUserId)
  })
})

describe('token doğrulama', () => {
  it('bozuk imza TOKEN_INVALID', async () => {
    const { tokens } = await login({ email: tenant.adminEmail, password: tenant.password }, opts)
    const tampered = `${tokens.accessToken.slice(0, -4)}AAAA`
    await expectAppError(actorFromAccessToken(tampered), 'TOKEN_INVALID')
  })

  it('yükü değiştirilmiş token TOKEN_INVALID', async () => {
    // Rolü STAFF'tan ADMIN'e çevirme denemesi. İmza tutmadığı için geçmez.
    const { tokens } = await login({ email: tenant.staffEmail, password: tenant.password }, opts)
    const [header, payload, signature] = tokens.accessToken.split('.')
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString())
    decoded.role = 'ADMIN'
    const forged = [
      header,
      Buffer.from(JSON.stringify(decoded)).toString('base64url'),
      signature,
    ].join('.')

    await expectAppError(actorFromAccessToken(forged), 'TOKEN_INVALID')
  })

  it('alg:none token reddedilir', async () => {
    // JWT'nin en bilinen açığı. `algorithms: ['HS256']` sabitlenmemiş
    // olsaydı bu token imzasız kabul edilirdi.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        sub: tenant.adminUserId,
        tid: tenant.tenantId,
        role: 'ADMIN',
        typ: 'access',
        ver: 0,
        iss: 'stok',
        aud: 'stok-api',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url')

    await expectAppError(actorFromAccessToken(`${header}.${payload}.`), 'TOKEN_INVALID')
  })

  it('süresi dolmuş token TOKEN_EXPIRED (TOKEN_INVALID değil)', async () => {
    // Ayrım önemli: istemci TOKEN_EXPIRED görünce sessizce yeniler,
    // TOKEN_INVALID görünce kullanıcıyı giriş ekranına atar.
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0)
    const { tokens } = await login(
      { email: tenant.adminEmail, password: tenant.password },
      { ...opts, now: () => t0 },
    )

    const justBefore = t0 + (TOKEN_TTL.accessSeconds - 30) * 1000
    await expect(
      actorFromAccessToken(tokens.accessToken, { now: () => justBefore }),
    ).resolves.toBeTruthy()

    const after = t0 + (TOKEN_TTL.accessSeconds + 60) * 1000
    await expectAppError(
      actorFromAccessToken(tokens.accessToken, { now: () => after }),
      'TOKEN_EXPIRED',
    )
  })

  it('refresh token access yerine kullanılamaz', async () => {
    // Kullanılabilseydi 15 dakikalık pencere 30 güne çıkardı.
    const { tokens } = await login({ email: tenant.adminEmail, password: tenant.password }, opts)
    await expectAppError(actorFromAccessToken(tokens.refreshToken), 'TOKEN_INVALID')
  })

  it('access token refresh yerine kullanılamaz', async () => {
    const { tokens } = await login({ email: tenant.adminEmail, password: tenant.password }, opts)
    await expectAppError(
      refreshSession({ refreshToken: tokens.accessToken }, opts),
      'TOKEN_INVALID',
    )
  })

  it('başka bir anahtarla imzalanmış token reddedilir', async () => {
    const { tokens } = await login({ email: tenant.adminEmail, password: tenant.password }, opts)
    const original = process.env.AUTH_SECRET
    process.env.AUTH_SECRET = 'bambaska-bir-anahtar-ama-yeterince-uzun'
    try {
      await expectAppError(actorFromAccessToken(tokens.accessToken), 'TOKEN_INVALID')
    } finally {
      process.env.AUTH_SECRET = original
    }
  })

  it('AUTH_SECRET yoksa sunucu token üretmez, varsayılana DÜŞMEZ', async () => {
    const original = process.env.AUTH_SECRET
    process.env.AUTH_SECRET = ''
    try {
      await expectAppError(
        login({ email: tenant.adminEmail, password: tenant.password }, opts),
        'SERVER_ERROR',
      )
    } finally {
      process.env.AUTH_SECRET = original
    }
  })
})

describe('bearerToken', () => {
  it('geçerli başlığı çözer', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
    expect(bearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi')
  })

  it.each([undefined, null, '', 'abc.def.ghi', 'Basic dXNlcjpwYXNz', 'Bearer'])(
    '%s reddedilir',
    (header) => {
      expect(() => bearerToken(header)).toThrow(AppError)
    },
  )
})

describe('yenileme ve uzaktan oturum kapatma (S5)', () => {
  it('refresh yeni token çifti verir', async () => {
    const first = await login({ email: tenant.adminEmail, password: tenant.password }, opts)
    const t1 = Date.now() + 2000
    const second = await refreshSession(
      { refreshToken: first.tokens.refreshToken },
      { ...opts, now: () => t1 },
    )

    expect(second.user.userId).toBe(first.user.userId)
    expect(second.tokens.accessToken).not.toBe(first.tokens.accessToken)
    await expect(actorFromAccessToken(second.tokens.accessToken)).resolves.toMatchObject({
      role: 'ADMIN',
    })
  })

  it('refresh anındaki rolü kullanır, token içindekini değil', async () => {
    // Yetkisi alınan biri, elindeki eski token'la admin kalmamalı.
    const demote = await seedTestTenant(admin.db, 'auth-demote', [{ sku: 'R-1', name: 'Rol' }])
    const before = await login({ email: demote.adminEmail, password: demote.password }, opts)
    expect(before.user.role).toBe('ADMIN')

    await admin.db.update(users).set({ role: 'STAFF' }).where(eq(users.id, demote.adminUserId))

    const after = await refreshSession({ refreshToken: before.tokens.refreshToken }, opts)
    expect(after.user.role).toBe('STAFF')
    await expect(actorFromAccessToken(after.tokens.accessToken)).resolves.toMatchObject({
      role: 'STAFF',
    })
  })

  it('oturum iptali sonrası eski refresh token çalışmaz', async () => {
    const target = await seedTestTenant(admin.db, 'auth-revoke', [{ sku: 'V-1', name: 'İptal' }])
    const session = await login({ email: target.staffEmail, password: target.password }, opts)
    const bossActor: Actor = {
      tenantId: target.tenantId,
      userId: target.adminUserId,
      role: 'ADMIN',
    }

    await revokeSessions(bossActor, target.staffUserId, opts)

    await expectAppError(
      refreshSession({ refreshToken: session.tokens.refreshToken }, opts),
      'TOKEN_INVALID',
    )
    // Yeniden giriş çalışıyor: iptal edilen oturum, hesap değil.
    await expect(
      login({ email: target.staffEmail, password: target.password }, opts),
    ).resolves.toBeTruthy()
  })

  it('pasifleştirilen kullanıcı yenileme yapamaz', async () => {
    const target = await seedTestTenant(admin.db, 'auth-deact', [{ sku: 'K-1', name: 'Kapalı' }])
    const session = await login({ email: target.staffEmail, password: target.password }, opts)

    await admin.db.update(users).set({ active: false }).where(eq(users.id, target.staffUserId))

    await expectAppError(
      refreshSession({ refreshToken: session.tokens.refreshToken }, opts),
      'ACCOUNT_INACTIVE',
    )
  })

  it('çalışan kendi oturumlarını kapatabilir', async () => {
    const self = await seedTestTenant(admin.db, 'auth-self', [{ sku: 'S-1', name: 'Kendi' }])
    const actor: Actor = { tenantId: self.tenantId, userId: self.staffUserId, role: 'STAFF' }
    const session = await login({ email: self.staffEmail, password: self.password }, opts)

    await revokeSessions(actor, self.staffUserId, opts)

    await expectAppError(
      refreshSession({ refreshToken: session.tokens.refreshToken }, opts),
      'TOKEN_INVALID',
    )
  })

  it('çalışan BAŞKASININ oturumunu kapatamaz', async () => {
    const other = await seedTestTenant(admin.db, 'auth-other', [{ sku: 'O-1', name: 'Başka' }])
    const actor: Actor = { tenantId: other.tenantId, userId: other.staffUserId, role: 'STAFF' }

    await expectAppError(revokeSessions(actor, other.adminUserId, opts), 'FORBIDDEN')
  })

  it('başka tenantın kullanıcısı NOT_FOUND (sessiz başarı değil)', async () => {
    // RLS yabancı satırı görünmez yapıyor ve UPDATE sıfır satır güncelliyor.
    // Sessizce başarılı dönseydi yöneticiye "oturum kapatıldı" yalanı
    // söylenmiş olurdu.
    const foreign = await seedTestTenant(admin.db, 'auth-foreign', [{ sku: 'F-1', name: 'Yabancı' }])
    const bossActor: Actor = {
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
      role: 'ADMIN',
    }

    await expectAppError(revokeSessions(bossActor, foreign.staffUserId, opts), 'NOT_FOUND')
  })
})
