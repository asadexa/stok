/**
 * Test için çerez kavanozu.
 *
 * `next/headers`'ın `cookies()` fonksiyonu bir istek bağlamı istiyor ve
 * vitest'te öyle bir bağlam yok. Sahtelenen TEK sınır bu: veritabanı,
 * `@stok/core`'daki yetki mantığı ve rota kodunun kendisi GERÇEK koşuyor.
 *
 * Neden daha fazlasını sahtelemiyoruz: `session.ts`'in işi zaten token'ı
 * çerezden okuyup core'a vermek. Core sahtelenirse geriye sınanacak bir şey
 * kalmaz ve test "sahtenin sahteyi çağırdığını" doğrulamış olur.
 */

export interface TestCookie {
  name: string
  value: string
}

const jar = new Map<string, string>()

/** Çerez yazımı engelli mi (sayfa render'ı sırasında Next böyle davranıyor). */
let readOnly = false

export function resetCookieJar(): void {
  jar.clear()
  readOnly = false
}

/**
 * Çerezleri salt okunur yap. Next.js sunucu bileşeni render'ında çerez
 * yazmak bir istisna fırlatıyor; `session.ts` bunu yakalayıp
 * `sessionNeedsPersist()` yolunu açıyor. O yolu test edebilmek için
 * aynı davranışı taklit edebilmemiz gerek.
 */
export function setCookiesReadOnly(value: boolean): void {
  readOnly = value
}

export function getCookie(name: string): string | undefined {
  return jar.get(name)
}

export function setCookie(name: string, value: string): void {
  jar.set(name, value)
}

export function cookieNames(): string[] {
  return [...jar.keys()]
}

/** `next/headers` → `cookies()` yerine geçen nesne. */
export function fakeCookieStore() {
  return {
    get(name: string): TestCookie | undefined {
      const value = jar.get(name)
      return value === undefined ? undefined : { name, value }
    },
    getAll(): TestCookie[] {
      return [...jar.entries()].map(([name, value]) => ({ name, value }))
    },
    has(name: string): boolean {
      return jar.has(name)
    },
    set(nameOrOptions: string | { name: string; value: string }, value?: string): void {
      if (readOnly) {
        throw new Error(
          'Cookies can only be modified in a Server Action or Route Handler (test taklidi)',
        )
      }
      if (typeof nameOrOptions === 'string') jar.set(nameOrOptions, value ?? '')
      else jar.set(nameOrOptions.name, nameOrOptions.value)
    },
    delete(nameOrOptions: string | { name: string }): void {
      if (readOnly) {
        throw new Error(
          'Cookies can only be modified in a Server Action or Route Handler (test taklidi)',
        )
      }
      jar.delete(typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions.name)
    },
  }
}
