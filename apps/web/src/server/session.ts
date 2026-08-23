import 'server-only'
import { AppError } from '@stok/shared'
import { type Actor, TOKEN_TTL, actorFromAccessToken, login, refreshSession } from '@stok/core'
import { appDb } from '@stok/db'
import { cookies } from 'next/headers'

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
function secureCookies(): boolean {
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
 */
export async function currentActor(): Promise<Actor | null> {
  const jar = await cookies()
  const access = jar.get(ACCESS_COOKIE)?.value

  if (access) {
    const actor = await actorFromAccessToken(access).catch((err: unknown) => {
      // Süresi dolmuşsa aşağıda yenileyeceğiz; başka her hata oturumu
      // geçersiz kılıyor.
      if (err instanceof AppError && err.code === 'TOKEN_EXPIRED') return null
      return null
    })
    if (actor) return actor
  }

  const refresh = jar.get(REFRESH_COOKIE)?.value
  if (!refresh) return null

  const renewed = await refreshSession({ refreshToken: refresh }, { db: appDb() }).catch(
    () => null,
  )
  if (!renewed) return null

  jar.set(ACCESS_COOKIE, renewed.tokens.accessToken, cookieOptions(TOKEN_TTL.accessSeconds))
  jar.set(REFRESH_COOKIE, renewed.tokens.refreshToken, cookieOptions(TOKEN_TTL.refreshSeconds))

  return {
    tenantId: renewed.user.tenantId,
    userId: renewed.user.userId,
    role: renewed.user.role,
  }
}

/** Oturum yoksa fırlatır. Korumalı sayfa ve route'ların ilk satırı. */
export async function requireActor(): Promise<Actor> {
  const actor = await currentActor()
  if (!actor) throw new AppError('TOKEN_INVALID', 'no session')
  return actor
}
