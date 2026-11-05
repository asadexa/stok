import { type Locator, type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T233 — DEPOLAR ARASI TRANSFER
 *
 * Sınanan: iki depolu üründe "Depolar arası transfer" bölümü; hedef listesinde
 * kaynak depo yok; kaydetmeden önce iki depo ve değişmeyen toplam görünüyor;
 * transfer yalnız iki depoyu değiştiriyor, toplam aynı; hareketlerde iki
 * transfer bacağı; çalışan bölümü görmüyor. Kilit, eşzamanlılık, atomiklik,
 * kaynak ≠ hedef reddi ve göstergeler core'da (`transfers.test.ts`).
 *
 * DEPO AÇIYOR (envanter dosyasıyla): t219/t220/t223 gibi yalnız izole
 * veritabanında (`E2E_IZOLE_DB=1`) ya da CI'da, Demir işletmesinde (T150).
 * Kendi ürününü dosyayla açıyor; seed ürünlerine dokunmuyor.
 * ============================================================================
 */

test.skip(
  !process.env.CI && process.env.E2E_IZOLE_DB !== '1',
  "Depo açıyor: yalnız izole veritabanında (E2E_IZOLE_DB=1) ya da CI'da koşar (T150)",
)

const YONETICI = { email: 'admin@demir.example', parola: 'admin123' }
const CALISAN = { email: 'fatma@demirhirdavat.example', parola: 'calisan123' }
const ek = () => Date.now().toString().slice(-7)

async function girisYap(page: Page, hesap: { email: string; parola: string }) {
  await page.goto('/giris')
  await page.fill('input[name="email"]', hesap.email)
  await page.fill('input[name="parola"]', hesap.parola)
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  await page.waitForURL('**/panel')
}

async function urunSayfasi(page: Page, kod: string): Promise<string> {
  await page.goto(`/stok?ara=${encodeURIComponent(kod)}`)
  const href = (await page.locator('table a[href^="/urunler/"]').first().getAttribute('href'))!
  await page.goto(href)
  return href
}

/** "38 adet" → 38 (adetli ürün). */
async function miktar(satir: Locator): Promise<number> {
  return Number((await satir.locator('td').innerText()).replace(/\D/g, ''))
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('depodan depoya transfer: iki depo değişiyor, toplam aynı; çalışan bölümü görmüyor', async ({
  page,
  browser,
}) => {
  const n = ek()
  const kod = `TRF-${n}`
  const depoA = `Transfer A ${n}`
  const depoB = `Transfer B ${n}`
  await girisYap(page, YONETICI)

  // Ürün ve iki depo envanter dosyasıyla: A'da 10, B'de 1.
  await page.goto('/stok/envanter')
  await page.setInputFiles('input[type="file"]', {
    name: `t233-${n}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'Malzeme Kodu;Malzeme Açıklaması;Ambar;Envanter Miktarı;Birim',
        `${kod};Transfer Ürünü;${depoA};10;AD`,
        `${kod};Transfer Ürünü;${depoB};1;AD`,
      ].join('\n'),
      'utf-8',
    ),
  })
  await page.getByRole('button', { name: /oku ve önizle/i }).click()
  await expect(page.locator('section[aria-label="Önizleme"]')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /satırı uygula/i }).click()
  await expect(page.locator('section[aria-label="Sonuç"]')).toBeVisible({ timeout: 60_000 })

  const urun = await urunSayfasi(page, kod)
  const dagilim = page.locator('section[aria-label="Depolara göre stok"]')
  expect(await miktar(dagilim.getByRole('row', { name: /^Toplam/ }))).toBe(11)

  const bolum = page.locator('section[aria-label="Depolar arası transfer"]')
  // Miktar boş geliyor; kaynak seçilince hedef listesinde kaynak yok.
  await expect(bolum.locator('input[name="miktar"]')).toHaveValue('')
  await bolum.locator('select[name="kaynak"]').selectOption({ label: `${depoA} — 10 adet` })
  await expect(bolum.locator('select[name="hedef"] option', { hasText: depoA })).toHaveCount(0)
  await bolum.locator('select[name="hedef"]').selectOption({ label: `${depoB} — 1 adet` })

  // Kaynaktaki miktarı aşan giriş önizlemede reddediliyor, düğme kapalı.
  await bolum.locator('input[name="miktar"]').fill('11')
  await expect(bolum.getByRole('status')).toHaveText('Miktar sıfırdan büyük ve en fazla 10 adet olmalı (en fazla 3 ondalık).')
  await expect(bolum.getByRole('button', { name: 'Depoya taşı' })).toBeDisabled()

  await bolum.locator('input[name="miktar"]').fill('4')
  await expect(bolum.getByRole('status')).toHaveText(
    `${depoA} 10 adet → 6 adet · ${depoB} 1 adet → 5 adet · Toplam 11 adet (değişmez)`,
  )
  await bolum.locator('input[name="not"]').fill('raf değişimi')
  await bolum.getByRole('button', { name: 'Depoya taşı' }).click()
  await expect(page.getByText('Stok depolar arasında taşındı.')).toBeVisible()

  await expect(dagilim.getByRole('row', { name: new RegExp(`^${depoA}`) })).toContainText('6 adet')
  await expect(dagilim.getByRole('row', { name: new RegExp(`^${depoB}`) })).toContainText('5 adet')
  expect(await miktar(dagilim.getByRole('row', { name: /^Toplam/ }))).toBe(11)

  await page.goto(`/hareketler?urun=${urun.split('/').pop()}`)
  await expect(page.getByRole('cell', { name: 'Depo transferi (giriş)', exact: true })).toHaveCount(1)
  await expect(page.getByRole('cell', { name: 'Depo transferi (çıkış)', exact: true })).toHaveCount(1)
  await expect(page.getByText(`Depo transferi: ${depoA} → ${depoB}: raf değişimi`).first()).toBeVisible()

  // Çalışan aynı ürünü görüyor ama transfer bölümünü görmüyor.
  const calisanBaglam = await browser.newContext()
  const calisan = await calisanBaglam.newPage()
  await girisYap(calisan, CALISAN)
  await calisan.goto(urun)
  await expect(calisan.locator('section[aria-label="Mevcut durum"]')).toBeVisible()
  await expect(calisan.locator('section[aria-label="Depolar arası transfer"]')).toHaveCount(0)
  await calisanBaglam.close()
})
