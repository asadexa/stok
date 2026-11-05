import { type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T232 — ÜRÜN SAYFASINDAN TEK ÜRÜN STOK DÜZELTMESİ
 *
 * Sınanan: kaydetmeden önce "mevcut → hedef, fark" görünüyor; fark 0 iken
 * kaydedilemiyor; kayıt tek "Sayım düzeltmesi" hareketi yazıyor; sayfa
 * açıldıktan sonra stok değiştiyse eski miktara göre yazılmıyor; çalışan
 * bölümü görmüyor. Deposuz işletmede hedef toplam stok; depolu işletmede
 * seçilen depo değişiyor, diğeri değişmiyor; depoya atanmamış stoklu üründe
 * form kapalı. Kapı kuralları core'da (`depots.test.ts`).
 *
 * Deposuz kısım Yılmaz'da (deposu yok) her koşuda; depolu kısım depo açtığı
 * için t219/t220 gibi yalnız izole veritabanında ya da CI'da, Demir'de (T150).
 * ============================================================================
 */

const YILMAZ = { email: 'admin@yilmaz.example', parola: 'admin123' }
const YILMAZ_CALISAN = { email: 'ahmet@yilmazkirtasiye.example', parola: 'calisan123' }
const DEMIR = { email: 'admin@demir.example', parola: 'admin123' }
/** Seed'in Demir ürünü: depo kavramından önce girilmiş stok, deposu yok. */
const DEMIR_ESKI_STOKLU = 'DEM-0001'
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

/** Kaydı ürün aktarımıyla: açılış stoğu devir olarak yazılıyor. */
async function urunAktar(page: Page, satir: string) {
  await page.goto('/urunler/aktar')
  await page.setInputFiles('input[type="file"]', {
    name: `t232-${ek()}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(['Stok Kodu;Ürün Adı;Birim;Alış Fiyatı;Barkod;Açılış Stoğu', satir].join('\n'), 'utf-8'),
  })
  await page.getByRole('button', { name: /oku ve önizle/i }).click()
  await expect(page.locator('section[aria-label="Önizleme"]')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /satırı aktar/i }).click()
  await expect(page.locator('section[aria-label="Sonuç"]')).toContainText('Aktarım tamamlandı.', { timeout: 60_000 })
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('deposuz işletme: toplam stok 10 → 7; fark önce görünüyor; eski sayfadan yazılmıyor', async ({ page, context }) => {
  const kod = `SAY-${ek()}`
  await girisYap(page, YILMAZ)
  await urunAktar(page, `${kod};Sayım Ürünü;Adet;5;8${ek()};10`)

  const urun = await urunSayfasi(page, kod)
  const bolum = page.locator('section[aria-label="Stoğu düzelt"]')
  await expect(bolum).toContainText('Toplam stok: 10 adet')

  const hedef = bolum.locator('input[name="hedef"]')
  const kaydet = bolum.getByRole('button', { name: 'Düzeltmeyi uygula' })
  await hedef.fill('10')
  await expect(bolum.getByRole('status')).toHaveText('Fark yok; kaydedilecek hareket yok.')
  await expect(kaydet).toBeDisabled()

  // İkinci sekme aynı sayfayı ESKİ miktarla (10) açık tutuyor.
  const eski = await context.newPage()
  await eski.goto(urun)

  await hedef.fill('7')
  await expect(bolum.getByRole('status')).toHaveText('10 adet → 7 adet, fark −3 adet')
  await kaydet.click()
  await expect(page.getByText('Sayım düzeltmesi kaydedildi.')).toBeVisible()
  await expect(page.locator('section[aria-label="Mevcut durum"]')).toContainText('7 adet')

  // Eski sekme 10'u gördü; stok artık 7. 10 → 5 yazılsaydı aradaki düzeltme kaybolurdu.
  const eskiBolum = eski.locator('section[aria-label="Stoğu düzelt"]')
  await eskiBolum.locator('input[name="hedef"]').fill('5')
  await eskiBolum.getByRole('button', { name: 'Düzeltmeyi uygula' }).click()
  await expect(eski.getByText('Stok, sayfa açıldıktan sonra değişti; düzeltme yazılmadı.')).toBeVisible()
  await eski.close()

  await page.goto(urun)
  await expect(page.locator('section[aria-label="Mevcut durum"]')).toContainText('7 adet')
  await page.goto(`/hareketler?urun=${urun.split('/').pop()}`)
  // Süzgeçteki sebep seçeneği de aynı metni taşıyor: yalnız tablo hücreleri sayılıyor.
  await expect(page.getByRole('cell', { name: 'Sayım düzeltmesi (-)', exact: true })).toHaveCount(1)
})

test('çalışan stok düzeltme bölümünü görmüyor', async ({ page }) => {
  await girisYap(page, YILMAZ_CALISAN)
  await page.goto('/stok')
  await page.goto((await page.locator('table a[href^="/urunler/"]').first().getAttribute('href'))!)
  // Sayfada iki h1 var (üst şerit ve ürün adı): ürün sayfasının yüklendiği,
  // ürüne özgü bölümden anlaşılıyor.
  await expect(page.locator('section[aria-label="Mevcut durum"]')).toBeVisible()
  await expect(page.locator('section[aria-label="Stoğu düzelt"]')).toHaveCount(0)
})

test.describe('depolu işletme', () => {
  test.skip(
    !process.env.CI && process.env.E2E_IZOLE_DB !== '1',
    "Depo açıyor: yalnız izole veritabanında (E2E_IZOLE_DB=1) ya da CI'da koşar (T150)",
  )

  test('seçilen depo 10 → 6, diğer depo 4 kalıyor; atanmamış stoklu üründe form kapalı', async ({ page }) => {
    const n = ek()
    const kod = `SYD-${n}`
    const depoA = `Sayım A ${n}`
    const depoB = `Sayım B ${n}`
    await girisYap(page, DEMIR)

    await page.goto('/stok/envanter')
    await page.setInputFiles('input[type="file"]', {
      name: `t232-${kod}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(
        [
          'Malzeme Kodu;Malzeme Açıklaması;Ambar;Envanter Miktarı;Birim',
          `${kod};Depolu Sayım;${depoA};10;AD`,
          `${kod};Depolu Sayım;${depoB};4;AD`,
        ].join('\n'),
        'utf-8',
      ),
    })
    await page.getByRole('button', { name: /oku ve önizle/i }).click()
    await expect(page.locator('section[aria-label="Önizleme"]')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /satırı uygula/i }).click()
    await expect(page.locator('section[aria-label="Sonuç"]')).toBeVisible({ timeout: 60_000 })

    await urunSayfasi(page, kod)
    const bolum = page.locator('section[aria-label="Stoğu düzelt"]')
    await bolum.locator('select[name="depo"]').selectOption({ label: `${depoA} — 10 adet` })
    await bolum.locator('input[name="hedef"]').fill('6')
    await expect(bolum.getByRole('status')).toHaveText('10 adet → 6 adet, fark −4 adet')
    await bolum.getByRole('button', { name: 'Düzeltmeyi uygula' }).click()
    await expect(page.getByText('Sayım düzeltmesi kaydedildi.')).toBeVisible()

    const dagilim = page.locator('section[aria-label="Depolara göre stok"]')
    await expect(dagilim.getByRole('row', { name: new RegExp(`^${depoA}`) })).toContainText('6 adet')
    await expect(dagilim.getByRole('row', { name: new RegExp(`^${depoB}`) })).toContainText('4 adet')
    await expect(dagilim.getByRole('row', { name: /^Toplam/ })).toContainText('10 adet')

    // Deposu bilinmeyen eski stoklu ürün: düzeltme formu yok, ne yapılacağı yazıyor.
    await urunSayfasi(page, DEMIR_ESKI_STOKLU)
    const kapali = page.locator('section[aria-label="Stoğu düzelt"]')
    await expect(kapali).toContainText('henüz bir depoya atanmamış stok var')
    await expect(kapali.locator('input[name="hedef"]')).toHaveCount(0)
    await expect(kapali).not.toContainText('T223')
  })
})
