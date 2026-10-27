import { type Locator, type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T219 — ENVANTERİ GÜNCELLE: GERÇEK TARAYICIDA UÇTAN UCA
 *
 * Sınanan: dosya tarayıcıda okunuyor, önizleme "yeni toplam"ı ve eski → yeni
 * miktarları gösteriyor, onaydan önce hiçbir şey yazılmıyor, yalnız
 * dosyadaki depo değişiyor (Depo 1 = 10, Depo 2 = 20 → Depo 1 = 5, toplam
 * 25), aynı içerik "yeni sayım" onayı istiyor, önizlemeden sonra değişen
 * stok Çakışma olarak görünüyor, çalışan ekrana ve rapora giremiyor.
 * Satır kurallarının ayrıntısı core'da (`inventory-runs.test.ts`).
 *
 * DEPO AÇIYOR. Bir işletmede ikinci depo açılınca o işletmede el ile hareket
 * depo seçimi gelene kadar reddediliyor (DEPOT_REQUIRED, T220). Bu yüzden:
 *   - ikinci demo işletmesi (Demir) kullanılıyor; diğer E2E'ler Yılmaz'da
 *     el ile hareket yazıyor;
 *   - yalnız izole veritabanında (`E2E_IZOLE_DB=1`, T150) ya da her koşuda
 *     sıfırdan kurulan CI veritabanında koşuyor. Geliştirme veritabanına
 *     karşı sıradan bir `test:e2e` demo verisinde kalıcı depo bırakmasın.
 * ============================================================================
 */

test.skip(
  !process.env.CI && process.env.E2E_IZOLE_DB !== '1',
  "Depo açıyor: yalnız izole veritabanında (E2E_IZOLE_DB=1) ya da CI'da koşar (T150)",
)

const YONETICI = { email: 'admin@demir.example', parola: 'admin123' }
const CALISAN = { email: 'fatma@demirhirdavat.example', parola: 'calisan123' }
const ek = () => Date.now().toString().slice(-7)

/** Gerçek ERP raporunun başlıkları; fiyat ve tutar sütunları dolu ama okunmamalı. */
const BASLIK = 'Malzeme Türü;Malzeme Kodu;Malzeme Açıklaması;Ambar;Envanter Miktarı;Birim;Ortalama Değer;Envanter Tutarı'
const satir = (kod: string, ad: string, depo: string, miktar: string) =>
  `Ticari Mal;${kod};${ad};${depo};${miktar};AD;12,50;125,00`

async function girisYap(page: Page, hesap: { email: string; parola: string }) {
  await page.goto('/giris')
  await page.fill('input[name="email"]', hesap.email)
  await page.fill('input[name="parola"]', hesap.parola)
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  await page.waitForURL('**/panel')
}

async function onizle(page: Page, dosyaAdi: string, satirlar: string[]): Promise<Locator> {
  await page.goto('/stok/envanter')
  await page.setInputFiles('input[type="file"]', {
    name: dosyaAdi,
    mimeType: 'text/csv',
    buffer: Buffer.from([BASLIK, ...satirlar].join('\n'), 'utf-8'),
  })
  await page.getByRole('button', { name: /oku ve önizle/i }).click()
  const onizleme = page.locator('section[aria-label="Önizleme"]')
  await expect(onizleme, 'önizleme gelmedi').toBeVisible({ timeout: 30_000 })
  return onizleme
}

async function uygula(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /satırı uygula/i }).click()
  const sonuc = page.locator('section[aria-label="Sonuç"]')
  await expect(sonuc, 'sonuç gelmedi').toBeVisible({ timeout: 60_000 })
  return sonuc
}

/** Sayı kartının değeri: etiket paragrafından hemen sonraki paragraf (t171'deki gibi). */
async function kart(alan: Locator, etiket: string): Promise<number> {
  const deger = alan.locator('p', { hasText: new RegExp(`^${etiket}$`) }).locator('xpath=following-sibling::p[1]')
  return Number((await deger.innerText()).replace(/\D/g, ''))
}

/** Ürün sayfasının "Depolara göre stok" bölümü; ürün stok tablosunda kodla aranıyor. */
async function depoDagilimi(page: Page, kod: string, ad: string): Promise<Locator> {
  await page.goto(`/stok?ara=${encodeURIComponent(kod)}`)
  const href = await page.getByRole('link', { name: ad }).first().getAttribute('href')
  expect(href, `${kod} stok tablosunda yok`).toMatch(/^\/urunler\//)
  await page.goto(href!)
  const bolum = page.locator('section[aria-label="Depolara göre stok"]')
  await expect(bolum).toBeVisible()
  return bolum
}

async function satirDegeri(bolum: Locator, baslik: string): Promise<string> {
  return (await bolum.getByRole('row', { name: new RegExp(`^${baslik}`) }).locator('td').innerText()).trim()
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('ilk kurulum, yalnız bir deponun güncellenmesi ve aynı içeriğin yeni sayım onayı', async ({ page, context }) => {
  const n = ek()
  const A = `ENV-${n}-A`
  const merkez = `Merkez ${n}`
  const sube = `Şube ${n}`
  await girisYap(page, YONETICI)

  // Stok bölümünden giriş.
  await page.goto('/stok')
  await page.getByRole('link', { name: 'Envanteri güncelle' }).click()
  await expect.poll(() => page.url()).toContain('/stok/envanter')

  // 1–2. Yükle: iki depo, barkodsuz yeni ürünler, hatalı satırlar.
  const ilk = await onizle(page, `ilk-kurulum-${n}.csv`, [
    satir(A, 'Galvaniz Boru', merkez, '10'),
    satir(A, 'Galvaniz Boru', sube, '20'),
    satir(`ENV-${n}-B`, 'Sıva Malası', merkez, '7'),
    satir(`ENV-${n}-C`, 'Boş Miktarlı', merkez, ''),
    satir(`ENV-${n}-D`, 'Eksi Miktarlı', merkez, '-3'),
  ])
  await expect(ilk).toContainText('YENİ TOPLAM stoğudur; mevcut stoğa eklenmez')
  expect(await kart(ilk, 'Yeni ürün')).toBe(2)
  expect(await kart(ilk, 'Stoğu artacak')).toBe(3)
  expect(await kart(ilk, 'Hatalı \\(atlanacak\\)')).toBe(2)
  await expect(ilk).toContainText(`${merkez} (yeni, onayda açılacak)`)
  await expect(ilk).toContainText(`${sube} (yeni, onayda açılacak)`)
  await expect(ilk).toContainText('Malzeme Kodu, Malzeme Açıklaması, Ambar (Depo), Envanter Miktarı, Birim')
  await expect(ilk).toContainText('Okunmayan sütunlar: Malzeme Türü, Ortalama Değer, Envanter Tutarı')
  await expect(ilk).toContainText('Dosyada olmayan ürünlerin ve depoların stoğu değişmez.')
  await expect(ilk).toContainText('Envanter miktarı boş; boş hücre 0 sayılmaz')
  await expect(ilk).toContainText('negatif olamaz')

  // Onaydan önce hiçbir şey yazılmadı: ürün stok tablosunda yok.
  const yan = await context.newPage()
  await yan.goto(`/stok?ara=${encodeURIComponent(A)}`)
  await expect(yan.getByRole('link', { name: 'Galvaniz Boru' })).toHaveCount(0)
  await yan.close()

  // 3. Onay: ürünler, depolar ve stoklar oluşuyor; hatalı satırlar atlanıyor.
  const ilkSonuc = await uygula(page)
  await expect(ilkSonuc.getByRole('status')).toHaveText('Envanter güncellendi.')
  expect(await kart(ilkSonuc, 'Yeni ürün satırı yazıldı')).toBe(3)
  expect(await kart(ilkSonuc, 'Hatalı \\(atlandı\\)')).toBe(2)

  // 4. Depo 1 = 10, Depo 2 = 20, toplam 30.
  let dagilim = await depoDagilimi(page, A, 'Galvaniz Boru')
  expect(await satirDegeri(dagilim, merkez)).toBe('10 adet')
  expect(await satirDegeri(dagilim, sube)).toBe('20 adet')
  expect(await satirDegeri(dagilim, 'Toplam')).toBe('30 adet')

  // 5–6. Yalnız Depo 1 = 5: önizleme eski → yeni miktarı gösteriyor; Depo 2 korunuyor.
  const ikinciDosya = [satir(A, 'Galvaniz Boru', merkez, '5')]
  const ikinci = await onizle(page, `merkez-sayim-${n}.csv`, ikinciDosya)
  expect(await kart(ikinci, 'Stoğu azalacak')).toBe(1)
  const degisim = ikinci.getByRole('row', { name: new RegExp(A) })
  await expect(degisim).toContainText('10 adet')
  await expect(degisim).toContainText('5 adet')
  await uygula(page)
  // Son uygulanan dosya ekranın üstünde, sonuçtan hemen sonra güncel (sayfadan çıkmadan).
  await expect(page.locator('section[aria-label="Son uygulanan envanter dosyası"]')).toContainText(
    new RegExp(`merkez-sayim-${n}\\.csv, .+ \\(tamamlandı\\)`),
  )
  dagilim = await depoDagilimi(page, A, 'Galvaniz Boru')
  expect(await satirDegeri(dagilim, merkez)).toBe('5 adet')
  expect(await satirDegeri(dagilim, sube)).toBe('20 adet')
  expect(await satirDegeri(dagilim, 'Toplam')).toBe('25 adet')

  // Araya başka bir sayım girsin (Depo 1 = 8); belirsiz kod hatalı gösteriliyor.
  const ucuncu = await onizle(page, `ara-sayim-${n}.csv`, [
    satir(A, 'Galvaniz Boru', merkez, '8'),
    satir(A.toLowerCase(), 'Küçük Harfli Kod', merkez, '1'),
  ])
  await expect(ucuncu).toContainText('1 belirsiz eşleşme')
  await expect(ucuncu).toContainText('Belirsiz eşleşme')
  await uygula(page)

  // 7. Aynı içerik başka adla: uyarı ve onay kutusu; onaysız düğme kapalı.
  const tekrar = await onizle(page, `merkez-sayim-kopya-${n}.csv`, ikinciDosya)
  await expect(tekrar.getByRole('alert')).toContainText(`daha önce uygulandı: merkez-sayim-${n}.csv`)
  const dugme = page.getByRole('button', { name: /satırı uygula/i })
  await expect(dugme).toBeDisabled()
  await page.getByLabel('Bu yeni bir sayımdır; dosyayı yeniden uygulamak istiyorum').check()
  await expect(dugme).toBeEnabled()
  await uygula(page)
  dagilim = await depoDagilimi(page, A, 'Galvaniz Boru')
  expect(await satirDegeri(dagilim, merkez)).toBe('5 adet')
  expect(await satirDegeri(dagilim, 'Toplam')).toBe('25 adet')
})

test('önizlemeden sonra değişen stok Çakışma olarak gösteriliyor, üzerine yazılmıyor', async ({ page, context }) => {
  const n = ek()
  const X = `CKS-${n}`
  const depo = `Çakışma Deposu ${n}`
  await girisYap(page, YONETICI)
  await onizle(page, `kurulum-${n}.csv`, [satir(X, 'Zincir', depo, '10')])
  await uygula(page)

  // Birinci sekme 6'yı önizledi (beklenen 10)…
  await onizle(page, `sayim-a-${n}.csv`, [satir(X, 'Zincir', depo, '6')])
  // …bu arada ikinci sekme depoyu 3'e getirdi.
  const ikinci = await context.newPage()
  await onizle(ikinci, `sayim-b-${n}.csv`, [satir(X, 'Zincir', depo, '3')])
  await uygula(ikinci)
  await ikinci.close()

  const sonuc = await uygula(page)
  await expect(sonuc.getByRole('status')).toContainText('1 satır yazılamadı')
  expect(await kart(sonuc, 'Çakışma')).toBe(1)
  await expect(sonuc.getByRole('row', { name: new RegExp(X) })).toContainText('Çakışma')

  const dagilim = await depoDagilimi(page, X, 'Zincir')
  expect(await satirDegeri(dagilim, depo)).toBe('3 adet')
})

test('çalışan envanter ekranını, bağlantısını ve raporunu göremiyor', async ({ page }) => {
  await girisYap(page, CALISAN)
  await page.goto('/stok')
  await expect(page.getByRole('link', { name: 'Envanteri güncelle' })).toHaveCount(0)

  await page.goto('/stok/envanter')
  await expect.poll(() => new URL(page.url()).pathname).toBe('/stok')

  const rapor = await page.request.get(`/api/rapor/aktarim?kayit=${crypto.randomUUID()}&tur=envanter`)
  expect(rapor.status()).toBe(403)
})
