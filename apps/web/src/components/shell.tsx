import { type Role, roleLabel } from '@stok/shared'
import Link from 'next/link'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { BottomNav, PageHeading, SidebarNav } from '@/components/panel-nav'
import { ThemeToggle } from '@/components/theme-toggle'
import { endSession } from '@/server/session'
import { readTheme, writeTheme } from '@/server/theme'

/**
 * ============================================================================
 * PANEL KABUĞU — T66 / T67 / T69 (tasarım incelemesi, kararlar TD1, TD3, TD4)
 *
 * Eski kabuk üst şerit gezinme + `max-w-6xl` (1152 px) idi ve HER SAYFANIN
 * İÇİNDE render ediliyordu. İki sorun vardı: menü içerikle aynı yatay şeridi
 * paylaşıyordu, ve tablo genişliği 1152 px'e hapsolmuştu — 27" ekranda iki
 * yanda boşluk dururken stok tablosu yatay kayıyordu.
 *
 * ARTIK DÜZENDE, SAYFADA DEĞİL (`app/(panel)/layout.tsx`). Bu, T69'in ön
 * şartı: `loading.tsx` yalnızca kendi düzeninin içinde render edilir. Kabuk
 * sayfada kalsaydı geçiş sırasında kenar çubuğu da iskelete dönerdi ve
 * kullanıcı menüsünü kaybederdi.
 *
 *   ≥1024px   244 px kenar çubuğu, kalıcı. İçerik tam genişlik.
 *   <1024px   kenar çubuğu gizlenir, altta 64 px gezinme çubuğu çıkar.
 *
 * ALT ÇUBUK BAŞPARMAK İÇİN (karar TD4). Depodaki çalışan telefonu tek elle,
 * eldivenle tutuyor. Ekranın tepesindeki bir hamburger o elle ıskalanır;
 * ekranın altındaki 97×64 px'lik bir sekme ıskalanmaz.
 *
 * ÜST ŞERİTTE ARAMA VAR, ZİL YOK. Zil (T80) ve Ctrl+K paleti (T86) ayrı
 * görevler. Sayı bağlanmamış bir zil ikonu koymak referans görseldeki öğeyi
 * taklit eder ama hiçbir şey söylemez: kullanıcı birkaç kez tıklar, boş
 * bulur, bir daha bakmaz. Boş süs, eksik özellikten kötüdür.
 * ============================================================================
 */

export async function Shell({
  role,
  title,
  children,
}: {
  role: Role
  /** Menüde karşılığı olmayan ekranlar için başlık (ör. "Yeni ürün"). */
  title?: string
  children: React.ReactNode
}) {
  const theme = await readTheme()

  async function logout() {
    'use server'
    await endSession()
    redirect('/giris')
  }

  async function cycleTheme() {
    'use server'
    const current = await readTheme()
    // sistem → açık → koyu → sistem
    await writeTheme(current === null ? 'light' : current === 'light' ? 'dark' : null)
    // Tema `<html>` niteliğinde, yani KÖK DÜZENDE. Sadece bulunulan sayfayı
    // tazelemek yetmez; 'layout' kapsamı olmadan nitelik eski değerde kalır.
    revalidatePath('/', 'layout')
  }

  return (
    <div className="min-h-screen lg:flex">
      {/* Klavye kullanıcısı her sayfada altı menü satırını geçmek zorunda
          kalmasın. Odaklanana kadar görünmüyor, odaklanınca tam görünür. */}
      <a
        href="#icerik"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-ink"
      >
        İçeriğe atla
      </a>

      {/* ── KENAR ÇUBUĞU (≥1024px) ─────────────────────────────── */}
      {/*
        `sticky top-0 h-screen`: çubuk BELGE değil EKRAN yüksekliğinde.
        Olmasaydı 1.248 satırlık stok tablosunda çubuk da 12 bin piksel
        uzar, "Çıkış yap" ve menü sayfanın en dibinde kalırdı — yani
        kalıcı gezinmenin bütün anlamı kaybolurdu.
        `overflow-y-auto`: menü ekrana sığmazsa çubuk KENDİ İÇİNDE
        kayıyor, sayfayı kaydırmıyor.
      */}
      <aside className="hidden w-61 shrink-0 flex-col gap-6 overflow-y-auto border-r border-line bg-surface p-4 lg:sticky lg:top-0 lg:flex lg:h-screen">
        <Link href="/panel" className="flex items-center gap-3 px-2 py-1">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-accent text-accent-ink"
          >
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m21 16-9 5-9-5V8l9-5 9 5z" />
              <path d="M3.3 7 12 12l8.7-5" />
              <path d="M12 22V12" />
            </svg>
          </span>
          <span className="font-display text-lg font-semibold tracking-tight">
            Stok<span className="text-accent">Takip</span>
          </span>
        </Link>

        <SidebarNav role={role} />

        {/*
          Referans görselde burada kullanıcının baş harfleri ve fotoğrafı var.
          `Actor` yalnızca `tenantId`, `userId` ve `role` taşıyor; isim yok.
          Baş harf basmak için her sayfada fazladan bir kullanıcı sorgusu
          gerekirdi. Rolün ilk iki harfini avatar diye göstermek ise sahte bir
          kişiselleştirme olurdu ("YÖ"), o yüzden jenerik ikon duruyor.
          İsim gerçekten isteniyorsa `Actor`'a eklenip token'da taşınmalı.
        */}
        <div className="mt-auto flex items-center gap-3 rounded-[10px] border border-line p-2.5">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-soft-ink"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </span>
          <span className="min-w-0 text-[13px] leading-tight">
            <span className="block font-semibold">{roleLabel(role)}</span>
            <form action={logout}>
              <button type="submit" className="text-ink-3 underline hover:text-ink">
                Çıkış yap
              </button>
            </form>
          </span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── ÜST ŞERİT ────────────────────────────────────────── */}
        {/*
          Üst şerit de yapışkan: arama kutusu Kural 05 gereği HER ZAMAN
          görünür olmalı. Uzun bir tablonun ortasındayken barkod okutmak
          için başa dönmek gerekseydi kural kağıt üstünde kalırdı.
          `z-30` alt gezinme çubuğunun (z-40) altında: ikisi aynı anda
          görünmüyor ama sıralama yine de belirli olsun.
        */}
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 lg:h-17 lg:flex-nowrap lg:py-0">
          <PageHeading role={role} fallback={title} />

          {/*
            ARAMA ÜST ŞERİTTE, HER SAYFADA (Kural 05).

            `autoFocus` BİLEREK YOK. Kural 05 "sayfa açılınca odaklan" diyor
            ama o kural barkod alanı için: Giriş/Çıkış ekranı kendi barkod
            alanını odaklıyor. Genel aramayı her sayfada odaklamak o odağı
            ÇALARDI ve okutulan barkod arama kutusuna düşerdi — kullanıcı da
            bunu fark etmezdi. Ctrl+K paleti (T86) boşluğu kısayolla kapatacak.
          */}
          <form
            action="/stok"
            method="get"
            role="search"
            className="order-3 flex h-11 w-full items-center gap-2 rounded-[10px] border border-line-control bg-surface px-3 focus-within:outline-3 focus-within:outline-focus lg:order-none lg:ml-auto lg:w-80"
          >
            <label htmlFor="genel-ara" className="sr-only">
              Ürün, stok kodu veya barkod ara
            </label>
            <svg
              aria-hidden
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="shrink-0 text-ink-3"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            {/*
              `outline-none` BURADA MEŞRU VE TEK İSTİSNA: odak halkası
              kaybolmuyor, sarmalayıcıya taşınıyor (`focus-within:outline-3`
              yukarıda). Alan kutunun tamamını kapladığı için halkayı alanın
              kendisine koymak, kenarlığın bir piksel içine çizilmiş ikinci
              bir çerçeve gibi görünürdü.
            */}
            <input
              id="genel-ara"
              name="ara"
              type="search"
              placeholder="Ürün, stok kodu veya barkod"
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
            />
          </form>

          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            <ThemeToggle theme={theme} action={cycleTheme} />
          </div>
        </header>

        {/* `pb-20` alt çubuğun altında kalan içeriği kurtarıyor: 64 px çubuk
            + nefes payı. Masaüstünde çubuk yok, o yüzden `lg:pb-4`. */}
        <main id="icerik" className="flex-1 p-4 pb-20 lg:pb-4">
          {children}
        </main>
      </div>

      <BottomNav role={role} />
    </div>
  )
}
