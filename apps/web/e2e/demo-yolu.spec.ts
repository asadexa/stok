import { expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T93 — KURULUMDAN GİRİŞE GİDEN YOL
 *
 * NEDEN BU DOSYA VAR. CI bugüne kadar kullanıcıya görünen tek bir hata
 * yakalamadı. T57, T58, T59 ve T61 — dördü de P1, dördü de kullanıcı
 * testinde çıktı, dördü de CI yeşilken vardı. Ortak noktaları tek yerde
 * toplanıyor: hepsi temiz checkout'tan çalışan uygulamaya giden yolda.
 * CI o yolu hiç yürümüyordu; `pnpm install` ile başlayıp `next build` ile
 * bitiyordu.
 *
 * Bu dosya o yolun SON adımını yürüyor. İlk adımları (`pnpm demo --seed
 * --no-server`) iş akışı çalıştırıyor; buraya gelindiğinde veritabanı
 * kurulmuş, migration'lar uygulanmış ve örnek veri yüklenmiş olmalı.
 *
 * KAPSAM DAR TUTULDU. Ekran ekran gezmek T92'nin işi. Burada üç soru var:
 *   1. Uygulama gerçekten açılıyor ve giriş çalışıyor mu   (T58, T61)
 *   2. Panel veritabanından okuyabiliyor mu                (T59)
 *   3. Yetki sınırı sunucuda gerçekten duruyor mu          (S6, S7)
 *
 * Yanlış parola / kilitleme senaryoları BİLEREK YOK: onlar T94'ün rota ve
 * oturum testlerine ait, ve burada koşarlarsa oran sınırı sayaçlarını
 * kirletip sonraki testleri kırılgan yaparlar.
 * ============================================================================
 */

/** `pnpm demo` çıktısında basılan demo hesapları. Seed bunları kuruyor. */
const YONETICI = { email: 'admin@yilmaz.example', parola: 'admin123' }
const CALISAN = { email: 'ahmet@yilmazkirtasiye.example', parola: 'calisan123' }

async function girisYap(
  page: import('@playwright/test').Page,
  hesap: { email: string; parola: string },
) {
  await page.goto('/giris')
  await page.fill('input[name="email"]', hesap.email)
  await page.fill('input[name="parola"]', hesap.parola)
  await page.click('button[type="submit"]')
  await page.waitForURL('**/panel')
}

test.describe('demo yolu', () => {
  // Sunucu kusurlarını yüzeye çıkar. T61'in dersi: teşhis kimseye
  // ulaşmazsa hatanın kendisinden pahalıya mal oluyor.
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
    })
  })

  test('giriş sayfası açılıyor', async ({ page }) => {
    const res = await page.goto('/giris')
    // 200 şart: T58'de bu adım GEÇİYORDU, o yüzden tek başına yeterli değil
    // ama bozulursa sonraki her şey anlamsız olur.
    expect(res?.status(), 'GET /giris 200 dönmeli').toBe(200)
    await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible()
  })

  test('oturumsuz kullanıcı panele giremiyor', async ({ page }) => {
    await page.goto('/panel')
    // Koruma sunucuda: `currentActor()` yoksa `/giris`e yönlendiriliyor.
    await expect(page).toHaveURL(/\/giris/)
  })

  test('yönetici giriş yapıyor ve panel veritabanından okuyor', async ({ page }) => {
    await girisYap(page, YONETICI)

    const ozet = page.getByRole('region', { name: 'Özet' })
    await expect(ozet).toBeVisible()
    await expect(ozet.getByText('Toplam ürün')).toBeVisible()

    // ASIL SORU: sayı gerçekten veritabanından mı geldi? Kartlar render
    // olup hepsi sıfır gösterse uygulama "çalışıyor" görünür ama veri
    // yolu kopuk olurdu. Seed 240 ürün yüklüyor; sıfırdan büyük olmalı.
    const rakamlar = [...(await ozet.innerText()).matchAll(/\d[\d.]*/g)].map((m) =>
      Number(m[0].replace(/\./g, '')),
    )
    expect(Math.max(0, ...rakamlar), 'özet kartlarında veritabanından gelen sayı yok').toBeGreaterThan(0)

    await expect(page.getByText('Son hareketler')).toBeVisible()
  })

  test('çalışan stok değerini göremiyor', async ({ page }) => {
    // Tehdit S7'nin uçtan uca kanıtı. `price:read` yetkisi core'da
    // kesiliyor: yetkisi olmayana `summary.stockValue` HİÇ gelmiyor, kart
    // da render edilmiyor. Bu testin değeri, matrisin kendisini değil
    // ROTANIN MATRİSİ ÇAĞIRDIĞINI doğrulaması.
    await girisYap(page, CALISAN)

    await expect(page.getByRole('region', { name: 'Özet' })).toBeVisible()
    await expect(page.getByText('Stoktaki değer')).toHaveCount(0)
  })
})
