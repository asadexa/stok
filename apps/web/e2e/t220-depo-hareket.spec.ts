import { type Locator, type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T220 — ELLE HAREKETTE DEPO SEÇİMİ, ATANMAMIŞ STOK VE BARKODSUZ ÜRÜN
 *
 * Sınanan: iki depolu işletmede Giriş / Çıkış ekranı depo soruyor ve yalnız
 * seçilen depo değişiyor; depoda yetmeyen çıkış anlaşılır mesajla reddediliyor
 * ve form korunuyor; barkodsuz ürün stok koduyla ve ürün sayfasındaki "Hareket
 * gir" ile bulunuyor; deposu bilinmeyen eski stoktan açık seçimle çıkış
 * yapılıyor, girişte reddediliyor; çalışan da depo seçerek çıkış yapabiliyor;
 * yeni ürün barkodsuz açılabiliyor. Kuralların ayrıntısı core'da
 * (`depots.test.ts`).
 *
 * DEPO AÇIYOR (envanter dosyasıyla): t219 ile aynı nedenle yalnız izole
 * veritabanında (`E2E_IZOLE_DB=1`) ya da CI'da, Demir işletmesinde koşuyor.
 * ============================================================================
 */

test.skip(
  !process.env.CI && process.env.E2E_IZOLE_DB !== '1',
  "Depo açıyor: yalnız izole veritabanında (E2E_IZOLE_DB=1) ya da CI'da koşar (T150)",
)

const YONETICI = { email: 'admin@demir.example', parola: 'admin123' }
const CALISAN = { email: 'fatma@demirhirdavat.example', parola: 'calisan123' }
/** Seed'in Demir ürünü: depo kavramından önce girilmiş stok, deposu yok. */
const ESKI_STOKLU = 'DEM-0001'
const ek = () => Date.now().toString().slice(-7)
const BASLIK = 'Malzeme Kodu;Malzeme Açıklaması;Ambar;Envanter Miktarı;Birim'

async function girisYap(page: Page, hesap: { email: string; parola: string }) {
  await page.goto('/giris')
  await page.fill('input[name="email"]', hesap.email)
  await page.fill('input[name="parola"]', hesap.parola)
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  await page.waitForURL('**/panel')
}

/** İki depo ve barkodsuz bir ürün: envanter dosyasıyla (T219). */
async function kurulum(page: Page, kod: string, depoA: string, depoB: string) {
  await page.goto('/stok/envanter')
  await page.setInputFiles('input[type="file"]', {
    name: `t220-${kod}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [BASLIK, `${kod};Barkodsuz Somun;${depoA};10;AD`, `${kod};Barkodsuz Somun;${depoB};4;AD`].join('\n'),
      'utf-8',
    ),
  })
  await page.getByRole('button', { name: /oku ve önizle/i }).click()
  await expect(page.locator('section[aria-label="Önizleme"]')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /satırı uygula/i }).click()
  await expect(page.locator('section[aria-label="Sonuç"]')).toBeVisible({ timeout: 60_000 })
}

/** Giriş / Çıkış ekranında ürünü barkod ya da stok koduyla açar. */
async function urunAc(page: Page, kod: string): Promise<Locator> {
  await page.goto('/hareket')
  await page.fill('input[name="barkod"]', kod)
  await page.press('input[name="barkod"]', 'Enter')
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Kaydet' }) })
  await expect(form).toBeVisible()
  return form
}

async function kaydet(form: Locator, secim: { sebep: string; depo: RegExp; miktar: string }) {
  await form.getByRole('radio', { name: secim.sebep, exact: true }).check()
  await form.getByRole('radio', { name: secim.depo }).check()
  await form.locator('input[name="miktar"]').fill(secim.miktar)
  await form.getByRole('button', { name: 'Kaydet' }).click()
}

/** Ürün sayfasının "Depolara göre stok" satırının değeri. */
async function depoMiktari(page: Page, kod: string, satir: string): Promise<string> {
  await page.goto(`/stok?ara=${encodeURIComponent(kod)}`)
  const href = await page.locator('table a[href^="/urunler/"]').first().getAttribute('href')
  await page.goto(href!)
  const bolum = page.locator('section[aria-label="Depolara göre stok"]')
  return (await bolum.getByRole('row', { name: new RegExp(`^${satir}`) }).locator('td').innerText()).trim()
}

/** Seçeneğin yanındaki miktar ("1.012 adet" → 1012). */
async function secenekMiktari(form: Locator, ad: RegExp): Promise<number> {
  const metin = await form.locator('label', { has: form.page().getByRole('radio', { name: ad }) }).innerText()
  return Number((metin.match(/([\d.]+) adet/)?.[1] ?? 'NaN').replace(/\./g, ''))
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('iki depolu işletmede yalnız seçilen depo değişiyor; depoda yetmeyen çıkış anlaşılır mesajla reddediliyor', async ({
  page,
}) => {
  const n = ek()
  const kod = `T220-${n}`
  const depoA = `Hareket A ${n}`
  const depoB = `Hareket B ${n}`
  await girisYap(page, YONETICI)
  await kurulum(page, kod, depoA, depoB)

  // Barkodsuz ürün stok koduyla bulunuyor; depolar miktarlarıyla soruluyor.
  let form = await urunAc(page, kod)
  await expect(form).toContainText('Barkodsuz Somun')
  await expect(form.getByRole('radio', { name: new RegExp(depoA) })).not.toBeChecked()
  await kaydet(form, { sebep: 'Kullanım', depo: new RegExp(depoA), miktar: '3' })
  await expect(page.getByRole('status').filter({ hasText: 'Barkodsuz Somun' })).toContainText('14 → 11')

  expect(await depoMiktari(page, kod, depoA)).toBe('7 adet')
  expect(await depoMiktari(page, kod, depoB)).toBe('4 adet')

  // Depo B'de 4 var: 5'lik çıkış reddediliyor; miktar ve depo seçimi korunuyor.
  form = await urunAc(page, kod)
  await kaydet(form, { sebep: 'Kullanım', depo: new RegExp(depoB), miktar: '5' })
  await expect(page.getByRole('alert').first()).toContainText(`${depoB} deposunda 4 adet var, 5 adet çıkışı yapılamaz`)
  form = page.locator('form', { has: page.getByRole('button', { name: 'Kaydet' }) })
  await expect(form.locator('input[name="miktar"]')).toHaveValue('5')
  await expect(form.getByRole('radio', { name: new RegExp(depoB) })).toBeChecked()

  // Mal kabulü seçilen depoya; ürün sayfasındaki "Hareket gir" barkodsuz ürünü açıyor.
  await page.goto(`/stok?ara=${encodeURIComponent(kod)}`)
  await page.goto((await page.locator('table a[href^="/urunler/"]').first().getAttribute('href'))!)
  await page.getByRole('link', { name: 'Hareket gir' }).click()
  form = page.locator('form', { has: page.getByRole('button', { name: 'Kaydet' }) })
  await expect(form).toContainText('Barkodsuz Somun')
  await kaydet(form, { sebep: 'Diğer giriş', depo: new RegExp(depoB), miktar: '6' })
  await expect(page.getByRole('status').filter({ hasText: 'Barkodsuz Somun' })).toContainText('11 → 17')
  expect(await depoMiktari(page, kod, depoA)).toBe('7 adet')
  expect(await depoMiktari(page, kod, depoB)).toBe('10 adet')
  expect(await depoMiktari(page, kod, 'Toplam')).toBe('17 adet')
})

test('deposu bilinmeyen eski stoktan açık seçimle çıkış; girişte Atanmamış Stok reddediliyor', async ({ page }) => {
  const n = ek()
  await girisYap(page, YONETICI)
  // İşletmede en az iki depo olsun (önceki test koşmamış olabilir).
  await kurulum(page, `T220E-${n}`, `Eski A ${n}`, `Eski B ${n}`)

  let form = await urunAc(page, ESKI_STOKLU)
  const atanmamis = /^Atanmamış Stok/
  const once = await secenekMiktari(form, atanmamis)
  expect(once).toBeGreaterThan(0)
  await kaydet(form, { sebep: 'Kullanım', depo: atanmamis, miktar: '1' })
  await expect(page.getByRole('status').first()).toBeVisible()

  form = await urunAc(page, ESKI_STOKLU)
  expect(await secenekMiktari(form, atanmamis)).toBe(once - 1)

  await kaydet(form, { sebep: 'Diğer giriş', depo: atanmamis, miktar: '1' })
  await expect(page.getByRole('alert').first()).toContainText(
    'Atanmamış Stok yalnız çıkışta seçilebilir; mal kabulü için bir depo seçin',
  )
  form = await urunAc(page, ESKI_STOKLU)
  expect(await secenekMiktari(form, atanmamis)).toBe(once - 1)
})

test('çalışan depo seçerek çıkış yapabiliyor; yönetici barkodsuz ürün açabiliyor', async ({ page, browser }) => {
  const n = ek()
  const kod = `T220C-${n}`
  const depoA = `Çalışan A ${n}`
  await girisYap(page, YONETICI)
  await kurulum(page, kod, depoA, `Çalışan B ${n}`)

  // Barkodsuz yeni ürün formdan.
  await page.goto('/urunler/yeni')
  await page.fill('input[name="sku"]', `YENI-${n}`)
  await page.fill('input[name="ad"]', `Barkodsuz Yeni ${n}`)
  await page.getByRole('button', { name: 'Kaydet' }).click()
  await expect(page.getByText('Bu ürünün barkodu yok; okutulamaz.')).toBeVisible()

  const calisan = await browser.newPage()
  await girisYap(calisan, CALISAN)
  const form = await urunAc(calisan, kod)
  await kaydet(form, { sebep: 'Kullanım', depo: new RegExp(depoA), miktar: '2' })
  await expect(calisan.getByRole('status').filter({ hasText: 'Barkodsuz Somun' })).toContainText('14 → 12')
  await calisan.close()

  expect(await depoMiktari(page, kod, depoA)).toBe('8 adet')
})

test("bir ürünün barkodu başka ürünün stok koduysa ekran seçmiyor, kullanıcıya soruyor", async ({ page }) => {
  const deger = `CKS${ek()}`
  await girisYap(page, YONETICI)
  for (const urun of [
    { barkod: deger, sku: `A-${deger}`, ad: `Barkodu ${deger}` },
    { barkod: '', sku: deger, ad: `Stok Kodu ${deger}` },
  ]) {
    await page.goto('/urunler/yeni')
    await page.fill('input[name="barkod"]', urun.barkod)
    await page.fill('input[name="sku"]', urun.sku)
    await page.fill('input[name="ad"]', urun.ad)
    await page.getByRole('button', { name: 'Kaydet' }).click()
    await expect(page.getByText('Ürün oluşturuldu.')).toBeVisible()
  }

  await page.goto('/hareket')
  await page.fill('input[name="barkod"]', deger)
  await page.press('input[name="barkod"]', 'Enter')
  const secim = page.getByRole('alert').filter({ hasText: 'iki farklı ürünü gösteriyor' })
  await expect(secim).toBeVisible()
  await expect(page.getByRole('button', { name: 'Kaydet' })).toHaveCount(0)

  await secim.getByRole('link', { name: `Stok Kodu ${deger}` }).click()
  await expect(page.locator('form', { has: page.getByRole('button', { name: 'Kaydet' }) })).toContainText(
    `Stok Kodu ${deger}`,
  )
  await page.goBack()
  await page.getByRole('alert').filter({ hasText: 'iki farklı ürünü gösteriyor' }).getByRole('link', { name: `Barkodu ${deger}` }).click()
  await expect(page.locator('form', { has: page.getByRole('button', { name: 'Kaydet' }) })).toContainText(
    `Barkodu ${deger}`,
  )
})
