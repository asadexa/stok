import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertServerConfig } from './config'

/**
 * ============================================================================
 * T116 — YAPILANDIRMA KONTROLÜ
 *
 * Bu testler kontrolün KENDİSİNİ sınıyor. Kontrolün üretimde koştuğunu
 * sınamıyorlar — o, `src/instrumentation.ts`'in varlığına bağlı ve orası
 * Next'in çağırdığı bir kanca; testte taklit edilse "taklidin taklidi
 * çağırdığı" doğrulanmış olurdu.
 *
 * "HEPSİ BİRDEN" TESTİ EN ÖNEMLİSİ: kontrol ilk eksikte fırlatsaydı her
 * test yine yeşil yanardı, ama kullanıcı birini düzeltip diğerini keşfetme
 * turuna girerdi. Yazılı karar buydu ve test onu koruyor.
 * ============================================================================
 */
describe('assertServerConfig (T116)', () => {
  let onceki: Record<string, string | undefined>

  beforeEach(() => {
    onceki = { DATABASE_URL: process.env.DATABASE_URL, AUTH_SECRET: process.env.AUTH_SECRET }
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(onceki)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('her şey yerindeyse fırlatmıyor', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5433/stok'
    process.env.AUTH_SECRET = 'a'.repeat(32)

    expect(() => assertServerConfig()).not.toThrow()
  })

  it('DATABASE_URL yoksa fırlatıyor ve adını söylüyor', () => {
    delete process.env.DATABASE_URL
    process.env.AUTH_SECRET = 'a'.repeat(32)

    expect(() => assertServerConfig()).toThrow(/DATABASE_URL tanımlı değil/)
  })

  /**
   * Üç biçim de GERÇEK hata: ikisi ölçülerek bulundu. `new URL()` tek
   * başına kontrol edildiğinde `localhost:5433/stok` ve `merhaba:dunya`
   * FIRLATMIYOR — `localhost:` geçerli bir şema sayılıyor. Yani kontrol
   * "bağlantı adresi mi" diye sorduğunu sanırken yalnızca iki nokta üst
   * üste arıyordu.
   */
  it.each([
    ['postgresql:// öneki unutulmuş', 'localhost:5433/stok'],
    ['şema hiç yok', 'stok'],
    ['yanlış şema (panelden kopyalanmış https)', 'https://abc.supabase.co'],
  ])('DATABASE_URL bağlantı adresi değilse fırlatıyor — %s', (_ad, deger) => {
    process.env.DATABASE_URL = deger
    process.env.AUTH_SECRET = 'a'.repeat(32)

    expect(() => assertServerConfig()).toThrow(/postgresql:\/\/ ile başlayan/)
  })

  it('AUTH_SECRET yoksa fırlatıyor', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5433/stok'
    delete process.env.AUTH_SECRET

    expect(() => assertServerConfig()).toThrow(/AUTH_SECRET tanımlı değil/)
  })

  it('AUTH_SECRET 32 karakterden kısaysa fırlatıyor ve KAÇ karakter olduğunu yazıyor', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5433/stok'
    process.env.AUTH_SECRET = 'a'.repeat(31)

    // Uzunluğun mesajda geçmesi önemli: "kısa" demek kullanıcıyı saymaya
    // gönderir, "31 karakter" düzeltmeyi tek adıma indirir.
    expect(() => assertServerConfig()).toThrow(/31 karakter/)
  })

  it('EKSİKLERİN HEPSİNİ birden listeliyor', () => {
    delete process.env.DATABASE_URL
    delete process.env.AUTH_SECRET

    let mesaj = ''
    try {
      assertServerConfig()
    } catch (err) {
      mesaj = err instanceof Error ? err.message : String(err)
    }

    // ASIL KONTROL: ilk eksikte fırlatan bir uygulama da diğer testlerin
    // hepsinden geçerdi. Kullanıcıyı düzelt-keşfet turuna sokmamak yazılı
    // bir karardı; koruyan tek şey bu satır.
    expect(mesaj).toMatch(/DATABASE_URL tanımlı değil/)
    expect(mesaj).toMatch(/AUTH_SECRET tanımlı değil/)
  })
})
