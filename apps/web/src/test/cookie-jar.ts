/**
 * Test için çerez kavanozu.
 *
 * `next/headers`'ın `cookies()` fonksiyonu bir istek bağlamı istiyor ve
 * vitest'te öyle bir bağlam yok. Sahtelenen TEK sınır bu: veritabanı,
 * `@stok/core`'daki yetki ve token mantığı ve rota kodunun kendisi GERÇEK
 * koşuyor.
 *
 * Neden daha fazlasını sahtelemiyoruz: `session.ts`'in işi zaten token'ı
 * çerezden okuyup core'a vermek. Core sahtelenirse geriye sınanacak bir şey
 * kalmaz ve test "sahtenin sahteyi çağırdığını" doğrulamış olur.
 *
 * SEÇENEKLER DE SAKLANIYOR (`httpOnly`, `secure`, `sameSite`, `maxAge`).
 * Yalnızca değer saklansaydı, `Secure` bayrağının yanlış hesaplanması —
 * bu üründeki en sinsi arıza, LAN'da sessiz giriş başarısızlığı — test
 * edilemezdi.
 */

export interface TestCookie {
  name: string
  value: string
}

export interface TestCookieOptions {
  httpOnly?: boolean
  sameSite?: string
  secure?: boolean
  path?: string
  maxAge?: number
}

interface Entry {
  value: string
  options: TestCookieOptions
}

const jar = new Map<string, Entry>()

/** Çerez yazımı engelli mi (Next sayfa render'ında deposu salt okunur). */
let readOnly = false

export function resetCookieJar(): void {
  jar.clear()
  readOnly = false
}

/**
 * Çerezleri salt okunur yap.
 *
 * Next.js 15 sayfa render'ında çerez yazmayı yasaklıyor ve `set` fırlatıyor.
 * `session.ts` bunu yakalayıp `sessionNeedsPersist()` yolunu açıyor (T87).
 * O yolun gerçekten çalıştığını sınayabilmek için aynı davranışı taklit
 * edebilmemiz gerek — sarmalama kaldırılsaydı kullanıcı 15 dakika sonra
 * herhangi bir sayfada 500 görürdü (4b008e2'de bir kez yaşandı).
 */
export function setCookiesReadOnly(value: boolean): void {
  readOnly = value
}

export function getCookie(name: string): string | undefined {
  return jar.get(name)?.value
}

export function getCookieOptions(name: string): TestCookieOptions | undefined {
  return jar.get(name)?.options
}

export function setCookie(name: string, value: string): void {
  jar.set(name, { value, options: {} })
}

export function deleteCookie(name: string): void {
  jar.delete(name)
}

export function cookieNames(): string[] {
  return [...jar.keys()]
}

/** `next/headers` → `cookies()` yerine geçen nesne. */
export function fakeCookieStore() {
  const guard = () => {
    if (readOnly) {
      // Next'in gerçek mesajını taklit ediyoruz: `session.ts` mesaja değil
      // istisnanın varlığına bakıyor, ama hata ayıklarken tanıdık olsun.
      throw new Error('Cookies can only be modified in a Server Action or Route Handler')
    }
  }

  return {
    get(name: string): TestCookie | undefined {
      const entry = jar.get(name)
      return entry === undefined ? undefined : { name, value: entry.value }
    },
    getAll(): TestCookie[] {
      return [...jar.entries()].map(([name, e]) => ({ name, value: e.value }))
    },
    has(name: string): boolean {
      return jar.has(name)
    },
    set(
      nameOrOptions: string | ({ name: string; value: string } & TestCookieOptions),
      value?: string,
      options?: TestCookieOptions,
    ): void {
      guard()
      if (typeof nameOrOptions === 'string') {
        jar.set(nameOrOptions, { value: value ?? '', options: options ?? {} })
      } else {
        const { name, value: v, ...rest } = nameOrOptions
        jar.set(name, { value: v, options: rest })
      }
    },
    delete(nameOrOptions: string | { name: string }): void {
      guard()
      jar.delete(typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions.name)
    },
  }
}
