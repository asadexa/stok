import { randomUUID } from 'node:crypto'
import { type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * WS-SCAN — TELEFONLA BARKOD OKUT (laptop paneli + köprü)
 *
 * Laptop GERÇEK tarayıcı. Telefon Playwright'ın `request` istemcisiyle
 * taklit ediliyor: QR'daki token'la eşleşip barkodu `okut` ucuna
 * gönderiyor. Kamera ve çözücü burada yok (CI'daki headless tarayıcıda
 * `getUserMedia` yok); onlar gerçek telefonla ve yerel sahte kamera
 * betiğiyle sınanıyor.
 *
 * KANITLANAN: telefonun okuduğu barkod laptopta mevcut `/hareket?barkod=`
 * akışını açıyor; stok YALNIZ Kaydet'le değişiyor; formda yazılan miktar
 * yeni bir okumayla sessizce kaybolmuyor; Kes telefonu hemen düşürüyor.
 * ============================================================================
 */

const YONETICI = { email: 'admin@yilmaz.example', parola: 'admin123' }

async function girisYap(page: Page) {
  await page.goto('/giris')
  await page.fill('input[name="email"]', YONETICI.email)
  await page.fill('input[name="parola"]', YONETICI.parola)
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  await page.waitForURL('**/panel')
}

/** Barkod ekrandan okunuyor, stok kodu sabit (gerekçe faz10-fiyat.spec.ts `barkodBul`). */
async function barkodBul(page: Page, sku: string): Promise<string> {
  await page.goto(`/stok?ara=${encodeURIComponent(sku)}`)
  const satir = page.locator('tbody tr', { hasText: sku }).first()
  await expect(satir, `${sku} stok kodlu ürün bulunamadı`).toBeVisible()
  await satir.locator('a').first().click()
  await page.waitForSelector('h2:has-text("Barkodlar")')
  const barkodSatiri = page.locator('li', { hasText: 'Tekli' }).first()
  return (await barkodSatiri.locator('span').first().innerText()).trim()
}

async function adresBekle(page: Page, parca: string) {
  await expect
    .poll(() => decodeURIComponent(page.url()), { message: `adres '${parca}' içermiyor`, timeout: 15_000 })
    .toContain(parca)
}

const stokSatiri = (page: Page) => page.locator('p', { hasText: 'Mevcut stok' }).first()

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('telefonun okuduğu barkod hareket ekranında açılıyor; stok yalnız Kaydet’le değişiyor', async ({
  page,
  request,
}) => {
  await girisYap(page)
  const birinci = await barkodBul(page, 'YIL-0012')
  const ikinci = await barkodBul(page, 'YIL-0013')

  await page.goto('/hareket')
  await page.fill('input[name="adres"]', 'https://ornek.trycloudflare.com')
  await page.getByRole('button', { name: 'Telefonla Barkod Okut' }).click()
  await expect(page.getByAltText('Telefonla okutulacak eşleştirme kodu')).toBeVisible()
  const baglanti = (await page.getByText('QR okunmuyorsa').textContent()) ?? ''
  const qrAdresi = new URL(baglanti.match(/https:\/\/\S+/)?.[0] ?? '')
  expect(qrAdresi.origin).toBe('https://ornek.trycloudflare.com')
  expect(qrAdresi.pathname).toBe('/tara')

  // TELEFON: QR'daki tek kullanımlık token'la eşleş.
  const eslesme = await request.post('/api/tara/eslestir', {
    data: { token: qrAdresi.hash.slice('#e='.length) },
  })
  expect(eslesme.status()).toBe(200)
  const { phoneToken } = (await eslesme.json()) as { phoneToken: string }
  const okut = (barcode: string) =>
    request.post('/api/tara/okut', {
      headers: { authorization: `Bearer ${phoneToken}` },
      data: { scanId: randomUUID(), barcode },
    })
  await expect(page.getByText('Telefon bağlı ✓')).toBeVisible()

  // Okuma laptopta mevcut hareket formunu açıyor; telefona ürün bilgisi gitmiyor.
  const cevap = await okut(birinci)
  expect(cevap.status()).toBe(200)
  expect(Object.keys((await cevap.json()) as object)).toEqual(['seq'])
  await adresBekle(page, `barkod=${birinci}`)
  const miktar = page.locator('input[name="miktar"]')
  await expect(miktar).toBeVisible()
  await expect(miktar).toBeFocused()
  const stokOnce = await stokSatiri(page).innerText()

  // KİRLİ FORM: yazılan miktar yeni okumayla kaybolmuyor, sayfa değişmiyor.
  await miktar.fill('3')
  await page.check('input[name="sebep"][value="OTHER_IN"]')
  expect((await okut(ikinci)).status()).toBe(200)
  await expect(page.getByText('Telefondan yeni barkod')).toBeVisible()
  expect(decodeURIComponent(page.url())).toContain(`barkod=${birinci}`)
  await expect(miktar).toHaveValue('3')

  // Okumalar stoğu değiştirmedi: yalnız Kaydet değiştirir.
  await page.goto(`/hareket?barkod=${encodeURIComponent(birinci)}`)
  await expect(stokSatiri(page)).toHaveText(stokOnce)
  await page.fill('input[name="miktar"]', '3')
  await page.check('input[name="sebep"][value="OTHER_IN"]')
  await page.getByRole('button', { name: 'Kaydet' }).click()
  await adresBekle(page, 'yeni=')
  await expect(page.locator('p[role="status"]').first()).toContainText('→')

  // Kes: telefon hemen "bağlantı kapandı" alıyor.
  await page.getByRole('button', { name: 'Bağlantıyı kes' }).click()
  await expect(page.getByRole('button', { name: 'Telefonla Barkod Okut' })).toBeVisible()
  const nabiz = await request.post('/api/tara/telefon', {
    headers: { authorization: `Bearer ${phoneToken}` },
    data: {},
  })
  expect(nabiz.status()).toBe(410)
  expect(((await nabiz.json()) as { code: string }).code).toBe('SCAN_SESSION_CLOSED')
})
