import { expect, test } from '@playwright/test'

/**
 * ============================================================================
 * T109 — SUNUCU EYLEMİ EKRANA YANSIMIYOR
 *
 * ÖLÇÜLEN ARIZA (gerçek tarayıcı, üretim derlemesi): tema düğmesine
 * basıldığında çerez yazılıyor, eylem 200 dönüyor, SERT YENİLEMEDE yeni tema
 * geliyor — ama ekran eski temada kalıyor. 12 tıklamanın 5-8'i böyleydi.
 * Kullanıcı için bu "düğme çalışmıyor" demek: birkaç kez basıp vazgeçer.
 *
 * SEBEP: `revalidatePath('/', 'layout')` TEK BAŞINA yetmiyordu. Tema
 * `<html data-theme>` niteliğinde, yani kök düzende; sunucu eyleminin cevabı
 * kökü her zaman yeniden render ettirmiyor. Çözüm, eylemin sonunda aynı
 * adrese yönlendirmek (`shell.tsx` → `cycleTheme`).
 *
 * NEDEN E2E, NEDEN BİRİM TESTİ DEĞİL: arıza sunucuda değil, İSTEMCİ
 * YÖNLENDİRİCİSİNDE. Sunucu her seferinde doğru çalışıyordu — çerez
 * yazılmıştı. Sahte bir DOM'da bu hata görünmez; ancak gerçek tarayıcıda
 * gerçek bir App Router gezinmesiyle görünüyor.
 *
 * ARALIKLI OLDUĞU İÇİN TEKRARLI: 10 tıklama, 5/12'lik bir arıza oranını
 * neredeyse kesin yakalar. Tek tıklama sınasaydı test yalancı yeşil yanardı.
 * ============================================================================
 */

const YONETICI = { email: 'admin@yilmaz.example', parola: 'admin123' }

/** `null` = seçim yok, karar işletim sistemine kalıyor (server/theme.ts). */
const DONGU = [null, 'light', 'dark'] as const

test('tema düğmesi HER basışta ekrana yansıyor (T109)', async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Sayfada işlenmemiş hata: ${err.message}`)
  })

  await page.goto('/giris')
  await page.fill('input[name="email"]', YONETICI.email)
  await page.fill('input[name="parola"]', YONETICI.parola)
  await page.click('button[type="submit"]')
  await page.waitForURL('**/panel')

  const okunanTema = () =>
    page.locator('html').getAttribute('data-theme')

  const dugme = page.getByRole('button', { name: /tema/i })

  let simdiki = await okunanTema()
  expect(simdiki, 'başlangıçta seçim olmamalı').toBeNull()

  for (let i = 1; i <= 10; i++) {
    const beklenen = DONGU[i % 3] ?? null
    await dugme.click()

    // Nitelik DEĞİŞMELİ. Beklemek şart: gezinme eşzamansız. Ama süresiz
    // beklemek de yanlış olurdu — arıza tam olarak "hiç değişmiyor".
    await expect
      .poll(okunanTema, {
        message: `${i}. tıklamada tema değişmedi (ekranda ${simdiki} kaldı)`,
        timeout: 5_000,
      })
      .toBe(beklenen)

    simdiki = beklenen
  }

  // Çerez ile ekran AYRIŞMAMALI. Arızanın kalbi buydu: çerez doğruydu,
  // ekran yanlıştı. Sadece ekrana bakan bir test, çerezin hiç yazılmadığı
  // bir gerilemeyi de yeşil geçirirdi.
  const cerez = (await page.context().cookies()).find((c) => c.name === 'stok_tema')
  expect(cerez?.value ?? null, 'çerez ile ekran ayrışmış').toBe(simdiki)
})
