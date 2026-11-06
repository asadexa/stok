import { type Locator, type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T223 — ATANMAMIŞ STOĞU DEPOYA ATAMA
 *
 * Sınanan: depolu işletmede eski stoklu üründe "Depoya ata" bölümü; miktar
 * tamamıyla dolu geliyor; kaydetmeden önce iki kova ve değişmeyen toplam
 * görünüyor; kısmi atama yalnız seçilen depoyu artırıyor; kalanın atanmasıyla
 * "Depoya atama bekliyor" satırı kalkıyor ve sayım düzeltmesi formu açılıyor;
 * hareketlerde iki transfer bacağı var; çalışan bölümü görmüyor. Kilit,
 * eşzamanlılık, atomiklik ve göstergeler core'da (`transfers.test.ts`).
 *
 * DEPO AÇIYOR (envanter dosyasıyla): t219/t220 gibi yalnız izole veritabanında
 * (`E2E_IZOLE_DB=1`) ya da CI'da, Demir işletmesinde koşuyor (T150).
 * DEM-0001'e dokunulmuyor: t232 onun atanmamış kalmasına güveniyor.
 * ============================================================================
 */

test.skip(
  !process.env.CI && process.env.E2E_IZOLE_DB !== '1',
  "Depo açıyor: yalnız izole veritabanında (E2E_IZOLE_DB=1) ya da CI'da koşar (T150)",
)

const YONETICI = { email: 'admin@demir.example', parola: 'admin123' }
const CALISAN = { email: 'fatma@demirhirdavat.example', parola: 'calisan123' }
/** Seed'in Demir ürünü: depo kavramından önce girilmiş stok, deposu yok. */
const ESKI_STOKLU = 'DEM-0005'
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

test('kısmi, sonra tam atama: toplam değişmiyor, sayım düzeltmesi açılıyor', async ({ page }) => {
  const n = ek()
  const depoA = `Atama A ${n}`
  const depoB = `Atama B ${n}`
  await girisYap(page, YONETICI)

  // İki yeni depo: başka bir ürünün envanter dosyasıyla açılıyor.
  await page.goto('/stok/envanter')
  await page.setInputFiles('input[type="file"]', {
    name: `t223-${n}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'Malzeme Kodu;Malzeme Açıklaması;Ambar;Envanter Miktarı;Birim',
        `ATD-${n};Atama Deposu Ürünü;${depoA};1;AD`,
        `ATD-${n};Atama Deposu Ürünü;${depoB};1;AD`,
      ].join('\n'),
      'utf-8',
    ),
  })
  await page.getByRole('button', { name: /oku ve önizle/i }).click()
  await expect(page.locator('section[aria-label="Önizleme"]')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /satırı uygula/i }).click()
  await expect(page.locator('section[aria-label="Sonuç"]')).toBeVisible({ timeout: 60_000 })

  const urun = await urunSayfasi(page, ESKI_STOKLU)
  const dagilim = page.locator('section[aria-label="Depolara göre stok"]')
  const bekleyen = dagilim.getByRole('row', { name: /^Depoya atama bekliyor/ })
  const eski = await miktar(bekleyen)
  const toplam = await miktar(dagilim.getByRole('row', { name: /^Toplam/ }))
  expect(eski).toBeGreaterThan(3)
  // Atanmamış stok varken sayım düzeltmesi kapalı (T232).
  await expect(page.locator('section[aria-label="Stoğu düzelt"] input[name="hedef"]')).toHaveCount(0)

  const bolum = page.locator('section[aria-label="Depoya ata"]')
  await expect(bolum.locator('input[name="miktar"]')).toHaveValue(String(eski))
  await bolum.locator('select[name="depo"]').selectOption({ label: `${depoA} — 0 adet` })
  await bolum.locator('input[name="miktar"]').fill('3')
  await expect(bolum.getByRole('status')).toHaveText(
    `Atanmamış ${eski} adet → ${eski - 3} adet · ${depoA} 0 adet → 3 adet · Toplam ${toplam} adet (değişmez)`,
  )
  await bolum.getByRole('button', { name: 'Depoya ata' }).click()
  await expect(page.getByText('Stok depoya atandı.')).toBeVisible()

  await expect(dagilim.getByRole('row', { name: new RegExp(`^${depoA}`) })).toContainText('3 adet')
  expect(await miktar(bekleyen)).toBe(eski - 3)
  expect(await miktar(dagilim.getByRole('row', { name: /^Toplam/ }))).toBe(toplam)

  // Kalanın tamamı (alan dolu geliyor) ikinci depoya.
  await bolum.locator('select[name="depo"]').selectOption({ label: `${depoB} — 0 adet` })
  await expect(bolum.locator('input[name="miktar"]')).toHaveValue(String(eski - 3))
  await bolum.getByRole('button', { name: 'Depoya ata' }).click()
  await expect(page.getByText('Stok depoya atandı.')).toBeVisible()

  await expect(bekleyen).toHaveCount(0)
  await expect(dagilim.getByRole('row', { name: new RegExp(`^${depoB}`) })).toContainText(`${eski - 3} adet`)
  expect(await miktar(dagilim.getByRole('row', { name: /^Toplam/ }))).toBe(toplam)
  await expect(page.locator('section[aria-label="Depoya ata"]')).toHaveCount(0)
  await expect(page.locator('section[aria-label="Stoğu düzelt"] input[name="hedef"]')).toHaveCount(1)

  await page.goto(`/hareketler?urun=${urun.split('/').pop()}`)
  await expect(page.getByRole('cell', { name: 'Depo transferi (giriş)', exact: true })).toHaveCount(2)
  await expect(page.getByRole('cell', { name: 'Depo transferi (çıkış)', exact: true })).toHaveCount(2)
})

test('çalışan depoya atama bölümünü görmüyor', async ({ page }) => {
  await girisYap(page, CALISAN)
  // DEM-0001 hep atanmamış stoklu kalıyor (yukarıdaki test DEM-0005'i kullanıyor).
  await urunSayfasi(page, 'DEM-0001')
  await expect(page.locator('section[aria-label="Mevcut durum"]')).toBeVisible()
  await expect(page.locator('section[aria-label="Depoya ata"]')).toHaveCount(0)
})
