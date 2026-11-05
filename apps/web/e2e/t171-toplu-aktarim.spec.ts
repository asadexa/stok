import { type Locator, type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T171 — TOPLU AKTARIM: İLERLEME, SONUÇ, RAPOR, İPTAL
 *
 * Tarayıcıda sınanan şey core testlerinin göremediği kısım: dosya Web
 * Worker'da okunuyor mu, satırlar parça parça gidiyor mu, ilerleme çubuğu
 * görünüyor mu, iptal düğmesi aktarımı durdurup işlenenleri koruyor mu.
 * İptalin satır sınırındaki kesin davranışı core'da kilitle sınanıyor
 * (`import-runs.test.ts`); burada süreye bağlı bir iddia YOK (T109).
 *
 * Her test kendi sentetik ürünlerini yaratıyor (demo ürünlerine dokunmuyor).
 * ============================================================================
 */

const YONETICI = { email: 'admin@yilmaz.example', parola: 'admin123' }
const ek = () => Date.now().toString().slice(-7)
const BASLIK = 'Stok Kodu;Ürün Adı;Birim;Alış Fiyatı;Barkod'

async function girisYap(page: Page) {
  await page.goto('/giris')
  await page.fill('input[name="email"]', YONETICI.email)
  await page.fill('input[name="parola"]', YONETICI.parola)
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  await page.waitForURL('**/panel')
}

function satirlar(n: string, adet: number): string[] {
  return Array.from({ length: adet }, (_, i) => {
    const no = String(i + 1).padStart(4, '0')
    return `AKT-${n}-${no};Toplu Ürün ${n} ${no};Adet;2,50;3${n}${no}`
  })
}

async function onizle(page: Page, dosya: string[]) {
  await page.goto('/urunler/aktar')
  await page.setInputFiles('input[type="file"]', {
    name: `toplu-${ek()}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(dosya.join('\n'), 'utf-8'),
  })
  await page.getByRole('button', { name: /oku ve önizle/i }).click()
  const onizleme = page.locator('section[aria-label="Önizleme"]')
  await expect(onizleme, 'önizleme gelmedi').toBeVisible({ timeout: 30_000 })
  return onizleme
}

/**
 * Sayı kartının değeri: etiket paragrafından hemen sonraki paragraf ("1.234" → 1234).
 * Yalnız `p` etiketleri aranıyor: rapor tablosunun Durum sütunu da "İşlenmedi" yazıyor.
 */
async function kart(alan: Locator, etiket: string): Promise<number> {
  const deger = alan.locator('p', { hasText: new RegExp(`^${etiket}$`) }).locator('xpath=following-sibling::p[1]')
  return Number((await deger.innerText()).replace(/\D/g, ''))
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('dosya tarayıcıda okunuyor, ilerleme görünüyor, sonuç ve rapor iniyor', async ({ page }) => {
  const n = ek()
  await girisYap(page)
  const onizleme = await onizle(page, [BASLIK, ...satirlar(n, 40), `;Adsız ${n};Adet;1;`])

  await expect(onizleme).toContainText('Yeni eklenecek40')
  await expect(onizleme).toContainText('Atlanacak (hatalı)1')

  // İlerleme çubuğu kısa sürebiliyor: göründüğü an DOM'da işaretleniyor,
  // yoklama aralığına sığmasına güvenilmiyor.
  await page.evaluate(() => {
    const w = window as unknown as { ilerlemeGorundu?: boolean }
    new MutationObserver(() => {
      if (document.querySelector('[role="progressbar"]')) w.ilerlemeGorundu = true
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.getByRole('button', { name: /satırı aktar/i }).click()

  const sonuc = page.locator('section[aria-label="Sonuç"]')
  await expect(sonuc, 'sonuç paneli gelmedi').toBeVisible({ timeout: 60_000 })
  await expect(sonuc).toContainText('Aktarım tamamlandı.')
  await expect(sonuc).toContainText('Eklendi40')
  await expect(sonuc).toContainText('Atlandı (hatalı)1')
  expect(await page.evaluate(() => (window as unknown as { ilerlemeGorundu?: boolean }).ilerlemeGorundu)).toBe(true)

  // Rapor kayıttan iniyor; dosya sunucuya hiç gelmedi.
  const indirme = page.waitForEvent('download')
  await sonuc.getByRole('link', { name: 'Raporu indir' }).click()
  expect((await indirme).suggestedFilename()).toMatch(/\.xlsx$/)

  await page.goto(`/stok?ara=AKT-${n}-0040`)
  await expect(page.getByText(`Toplu Ürün ${n} 0040`)).toBeVisible()
})

test('boş fiyat hücresi fiyatı korur; fiyat ürün formundan temizlenir (PRC-14)', async ({ page }) => {
  const n = ek()
  const kod = `FYT-${n}`
  const baslik = 'Stok Kodu;Ürün Adı;Birim;Alış Fiyatı;Satış Fiyatı;Barkod'
  await girisYap(page)

  async function uygula() {
    await page.getByRole('button', { name: /satırı aktar/i }).click()
    await expect(page.locator('section[aria-label="Sonuç"]')).toContainText('Aktarım tamamlandı.', { timeout: 60_000 })
  }

  await onizle(page, [baslik, `${kod};Fiyat Ürünü ${n};Adet;50;80;9${n}`])
  await uygula()

  // Fiyat sütunu var, hücreler boş: önizleme kuralı söylüyor, fiyatlar kalıyor.
  const onizleme = await onizle(page, [baslik, `${kod};Fiyat Ürünü ${n};Adet;;;`])
  await expect(onizleme).toContainText('Boş fiyat hücreleri mevcut fiyatları değiştirmez.')
  await uygula()

  await page.goto(`/stok?ara=${encodeURIComponent(kod)}`)
  const urun = (await page.locator('table a[href^="/urunler/"]').first().getAttribute('href'))!
  await page.goto(urun)
  await expect(page.locator('input[name="alis"]')).toHaveValue(/^50/)
  await expect(page.locator('input[name="satis"]')).toHaveValue(/^80/)

  // Bilerek temizleme ürün formundan.
  await page.locator('input[name="alis"]').fill('')
  await page.getByRole('button', { name: 'Kaydet' }).click()
  await expect(page.getByText('Değişiklikler kaydedildi.')).toBeVisible()
  await page.goto(urun)
  await expect(page.locator('input[name="alis"]')).toHaveValue('')
  await expect(page.locator('input[name="satis"]')).toHaveValue(/^80/)
})

test('iptal: aktarım duruyor, işlenen satırlar kalıyor, kalanlar "işlenmedi"', async ({ page }) => {
  const n = ek()
  const toplam = 1_000
  await girisYap(page)
  await onizle(page, [BASLIK, ...satirlar(n, toplam)])

  await page.getByRole('button', { name: /satırı aktar/i }).click()
  const ilerleme = page.locator('section[aria-label="Aktarım"]')
  await expect(ilerleme.getByRole('progressbar')).toBeVisible()
  await ilerleme.getByRole('button', { name: 'İptal et' }).click()
  await expect(ilerleme).toContainText('İptal ediliyor')

  const sonuc = page.locator('section[aria-label="Sonuç"]')
  await expect(sonuc, 'sonuç paneli gelmedi').toBeVisible({ timeout: 60_000 })
  await expect(sonuc).toContainText('Aktarım iptal edildi')

  const eklendi = await kart(sonuc, 'Eklendi')
  const islenmedi = await kart(sonuc, 'İşlenmedi')
  // İptal tıklandığında ilk parça sunucuda sürüyordu: en az bir satır işlendi,
  // dosyanın tamamı işlenmeden durdu ve hiçbir satır kaybolmadı.
  expect(eklendi).toBeGreaterThan(0)
  expect(islenmedi).toBeGreaterThan(0)
  expect(eklendi + islenmedi).toBe(toplam)
})
