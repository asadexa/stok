import 'server-only'
import { AppError } from '@stok/shared'
import { type Actor, TOKEN_TTL, actorFromAccessToken, login, refreshSession } from '@stok/core'
import { appDb } from '@stok/db'
import { cookies } from 'next/headers'
import { cache } from 'react'

/**
 * ============================================================================
 * OTURUM — WEB TARAFI
 *
 * Token'lar `httpOnly` çerezde. localStorage DEĞİL: oradaki bir token'ı
 * herhangi bir XSS açığı okuyabilir ve bu uygulamada token, bütün stok
 * verisine erişim demek. `httpOnly` çerezi JavaScript okuyamaz.
 *
 * İki çerez, iki farklı ömür:
 *
 *   stok_at   15 dk   her istekte imzadan doğrulanıyor
 *   stok_rt   30 gün  sadece yenileme yolunda, veritabanına gidiyor
 *
 * `sameSite: 'lax'`: CSRF'e karşı ilk savunma. Yazma işlemleri POST ve
 * lax çerez başka sitenin POST'unda GÖNDERİLMİYOR.
 *
 * Mobil istemci bu katmanı kullanmıyor; o `Authorization: Bearer` ile
 * geliyor (packages/core/src/auth.ts `bearerToken`). İki taşıma yolu var
 * ama tek doğrulama var — ikisi de aynı `actorFromAccessToken`'a düşüyor.
 * ============================================================================
 */

const ACCESS_COOKIE = 'stok_at'
const REFRESH_COOKIE = 'stok_rt'

interface Session {
  actor: Actor | null
  /**
   * Taze çerez yazılabildi mi. Render sırasında `false` olabilir:
   * Next.js 15 sayfa render'ında çerez deposunu salt okunur tutuyor.
   */
  persisted: boolean
}

interface CookieOptions {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
  path: string
  maxAge: number
}

/**
 * Çerez `secure` bayrağı UYGULAMANIN ADRESİNDEN türüyor, `NODE_ENV`'den
 * değil.
 *
 * `NODE_ENV` bir DERLEME modu, dağıtım şeması değil. `next start` her
 * zaman production modunda çalışır — yani bayrağı `NODE_ENV`'e bağlamak
 * "üretim = HTTPS" varsayımını kodun içine gömer.
 *
 * O varsayım bu üründe tutmuyor: depo sunucusunun LAN'da düz HTTP ile
 * (`http://192.168.1.20:3000`) koşması gayet olası bir kurulum. Orada
 * tarayıcı `Secure` çerezi SAKLAMAZ bile ve giriş ekranı hiçbir hata
 * göstermeden kendini tekrar eder — teşhis edilmesi en zor arıza türü.
 * (`localhost` istisna: tarayıcılar onu güvenilir sayar, o yüzden
 * yerelde sorun görünmüyordu.)
 *
 * `APP_URL` uygulamanın gerçekten hangi şemayla servis edildiğini
 * söylüyor; bayrağı oradan almak dağıtımla tutarlı davranış veriyor.
 *
 * FAIL CLOSED: `APP_URL` yoksa veya çözümlenemiyorsa `Secure` AÇIK
 * kalıyor. Yanlış tarafa düşmek, oturum çerezini düz metin göndermek
 * demek olurdu.
 */
export function secureCookies(): boolean {
  const url = process.env.APP_URL
  if (!url) return true
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return true
  }
}

function cookieOptions(maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(),
    path: '/',
    maxAge,
  }
}

export async function startSession(email: string, password: string, clientIp?: string) {
  const result = await login({ email, password }, { db: appDb(), clientIp })
  const jar = await cookies()

  jar.set(ACCESS_COOKIE, result.tokens.accessToken, cookieOptions(TOKEN_TTL.accessSeconds))
  jar.set(REFRESH_COOKIE, result.tokens.refreshToken, cookieOptions(TOKEN_TTL.refreshSeconds))

  return result.user
}

export async function endSession(): Promise<void> {
  const jar = await cookies()
  jar.delete(ACCESS_COOKIE)
  jar.delete(REFRESH_COOKIE)
}

/**
 * İsteğin sahibini çözer. Access token süresi dolmuşsa refresh ile SESSİZCE
 * yeniliyor: kullanıcıyı on beş dakikada bir giriş ekranına atmak, depoda
 * çalışan biri için kabul edilemez.
 *
 * `null` dönüyor, fırlatmıyor: çağıran yer "giriş ekranına yönlendir" ile
 * "403 döndür" arasında kendisi karar versin.
 *
 * `cache()` İLE SARMALI VE BU ZORUNLU. Kabuk artık düzende (layout), sayfa
 * ise kendi sorgusu için aktörü yine istiyor: tek istekte iki çağrı oluyor.
 * Sarmalanmasaydı access token'ın süresi dolduğu istekte yenileme İKİ KEZ
 * çalışır, refresh token iki kez döndürülürdü. `cache()` istek başına tek
 * çalıştırma garantisi veriyor; yan etkisi (çerez yazma) de bir kez oluyor.
 */
const resolveSession = cache(async function resolveSession(): Promise<Session> {
  const jar = await cookies()
  const access = jar.get(ACCESS_COOKIE)?.value

  if (access) {
    const actor = await actorFromAccessToken(access).catch((err: unknown) => {
      // Süresi dolmuşsa aşağıda yenileyeceğiz; başka her hata oturumu
      // geçersiz kılıyor.
      if (err instanceof AppError && err.code === 'TOKEN_EXPIRED') return null
      return null
    })
    if (actor) return { actor, persisted: true }
  }

  const refresh = jar.get(REFRESH_COOKIE)?.value
  if (!refresh) return { actor: null, persisted: true }

  const renewed = await refreshSession({ refreshToken: refresh }, { db: appDb() }).catch(
    () => null,
  )
  if (!renewed) return { actor: null, persisted: true }

  // ÇEREZ YAZMA RENDER SIRASINDA BAŞARISIZ OLABİLİR VE BU NORMALDİR.
  //
  // Next.js 15 çerez değiştirmeye yalnızca Server Action ve Route Handler
  // içinde izin veriyor; bir sayfa render edilirken çerez deposu SALT
  // OKUNUR ve `set` fırlatıyor.
  //
  // Sarmalanmasaydı ne olurdu: access token'ın ömrü 15 dakika. Kullanıcı
  // giriş yaptıktan 15 dakika sonra HERHANGİ bir sayfayı açtığında bu satır
  // fırlatır ve ekranda 500 hatası görürdü. Yani kodun tam olarak önlemek
  // istediği şey ("kullanıcıyı 15 dakikada bir dışarı atma") çok daha kötü
  // bir biçimde gerçekleşirdi: dışarı atılmak yerine çökme.
  //
  // YUTMAK NEDEN GÜVENLİ: `refreshSession` yenileme token'ını DÖNDÜRMÜYOR
  // (auth.ts) — imzayı ve `tokenVersion`'ı doğrulayıp yeni token üretiyor,
  // eldeki yenileme token'ı kendi süresi dolana (30 gün) veya oturum iptal
  // edilene kadar geçerli kalıyor. Yani yazamamak bir şey kaybettirmiyor:
  // istek kendi taze token'ıyla tamamlanıyor, çerez ise bir sonraki sunucu
  // eyleminde (form gönderimi, çıkış) veya route handler'da tazeleniyor.
  //
  // BEDELİ: çerez tazelenene kadar her render bir yenileme sorgusu yapıyor.
  // Kalıcı çözüm yenilemeyi render'dan çıkarmak (T87).
  let persisted = true
  try {
    jar.set(ACCESS_COOKIE, renewed.tokens.accessToken, cookieOptions(TOKEN_TTL.accessSeconds))
    jar.set(REFRESH_COOKIE, renewed.tokens.refreshToken, cookieOptions(TOKEN_TTL.refreshSeconds))
  } catch {
    // Salt okunur çerez deposu (render). İstek yine de tamamlanıyor; taze
    // çerezi istemci `/oturum/yenile` üzerinden yazdıracak (T87).
    persisted = false
  }

  return {
    actor: {
      tenantId: renewed.user.tenantId,
      userId: renewed.user.userId,
      role: renewed.user.role,
    },
    persisted,
  }
})

/**
 * İsteğin sahibini çözer. `null` dönüyor, fırlatmıyor: çağıran yer
 * "giriş ekranına yönlendir" ile "403 döndür" arasında kendisi karar versin.
 */
export async function currentActor(): Promise<Actor | null> {
  return (await resolveSession()).actor
}

/**
 * Bu istekte oturum yenilendi ama taze çerez YAZILAMADI mı?
 *
 * `true` ise sayfa render sırasında yenileme yaptı ve çerez salt okunurdu.
 * Kabuk bunu görünce istemciye küçük bir işaret basıyor; istemci de
 * `POST /oturum/yenile` ile çerezi kalıcılaştırıyor (T87).
 *
 * Yapılmasaydı ne olurdu: access çerezi süresi dolmuş hâlde kalır ve SALT
 * GEZİNEN bir kullanıcı (form göndermeyen) her sayfa açılışında bir yenileme
 * sorgusu tetiklerdi — kalıcı olarak, çünkü render hiçbir zaman çerezi
 * yazamıyor. Sunucu eylemi çalıştıran kullanıcıda sorun kendiliğinden
 * kapanıyordu; salt gezinende kapanmıyordu.
 */
export async function sessionNeedsPersist(): Promise<boolean> {
  const { actor, persisted } = await resolveSession()
  return actor !== null && !persisted
}

/**
 * Taze token'ları çereze yazar. YALNIZCA route handler'dan çağrılır —
 * çerez yazma orada serbest.
 *
 * `currentActor()` zaten yenilemeyi yapıyor; buradaki iş sadece sonucu
 * kalıcılaştırmak. Ayrı bir yenileme daha yapmıyoruz çünkü `resolveSession`
 * `cache()` ile sarmalı ve aynı istekte ikinci kez çalışmıyor.
 */
export async function persistSession(): Promise<boolean> {
  const jar = await cookies()
  const refresh = jar.get(REFRESH_COOKIE)?.value
  if (!refresh) return false

  const renewed = await refreshSession({ refreshToken: refresh }, { db: appDb() }).catch(
    () => null,
  )
  if (!renewed) return false

  jar.set(ACCESS_COOKIE, renewed.tokens.accessToken, cookieOptions(TOKEN_TTL.accessSeconds))
  jar.set(REFRESH_COOKIE, renewed.tokens.refreshToken, cookieOptions(TOKEN_TTL.refreshSeconds))
  return true
}

/** Oturum yoksa fırlatır. Korumalı sayfa ve route'ların ilk satırı. */
export async function requireActor(): Promise<Actor> {
  const actor = await currentActor()
  if (!actor) throw new AppError('TOKEN_INVALID', 'no session')
  return actor
}
