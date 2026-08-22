import { type Role, roleLabel } from '@stok/shared'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { endSession } from '@/server/session'

/**
 * Panel kabuğu: üst şerit + gezinme.
 *
 * Gezinme bağlantıları ROLE GÖRE süzülüyor ama bu bir yetki kontrolü
 * DEĞİL, sadece görgü kuralı: asıl kontrol her sayfanın kendi
 * `requirePermission()` çağrısında. Menüden gizlemek, adresi elle yazan
 * kullanıcıyı durdurmaz (tehdit S6).
 */

interface NavItem {
  href: string
  label: string
  adminOnly: boolean
}

const NAV: NavItem[] = [
  { href: '/panel', label: 'Panel', adminOnly: false },
  { href: '/stok', label: 'Stok', adminOnly: false },
  { href: '/hareketler', label: 'Hareketler', adminOnly: false },
]

export function Shell({
  role,
  active,
  children,
}: {
  role: Role
  active: string
  children: React.ReactNode
}) {
  async function logout() {
    'use server'
    await endSession()
    redirect('/giris')
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <span className="font-semibold">Stok Takip</span>

          <nav className="flex gap-1" aria-label="Ana gezinme">
            {NAV.filter((item) => !item.adminOnly || role === 'ADMIN').map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active === item.href ? 'page' : undefined}
                className={
                  active === item.href
                    ? 'rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white'
                    : 'rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100'
                }
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-slate-600">{roleLabel(role)}</span>
            <form action={logout}>
              <button type="submit" className="rounded-md px-3 py-2 hover:bg-slate-100">
                Çıkış
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-4">{children}</main>
    </div>
  )
}
