import { type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T247 — ÜRÜN AKTARIMINDA SESSİZ KAYIPLAR (DAT-28)
 *
 * Sınanan, tarayıcıda:
 *   1. ERP biçimli dosyada okunan ve okunmayan sütunlar önizlemede yazıyor;
 *      ikinci "Barkod" başlığı "yalnız ilki okunur" notuyla görünüyor.
 *   2. Başka ürüne ait barkodlu satır önizlemede hatalı; temiz satır aktarılıyor.
 *   3. Boş Kategori hücresi mevcut kategoriyi silmiyor; not bunu söylüyor.
 *
 * Kayıtlı aktarım ve tek istek yolları, kısmi yazım ve dosya içi aynı barkod
 * core'da (`import.test.ts`, `import-runs.test.ts`). Deposuz Yılmaz
 * işletmesinde, kendi ürünleriyle.
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

/** Dosyayı BELLEKTEN yükler; önizleme bölümünü döner. */
async function onizle(page: Page, ad: string, satirlar: string[]) {
  await page.goto('/urunler/aktar')
  await page.setInputFiles('input[type="file"]', {
    name: ad,
    mimeType: 'text/csv',
    buffer: Buffer.from(satirlar.join('\n'), 'utf-8'),
  })
  await page.getByRole('button', { name: /oku ve önizle/i }).click()
  const onizleme = page.locator('section[aria-label="Önizleme"]')
  await expect(onizleme).toBeVisible({ timeout: 30_000 })
  return onizleme
}

async function aktar(page: Page, onizleme: ReturnType<Page['locator']>) {
  await onizleme.getByRole('button', { name: /satırı aktar/i }).click()
  await expect(page.locator('section[aria-label="Sonuç"]')).toBeVisible({ timeout: 30_000 })
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('okunmayan sütunlar ve barkod çakışması önizlemede; boş kategori korunuyor', async ({ page }) => {
  const n = ek()
  const sahip = `T247S-${n}`
  const alinmis = `2${n}47`
  await girisYap(page)

  // Hazırlık: barkodu ve kategorisi olan bir ürün.
  const ilk = await onizle(page, `t247-ilk-${n}.csv`, [
    'Stok Kodu;Ürün Adı;Kategori;Barkod',
    `${sahip};Sahibi ${n};Kırtasiye;${alinmis}`,
  ])
  await aktar(page, ilk)

  // 1 + 2. ERP biçimli dosya: okunmayan sütunlar, ikinci Barkod başlığı,
  // başka ürüne ait barkod. Sahibi de dosyada: boş Kategori hücresiyle.
  const yeni = `T247Y-${n}`
  const temiz = `T247T-${n}`
  const onizleme = await onizle(page, `t247-erp-${n}.csv`, [
    'Malzeme Kodu;Malzeme Açıklaması;Kategori;Barkod;Ortalama Değer;Barkod',
    `${yeni};Barkodu Alınmış ${n};;${alinmis};9,5;`,
    `${temiz};Temiz ${n};;3${n}47;4;`,
    `${sahip};Sahibi ${n};;;;`,
  ])
  const notlar = onizleme.getByRole('status')
  await expect(notlar).toContainText('Okunan sütunlar: Stok Kodu, Ürün Adı, Kategori, Barkod.')
  await expect(notlar).toContainText('Okunmayan sütunlar: Ortalama Değer.')
  await expect(notlar).toContainText('"Barkod" sütunu okunmadı')
  await expect(notlar).toContainText('Boş hücreler mevcut değerleri değiştirmez (Kategori)')

  const hatali = onizleme.locator('div.border-kritik', { has: page.getByRole('heading', { name: 'Hatalı satırlar' }) })
  await expect(hatali).toContainText(yeni)
  await expect(hatali).toContainText(`Bu barkod başka bir üründe kayıtlı (stok kodu ${sahip})`)
  await expect(onizleme.getByRole('button', { name: /2 satırı aktar/i })).toBeVisible()
  await aktar(page, onizleme)

  // Barkodu alınmış ürün açılmadı; temiz ürün açıldı.
  await page.goto(`/stok?ara=${yeni}`)
  await expect(page.locator('tbody tr', { hasText: yeni })).toHaveCount(0)
  await page.goto(`/stok?ara=${temiz}`)
  await expect(page.locator('tbody tr', { hasText: temiz })).toHaveCount(1)

  // 3. Boş Kategori hücresi mevcut kategoriyi silmedi.
  await page.goto(`/stok?ara=${sahip}&kategori=${encodeURIComponent('Kırtasiye')}`)
  await expect(page.locator('tbody tr', { hasText: sahip })).toHaveCount(1)
})
