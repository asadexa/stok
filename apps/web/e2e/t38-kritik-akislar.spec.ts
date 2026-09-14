import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * ============================================================================
 * T38 — KRİTİK AKIŞLAR (PLAN.md Bölüm 6)
 *
 * `demo-yolu.spec.ts` kurulumdan girişe giden yolu yürüyor, `faz10-fiyat`
 * fiyat ve kasa açığı akışlarını. Bu dosya kalan kritik akışları kapatıyor:
 * ürün ekleme, arama, kullanıcı yönetimi ve toplu yükleme.
 *
 * NEDEN TARAYICI. Bu akışların hepsinin sunucu tarafı testi zaten var
 * (`packages/core`). Sunucu testleri "servis doğru çalışıyor mu" diyor;
 * burada sorulan "EKRAN o servisi doğru çağırıyor mu". İkisi farklı: bu
 * depoda kullanıcıya görünen dört hata yalnızca gerçek tarayıcıda bulundu,
 * ve hepsinde sunucu testleri yeşildi.
 *
 * HER TEST KENDİ VERİSİNİ ÜRETİYOR. Ortak fixture'a yaslanan testler
 * birbirinin verisini bozar ve arıza "bazen kırmızı" olarak görünür — bu
 * depoda o hatanın bedeli T109'da ölçüldü.
 * ============================================================================
 */

const YONETICI = { email: 'admin@yilmaz.example', parola: 'admin123' }
const CALISAN = { email: 'ahmet@yilmazkirtasiye.example', parola: 'calisan123' }

/** Testler arası çakışmasın diye her koşu kendi ekini alıyor. */
const ek = () => Date.now().toString().slice(-7)

async function girisYap(page: Page, hesap: { email: string; parola: string }) {
  await page.goto('/giris')
  await page.fill('input[name="email"]', hesap.email)
  await page.fill('input[name="parola"]', hesap.parola)
  // Giriş ekranında tek gönderme düğmesi var ama yine de ADIYLA: kabuk
  // buraya bir gün eklenirse sessizce yanlış düğmeye basılmasın.
  await page.getByRole('button', { name: 'Giriş yap' }).click()
  await page.waitForURL('**/panel')
}

/**
 * Sunucu eyleminin sonucunu bekler.
 *
 * `waitForURL` KULLANILMIYOR: varsayılan `waitUntil: 'load'` bekliyor ama
 * sunucu eylemi sonrası yönlendirme App Router'da yumuşak gezinme — belge
 * yeniden yüklenmiyor, `load` hiç ateşlenmiyor ve bekleme zaman aşımına
 * düşüyor. Üstelik hata "zaman aşımı" diye görünüyor, oysa uygulama doğru
 * çalışmış oluyor.
 */
async function adresBekle(page: Page, parca: string) {
  // Hata mesajına GERÇEK adres giriyor. Olmadan "beklenen bulunamadı" der
  // ve nereye gidildiği hiç raporlanmaz — teşhisi imkansız kılan tam olarak bu.
  await expect
    .poll(() => page.url(), { message: `adres '${parca}' içermiyor`, timeout: 15_000 })
    .toContain(parca)
}

/**
 * OTURUMU KAPATIR.
 *
 * Giriş yapmış bir kullanıcı `/giris` adresine giderse sunucu onu `/panel`e
 * yönlendiriyor ve giriş formu HİÇ render edilmiyor. Çerezi temizlemeden
 * ikinci bir hesapla giriş denemek, form alanını sonsuza kadar beklemek
 * demek (ölçüldü: 60 sn zaman aşımı).
 */
async function cikisYap(page: Page) {
  await page.context().clearCookies()
}

/**
 * Formun KENDİ gönderme düğmesine basar.
 *
 * `page.click('button[type="submit"]')` KULLANILMIYOR — ve bunun bedeli
 * ölçüldü: sayfadaki İLK gönderme düğmesi kenar çubuğundaki **"Çıkış yap"**.
 * Yani "Kaydet" sanılan her tıklama kullanıcıyı sistemden atıyordu ve test,
 * ürün kaydetme akışı bozukmuş gibi kırmızı yanıyordu. Kabuk her sayfada
 * render edildiği için bu tuzak BÜTÜN panel ekranlarında geçerli.
 *
 * Düğme ADIYLA seçiliyor: kullanıcının gördüğü şey de bu.
 */
async function kaydet(page: Page, ad: RegExp | string = 'Kaydet') {
  await page.getByRole('button', { name: ad }).click()
}

test.beforeEach(async ({ page }) => {
  // Sunucu kusurlarını yüzeye çıkar: teşhis kimseye ulaşmazsa hatanın
  // kendisinden pahalıya mal oluyor (T61'in dersi).
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })
})

test.describe('ürün ekleme ve arama', () => {
  test('YÖNETİCİ ürün ekliyor, ürün ARAMADA ve HAREKET ekranında çıkıyor', async ({ page }) => {
    const n = ek()
    const sku = `E2E-${n}`
    const barkod = `869${n}9`
    const ad = `Testte Eklenen Ürün ${n}`

    await girisYap(page, YONETICI)
    await page.goto('/urunler/yeni')

    await page.fill('input[name="barkod"]', barkod)
    await page.fill('input[name="sku"]', sku)
    await page.fill('input[name="ad"]', ad)
    await page.fill('input[name="satis"]', '42.50')
    await kaydet(page)

    // Ürün gerçekten oluştu mu: kaydın KENDİ sayfasına gidilmiş olmalı.
    // `'/urunler/'` beklemek YETMEZ — başlangıç adresi (`/urunler/yeni`)
    // zaten onu içeriyor ve bekleme anında geçerdi. `?yeni=1` yalnızca
    // başarılı kayıttan sonra ekleniyor.
    await adresBekle(page, 'yeni=1')

    // ARAMA. Ürünü SKU ile arıyoruz; ekleme başarılı ama index'e girmemiş
    // olsaydı burada görünmezdi.
    await page.goto(`/stok?ara=${sku}`)
    await expect(page.locator('main')).toContainText(ad)

    /**
     * ASIL KONTROL: yeni ürün BARKODLA okutulabiliyor mu.
     *
     * Ürün ekleme akışının varlık sebebi bu. Ürün kaydedilip barkodu
     * bağlanmasaydı liste ekranı doğru görünür, ama depoda okutulduğunda
     * "barkod tanımlı değil" derdi — ve bu, ekrana bakarak anlaşılmaz.
     */
    await page.goto(`/hareket?barkod=${barkod}`)
    await expect(page.locator('main')).toContainText(ad)
    await expect(page.locator('input[name="miktar"]')).toBeVisible()
  })

  test('AYNI SKU ikinci kez eklenemiyor', async ({ page }) => {
    const n = ek()
    const sku = `E2E-TEK-${n}`

    await girisYap(page, YONETICI)

    for (const tur of [1, 2]) {
      await page.goto('/urunler/yeni')
      await page.fill('input[name="barkod"]', `869${n}${tur}`)
      await page.fill('input[name="sku"]', sku)
      await page.fill('input[name="ad"]', `Tekil ${n}`)
      await kaydet(page)

      if (tur === 1) {
        await adresBekle(page, 'yeni=1')
      } else {
        // İkinci kayıt REDDEDİLMELİ ve sebebi EKRANDA yazmalı. Sessizce
        // ikinci bir ürün oluşsaydı, iki farklı stok satırı aynı ürünü
        // gösterirdi ve sayım hiç tutmazdı.
        await adresBekle(page, 'hata=SKU_EXISTS')
        await expect(page.locator('p[role="alert"]')).toBeVisible()
      }
    }
  })

  test('ÇALIŞAN ürün ekleme ekranına giremiyor', async ({ page }) => {
    // Arayüzde buton gizlemek yetki kontrolü DEĞİL: çalışan adresi
    // doğrudan yazabilir. Sınırın sunucuda durması gerekiyor (tehdit S6).
    await girisYap(page, CALISAN)
    await page.goto('/urunler/yeni')

    // Yönlendirme YUMUŞAK olabilir; adresi yoklayarak bekliyoruz.
    await expect
      .poll(() => page.url(), { timeout: 15_000 })
      .not.toContain('/urunler/yeni')
    await expect(page.locator('main')).not.toContainText('Kaydet')
  })
})

test.describe('kullanıcı yönetimi', () => {
  test('YÖNETİCİ kullanıcı ekliyor, kullanıcı GİRİŞ YAPABİLİYOR', async ({ page }) => {
    const n = ek()
    const email = `e2e${n}@ornek.test`
    const parola = 'gecici-parola-123'

    await girisYap(page, YONETICI)
    await page.goto('/kullanicilar')

    await page.fill('input[name="ad"]', `E2E Kullanıcı ${n}`)
    await page.fill('input[name="email"]', email)
    await page.fill('input[name="parola"]', parola)
    await kaydet(page, /kullanıcıyı ekle/i)
    // Liste e-postayı DEĞİL adı gösteriyor (tarayıcıda ölçüldü); e-postayı
    // beklemek testi sonsuza kadar bekletirdi.
    await expect(page.locator('main')).toContainText(`E2E Kullanıcı ${n}`)

    /**
     * ASIL KONTROL: kullanıcı GERÇEKTEN girebiliyor mu.
     *
     * Listede satır görmek yetmez — parola özeti yanlış yazılsaydı satır
     * yine görünürdü ve hata ancak yeni çalışan işe başladığı sabah
     * ortaya çıkardı.
     */
    await cikisYap(page)
    await girisYap(page, { email, parola })
    await expect(page.locator('main')).toBeVisible()
  })

  test('PASİFLEŞTİRİLEN kullanıcı GİREMİYOR', async ({ page }) => {
    const n = ek()
    const email = `e2epasif${n}@ornek.test`
    const parola = 'gecici-parola-123'

    await girisYap(page, YONETICI)
    await page.goto('/kullanicilar')
    await page.fill('input[name="ad"]', `Pasif Olacak ${n}`)
    await page.fill('input[name="email"]', email)
    await page.fill('input[name="parola"]', parola)
    await kaydet(page, /kullanıcıyı ekle/i)
    await expect(page.locator('main')).toContainText(`Pasif Olacak ${n}`)

    // Satırın kendi formundaki pasifleştirme düğmesi. Liste e-postayı
    // göstermediği için satır ADLA bulunuyor.
    const satir = page.locator('li, tr', { hasText: `Pasif Olacak ${n}` }).last()
    await satir.getByRole('button', { name: /pasif/i }).first().click()
    await expect(page.locator('main')).toContainText(`Pasif Olacak ${n}`)

    // İşten çıkan çalışanın erişimi ANINDA kesilmeli; bu, ürünün
    // güvenlik vaadi (tehdit S4).
    await cikisYap(page)
    await page.goto('/giris')
    await page.fill('input[name="email"]', email)
    await page.fill('input[name="parola"]', parola)
    await page.getByRole('button', { name: 'Giriş yap' }).click()

    await expect
      .poll(() => page.url(), { message: 'pasif kullanıcı panele girdi', timeout: 15_000 })
      .not.toContain('/panel')
    await expect(page.locator('p[role="alert"]')).toBeVisible()
  })

  test('ÇALIŞAN kullanıcı ekranına giremiyor', async ({ page }) => {
    await girisYap(page, CALISAN)
    await page.goto('/kullanicilar')
    await expect
      .poll(() => page.url(), { message: 'çalışan kullanıcı yönetimine girdi', timeout: 15_000 })
      .not.toContain('/kullanicilar')
  })
})

test.describe('toplu ürün yükleme', () => {
  test('CSV yükleniyor, ÖNİZLEME çıkıyor ve onayla ürünler oluşuyor', async ({ page }) => {
    const n = ek()
    const satirlar = [
      'sku,ad,barkod,birim,satis',
      `TOP-${n}-1,Çizgili Şişe ${n},869${n}01,ADET,15.00`,
      `TOP-${n}-2,İğneli Ölçü ${n},869${n}02,ADET,22.50`,
    ].join('\n')

    await girisYap(page, YONETICI)
    await page.goto('/urunler/aktar')

    // Dosya BELLEKTEN veriliyor: diske geçici dosya yazmak, testin
    // çalıştığı makinenin yazma iznine bağımlı hale getirirdi.
    await page.setInputFiles('input[type="file"]', {
      name: `urunler-${n}.csv`,
      mimeType: 'text/csv',
      // BOM YOK ve Türkçe karakter VAR: G2'nin (Türkçe karakter bozulması)
      // içe aktarma tarafı. Excel'in ürettiği dosyada ç/ş/ğ bozuk gelirse
      // ürün adları kalıcı olarak yanlış kaydedilir.
      buffer: Buffer.from(satirlar, 'utf-8'),
    })

    // Dosya seçmek TEK BAŞINA okuma başlatmıyor — ekran bilerek iki adımlı:
    // "oku ve önizle", sonra "onayla". Kullanıcı ne yazılacağını görmeden
    // hiçbir şey kaydedilmiyor.
    await kaydet(page, /oku ve önizle/i)

    /**
     * ÖNİZLEME SAYI GÖSTERİYOR, satırları değil (tarayıcıda ölçüldü).
     * Sınanan şey de bu: kullanıcı ne olacağını ONAYLAMADAN önce görüyor mu.
     * "Atlanacak (hatalı) 0" özellikle kontrol ediliyor — Türkçe karakterli
     * bir CSV hatalı sayılsaydı ürünler sessizce eksik aktarılırdı (G2).
     */
    const ozet = page.locator('main')
    await expect(ozet).toContainText('Yeni eklenecek')
    await expect(ozet, 'iki satır okunmadı').toContainText('2')
    await expect(ozet, 'Türkçe karakterli satır hatalı sayıldı').toContainText(
      'Atlanacak (hatalı)0',
    )

    await kaydet(page, /satırı aktar/i)

    /**
     * SONUÇ PANELİNİ BEKLE, sonra listeye git.
     *
     * Beklemeden `goto` etmek, sunucu eylemi daha bitmeden sayfayı
     * değiştiriyordu ve liste ürünleri henüz göremiyordu — testin
     * "bazen kırmızı" olmasının kaynağı buydu. Sabit bir `waitForTimeout`
     * yerine ekranın GERÇEK durumu bekleniyor.
     */
    const sonuc = page.locator('section[aria-label="Sonuç"]')
    await expect(sonuc, 'aktarım sonuç paneli gelmedi').toBeVisible()
    await expect(sonuc, 'aktarılamayan satır var').toContainText('Aktarılamadı0')

    /**
     * Ürünler gerçekten oluştu mu — LİSTEDEN doğrula, önizlemeden değil.
     *
     * `getByText` kullanılıyor, `locator('main').toContainText` değil: ikinci
     * yol tek bir metin anlık görüntüsü alıyor ve liste hâlâ yerleşiyorsa
     * ikinci ad henüz orada olmuyor. `getByText` her yoklamada yeniden
     * sorguluyor.
     *
     * Türkçe adlar BİLEREK: Ç/Ş/İ/Ö bozulursa ürün adları kalıcı olarak
     * yanlış kaydedilir ve bunu yalnızca insan gözü fark eder (G2).
     */
    await page.goto(`/stok?ara=TOP-${n}`)
    await expect(page.getByText(`Çizgili Şişe ${n}`)).toBeVisible()
    await expect(page.getByText(`İğneli Ölçü ${n}`)).toBeVisible()
  })
})
