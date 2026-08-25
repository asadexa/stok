'use client'

import type { Role } from '@stok/shared'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isActive, visibleNav } from './nav-items'

/**
 * ============================================================================
 * GEZİNME — İSTEMCİ TARAFI (T67 / T69)
 *
 * NEDEN İSTEMCİ BİLEŞENİ?
 *
 * Kabuk artık sayfada değil, DÜZENDE (`(panel)/layout.tsx`). Bunun sebebi
 * yükleme durumu: `loading.tsx` yalnızca kendi düzeninin İÇİNDE render
 * edilir. Kabuk sayfada kalsaydı, "Stok"a basıldığında kenar çubuğu da
 * iskelete dönerdi — yani kullanıcı menüsünü kaybederdi ve ekran tamamen
 * boşalırdı. Şimdi çubuk yerinde duruyor, sadece içerik alanı iskelete
 * dönüyor.
 *
 * Ama düzenler sunucuda hangi yolda olduğumuzu BİLMİYOR (Next.js düzene
 * `pathname` vermiyor; verseydi düzen her gezinmede yeniden render edilmek
 * zorunda kalırdı). Aktif maddeyi işaretlemek için `usePathname()` gerekiyor
 * ve o da istemci tarafında.
 *
 * Bedeli küçük: bu dosya ve ikonlar istemci paketine giriyor, birkaç kB.
 * Karşılığında gezinme, sayfa geçişlerinde hiç yeniden render edilmiyor.
 * ============================================================================
 */

export function SidebarNav({ role }: { role: Role }) {
  const pathname = usePathname()
  const items = visibleNav(role)

  return (
    <nav aria-label="Ana gezinme" className="flex flex-col gap-0.5">
      {items.map((item, index) => {
        const current = isActive(item, pathname)
        return (
          <div key={item.href} className="contents">
            {/* Yönetici bölümünden önce ayırıcı: günlük işler ile yönetim
                işleri farklı şeyler, göz bunu ayırt edebilmeli. */}
            {item.adminOnly && !items[index - 1]?.adminOnly ? (
              <span aria-hidden className="my-2 h-px bg-line" />
            ) : null}
            <Link
              href={item.href}
              aria-current={current ? 'page' : undefined}
              className={`flex h-12 items-center gap-3 rounded-[9px] px-3 text-[15px] font-medium ${
                current
                  ? 'bg-accent-soft text-accent-soft-ink'
                  : 'text-ink-2 hover:bg-surface-2'
              }`}
            >
              {item.icon}
              {item.label}
            </Link>
          </div>
        )
      })}
    </nav>
  )
}

/**
 * Alt gezinme çubuğu (<1024px) — karar TD4.
 *
 * Dört sekme, her biri 64 px yüksekliğinde ve ekran genişliğinin dörtte
 * birinde: 390 px'lik bir telefonda 97×64 px'lik hedef. WCAG 2.5.5'in
 * istediği 44 px'in iki katından fazla, çünkü depoda eldiven var.
 *
 * Yalnızca `primary` maddeler burada. Kullanıcılar ve Sağlık günde bir
 * açılan yönetim ekranları; onları da sığdırmaya çalışmak dört hedefi de
 * daraltırdı. Onlara masaüstünden veya doğrudan adresle gidiliyor.
 */
export function BottomNav({ role }: { role: Role }) {
  const pathname = usePathname()
  const items = visibleNav(role).filter((item) => item.primary)

  return (
    <nav
      aria-label="Ana gezinme"
      className="fixed inset-x-0 bottom-0 z-40 flex h-16 border-t border-line bg-surface lg:hidden"
    >
      {items.map((item) => {
        const current = isActive(item, pathname)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={current ? 'page' : undefined}
            className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[11.5px] font-semibold ${
              current ? 'text-accent-soft-ink' : 'text-ink-3'
            }`}
          >
            <span
              className={`grid h-6 w-[34px] place-items-center rounded-lg ${
                current ? 'bg-accent-soft' : ''
              }`}
            >
              {item.icon}
            </span>
            {item.shortLabel ?? item.label}
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * Üst şeritteki sayfa başlığı.
 *
 * Menü etiketinden türüyor, yani başlık ile menüdeki yanan satır HER ZAMAN
 * aynı kelimeyi söylüyor. İkisi ayrı yazılsaydı biri değişip diğeri
 * unutulurdu ve kullanıcı "Stok" menüsünde "Ürünler" başlığı görürdü.
 *
 * Menüde olmayan yollar (`/urunler/yeni` gibi) kendi başlıklarını veriyor.
 */
export function PageHeading({ role, fallback }: { role: Role; fallback?: string }) {
  const pathname = usePathname()
  const match = visibleNav(role).find((item) => isActive(item, pathname))

  return (
    <h1 className="font-display text-xl font-semibold tracking-tight">
      {fallback ?? match?.label ?? 'Stok Takip'}
    </h1>
  )
}
