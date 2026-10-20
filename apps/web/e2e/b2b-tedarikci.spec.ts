import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * ============================================================================
 * T200 — B2B V1 TEDARİKÇİ VERİSİ, GERÇEK TARAYICIDA
 *
 * Sunucu tarafı `packages/core/src/suppliers.test.ts` ve eylem testlerinde.
 * Burada sorulan: EKRAN onu doğru çağırıyor mu, kullanıcı ne gördüğünü
 * anlıyor mu, çalışan tedarikçi fiyatını hiçbir yoldan görmüyor mu.
 *
 * HER TEST KENDİ VERİSİNİ ÜRETİYOR (ürün, tedarikçi, dosya): seed barkoduna
 * yaslanmıyor. Demo veritabanına yazıyor (T150).
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

/** Yumuşak gezinmede `waitForURL` ateşlenmiyor: adresi yokla (t38'deki gerekçe). */
async function adresBekle(page: Page, parca: string) {
  await expect
    .poll(() => page.url(), { message: `adres '${parca}' içermiyor`, timeout: 15_000 })
    .toContain(parca)
}

/** Düğmeyi ADIYLA seç: sayfadaki ilk gönderme düğmesi kenar çubuğundaki "Çıkış yap". */
async function bas(page: Page, ad: RegExp | string) {
  await page.getByRole('button', { name: ad }).click()
}

/** UI'dan ürün açar, kimliğini döner. */
async function urunAc(page: Page, urun: { sku: string; ad: string; barkod: string }): Promise<string> {
  await page.goto('/urunler/yeni')
  await page.fill('input[name="barkod"]', urun.barkod)
  await page.fill('input[name="sku"]', urun.sku)
  await page.fill('input[name="ad"]', urun.ad)
  await bas(page, 'Kaydet')
  await adresBekle(page, 'yeni=1')
  return new URL(page.url()).pathname.split('/').pop()!
}

/** Tedarikçi açar, detay sayfasına gelinmiş olur; kimliğini döner. */
async function tedarikciAc(
  page: Page,
  t: { ad: string; birimBeyani: boolean },
): Promise<string> {
  await page.goto('/tedarikciler')
  const form = page.locator('form#yeni-tedarikci')
  await form.locator('input[name="ad"]').fill(t.ad)
  await form.locator('select[name="kdv"]').selectOption('EXCLUDED')
  await form.locator('select[name="fiyatTuru"]').selectOption('NET')
  if (t.birimBeyani) await form.locator('select[name="fiyatMiktari"]').selectOption('1')
  await bas(page, 'Tedarikçiyi ekle')
  await adresBekle(page, 'yeni=1')
  return new URL(page.url()).pathname.split('/').pop()!
}

/** Dosyayı BELLEKTEN yükler, önizler; önizleme bölümünü döner. */
async function onizle(page: Page, satirlar: string[]) {
  await page.setInputFiles('input[name="dosya"]', {
    name: 'liste.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(satirlar.join('\n'), 'utf-8'),
  })
  await bas(page, /oku ve önizle/i)
  const onizleme = page.locator('section[aria-label="Önizleme"]')
  await expect(onizleme, 'önizleme gelmedi').toBeVisible()
  return onizleme
}

/** Önizlenen dosyayı kaydeder ve sonucun gelmesini bekler. */
async function kaydetVeBekle(page: Page, kalem: number) {
  await bas(page, `${kalem} kalemi kaydet`)
  await expect(page.getByRole('status').filter({ hasText: 'kaydedildi' })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test('YÖNETİCİ: tedarikçi açar, önizler, kaydeder, eşleştirir; fiyat değişimi ve karşılaştırma görünür', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const n = ek()
  const urun = { sku: `B2B-${n}`, ad: `B2B Kalemi ${n}`, barkod: `869${n}7` }
  const elleUrun = { sku: `B2B-${n}-E`, ad: `Elle Bağlanan ${n}`, barkod: `869${n}8` }

  await girisYap(page, YONETICI)
  const urunId = await urunAc(page, urun)
  await urunAc(page, elleUrun)

  // 1) Beyanlı tedarikçi: "1 ürün birimi" AÇIKÇA seçiliyor.
  await tedarikciAc(page, { ad: `Beyanlı Toptan ${n}`, birimBeyani: true })
  await expect(page.locator('main')).toContainText('Tedarikçi eklendi')

  // 2) Önizleme dosyanın NASIL okunduğunu gösteriyor; fiyat onayı değil.
  const onizleme = await onizle(page, [
    'Kod;Barkod;Ürün Adı;Fiyat;Koli İçi Adet',
    `A-${n};${urun.barkod};Kalem;12,50;12`,
    `B-${n};;Silgi ${n};3;1`,
    `C-${n};;Bozuk;;1`,
  ])
  await expect(onizleme, 'okunmayan sütun söylenmedi').toContainText('Okunmayan sütunlar: Koli İçi Adet')
  await expect(onizleme, 'okunan fiyat Türkçe biçimde görünmüyor').toContainText('12,50 TL')
  await expect(onizleme, 'barkod eşleşmesi önizlemede yok').toContainText(urun.ad)
  await expect(onizleme).toContainText('Fiyat boş')

  await kaydetVeBekle(page, 2)

  // 3) Eşleşmeyen kalem bekleyenlerde; ürün arayıp elle bağla.
  const bekleyenler = page.locator('section[aria-label="Eşleşme bekleyenler"]')
  await expect(bekleyenler).toContainText(`Silgi ${n}`)
  await bekleyenler.getByRole('link', { name: 'Ürün ara' }).click()
  // Bağlantı YUMUŞAK gezinme: adres hemen değişiyor ama panel ancak sunucu
  // yanıtı gelince çiziliyor. Kutuya o andan önce yazılan metin yeniden
  // çizimde kayboluyor ve form kalemin adıyla gidiyordu. Panelin GERÇEKTEN
  // çizildiği, önceden doldurulmuş değerinden bekleniyor (T109'un dersi).
  const aramaKutusu = page.getByRole('searchbox', { name: 'Ürün adı, stok kodu ya da barkod' })
  await expect(aramaKutusu, 'bağlama paneli açılmadı').toHaveValue(`Silgi ${n}`)
  await aramaKutusu.fill(elleUrun.sku)
  await page.getByRole('button', { name: 'Ara', exact: true }).click()
  await expect(page.locator('main')).toContainText(elleUrun.ad)
  await bas(page, 'Bu ürüne bağla')
  await adresBekle(page, 'baglandi=1')
  await expect(page.locator('section[aria-label="Eşleşme bekleyenler"]')).toContainText(
    'Eşleşme bekleyen kalem yok',
  )

  // 4) Değişen fiyat: yön ve yüzde (12,50 → 13,75 = %10,0 artış).
  const ikinci = await onizle(page, ['Kod;Barkod;Ürün Adı;Fiyat', `A-${n};${urun.barkod};Kalem;13,75`])
  await expect(ikinci).toContainText('Fiyatı artan')
  await kaydetVeBekle(page, 1)
  await expect(page.locator('section[aria-label="Son fiyat değişimleri"]')).toContainText('%10,0 arttı')

  // 5) Beyansız tedarikçi: fiyat miktarı VARSAYILAN olarak belirsiz.
  await page.goto('/tedarikciler')
  await expect(
    page.locator('form#yeni-tedarikci select[name="fiyatMiktari"] option:checked'),
  ).toHaveText('Belirsiz')
  await tedarikciAc(page, { ad: `Beyansız Toptan ${n}`, birimBeyani: false })
  await onizle(page, ['Barkod;Ürün Adı;Fiyat', `${urun.barkod};Kalem;11`])
  await kaydetVeBekle(page, 1)

  // 6) Ürün sayfası: beyanlı teklif kendi koşul grubunda, beyansız ayrı ve sırasız.
  await page.goto(`/urunler/${urunId}`)
  const fiyatlar = page.locator('aside[aria-label="Tedarikçi fiyatları"]')
  await expect(fiyatlar).toContainText('TL · KDV hariç · Net alış · 1 adet')
  await expect(fiyatlar).toContainText('13,75 TL')
  await expect(fiyatlar).toContainText(`Beyanlı Toptan ${n}`)
  const belirsiz = fiyatlar.locator('section[aria-label="Fiyat miktarı belirsiz"]')
  await expect(belirsiz).toContainText(`Beyansız Toptan ${n}`)
  await expect(belirsiz).toContainText('11,00 TL')
  // Tek teklifli grupta "en düşük" anlamsız; belirsiz teklif sıralamaya girmiyor.
  await expect(fiyatlar).not.toContainText('En düşük fiyat')
  await expect(fiyatlar).toContainText('Tedarikçi stoğu')
})

test('YÖNETİCİ: uzun adlı kalemde ürün arama açılır; uzun değer satır hatası, kayıt engellenmez', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const n = ek()
  const urun = { sku: `B2L-${n}`, ad: `Arama Hedefi ${n}`, barkod: `869${n}4` }
  const dolgu = 'kalem defter silgi '.repeat(70)
  const uzunAd = (etiket: string, uzunluk: number) => `${etiket} ${n} ${dolgu}`.slice(0, uzunluk)
  const ad150 = uzunAd('Uzun150', 150)
  const ad300 = uzunAd('Uzun300', 300)
  expect(ad150).toHaveLength(150)
  expect(ad300).toHaveLength(300)
  // 210 okunmayan sütun: kayıt şeması 200'de kesiyordu (REVIEW B1).
  const ek210 = Array.from({ length: 210 }, (_, i) => `Ek ${i + 1}`)
  const satir = (...hucre: string[]) => [...hucre, ...ek210.map(() => 'x')].join(';')

  await girisYap(page, YONETICI)
  await urunAc(page, urun)
  await tedarikciAc(page, { ad: `Uzun Ad Toptan ${n}`, birimBeyani: true })
  const onizleme = await onizle(page, [
    ['Kod', 'Ürün Adı', 'Fiyat', ...ek210].join(';'),
    satir(`L150-${n}`, ad150, '10'),
    satir(`L300-${n}`, ad300, '11'),
    satir(`L1200-${n}`, uzunAd('Uzun1200', 1_200), '12'),
  ])
  await expect(onizleme).toContainText('…ve 10 sütun daha')
  await expect(onizleme, 'uzun değer Türkçe satır hatası değil').toContainText(
    'Ürün adı en fazla 300 karakter olabilir',
  )
  await kaydetVeBekle(page, 2)

  // Arama en fazla 100 karakter: kutu adın başıyla dolar, sayfa düşmez (REVIEW B2).
  const bekleyenler = page.locator('section[aria-label="Eşleşme bekleyenler"]')
  const kutu = page.getByRole('searchbox', { name: 'Ürün adı, stok kodu ya da barkod' })
  for (const ad of [ad150, ad300]) {
    await bekleyenler.locator('li', { hasText: ad.slice(0, 15) }).getByRole('link', { name: 'Ürün ara' }).click()
    await expect(kutu, 'bağlama paneli açılmadı').toHaveValue(ad.slice(0, 100).trim())
    await expect(page.getByText('Bu ekran yüklenemedi')).toHaveCount(0)

    // Kutu düzenlenebilir: kullanıcı aramayı değiştirir.
    await kutu.fill(urun.sku)
    await page.getByRole('button', { name: 'Ara', exact: true }).click()
    await expect(page.locator('main')).toContainText(urun.ad)
  }
})

test('ÇALIŞAN: menüde tedarikçi yok, adres panele döner, ürün sayfası tedarikçi fiyatı taşımaz', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const n = ek()
  const urun = { sku: `B2C-${n}`, ad: `Gizli Fiyatlı ${n}`, barkod: `869${n}6` }
  // Ayırt edilebilir bir fiyat: sayfanın HERHANGİ bir yerinde görünürse sızıntıdır.
  const fiyat = '987,65'

  await girisYap(page, YONETICI)
  const urunId = await urunAc(page, urun)
  await tedarikciAc(page, { ad: `Gizli Toptan ${n}`, birimBeyani: true })
  await onizle(page, ['Barkod;Ürün Adı;Fiyat', `${urun.barkod};Gizli;${fiyat}`])
  await kaydetVeBekle(page, 1)
  await page.context().clearCookies()

  await girisYap(page, CALISAN)
  await expect(page.getByRole('link', { name: 'Tedarikçiler' })).toHaveCount(0)

  await page.goto('/tedarikciler')
  await adresBekle(page, '/panel')

  await page.goto(`/urunler/${urunId}`)
  await expect(page.locator('main')).toContainText(urun.ad)
  await expect(page.locator('aside[aria-label="Tedarikçi fiyatları"]')).toHaveCount(0)
  // Görünmeyen yerler de: sunucunun gönderdiği HTML ve RSC verisi.
  const html = await page.content()
  expect(html, 'tedarikçi fiyatı çalışanın sayfasına gitti').not.toContain('987,65')
  expect(html, 'tedarikçi fiyatı çalışanın sayfasına gitti').not.toContain('987.65')
  expect(html).not.toContain(`Gizli Toptan ${n}`)
})

/** Belgenin görünür alandan taşan genişliği; 0 ya da eksi = yatay kaydırma yok. */
function yatayTasma(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test('MOBİL: tedarikçi ve ürün sayfası yatay kaymıyor, tedarikçi fiyatları barkodlardan sonra', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const n = ek()
  const urun = { sku: `B2M-${n}`, ad: `Mobil Ürün ${n}`, barkod: `869${n}5` }

  await girisYap(page, YONETICI)
  const urunId = await urunAc(page, urun)
  const tedarikciId = await tedarikciAc(page, { ad: `Mobil Toptan ${n}`, birimBeyani: true })
  // Doğrulamanın izin verdiği en uzun (100) boşluksuz kod: biri ürüne bağlanıp
  // ürün sayfasında, öteki eşleşme bekleyenlerde görünüyor. Kırılmayan kod dar
  // ekranda bütün sayfayı yatay kaydırıyordu.
  const uzunKod = (son: string) => `M${n}`.padEnd(99, 'X') + son
  await onizle(page, [
    'Tedarikçi Kodu;Barkod;Ürün Adı;Fiyat;Stok',
    `${uzunKod('A')};${urun.barkod};Mobil;45,5;120`,
    `${uzunKod('B')};;Eşleşmeyen Mobil;12;3`,
  ])
  await kaydetVeBekle(page, 2)

  await page.setViewportSize({ width: 390, height: 844 })
  // Kalem tablosu kendi kutusunda kaymalı. Başlıktaki `sr-only` etiketi
  // kutunun kırpmasından kaçınca bütün sayfa 754 px'e genişliyordu.
  // `toBeVisible` önce: Next içeriği yükleme iskeletinin yanına önce GİZLİ bir
  // kapsayıcıda akıtıyor ve `toContainText` oradaki metni de eşliyor. Ölçüm o
  // anda alınınca ekranda hâlâ iskelet vardı; taşma korumasız da "yok" çıktı.
  await page.goto(`/tedarikciler/${tedarikciId}`)
  const kalemler = page.locator('section[aria-label="Kalemler"]')
  await expect(kalemler).toBeVisible()
  await expect(kalemler).toContainText('Mobil')
  expect(await yatayTasma(page), 'tedarikçi sayfası yatay kayıyor').toBeLessThanOrEqual(0)

  await page.goto(`/urunler/${urunId}`)
  const fiyatlar = page.locator('aside[aria-label="Tedarikçi fiyatları"]')
  await expect(fiyatlar).toBeVisible()
  await expect(fiyatlar).toContainText('45,50 TL')

  const barkodlar = await page.locator('section[aria-label="Barkodlar"]').boundingBox()
  const bolum = await fiyatlar.boundingBox()
  expect(bolum!.y, 'tedarikçi fiyatları barkodların altında değil').toBeGreaterThan(barkodlar!.y)

  expect(await yatayTasma(page), 'ürün sayfası yatay kayıyor').toBeLessThanOrEqual(0)
})
