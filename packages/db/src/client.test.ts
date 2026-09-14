import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appPoolOptions } from './client'

/**
 * ============================================================================
 * T117 — HAVUZ AYARLARI
 *
 * Havuzun GERÇEKTEN o boyutta açıldığı burada sınanmıyor: postgres.js'in
 * iç durumunu okumak, kütüphanenin özel alanlarına bağımlı bir test
 * üretirdi ve sürüm yükseltmesinde sessizce anlamsızlaşırdı. Sınanan şey
 * bizim kararımız — hangi değişken okunuyor, varsayılan ne, bozuk değerde
 * ne oluyor.
 * ============================================================================
 */
describe('appPoolOptions (T117)', () => {
  let onceki: Record<string, string | undefined>

  beforeEach(() => {
    onceki = { DB_POOL_MAX: process.env.DB_POOL_MAX, DB_IDLE_TIMEOUT: process.env.DB_IDLE_TIMEOUT }
    delete process.env.DB_POOL_MAX
    delete process.env.DB_IDLE_TIMEOUT
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(onceki)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('varsayılanlar BUGÜNKÜYLE AYNI kalıyor', () => {
    // Bu test bir davranışı değil bir SÖZÜ koruyor: yerel geliştirme ve
    // demo yolu değişmeyecekti. Varsayılan sessizce küçültülürse tek
    // süreçli demo yavaşlar ve sebebi hiçbir yerde yazmaz.
    expect(appPoolOptions()).toEqual({ max: 10, idleTimeout: 0 })
  })

  it('ortamdan okunuyor', () => {
    process.env.DB_POOL_MAX = '3'
    process.env.DB_IDLE_TIMEOUT = '20'

    expect(appPoolOptions()).toEqual({ max: 3, idleTimeout: 20 })
  })

  it('boş dize varsayılana düşüyor', () => {
    // Vercel'de tanımlanıp boş bırakılan değişken boş dize olarak geliyor.
    // "Tanımlı" sayılıp Number('') === 0 ile havuzu sıfırlamak, hiç
    // bağlantı açamayan bir uygulama üretirdi.
    process.env.DB_POOL_MAX = ''

    expect(appPoolOptions().max).toBe(10)
  })

  it.each([
    ['sayı değil', 'bir'],
    ['ondalık', '2.5'],
    ['negatif', '-1'],
  ])('BOZUK değer sessizce yok sayılmıyor — %s', (_ad, deger) => {
    process.env.DB_POOL_MAX = deger

    // ASIL KONTROL: varsayılana düşen bir okuma bu testlerin hepsinden
    // geçerdi ama üretim on bağlantıyla koşar, operatör ayarı yaptığını
    // sanır ve "neden hâlâ too many connections" sorusunun cevabı hiçbir
    // yerde olmazdı.
    expect(() => appPoolOptions()).toThrow(/DB_POOL_MAX/)
  })
})
