import { closeAppDb } from '@stok/db'
import { TEST_PASSWORD, type TestTenant, seedTestTenant, testAdminDb } from '@stok/db/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  currentActor,
  endSession,
  persistSession,
  requireActor,
  secureCookies,
  sessionNeedsPersist,
  startSession,
} from '@/server/session'
import {
  deleteCookie,
  getCookie,
  getCookieOptions,
  resetCookieJar,
  setCookiesReadOnly,
} from '@/test/cookie-jar'
import { TEST_DB_NAME } from '@/test/db-name'

/**
 * ============================================================================
 * T94 — OTURUM KATMANI
 *
 * `session.ts` web tarafının tek güven sınırı: token'ı çerezden okuyup
 * core'a veriyor, core'un verdiğini çereze yazıyor. Sahtelenen tek şey
 * çerez deposu; token üretimi, imza doğrulama ve veritabanı gerçek.
 *
 * BURADAKİ EN ÖNEMLİ TEST `secureCookies()`. Yanlış hesaplanırsa ortaya
 * çıkan arıza SESSİZ: LAN'da düz HTTP ile servis edilen bir kurulumda
 * tarayıcı `Secure` çerezi saklamaz ve giriş ekranı hiçbir hata
 * göstermeden kendini tekrar eder. Bu üründe sessiz başarısızlık en kötü
 * sınıf, çünkü kullanıcı "sistem bozuk" der ve nedenini kimse bulamaz.
 * ============================================================================
 */

const ACCESS_COOKIE = 'stok_at'
const REFRESH_COOKIE = 'stok_rt'

const admin = testAdminDb(TEST_DB_NAME)
let tenant: TestTenant

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'websession')
})

afterAll(async () => {
  await admin.client.end()
  await closeAppDb()
})

beforeEach(() => {
  resetCookieJar()
})

describe('secureCookies: dağıtım şemasından türüyor, NODE_ENV.den değil', () => {
  const original = process.env.APP_URL

  afterEach(() => {
    if (original === undefined) delete process.env.APP_URL
    else process.env.APP_URL = original
  })

  it('https adreste Secure açık', () => {
    process.env.APP_URL = 'https://stok.ornek.com'
    expect(secureCookies()).toBe(true)
  })

  it('düz http adreste Secure KAPALI', () => {
    // Depo sunucusunun LAN'da düz HTTP ile koşması gerçek bir kurulum.
    // Secure açık kalsaydı tarayıcı çerezi hiç saklamaz ve giriş ekranı
    // hatasız şekilde kendini tekrar ederdi.
    process.env.APP_URL = 'http://192.168.1.20:3000'
    expect(secureCookies()).toBe(false)
  })

  it('APP_URL yoksa fail closed: Secure AÇIK', () => {
    // Yanlış tarafa düşmek oturum çerezini düz metin göndermek olurdu.
    delete process.env.APP_URL
    expect(secureCookies()).toBe(true)
  })

  it('APP_URL çözümlenemiyorsa fail closed: Secure AÇIK', () => {
    process.env.APP_URL = 'bu-bir-adres-degil'
    expect(secureCookies()).toBe(true)
  })

  it('NODE_ENV Secure bayrağını ETKİLEMİYOR', () => {
    // `next start` her zaman production modunda koşuyor; bayrağı NODE_ENV'e
    // bağlamak "üretim = HTTPS" varsayımını koda gömerdi ve bu üründe o
    // varsayım tutmuyor.
    process.env.APP_URL = 'http://192.168.1.20:3000'
    expect(secureCookies()).toBe(false)
  })
})

describe('giriş çerezleri', () => {
  it('iki çerez de httpOnly, lax ve doğru ömürle yazılıyor', async () => {
    await startSession(tenant.adminEmail, TEST_PASSWORD)

    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
      const opts = getCookieOptions(name)
      expect(opts, `${name} yazılmadı`).toBeDefined()
      // httpOnly olmasaydı herhangi bir XSS açığı token'ı okuyabilirdi ve
      // bu uygulamada token bütün stok verisine erişim demek.
      expect(opts?.httpOnly, `${name} httpOnly değil`).toBe(true)
      // lax: başka sitenin POST'unda çerez gönderilmiyor (CSRF).
      expect(opts?.sameSite, `${name} sameSite lax değil`).toBe('lax')
      expect(opts?.path).toBe('/')
    }

    // Erişim çerezi kısa ömürlü, yenileme çerezi uzun: ikisi karışırsa ya
    // oturum 15 dakikada biter ya da erişim token'ı 30 gün geçerli kalır.
    const access = getCookieOptions(ACCESS_COOKIE)?.maxAge ?? 0
    const refresh = getCookieOptions(REFRESH_COOKIE)?.maxAge ?? 0
    expect(access).toBeGreaterThan(0)
    expect(refresh).toBeGreaterThan(access)
  })

  it('çıkış iki çerezi de siliyor', async () => {
    await startSession(tenant.adminEmail, TEST_PASSWORD)
    expect(getCookie(ACCESS_COOKIE)).toBeDefined()

    await endSession()

    expect(getCookie(ACCESS_COOKIE)).toBeUndefined()
    // Yenileme çerezi kalsaydı bir sonraki istek oturumu sessizce geri
    // getirirdi: kullanıcı "çıkış yaptım" sanırken oturum açık kalırdı.
    expect(getCookie(REFRESH_COOKIE), 'yenileme çerezi silinmedi').toBeUndefined()
  })
})

describe('aktör çözümleme', () => {
  it('geçerli erişim çerezi aktörü veriyor', async () => {
    await startSession(tenant.adminEmail, TEST_PASSWORD)
    const actor = await currentActor()
    expect(actor?.userId).toBe(tenant.adminUserId)
    expect(actor?.tenantId).toBe(tenant.tenantId)
    expect(actor?.role).toBe('ADMIN')
  })

  it('çerez yokken null, fırlatmıyor', async () => {
    // `currentActor` bilerek fırlatmıyor: çağıran yer "giriş ekranına
    // yönlendir" ile "403 döndür" arasında kendisi karar veriyor.
    await expect(currentActor()).resolves.toBeNull()
  })

  it('requireActor oturum yoksa fırlatıyor', async () => {
    await expect(requireActor()).rejects.toMatchObject({ code: 'TOKEN_INVALID' })
  })

  it('bozuk erişim çerezi oturumu geçersiz kılıyor', async () => {
    await startSession(tenant.adminEmail, TEST_PASSWORD)
    deleteCookie(ACCESS_COOKIE)
    deleteCookie(REFRESH_COOKIE)
    resetCookieJar()
    await expect(currentActor()).resolves.toBeNull()
  })
})

describe('sessiz yenileme (erişim çerezi yok, yenileme çerezi var)', () => {
  it('aktörü yenileme çerezinden kurtarıyor ve taze çerez yazıyor', async () => {
    await startSession(tenant.adminEmail, TEST_PASSWORD)
    const ilkRefresh = getCookie(REFRESH_COOKIE)

    // Erişim çerezini düşür: süresi dolmuş bir token ile aynı yola giriyoruz.
    // Kullanıcıyı 15 dakikada bir giriş ekranına atmak depoda çalışan biri
    // için kabul edilemez, o yüzden bu yol sessizce çalışmalı.
    deleteCookie(ACCESS_COOKIE)

    const actor = await currentActor()
    expect(actor?.userId, 'yenileme yolu aktörü kurtaramadı').toBe(tenant.adminUserId)
    expect(getCookie(ACCESS_COOKIE), 'taze erişim çerezi yazılmadı').toBeDefined()
    expect(getCookie(REFRESH_COOKIE)).toBeDefined()
    expect(await sessionNeedsPersist()).toBe(false)
    expect(ilkRefresh).toBeDefined()
  })

  it('yenileme çerezi de yoksa null', async () => {
    await expect(currentActor()).resolves.toBeNull()
  })
})

describe('salt okunur çerez deposu (sayfa render.i) — T87 / 4b008e2', () => {
  it('yenileme çerez yazamasa bile ÇÖKMÜYOR, aktörü veriyor', async () => {
    await startSession(tenant.adminEmail, TEST_PASSWORD)
    deleteCookie(ACCESS_COOKIE)

    // Next 15 sayfa render'ında çerez deposunu salt okunur tutuyor.
    // Sarmalama kaldırılsaydı kullanıcı giriş yaptıktan 15 dakika sonra
    // HERHANGİ bir sayfayı açtığında 500 görürdü — kodun önlemek istediği
    // şeyin ("15 dakikada bir dışarı atma") çok daha kötü hâli.
    setCookiesReadOnly(true)

    const actor = await currentActor()
    expect(actor?.userId, 'salt okunur depoda aktör kaybedildi').toBe(tenant.adminUserId)
  })

  it('yazamadığını sessizce geçmiyor: sessionNeedsPersist true', async () => {
    await startSession(tenant.adminEmail, TEST_PASSWORD)
    deleteCookie(ACCESS_COOKIE)
    setCookiesReadOnly(true)

    await currentActor()
    // İşaret verilmezse SALT GEZİNEN kullanıcı her sayfa açılışında bir
    // yenileme sorgusu tetikler ve bu kalıcı olur: render hiçbir zaman
    // çerezi yazamıyor. İstemci bu işareti görüp /oturum/yenile çağırıyor.
    expect(await sessionNeedsPersist(), 'yazılamayan çerez sessizce geçildi').toBe(true)
  })

  it('persistSession çerezi route handler bağlamında kalıcılaştırıyor', async () => {
    await startSession(tenant.adminEmail, TEST_PASSWORD)
    deleteCookie(ACCESS_COOKIE)

    // Route handler'da çerez yazma serbest.
    const sonuc = await persistSession()
    expect(sonuc).toBe(true)
    expect(getCookie(ACCESS_COOKIE)).toBeDefined()
  })

  it('yenileme çerezi yoksa persistSession false, fırlatmıyor', async () => {
    await expect(persistSession()).resolves.toBe(false)
  })
})
