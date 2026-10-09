import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertServerConfig, phoneScannerEnabled } from './config'

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

  /**
   * T133 — DEPODA YAZAN SIRLAR ÜRETİMDE.
   *
   * Değerler kod içinde tekrar yazılmıyor, DOSYALARDAN okunuyor: biri
   * `.env.example`'daki ya da CI'daki örneği değiştirip config.ts'teki
   * listeyi güncellemeyi unutursa ilk iki vaka kırmızı yanar. Liste ile
   * dosyalar arasındaki senkronu tutan bu testin kendisi.
   */
  describe('üretimde depodaki örnek sırlar (T133)', () => {
    const kok = new URL('../../../../', import.meta.url)
    const oku = (yol: string) => readFileSync(fileURLToPath(new URL(yol, kok)), 'utf8')
    const ornekSir = /^AUTH_SECRET="?([^"\r\n]+)"?/m.exec(oku('.env.example'))?.[1] ?? ''
    const ciSir = /AUTH_SECRET:\s*([^\s#]+)/.exec(oku('.github/workflows/ci.yml'))?.[1] ?? ''

    beforeEach(() => {
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5433/stok'
    })

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it.each([
      ['.env.example', ornekSir],
      ['CI iş akışı', ciSir],
    ])('%s sırrıyla açılmıyor ve sırrı mesaja yazmıyor', (_kaynak, sir) => {
      expect(sir.length, 'örnek sır dosyadan okunamadı').toBeGreaterThanOrEqual(32)
      vi.stubEnv('NODE_ENV', 'production')
      process.env.AUTH_SECRET = sir

      let mesaj = ''
      try {
        assertServerConfig()
      } catch (err) {
        mesaj = err instanceof Error ? err.message : String(err)
      }

      expect(mesaj).toMatch(/AUTH_SECRET depoda açıkça yazan örnek/)
      // Mesaj log akışına gidiyor (instrumentation.ts); sır oraya düşmemeli.
      expect(mesaj).not.toContain(sir)
    })

    it('rastgele üretilmiş bir sırla açılıyor', () => {
      vi.stubEnv('NODE_ENV', 'production')
      process.env.AUTH_SECRET = randomBytes(32).toString('base64url')

      expect(() => assertServerConfig()).not.toThrow()
    })

    it('geliştirmede örnek sır çalışmaya devam ediyor', () => {
      vi.stubEnv('NODE_ENV', 'development')
      process.env.AUTH_SECRET = ornekSir

      expect(() => assertServerConfig()).not.toThrow()
    })
  })

  /**
   * WS-SCAN — `/tara` girişsiz açılıyor; bayrak yalnız açıkça `true` iken
   * açmalı. Yanlış yazım kapalı sayılsaydı operatör 404'ün sebebini
   * hiçbir yerde göremezdi.
   */
  describe('ENABLE_PHONE_SCANNER (WS-SCAN)', () => {
    beforeEach(() => {
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5433/stok'
      process.env.AUTH_SECRET = 'a'.repeat(32)
    })

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it.each([
      ['tanımsız', undefined, false],
      ['boş', '', false],
      ['false', 'false', false],
      ['true', 'true', true],
    ])('%s iken açık mı: %s → %s', (_ad, deger, beklenen) => {
      vi.stubEnv('ENABLE_PHONE_SCANNER', deger)

      expect(phoneScannerEnabled()).toBe(beklenen)
      expect(() => assertServerConfig()).not.toThrow()
    })

    it.each(['1', 'TRUE', 'evet'])('"%s" sayfayı açmıyor ve açılışı durduruyor', (deger) => {
      vi.stubEnv('ENABLE_PHONE_SCANNER', deger)

      expect(phoneScannerEnabled()).toBe(false)
      expect(() => assertServerConfig()).toThrow(/ENABLE_PHONE_SCANNER yalnız true ya da false/)
    })
  })
})
