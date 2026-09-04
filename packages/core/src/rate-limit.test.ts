import { AppError } from '@stok/shared'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { login } from './auth'
import {
  LOGIN_EMAIL_POLICY,
  LOGIN_IP_POLICY,
  clearAttempts,
  lockSecondsFor,
  pruneAttempts,
  readAttempts,
  recordFailure,
} from './rate-limit'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T51 — KABA KUVVET KORUMASI (tehdit S9)
 *
 * En kritik test aşağıda: "kilit, kayıtlı OLMAYAN e-posta için de
 * uygulanıyor". Sadece var olan hesaplar kilitlenseydi, kilit cevabının
 * kendisi bir kullanıcı sayımı kanalı olurdu ve giriş hatalarını tek kod
 * altında toplama çabamızın tamamı boşa giderdi.
 *
 * İkinci kritik test: sayaç KALICI. Bellekte tutulsaydı sunucu yeniden
 * başlayınca sıfırlanır, saldırgan da bunu her deploy'da bedava alırdı.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

let tenant: TestTenant

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'ratelimit', [{ sku: 'RL-1', name: 'Sayaç Ürünü' }])
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

const T0 = Date.UTC(2026, 2, 1, 9, 0, 0)

async function expectAppError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err, `beklenen hata: ${code}, ama çağrı başarılı oldu`).toBeInstanceOf(AppError)
  expect((err as AppError).code).toBe(code)
  return err as AppError
}

/** Belirtilen e-postaya art arda yanlış parola dener. */
async function attemptBadLogins(email: string, times: number, at: number, ip?: string) {
  const codes: string[] = []
  for (let i = 0; i < times; i++) {
    const err = await login(
      { email, password: 'kesinlikle-yanlis' },
      { db: app.db, now: () => at, clientIp: ip },
    ).then(
      () => 'OK',
      (e: unknown) => (e instanceof AppError ? e.code : `UNEXPECTED: ${String(e)}`),
    )
    codes.push(err)
  }
  return codes
}

describe('lockSecondsFor - kilit eğrisi', () => {
  it.each([
    [1, 0],
    [4, 0],
    [5, 60],
    [6, 120],
    [7, 240],
    [8, 480],
    [9, 900],
    [20, 900],
  ])('%s hata → %s saniye', (failures, expected) => {
    expect(lockSecondsFor(LOGIN_EMAIL_POLICY, failures)).toBe(expected)
  })

  it('çok yüksek sayıda hata Infinity üretmiyor', () => {
    // 2 ** 400 === Infinity; Math.min(Infinity, max) doğru sonucu verir ama
    // ara değerin sonlu kalması, eğriyi başka yerde kullanınca sürpriz olmasın.
    expect(lockSecondsFor(LOGIN_EMAIL_POLICY, 500)).toBe(LOGIN_EMAIL_POLICY.maxLockSeconds)
    expect(Number.isFinite(lockSecondsFor(LOGIN_EMAIL_POLICY, 500))).toBe(true)
  })

  it('tavan var: saldırgan meşru kullanıcıyı kalıcı olarak kilitleyemez', () => {
    // Hesap kilitleme, bir hizmet reddi biçimidir. Sınırsız artan bir
    // kilit, saldırgana müşterinin deposunu kapatma imkanı verirdi.
    expect(lockSecondsFor(LOGIN_EMAIL_POLICY, 1000)).toBeLessThanOrEqual(15 * 60)
  })
})

describe('sayaç deposu', () => {
  it('artırma atomik: 20 eşzamanlı hata 20 sayılır', async () => {
    // Oku-artır-yaz olsaydı yarış yüzünden bir kısmı kaybolur ve sayaç
    // eşiğe hiç ulaşmazdı. Koruma sessizce çalışmaz hale gelirdi.
    const subject = 'atomik@test.local'
    await clearAttempts(app.db, 'LOGIN_EMAIL', subject)

    await Promise.all(
      Array.from({ length: 20 }, () =>
        recordFailure(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, T0),
      ),
    )

    const state = await readAttempts(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, T0)
    expect(state.failures).toBe(20)
  })

  it('pencere dolunca sayaç sıfırdan başlıyor', async () => {
    const subject = 'pencere@test.local'
    await clearAttempts(app.db, 'LOGIN_EMAIL', subject)

    await recordFailure(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, T0)
    await recordFailure(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, T0)

    const later = T0 + (LOGIN_EMAIL_POLICY.windowSeconds + 60) * 1000
    const after = await recordFailure(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, later)

    // Yılda beş kez parolasını yanlış yazan kullanıcı kalıcı cezalı olmamalı.
    expect(after.failures).toBe(1)
  })

  it('okuma pencere dışındaki kaydı sıfır sayar', async () => {
    const subject = 'eski@test.local'
    await clearAttempts(app.db, 'LOGIN_EMAIL', subject)
    await recordFailure(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, T0)

    const later = T0 + (LOGIN_EMAIL_POLICY.windowSeconds + 1) * 1000
    const state = await readAttempts(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, later)

    expect(state.failures).toBe(0)
    expect(state.lockedUntil).toBeUndefined()
  })

  it('temizleme sayacı siler', async () => {
    const subject = 'temiz@test.local'
    await recordFailure(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, T0)
    await clearAttempts(app.db, 'LOGIN_EMAIL', subject)

    expect(
      (await readAttempts(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, T0)).failures,
    ).toBe(0)
  })

  it('kapsamlar birbirinden bağımsız', async () => {
    // Aynı metin hem e-posta hem IP anahtarı olabilir; sayaçlar
    // karışırsa bir kullanıcının hatası başkasını kilitler.
    const subject = 'ayni-anahtar'
    await clearAttempts(app.db, 'LOGIN_EMAIL', subject)
    await clearAttempts(app.db, 'LOGIN_IP', subject)

    await recordFailure(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, T0)

    expect(
      (await readAttempts(app.db, 'LOGIN_IP', subject, LOGIN_IP_POLICY, T0)).failures,
    ).toBe(0)
  })

  it('eskimiş satırlar temizlenebiliyor (tablo sınırsız büyümesin)', async () => {
    const subject = 'budanacak@test.local'
    await recordFailure(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, T0)

    const muchLater = T0 + 30 * 24 * 60 * 60 * 1000
    const removed = await pruneAttempts(app.db, 24 * 60 * 60, muchLater)

    expect(removed).toBeGreaterThan(0)
    expect(
      (await readAttempts(app.db, 'LOGIN_EMAIL', subject, LOGIN_EMAIL_POLICY, T0)).failures,
    ).toBe(0)
  })
})

describe('login - hesap bazlı kilit', () => {
  it('ilk dört hata serbest, beşinci kilitliyor', async () => {
    // Eldivenli elle telefon kullanan çalışan parolayı yanlış yazar;
    // her hatada bir dakika beklemek onu sisteme düşman ederdi.
    const email = tenant.adminEmail
    await clearAttempts(app.db, 'LOGIN_EMAIL', email)

    const codes = await attemptBadLogins(email, 4, T0)
    expect(codes).toEqual(Array(4).fill('INVALID_CREDENTIALS'))

    // Beşinci deneme hem yanlış hem kilit başlangıcı: kullanıcı doğrudan
    // bekleme süresini görüyor.
    const err = await expectAppError(
      login({ email, password: 'kesinlikle-yanlis' }, { db: app.db, now: () => T0 }),
      'TOO_MANY_ATTEMPTS',
    )
    expect(err.http).toBe(429)
    expect(err.details.retryAfterSeconds).toBe(60)
  })

  it('kilitliyken DOĞRU parola da kabul edilmiyor', async () => {
    const email = tenant.adminEmail
    await expectAppError(
      login({ email, password: tenant.password }, { db: app.db, now: () => T0 + 1000 }),
      'TOO_MANY_ATTEMPTS',
    )
  })

  it('kilitliyken yapılan denemeler sayacı BÜYÜTMÜYOR', async () => {
    // Kilit ön kontrolü, sayaç artırılmadan önce fırlatıyor. Aksi halde
    // saldırgan hamle yapmaya devam ederek kilidi süresiz uzatır ve
    // meşru kullanıcıyı kalıcı olarak dışarıda tutardı — kilit, saldırı
    // aracına dönüşürdü. Ayrıca her deneme scrypt çalıştırmadığı için
    // kilitli hesap sunucuyu yormuyor.
    const email = tenant.adminEmail
    const before = await readAttempts(app.db, 'LOGIN_EMAIL', email, LOGIN_EMAIL_POLICY, T0)
    expect(before.failures).toBe(5)

    await attemptBadLogins(email, 3, T0 + 2000)

    const after = await readAttempts(app.db, 'LOGIN_EMAIL', email, LOGIN_EMAIL_POLICY, T0 + 2000)
    expect(after.failures).toBe(5)
  })

  it('kilit süresi dolunca giriş yeniden çalışıyor', async () => {
    const email = tenant.adminEmail
    const afterLock = T0 + 61 * 1000

    const res = await login(
      { email, password: tenant.password },
      { db: app.db, now: () => afterLock },
    )
    expect(res.user.userId).toBe(tenant.adminUserId)
  })

  it('başarılı giriş sayacı sıfırlıyor', async () => {
    const email = tenant.adminEmail
    const state = await readAttempts(app.db, 'LOGIN_EMAIL', email, LOGIN_EMAIL_POLICY, T0)

    expect(state.failures).toBe(0)
  })

  it('kilit üstel artıyor', async () => {
    const email = tenant.staffEmail
    await clearAttempts(app.db, 'LOGIN_EMAIL', email)

    // 5. hatada 60 sn kilit.
    await attemptBadLogins(email, 4, T0)
    const first = await expectAppError(
      login({ email, password: 'yanlis' }, { db: app.db, now: () => T0 }),
      'TOO_MANY_ATTEMPTS',
    )
    expect(first.details.retryAfterSeconds).toBe(60)

    // Kilit bittikten sonra bir hata daha → 6. hata → 120 sn.
    const t1 = T0 + 61 * 1000
    const second = await expectAppError(
      login({ email, password: 'yanlis' }, { db: app.db, now: () => t1 }),
      'TOO_MANY_ATTEMPTS',
    )
    expect(second.details.retryAfterSeconds).toBe(120)

    const t2 = t1 + 121 * 1000
    const third = await expectAppError(
      login({ email, password: 'yanlis' }, { db: app.db, now: () => t2 }),
      'TOO_MANY_ATTEMPTS',
    )
    expect(third.details.retryAfterSeconds).toBe(240)
  })

  it('sayaç e-posta başına: bir hesabın kilidi diğerini etkilemiyor', async () => {
    const other = await seedTestTenant(admin.db, 'rl-other', [{ sku: 'X', name: 'X' }])
    await clearAttempts(app.db, 'LOGIN_EMAIL', other.adminEmail)

    await expect(
      login({ email: other.adminEmail, password: other.password }, { db: app.db, now: () => T0 }),
    ).resolves.toBeTruthy()
  })
})

describe('login - kullanıcı sayımı sızmıyor', () => {
  it('KAYITLI OLMAYAN e-posta da kilitleniyor', async () => {
    // Bu testin tamamı S9 ile S7'nin kesişimi hakkında: sadece var olan
    // hesaplar kilitlenseydi, "kilitlendim" cevabı hesabın varlığını ele
    // verirdi ve tek hata kodu (INVALID_CREDENTIALS) kullanma çabamız
    // anlamsız olurdu.
    const ghost = 'hic-kayitli-degil@yok.test'
    await clearAttempts(app.db, 'LOGIN_EMAIL', ghost)

    const codes = await attemptBadLogins(ghost, 4, T0)
    expect(codes).toEqual(Array(4).fill('INVALID_CREDENTIALS'))

    const err = await expectAppError(
      login({ email: ghost, password: 'x' }, { db: app.db, now: () => T0 }),
      'TOO_MANY_ATTEMPTS',
    )
    expect(err.details.retryAfterSeconds).toBe(60)
  })

  it('var olan ve olmayan hesap aynı eşikte kilitleniyor', async () => {
    const ghost = 'ikinci-hayalet@yok.test'
    const real = tenant.adminEmail
    await clearAttempts(app.db, 'LOGIN_EMAIL', ghost)
    await clearAttempts(app.db, 'LOGIN_EMAIL', real)

    const t = T0 + 10_000
    const ghostCodes = await attemptBadLogins(ghost, 5, t)
    const realCodes = await attemptBadLogins(real, 5, t)

    expect(ghostCodes).toEqual(realCodes)
  })
})

describe('login - adres bazlı kilit', () => {
  it('tek adresten çok sayıda hesaba deneme kesiliyor', async () => {
    const ip = '203.0.113.77'
    await clearAttempts(app.db, 'LOGIN_IP', ip)

    // Eşiğe kadar farklı hesaplara dene: hesap sayaçları eşiği görmez
    // ama adres sayacı görür.
    for (let i = 0; i < LOGIN_IP_POLICY.threshold - 1; i++) {
      await login(
        { email: `kurban-${i}@yok.test`, password: 'x' },
        { db: app.db, now: () => T0, clientIp: ip },
      ).catch(() => {})
    }

    const err = await expectAppError(
      login(
        { email: 'kurban-son@yok.test', password: 'x' },
        { db: app.db, now: () => T0, clientIp: ip },
      ),
      'TOO_MANY_ATTEMPTS',
    )
    expect(err.details.scope).toBe('LOGIN_IP')
  })

  it('adres eşiği hesap eşiğinden yüksek (paylaşılan NAT)', () => {
    // Depodaki bütün telefonlar tek IP'den çıkıyor ve vardiya başında
    // on kişi aynı anda giriyor. Düşük eşik saldırganı değil müşteriyi
    // engellerdi.
    expect(LOGIN_IP_POLICY.threshold).toBeGreaterThan(LOGIN_EMAIL_POLICY.threshold * 5)
  })

  it('adres verilmezse sayaç yazılmıyor, giriş çalışıyor', async () => {
    // Cron ve sunucu içi çağrılarda IP yok; bu yolun kapanmaması gerek.
    const fresh = await seedTestTenant(admin.db, 'rl-noip', [{ sku: 'N', name: 'N' }])
    await expect(
      login({ email: fresh.adminEmail, password: fresh.password }, { db: app.db, now: () => T0 }),
    ).resolves.toBeTruthy()
  })
})

describe('sayaca uygulama rolü doğrudan dokunamıyor', () => {
  it('tabloyu okuyamaz', async () => {
    // Okuyabilseydi bütün müşterilerin e-postaları tek sorguda dökülürdü.
    const err = await app.db.execute(sql`SELECT * FROM auth_attempts`).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeDefined()
  })

  it('sayacı silerek kilidi kaldıramaz', async () => {
    // Uygulama kodundaki bir hata korumayı devre dışı bırakamamalı.
    const err = await app.db.execute(sql`DELETE FROM auth_attempts`).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeDefined()
  })

  it('sahte sayaç satırı ekleyemez', async () => {
    const err = await app.db
      .execute(
        sql`INSERT INTO auth_attempts (scope, subject, failures, first_failure_at, last_failure_at)
            VALUES ('LOGIN_EMAIL', 'sahte@test.local', 0, now(), now())`,
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    expect(err).toBeDefined()
  })

  it('bilinmeyen kapsam adı reddediliyor', async () => {
    // Yazım hatası (`login_email`) her zaman sıfırdan başlayan bir sayaç
    // yaratır, yani korumayı sessizce kapatır. CHECK bunu yakalıyor.
    const err = await app.db
      .execute(sql`SELECT auth_record_failure('login_email', 'x', 3600, now())`)
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    expect(err).toBeDefined()
  })
})
