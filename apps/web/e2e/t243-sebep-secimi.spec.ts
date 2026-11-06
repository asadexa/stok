import { type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T243 — HAREKET FORMUNDA VARSAYILAN SEBEP YOK
 *
 * Eskiden "Satın alma" hazır seçiliydi ve odak miktardaydı: miktar yazıp
 * Enter'a basan kullanıcı çıkışı giriş olarak kaydedebiliyordu. Sınanan:
 * okutulan üründe hiçbir sebep seçili değil; sebepsiz Enter ve Kaydet hareket
 * yazmıyor; hata dönüşünde seçilen sebep ve miktar korunuyor; başarılı
 * kayıttan sonra yeni okutmada sebep yine boş (PRD-24). Sunucu reddi core'da
 * (`movements.test.ts`, sebepsiz istek); Atanmamış Stok seçeneğinin yalnız
 * çıkışta görünmesi `t220-depo-hareket.spec.ts`'te.
 *
 * Deposuz Yılmaz işletmesinde, kendi ürünüyle: her ortamda koşar.
 * ============================================================================
 */

const YONETICI = { email: 'admin@yilmaz.example', parola: 'admin123' }
const ek = () => Date.now().toString().slice(-7)

async function girisYap(page: Page) {
  await page.goto('/giris')
  await page.fill('input[name="email"]', YONETICI.email)
  await page.fill('input[name="parola"]', YONETICI.parola)
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  await page.waitForURL('**/panel')
}

/** Sunucu eylemli form React'e bağlanmadan tıklanırsa hiçbir şey olmuyor (faz10-fiyat.spec.ts). */
async function hidrasyonBekle(page: Page) {
  await page.waitForFunction(
    () => {
      const form = document.querySelector('form[action]')
      return !!form && Object.keys(form).some((k) => k.startsWith('__reactFiber$'))
    },
    undefined,
    { timeout: 20_000 },
  )
}

async function formAc(page: Page, barkod: string) {
  await page.goto(`/hareket?barkod=${barkod}`)
  await expect(page.locator('input[name="miktar"]')).toBeVisible()
  await hidrasyonBekle(page)
}

const mevcut = (page: Page) => page.locator('main').getByText(/Mevcut stok:/)

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('sebep seçilmeden hareket yazılmıyor; hata dönüşü seçimi koruyor; yeni okutma boş açılıyor', async ({
  page,
}) => {
  const n = ek()
  const barkod = `2${n}43`
  await girisYap(page)

  // Kendi ürünü: 10 adet devirle.
  await page.goto('/urunler/aktar')
  await page.setInputFiles('input[type="file"]', {
    name: `t243-${n}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(
      ['Stok Kodu;Ürün Adı;Birim;Alış Fiyatı;Satış Fiyatı;Barkod;Açılış Stoğu', `SBP-${n};Sebep Ürünü ${n};Adet;4;6;${barkod};10`].join(
        '\n',
      ),
      'utf-8',
    ),
  })
  await page.getByRole('button', { name: /oku ve önizle/i }).click()
  await expect(page.locator('section[aria-label="Önizleme"]')).toBeVisible()
  await page.getByRole('button', { name: /satırı aktar/i }).click()
  await expect(page.locator('section[aria-label="Sonuç"]')).toBeVisible()

  // 1. Hiçbir sebep seçili değil.
  await formAc(page, barkod)
  await expect(mevcut(page)).toContainText('10 adet')
  await expect(page.locator('input[name="sebep"]:checked')).toHaveCount(0)

  // 2. Miktar + Enter ve Kaydet hareket yazmıyor: zorunlu sebep grubu boş.
  await page.fill('input[name="miktar"]', '3')
  await page.press('input[name="miktar"]', 'Enter')
  await page.getByRole('button', { name: 'Kaydet' }).click()
  expect(
    await page.locator('input[name="sebep"]').first().evaluate((el) => (el as HTMLInputElement).validity.valueMissing),
  ).toBe(true)
  await formAc(page, barkod)
  await expect(mevcut(page)).toContainText('10 adet')

  // 3. Hata dönüşünde seçilen sebep ve miktar korunuyor (stoktan fazla satış).
  await page.check('input[name="sebep"][value="SALE"]')
  await page.fill('input[name="miktar"]', '999')
  await page.getByRole('button', { name: 'Kaydet' }).click()
  // Önce adres, sonra form, şerit ve hidratasyon (faz10-fiyat.spec.ts
  // `hataBekle`): yumuşak gezinmede içerik adresten sonra oturuyor; erken
  // yazılan miktar dönüşün render'ıyla eski değere dönüyordu.
  await expect.poll(() => new URL(page.url()).searchParams.get('hata')).toBe('INSUFFICIENT_STOCK')
  await page.waitForSelector('input[name="miktar"]', { timeout: 20_000 })
  await expect(page.getByRole('alert').first()).toBeVisible()
  await hidrasyonBekle(page)
  await expect(page.locator('input[name="sebep"]:checked')).toHaveValue('SALE')
  await expect(page.locator('input[name="miktar"]')).toHaveValue('999')

  // 4. Seçilen sebeple doğru yönde yazılıyor: satış 10 → 7.
  const miktar = page.locator('input[name="miktar"]')
  await miktar.fill('3')
  await expect(miktar, 'miktar alanına yazılan değer tutmadı').toHaveValue('3')
  await page.getByRole('button', { name: 'Kaydet' }).click()
  await expect.poll(() => decodeURIComponent(page.url()), { timeout: 15_000 }).toContain('yeni=7')

  // 5. Başarılı kayıttan sonra sebep hatırlanmıyor (K1).
  await formAc(page, barkod)
  await expect(mevcut(page)).toContainText('7 adet')
  await expect(page.locator('input[name="sebep"]:checked')).toHaveCount(0)
})
