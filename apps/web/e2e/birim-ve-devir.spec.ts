import { type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * WS-B — BİRİM HASSASİYETİ (T130) VE İÇE AKTARMADA AÇILIŞ STOĞU (T128)
 *
 * Her test kendi sentetik ürününü içe aktarmayla yaratıyor: demo ürünlerinin
 * stoğu ve birimi başka testlerce değişebiliyor.
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

async function adresBekle(page: Page, parca: string) {
  await expect
    .poll(() => decodeURIComponent(page.url()), { message: `adres '${parca}' içermiyor`, timeout: 15_000 })
    .toContain(parca)
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

/** CSV'yi içe aktarma ekranından önizletir. */
async function onizle(page: Page, satirlar: string[]) {
  await page.goto('/urunler/aktar')
  await page.setInputFiles('input[type="file"]', {
    name: `devir-${ek()}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(satirlar.join('\n'), 'utf-8'),
  })
  await page.getByRole('button', { name: /oku ve önizle/i }).click()
  await expect(page.locator('section[aria-label="Önizleme"]')).toBeVisible()
}

async function aktar(page: Page) {
  await page.getByRole('button', { name: /satırı aktar/i }).click()
  const sonuc = page.locator('section[aria-label="Sonuç"]')
  await expect(sonuc, 'aktarım sonuç paneli gelmedi').toBeVisible()
  return sonuc
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('devirli CSV: önizleme devri ve okunmayan "Miktar" sütununu söylüyor, aktarım devri yazıyor', async ({
  page,
}) => {
  const n = ek()
  const barkod = `2${n}77`
  await girisYap(page)
  await onizle(page, [
    'Stok Kodu;Ürün Adı;Birim;Alış Fiyatı;Barkod;Açılış Stoğu;Miktar',
    `DVR-${n};Devir Ürünü ${n};Adet;4,50;${barkod};12;99`,
  ])

  const onizleme = page.locator('section[aria-label="Önizleme"]')
  await expect(onizleme).toContainText('"Miktar" sütunu açılış stoğu olarak okunmadı')
  await expect(onizleme).toContainText('Açılış stoğu: 1 üründe yazılacak')

  const sonuc = await aktar(page)
  await expect(sonuc).toContainText('Devir yazıldı1')

  // Devir mevcut hareket ekranında görünüyor: stok "Miktar" (99) değil, 12.
  await page.goto(`/hareket?barkod=${barkod}`)
  await expect(page.locator('main')).toContainText('Mevcut stok: 12 adet')
})

test('adetli ürüne 0,5 girilemiyor: sebep Türkçe, miktar korunuyor, stok değişmiyor', async ({
  page,
}) => {
  const n = ek()
  const barkod = `2${n}55`
  await girisYap(page)
  await onizle(page, [
    'Stok Kodu;Ürün Adı;Birim;Alış Fiyatı;Barkod;Açılış Stoğu',
    `ADT-${n};Adetli Ürün ${n};Adet;2;${barkod};10`,
  ])
  await aktar(page)

  await page.goto(`/hareket?barkod=${barkod}`)
  await hidrasyonBekle(page)
  await page.fill('input[name="miktar"]', '0,5')
  await page.check('input[name="sebep"][value="OTHER_IN"]')
  await page.getByRole('button', { name: 'Kaydet' }).click()

  await adresBekle(page, 'hata=INVALID_QUANTITY')
  await expect(page.locator('p[role="alert"]')).toContainText(
    'Bu ürün adetle sayılıyor; miktar tam sayı olmalı',
  )
  await expect(page.locator('input[name="miktar"]')).toHaveValue('0,5')
  await expect(page.locator('main')).toContainText('Mevcut stok: 10 adet')
})
