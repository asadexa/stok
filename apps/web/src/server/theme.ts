import 'server-only'
import { cookies } from 'next/headers'
import { secureCookies } from './session'

/**
 * ============================================================================
 * KULLANICI TERCİHLERİ — TEMA (T65) ve SES (T81)
 *
 * İkisi de çerezde ve aynı gerekçeyle: sunucu okuyup ilk baytta doğru
 * davranıyor. Tek dosyada duruyorlar çünkü ikisi de aynı şey — oturumdan
 * bağımsız, tarayıcıya bağlı, gizli olmayan tercihler.
 *
 * Tercih ÇEREZDE, `localStorage`'da değil. Sebep tek kelimeyle: yanıp sönme.
 *
 * `localStorage` istemci tarafında ve sunucu onu göremiyor. Sunucu açık
 * temayla render eder, sonra tarayıcı JavaScript'i çalışır ve koyuya
 * çevirir. Aradaki birkaç yüz milisaniye, koyu temayı seçmiş kullanıcının
 * her sayfa geçişinde yüzüne beyaz ekran patlaması demek. Depoda gece
 * vardiyası var; bu küçük bir rahatsızlık değil.
 *
 * Çerez sunucuda okunuyor ve `<html data-theme>` ilk baytta doğru geliyor.
 * Ara durum yok, telafi eden bir script yok.
 *
 * `httpOnly: false`: istemci tarafı bir tema anahtarı ileride bunu
 * JavaScript'ten okumak isteyebilir. Tercih gizli bir bilgi değil, oturum
 * çerezinin aksine korunacak bir şeyi yok.
 *
 * `secure` bayrağı oturum çerezinin mantığını PAYLAŞIYOR (`secureCookies`).
 * Ayrı yazılsaydı biri değişip diğeri unutulurdu ve tema tercihi LAN
 * kurulumunda sessizce kaydedilmez hale gelirdi — teşhisi zor bir arıza.
 * ============================================================================
 */

const THEME_COOKIE = 'stok_tema'

/** Bir yıl: tercih kalıcı sayılıyor, oturumdan bağımsız. */
const THEME_MAX_AGE = 60 * 60 * 24 * 365

export type Theme = 'light' | 'dark'

/**
 * `null` = kullanıcı seçim yapmamış. Bu, "açık" ile AYNI ŞEY DEĞİL:
 * seçim yoksa `data-theme` hiç basılmıyor ve karar işletim sisteminin
 * `prefers-color-scheme` ayarına kalıyor.
 */
export async function readTheme(): Promise<Theme | null> {
  const value = (await cookies()).get(THEME_COOKIE)?.value
  return value === 'light' || value === 'dark' ? value : null
}

export async function writeTheme(theme: Theme | null): Promise<void> {
  const jar = await cookies()

  // null = "sistemi takip et". Çereze 'system' yazmak yerine SİLİYORUZ:
  // yokluk zaten sistemi takip etmek demek ve tek bir durumu iki farklı
  // şekilde temsil etmek, ileride ikisinin ayrışmasına davetiye çıkarır.
  if (theme === null) {
    jar.delete(THEME_COOKIE)
    return
  }

  jar.set(THEME_COOKIE, theme, {
    httpOnly: false,
    sameSite: 'lax',
    secure: secureCookies(),
    path: '/',
    maxAge: THEME_MAX_AGE,
  })
}

/**
 * ============================================================================
 * SES VE TİTREŞİM TERCİHİ — T81
 *
 * Varsayılan AÇIK. PLAN.md E4: "çalışan ekrana bakmaz, dinler; hız iki katına
 * çıkar". Varsayılanı kapalı yapmak, özelliği ayarlara girip açan azınlığa
 * indirmek olurdu.
 *
 * Çerezde SADECE "kapalı" durumu saklanıyor. Açık olan varsayılan ve varsayılanı
 * çereze yazmak, tek durumu iki şekilde temsil etmek olurdu (tema tercihindeki
 * 'system' ile aynı gerekçe).
 * ============================================================================
 */

const SOUND_COOKIE = 'stok_ses'
const SOUND_MAX_AGE = 60 * 60 * 24 * 365

export async function readSoundEnabled(): Promise<boolean> {
  // Yalnızca açık bir "kapalı" işareti sesi kapatıyor; çerez yoksa açık.
  return (await cookies()).get(SOUND_COOKIE)?.value !== 'kapali'
}

export async function writeSoundEnabled(enabled: boolean): Promise<void> {
  const jar = await cookies()

  if (enabled) {
    jar.delete(SOUND_COOKIE)
    return
  }

  jar.set(SOUND_COOKIE, 'kapali', {
    httpOnly: false,
    sameSite: 'lax',
    secure: secureCookies(),
    path: '/',
    maxAge: SOUND_MAX_AGE,
  })
}
