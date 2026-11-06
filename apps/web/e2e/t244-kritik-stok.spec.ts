import { type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T244 — KRİTİK STOK, "STOK YOK" VE ÇALIŞANIN EŞİK FORMU (PRD-25)
 *
 * Sınanan, tarayıcıda:
 *   1. Yeni ürün formu eşiği 3 ile açıyor; kaydedilen ürünün eşiği 3.
 *   2. Stoğu 0 olan ürün "Sadece stok yok" süzgecinde "Stok yok" rozetiyle,
 *      "Sadece kritik" süzgecinde YOK; panelde "Stok yok" kartı var.
 *   3. 2 adet girilince (eşik 3) ürün kritik süzgecine geçiyor.
 *   4. Çalışan ürün sayfasında yalnız eşik formunu görüyor (tam ürün formu ve
 *      fiyat yok); eşiği 1 yapınca ürün kritik olmaktan çıkıyor.
 *
 * Kuralın bütün yüzeylerde aynı olduğu ve servis yetkisi core'da
 * (`stock-levels.test.ts`). Deposuz Yılmaz işletmesinde, kendi ürünüyle.
 * ============================================================================
 */

const YONETICI = { email: 'admin@yilmaz.example', parola: 'admin123' }
const CALISAN = { email: 'ahmet@yilmazkirtasiye.example', parola: 'calisan123' }
const ek = () => Date.now().toString().slice(-7)

async function girisYap(page: Page, hesap: { email: string; parola: string }) {
  await page.goto('/giris')
  await page.fill('input[name="email"]', hesap.email)
  await page.fill('input[name="parola"]', hesap.parola)
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  await page.waitForURL('**/panel')
}

async function cikisYap(page: Page) {
  await page.getByRole('button', { name: 'Çıkış yap' }).click()
  await page.waitForURL('**/giris')
}

/** Yumuşak gezinmede `waitForURL` ateşlenmiyor: adresi yokla. */
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

/** Stok listesinde ürünün satırı; süzgeç adres çubuğundan. */
function satir(page: Page, sku: string) {
  return page.locator('tbody tr', { hasText: sku })
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('yeni ürün eşiği 3; stok 0 "Stok yok", stok 2 kritik; çalışan yalnız eşiği değiştiriyor', async ({
  page,
}) => {
  const n = ek()
  const sku = `KRT-${n}`
  const barkod = `2${n}44`
  await girisYap(page, YONETICI)

  // 1. Yeni ürün formu eşiği 3 ile açıyor; dokunmadan kaydediliyor.
  await page.goto('/urunler/yeni')
  await expect(page.locator('input[name="minStok"]')).toHaveValue('3')
  await page.fill('input[name="barkod"]', barkod)
  await page.fill('input[name="sku"]', sku)
  await page.fill('input[name="ad"]', `Eşik Ürünü ${n}`)
  await page.getByRole('button', { name: 'Kaydet' }).click()
  await adresBekle(page, 'yeni=1')
  const urunId = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.locator('section[aria-label="Mevcut durum"]')).toContainText('Kritik eşik')
  await expect(page.locator('section[aria-label="Mevcut durum"]')).toContainText('3 adet')
  await expect(page.locator('section[aria-label="Mevcut durum"]')).toContainText('stok yok')

  // 2. Stok 0: "Stok yok" süzgecinde var, kritik süzgecinde yok.
  await page.goto(`/stok?stokyok=1&ara=${sku}`)
  await expect(satir(page, sku)).toHaveCount(1)
  await expect(satir(page, sku)).toContainText('Stok yok')
  await expect(page.locator('input[name="stokyok"]')).toBeChecked()
  await page.goto(`/stok?kritik=1&ara=${sku}`)
  await expect(satir(page, sku)).toHaveCount(0)

  // Panelde "Stok yok" kartı, tümü bağlantısı ayrı süzgece gidiyor.
  await page.goto('/panel')
  const kart = page.locator('section[aria-label="Stoğu olmayan ürünler"]')
  await expect(kart).toBeVisible()
  await expect(kart.getByRole('link', { name: 'Tümü' })).toHaveAttribute('href', '/stok?stokyok=1')

  // 3. 2 adet giriş (eşik 3): kritik.
  await page.goto(`/hareket?barkod=${barkod}`)
  await expect(page.locator('input[name="miktar"]')).toBeVisible()
  await hidrasyonBekle(page)
  await page.check('input[name="sebep"][value="PURCHASE"]')
  const miktar = page.locator('input[name="miktar"]')
  await miktar.fill('2')
  await expect(miktar).toHaveValue('2')
  await page.getByRole('button', { name: 'Kaydet' }).click()
  await adresBekle(page, 'yeni=2')

  await page.goto(`/stok?kritik=1&ara=${sku}`)
  await expect(satir(page, sku)).toHaveCount(1)
  await expect(satir(page, sku)).toContainText('Kritik')
  await page.goto(`/stok?stokyok=1&ara=${sku}`)
  await expect(satir(page, sku)).toHaveCount(0)

  // 4. Çalışan: yalnız eşik formu; tam ürün formu ve fiyat alanı yok.
  await cikisYap(page)
  await girisYap(page, CALISAN)
  await page.goto(`/urunler/${urunId}`)
  const esikFormu = page.locator('form[aria-label="Kritik eşik"]')
  await expect(esikFormu).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Ürün bilgileri' })).toHaveCount(0)
  await expect(page.locator('input[name="alis"]')).toHaveCount(0)
  await expect(page.locator('input[name="ad"]')).toHaveCount(0)
  await expect(esikFormu.locator('input[name="minStok"]')).toHaveValue('3')

  await hidrasyonBekle(page)
  const alan = esikFormu.locator('input[name="minStok"]')
  await alan.fill('1')
  await expect(alan).toHaveValue('1')
  await esikFormu.getByRole('button', { name: 'Eşiği kaydet' }).click()
  await adresBekle(page, 'esik=kaydedildi')
  await expect(page.getByText('Kritik eşik kaydedildi.')).toBeVisible()
  await expect(page.locator('section[aria-label="Mevcut durum"]')).toContainText('1 adet')
  await expect(page.locator('section[aria-label="Mevcut durum"]')).not.toContainText('kritik')

  // Stok 2, eşik 1: artık kritik değil.
  await page.goto(`/stok?kritik=1&ara=${sku}`)
  await expect(satir(page, sku)).toHaveCount(0)
})
