import { type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T221 — STOK LİSTESİNDE "DEPOYA ATAMA BEKLİYOR" ROZETİ VE SÜZGECİ
 * T234 — ÇOK DEPOLU İŞLETMEDE ÜRÜN AKTARIMI ÖNİZLEMESİ
 *
 * Sınanan: deposuz işletmede süzgeç kutusu ve rozet yok; depolu işletmede eski
 * stoklu ürün rozetle ve süzgeçle bulunuyor, yönetici ve çalışan yetkisine
 * uygun açıklamayı görüyor; çok depolu işletmede devirli ürün dosyasının
 * önizlemesi devri "atlanacak" sayıyor, sonuç "Devir atlandı" diyor. Kural
 * ayrıntıları core'da (`awaiting-assignment.test.ts`, `opening-import.test.ts`).
 *
 * Depolu kısım DEPO AÇIYOR (envanter dosyasıyla): t219/t220/t223 gibi yalnız
 * izole veritabanında (`E2E_IZOLE_DB=1`) ya da CI'da, Demir işletmesinde (T150).
 * DEM-0001 deposu bilinmeyen eski stoklu kalıyor (t223 ona dokunmuyor).
 * ============================================================================
 */

const YILMAZ = { email: 'admin@yilmaz.example', parola: 'admin123' }
const DEMIR = { email: 'admin@demir.example', parola: 'admin123' }
const DEMIR_CALISAN = { email: 'fatma@demirhirdavat.example', parola: 'calisan123' }
const ESKI_STOKLU = 'DEM-0001'
const ek = () => Date.now().toString().slice(-7)

async function girisYap(page: Page, hesap: { email: string; parola: string }) {
  await page.goto('/giris')
  await page.fill('input[name="email"]', hesap.email)
  await page.fill('input[name="parola"]', hesap.parola)
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  await page.waitForURL('**/panel')
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('deposuz işletme: atama süzgeci ve rozeti yok', async ({ page }) => {
  await girisYap(page, YILMAZ)
  await page.goto('/stok')
  await expect(page.locator('section[aria-label="Stok tablosu"]')).toBeVisible()
  await expect(page.locator('input[name="atama"]')).toHaveCount(0)
  await expect(page.getByText('Depoya atama bekliyor')).toHaveCount(0)
})

test.describe('depolu işletme', () => {
  test.skip(
    !process.env.CI && process.env.E2E_IZOLE_DB !== '1',
    "Depo açıyor: yalnız izole veritabanında (E2E_IZOLE_DB=1) ya da CI'da koşar (T150)",
  )

  /** İki depo açar (yeni bir ürünün envanter dosyasıyla); işletmede zaten varsa da zararsız. */
  async function ikiDepo(page: Page, n: string) {
    await page.goto('/stok/envanter')
    // T237: depo seçiminden önceki davranışı anlatan cümle kalktı; doğru olan yarısı duruyor.
    await expect(page.getByText('ürün aktarımı açılış stoğu yazmaz')).toBeVisible()
    await expect(page.getByText('depo seçimi eklenene kadar')).toHaveCount(0)
    await page.setInputFiles('input[type="file"]', {
      name: `t221-${n}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(
        [
          'Malzeme Kodu;Malzeme Açıklaması;Ambar;Envanter Miktarı;Birim',
          `ATB-${n};Atama Rozeti Ürünü;Rozet A ${n};1;AD`,
          `ATB-${n};Atama Rozeti Ürünü;Rozet B ${n};1;AD`,
        ].join('\n'),
        'utf-8',
      ),
    })
    await page.getByRole('button', { name: /oku ve önizle/i }).click()
    await expect(page.locator('section[aria-label="Önizleme"]')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /satırı uygula/i }).click()
    await expect(page.locator('section[aria-label="Sonuç"]')).toBeVisible({ timeout: 60_000 })
  }

  test('eski stoklu ürün rozet ve süzgeçle bulunuyor; açıklama yetkiye göre', async ({ page, browser }) => {
    await girisYap(page, DEMIR)
    await ikiDepo(page, ek())

    await page.goto('/stok')
    await page.locator('input[name="atama"]').check()
    await page.getByRole('button', { name: 'Filtrele', exact: true }).click()
    await expect.poll(() => page.url()).toContain('atama=1')

    const satir = page.locator('section[aria-label="Stok tablosu"] tr', { hasText: ESKI_STOKLU })
    await expect(satir).toContainText('Depoya atama bekliyor')
    // Süzgeçte her satır bekleyen.
    const satirlar = page.locator('section[aria-label="Stok tablosu"] tbody tr')
    await expect(satirlar.filter({ hasNotText: 'Depoya atama bekliyor' })).toHaveCount(0)
    await expect(page.getByText('“Atanmamış stoğu depoya ata” bölümünden bir depoya atayabilirsiniz')).toBeVisible()

    // Çalışan rozeti görüyor; yapamayacağı işlem söylenmiyor.
    const baglam = await browser.newContext()
    const calisan = await baglam.newPage()
    await girisYap(calisan, DEMIR_CALISAN)
    await calisan.goto('/stok?atama=1')
    await expect(calisan.locator('section[aria-label="Stok tablosu"] tr', { hasText: ESKI_STOKLU })).toContainText(
      'Depoya atama bekliyor',
    )
    await expect(calisan.getByText('Depoya atamayı yönetici yapar')).toBeVisible()
    await expect(calisan.getByText('bölümünden bir depoya atayabilirsiniz')).toHaveCount(0)
    await baglam.close()
  })

  test('çok depolu işletmede ürün aktarımı devri "atlanacak" sayıyor, sonuç "atlandı" diyor (T234)', async ({
    page,
  }) => {
    const n = ek()
    await girisYap(page, DEMIR)
    await ikiDepo(page, n)

    await page.goto('/urunler/aktar')
    await page.setInputFiles('input[type="file"]', {
      name: `t234-${n}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(['Stok Kodu;Ürün Adı;Alış Fiyatı;Açılış Stoğu', `CDV-${n};Çok Depo Devri;2;5`].join('\n'), 'utf-8'),
    })
    await page.getByRole('button', { name: /oku ve önizle/i }).click()
    const onizleme = page.locator('section[aria-label="Önizleme"]')
    await expect(onizleme).toBeVisible()
    await expect(onizleme).toContainText('Açılış stoğu: 0 üründe yazılacak, 1 üründe atlanacak')
    await expect(onizleme).toContainText('Devir atlanacak: işletmede birden fazla depo var')

    await page.getByRole('button', { name: /satırı aktar/i }).click()
    const sonuc = page.locator('section[aria-label="Sonuç"]')
    await expect(sonuc).toBeVisible({ timeout: 60_000 })
    await expect(sonuc).toContainText('Devir atlandı1')
    await expect(sonuc).toContainText('Ürün eklendi, devir atlandı')
  })
})
