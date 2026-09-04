import { type Page, expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T92 / T38 — FAZ 10'UN KULLANICI AKIŞLARI, GERÇEK TARAYICIDA
 *
 * NEDEN SUNUCU TESTLERİ YETMİYOR. `prices.test.ts` kuralın kendisini
 * kanıtlıyor: sapma sebepsiz kaydedilemiyor. Ama form o alanı hiç
 * göstermeseydi ya da gönderdiği adı yanlış yazsaydı SUNUCU TESTLERİ YİNE
 * YEŞİL YANARDI — ve kasadaki kişi anlamadığı bir hata ekranıyla kalırdı.
 * Kuralın var olması ile kullanıcının onu KULLANABİLMESİ ayrı iki şey.
 *
 * Bu dosyadaki üç senaryo elle tarayıcı turunda BULUNDU ve o tur bir kere
 * yapılıp kayboldu. Buraya yazılmalarının sebebi tam olarak bu: bir kez
 * bulunan hatanın bir daha kendiliğinden geri gelmemesi.
 *
 *   · sapma sebebi sorulmadan satış geçmiyor mu      (kontrolün kalbi)
 *   · geçmiş fiyat tarihi satışta kaçak açıyor mu    (T89 → T88)
 *   · hata dönüşünde MİKTAR sıfırlanıyor mu          (sessiz yanlış kayıt)
 *
 * Üçüncüsü en sinsisiydi: kullanıcı 5 yazıyor, hata alıyor, düzeltiyor ve
 * stoğa 1 giriyor — ikinci gönderim BAŞARILI olduğu için hiçbir uyarı
 * çıkmıyor. Sunucu bunu göremez; hata kullanıcı ile form arasında.
 *
 * BİLİNEN KARARSIZLIK (T109). Bu dosya ~9 koşudan 1'inde, sunucu eylemi
 * sonrası YÖNLENDİRME GERÇEKLEŞMESİNE RAĞMEN sayfanın yeniden render
 * edilmemesi yüzünden kırmızı yanıyor. Ölçülenler: adres doğru hata koduna
 * dönüyor, sunucu 303 veriyor, veritabanında bekleyen kilit YOK, giriş
 * ~350 ms, sayfa yüklemeleri ~180 ms — yani sunucu tarafı temiz, takılan
 * istemci yönlendiricisi. Kapsam CI'ya BAĞLANMADAN önce T109 çözülmeli;
 * kararsız bir kapı, kimsenin bakmadığı bir kapıya dönüşür.
 *
 * HER TESTİN KENDİ ÜRÜNÜ VAR. Testler aynı ürüne yazdığında birbirlerinin
 * stoğunu ve liste sırasını bozuyor, sonuç her koşuda BAŞKA bir testin
 * kırmızı yandığı bir küme oluyordu. Ürün stok koduyla seçiliyor (iş
 * kimliği, sabit), barkod ise ekrandan okunuyor — barkodlar seed'in
 * rastgele üretecinden geliyor ve sabit yazılsalardı üreteç değiştiğinde
 * bu dosya sessizce "tanımsız barkod" testine dönüşürdü.
 * ============================================================================
 */

const YONETICI = { email: 'admin@yilmaz.example', parola: 'admin123' }
const CALISAN = { email: 'ahmet@yilmazkirtasiye.example', parola: 'calisan123' }

async function girisYap(page: Page, hesap: { email: string; parola: string }) {
  await page.goto('/giris')
  await page.fill('input[name="email"]', hesap.email)
  await page.fill('input[name="parola"]', hesap.parola)
  await page.click('button[type="submit"]')
  await page.waitForURL('**/panel')
}

/**
 * Verilen stok kodundaki ürünün TEKLİ barkodunu ekrandan okur.
 *
 * HER TESTİN KENDİ ÜRÜNÜ VAR ve stok kodu testte SABİT. İlk taslakta
 * "stok listesindeki ilk ürün" kullanılıyordu ve testler birbirini
 * bozuyordu: her test o üründen satış yazıyor, stok değişiyor, listenin
 * sırası kayıyor ve bir sonraki test BAŞKA bir ürünle çalışıyordu. Sonuç
 * her koşuda farklı testin kırmızı yandığı bir küme oldu — yani en
 * güvenilmez test türü.
 *
 * Barkod yine EKRANDAN okunuyor: barkodlar seed'in rastgele üretecinden
 * geliyor ve sabit yazılsalardı üreteç değiştiğinde bu dosya sessizce
 * "tanımsız barkod" testine dönüşürdü. Stok kodu ise iş kimliği, sabit.
 */
async function barkodBul(page: Page, sku: string): Promise<string> {
  await page.goto(`/stok?ara=${encodeURIComponent(sku)}`)
  const satir = page.locator('tbody tr', { hasText: sku }).first()
  await expect(satir, `${sku} stok kodlu ürün bulunamadı`).toBeVisible()
  await satir.locator('a').first().click()
  await page.waitForSelector('h2:has-text("Barkodlar")')
  const barkodSatiri = page.locator('li', { hasText: 'Tekli' }).first()
  return (await barkodSatiri.locator('span').first().innerText()).trim()
}

/**
 * Hareket formunu barkod çözülmüş halde açar VE HİDRATASYONU BEKLER.
 *
 * `waitForSelector` tek başına YETMİYOR: alanlar sunucudan gelen HTML'de
 * zaten var, ama "Kaydet" bir SUNUCU EYLEMİ ve React o düğmeyi bağlamadan
 * basılırsa gönderim hiç olmuyor — sayfa öylece duruyor. Test de "hata
 * şeridi çıkmadı" diye kırmızı yanıyor, üstelik HER KOŞUDA BAŞKA bir
 * testte: yarışı kimin kazandığına bağlı.
 *
 * `networkidle` DENENDİ, YETMEDİ: RSC ön-yüklemeleri ağı öngörülemez
 * biçimde meşgul ediyor ve "boşta" anı hidratasyonla aynı ana denk
 * gelmiyor. Onun yerine React'in KENDİ izine bakıyoruz: React bir DOM
 * düğümünü hidratladığında ona `__reactFiber$...` özelliği ekliyor.
 * Bu özellik varsa form gerçekten bağlanmıştır.
 *
 * Uygulamaya `data-hydrated` gibi bir alan eklemek de kesin olurdu ama
 * ürün kodunu teste göre değiştirmek istemedik.
 */
async function hidrasyonBekle(page: Page) {
  await page.waitForFunction(
    () => {
      const form = document.querySelector('form[action]')
      return !!form && Object.keys(form).some((k) => k.startsWith('__reactFiber$'))
    },
    undefined,
    { timeout: 20_000 },
  )
}

async function hareketFormu(page: Page, barkod: string) {
  await page.goto(`/hareket?barkod=${encodeURIComponent(barkod)}`)
  await page.waitForSelector('select[name="sapma"]')
  await hidrasyonBekle(page)
}

const kaydet = (page: Page) => page.getByRole('button', { name: 'Kaydet' }).click()

/**
 * Ekrandaki hata şeridi.
 *
 * `getByRole('alert')` KULLANILMIYOR: Next.js'in rota anonsçusu
 * (`__next-route-announcer__`) da `role="alert"` taşıyor ve strict mode iki
 * eşleşme görüp testi patlatıyor. Anonsçu boş bir `<div>`, bizimki bir `<p>`.
 */
const uyari = (page: Page) => page.locator('p[role="alert"]')

/**
 * Sunucu eyleminin YÖNLENDİRMESİNİ bekler.
 *
 * `page.waitForURL()` KULLANILMIYOR: varsayılan `waitUntil: 'load'` bekliyor
 * ama sunucu eylemi sonrası yönlendirme App Router'da YUMUŞAK gezinme —
 * belge yeniden yüklenmiyor, `load` olayı hiç ateşlenmiyor ve bekleme
 * zaman aşımına düşüyor. Üstelik hata "zaman aşımı" diye görünüyor, oysa
 * uygulama doğru çalışmış oluyor. (Bu dosya yazılırken tam olarak bu oldu.)
 *
 * Onun yerine KULLANICININ GÖRDÜĞÜ şeyi bekliyoruz: hata şeridi ya da onay
 * şeridi. Zaten testin ölçmek istediği de bu.
 */
async function hataBekle(page: Page, kod: string) {
  // ÖNCE URL, sonra şerit. Ters sırada olsaydı yönlendirme beklenenden
  // farklı bir yere gittiğinde hata "şerit bulunamadı" diye görünür ve
  // GERÇEK adres hiç raporlanmazdı — teşhisi imkansız kılan tam olarak bu.
  await expect.poll(() => new URL(page.url()).searchParams.get('hata')).toBe(kod)
  // Adres YUMUŞAK gezinmede içerikten ÖNCE değişiyor: URL yeni, `<main>`
  // hâlâ boş. Şeridi doğrudan beklemek "öğe bulunamadı" diye patlıyordu,
  // çünkü o an sayfa segmenti henüz render edilmemişti. Formun geri
  // gelmesini beklemek, içeriğin yerine oturduğunun tek güvenilir işareti.
  await page.waitForSelector('select[name="sapma"]', { timeout: 20_000 })
  await expect(uyari(page)).toBeVisible()
  // Hata dönüşünden SONRA da hidratasyon bekleniyor: testlerin çoğu
  // düzeltip yeniden gönderiyor ve ikinci gönderim aynı yarışa giriyor.
  await hidrasyonBekle(page)
}

async function onayBekle(page: Page) {
  await expect(page.getByRole('status').first()).toContainText('kaydedildi')
}

/**
 * Fiyat alanına yazılacak metin.
 *
 * `String(168.34 - 10)` "158.34000000000003" veriyor ve zod 2 basamak
 * sınırında REDDEDİYOR — test de kasa açığı hatası yerine doğrulama hatası
 * görüp yanlış sebeple kırmızı yanıyor. Bu deponun miktarda kayan noktayı
 * yasaklamasının sebebi tam olarak bu; testin kendisi de aynı tuzağa düştü.
 */
const kurus = (n: number) => n.toFixed(2)

/**
 * Alanı doldurur ve DEĞERİN GERÇEKTEN GİRDİĞİNİ doğrular.
 *
 * `page.fill()` sessizce etkisiz kalabiliyor — bu dosya yazılırken fiyat
 * alanı boş kaldı ve test "sapma tespit edilmedi" diye kırmızı yandı; sebebi
 * bulmak yarım saat aldı çünkü hata, dolduran satırda DEĞİL üç satır sonra
 * görünüyordu. Doğrulama doldurmanın hemen yanında olmalı.
 */
async function doldur(page: Page, ad: string, deger: string) {
  const alan = page.locator(`input[name="${ad}"]`)
  await alan.fill(deger)
  await expect(alan, `${ad} alanına yazılan değer tutmadı`).toHaveValue(deger)
}

/** Ekranda yazan liste satış fiyatını sayıya çevirir ("168,34 ₺" → 168.34). */
async function listeFiyati(page: Page): Promise<number> {
  const metin = await page.locator('fieldset', { hasText: 'Liste satış fiyatı' }).first().innerText()
  const eslesme = metin.match(/Liste satış fiyatı:\s*([\d.]+),(\d{2})/)
  expect(eslesme, 'liste satış fiyatı ekranda okunamadı').not.toBeNull()
  return Number(`${eslesme![1]!.replaceAll('.', '')}.${eslesme![2]}`)
}

// `@kararsiz` ETİKETİ KALDIRILDI — bu testler artık CI kapısında (T105/T109).
//
// Etiket bu dosyayı CI'dan çıkarıyordu ve gerekçesi "kararsız testler"di.
// YANLIŞTI: testler kırılgan değildi, gerçek bir ürün hatasını yakalıyorlardı.
// Ölçüldü (üretim derlemesi, gerçek tarayıcı): "Kaydet"e basıldığında sunucu
// eylemi çalışıyor ve 303 dönüyor, ama Next 15'in istemci yönlendiricisi
// turların 3-5'inde o yönlendirmeyi SESSİZCE düşürüyordu — konsolda hata
// yok, ağda hata yok, `framenavigated` hiç ateşlenmiyor. Kullanıcı için:
// "Kaydet'e bastım, hiçbir şey olmadı."
//
// Next 16'da arıza yok: aynı ölçüm 0/24. Bu dosyanın 9 senaryosu da yeşil.
//
// DERS: bir testi "kararsız" diye kapı dışına koymadan önce arızanın
// KENDİSİNİN olasılıksal olabileceği düşünülmeli. Bu etiket dört ay
// boyunca gerçek bir P1'i "test sorunu" gibi gösterebilirdi.
test.describe('Faz 10 — kasa açığı ve açılış değerlemesi', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
    })
  })

  test('liste satış fiyatı formda YAZIYOR', async ({ page }) => {
    // Yazmasaydı çalışan sapıp sapmadığını bilemezdi ve "sebep seçin"
    // uyarısı anlamsız bir engel gibi görünürdü.
    await girisYap(page, CALISAN)
    await hareketFormu(page, await barkodBul(page, 'YIL-0002'))

    expect(await listeFiyati(page)).toBeGreaterThan(0)
    await expect(page.locator('input[name="fiyat"]')).toBeVisible()
    await expect(page.locator('select[name="sapma"]')).toBeVisible()
  })

  test('SAPMA SEBEBİ SEÇMEDEN SATIŞ GEÇMİYOR — kontrolün kalbi', async ({ page }) => {
    await girisYap(page, CALISAN)
    const barkod = await barkodBul(page, 'YIL-0003')
    await hareketFormu(page, barkod)

    const liste = await listeFiyati(page)
    await page.check('input[name="sebep"][value="SALE"]')
    await doldur(page, 'miktar', '5')
    await doldur(page, 'fiyat', kurus(liste - 10))
    await kaydet(page)

    await hataBekle(page, 'PRICE_OVERRIDE_REASON_REQUIRED')
    await expect(uyari(page)).toContainText('Sapma sebebi seçmelisiniz')

    // MİKTAR KORUNUYOR MU. Korunmazsa kullanıcı sebebi seçip kaydeder ve
    // stoğa 5 yerine 1 girer — üstelik BAŞARI ekranı görerek.
    await expect(page.locator('input[name="miktar"]')).toHaveValue('5')
    await expect(page.locator('input[name="sebep"]:checked')).toHaveValue('SALE')

    // Sebep seçilince aynı gönderim kabul ediliyor.
    await page.selectOption('select[name="sapma"]', 'TANIDIK')
    await kaydet(page)
    await onayBekle(page)
  })

  test('"Diğer" sebebinde açıklama ZORUNLU', async ({ page }) => {
    // Açıklamasız "Diğer", raporda "bu ay 4.200 ₺ Diğer" satırı demek —
    // ve kimse nedenini öğrenemez.
    await girisYap(page, CALISAN)
    const barkod = await barkodBul(page, 'YIL-0004')
    await hareketFormu(page, barkod)

    const liste = await listeFiyati(page)
    await page.check('input[name="sebep"][value="SALE"]')
    await doldur(page, 'miktar', '1')
    await doldur(page, 'fiyat', kurus(liste - 5))
    await page.selectOption('select[name="sapma"]', 'DIGER')
    await kaydet(page)

    await hataBekle(page, 'VALIDATION_FAILED')
    await expect(uyari(page)).toContainText('açıklama zorunlu')

    await doldur(page, 'not', 'Müşteri şikayeti sonrası indirim')
    await page.selectOption('select[name="sapma"]', 'DIGER')
    await kaydet(page)
    await onayBekle(page)
  })

  test('SATIŞTA GEÇMİŞ FİYAT TARİHİ REDDEDİLİYOR — kasa açığı kaçağı kapalı', async ({ page }) => {
    // Serbest bırakılsaydı kontrol tek alanla atlanırdı: çalışan fiyat
    // tarihine dünü yazar, liste karşılaştırması düşer, açık sebepsiz
    // kaydedilirdi.
    await girisYap(page, CALISAN)
    await hareketFormu(page, await barkodBul(page, 'YIL-0005'))

    await page.check('input[name="sebep"][value="SALE"]')
    await doldur(page, 'miktar', '1')
    await doldur(page, 'fiyat', '1,00')
    await doldur(page, 'fiyatTarihi', '2021-01-15')
    await kaydet(page)

    await hataBekle(page, 'PRICE_DATE_INVALID')
    await expect(uyari(page)).toContainText('bugünden eski olamaz')
  })

  test('devirde birim fiyat ZORUNLU, geçmiş tarihli fatura sebep sormuyor', async ({ page }) => {
    await girisYap(page, YONETICI)
    await hareketFormu(page, await barkodBul(page, 'YIL-0006'))

    // Fiyatsız devir reddediliyor: defter append-only, o satırın değeri
    // sonradan EKLENEMEZ.
    await page.check('input[name="sebep"][value="OPENING"]')
    await doldur(page, 'miktar', '4')
    await kaydet(page)
    await hataBekle(page, 'PRICE_REQUIRED')
    await expect(uyari(page)).toContainText('birim fiyat zorunlu')
    await expect(page.locator('input[name="miktar"]')).toHaveValue('4')

    // 5 yıl önceki fatura: liste fiyatıyla kıyaslanmıyor, sebep sorulmuyor.
    // Aradaki fark indirim değil ENFLASYON.
    await doldur(page, 'fiyat', '1,00')
    await doldur(page, 'fiyatTarihi', '2021-01-15')
    await kaydet(page)
    await onayBekle(page)

    await page.goto('/hareketler')
    await page.waitForSelector('tbody tr')
    await expect(page.locator('tbody tr').first()).toContainText('15.01.2021')
  })

  test('"tahmini" işareti hareket logunda görünüyor', async ({ page }) => {
    // Toplanıp gösterilmeseydi tahmin ile ölçülmüş fiyat tabloda AYNI
    // görünürdü ve kullanıcı hangisine güveneceğini bilemezdi.
    await girisYap(page, YONETICI)
    await hareketFormu(page, await barkodBul(page, 'YIL-0007'))

    await page.check('input[name="sebep"][value="OPENING"]')
    await doldur(page, 'miktar', '2')
    await doldur(page, 'fiyat', '60,00')
    await page.check('input[name="tahmini"]')
    await kaydet(page)
    await onayBekle(page)

    await page.goto('/hareketler')
    await page.waitForSelector('tbody tr')
    await expect(page.locator('tbody tr').first()).toContainText('tahmini')
  })

  test('fark hareket logunda GÖRÜNÜYOR: liste, gerçekleşen ve sebep', async ({ page }) => {
    // Kayıt tek başına takip değil. Açık ancak iki sayı YAN YANA durunca
    // okunur; sebep olmadan da "bu ay tanıdık indirimine kaç lira gitti"
    // sorusu cevapsız kalır.
    await girisYap(page, YONETICI)
    await page.goto('/hareketler?sebep=SALE')
    await page.waitForSelector('tbody tr')

    await expect(page.getByRole('columnheader', { name: 'Sapma' })).toBeVisible()
    const sapmali = page.locator('tbody tr', { hasText: 'fark' }).first()
    await expect(sapmali).toContainText('liste')
    await expect(sapmali).toContainText('₺')
  })

  test('D7: çalışan satış fiyatını görüyor, ALIŞ fiyatını görmüyor', async ({ page }) => {
    // Satış fiyatı ticari sır değil — müşteri zaten biliyor. Alış fiyatı
    // tehdit S7'nin koruduğu şey ve `OPENING` de bir alış değerlemesidir.
    await girisYap(page, CALISAN)
    await page.goto('/hareketler')
    await page.waitForSelector('tbody tr')

    // Sütun başlığı CEVAPTAN türüyor: çalışanın gördüğü fiyatların hepsi
    // satış dayanaklı olduğu için başlık "Satış fiyatı".
    await expect(page.getByRole('columnheader', { name: 'Satış fiyatı' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Birim fiyat' })).toHaveCount(0)

    // KARIŞIK LİSTEDE alış satırında "gizli" yazıyor — boş değil. Boş hücre
    // "fiyat girilmemiş" demek olurdu ve çalışan ikisini ayırt edemezdi.
    //
    // Filtre `?sebep=PURCHASE` ile denenMEZ: o listede görülebilir tek bir
    // fiyat kalmadığı için sütun HİÇ ÇİZİLMİYOR (sütun cevaptan türüyor) ve
    // "gizli" de doğal olarak çıkmıyor. Doğru davranış bu — baştan sona boş
    // bir sütun gürültüden başka bir şey değil — ama testin ölçmesi gereken
    // durum karışık liste.
    await page.goto('/hareketler')
    await page.waitForSelector('tbody tr')
    const gizliSatir = page.locator('tbody tr', { hasText: 'gizli' }).first()
    await expect(gizliSatir).toBeVisible()
    // "gizli" yazan satır SATIŞ OLMAMALI; satışta fiyat açık.
    //
    // "giriş olmalı" DEĞİL: tedarikçiye iade (`RETURN_OUT`) bir çıkış ama
    // dayanağı alış fiyatı, o yüzden o da gizleniyor. Kural yönden değil
    // `priceBasis`'ten türüyor ve test de öyle sormalı.
    await expect(gizliSatir).not.toContainText('Satış')
  })

  test('yönetici hareket raporunu indirebiliyor', async ({ page }) => {
    // Başarı ölçütü: "geçen ay bu maldan kaça satmışız" sorusu Excel'den
    // cevaplanabilmeli. Sütunların İÇERİĞİ `excel.test.ts`'in işi; burada
    // sorulan tek şey ucun gerçekten çalışan bir dosya döndürdüğü.
    //
    // `page.goto` KULLANILMIYOR: indirme başlayınca gezinme iptal ediliyor
    // ve Playwright bunu hata sayıyor. Oturum çerezi `page.request` ile
    // paylaşıldığı için istek yine oturum açmış kullanıcı adına gidiyor.
    await girisYap(page, YONETICI)
    const cevap = await page.request.get('/api/rapor/hareket?sebep=SALE')

    expect(cevap.status()).toBe(200)
    expect(cevap.headers()['content-type']).toContain('spreadsheetml')
    expect(cevap.headers()['content-disposition']).toMatch(/\.xlsx/)
  })
})
