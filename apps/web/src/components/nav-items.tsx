import type { Role } from '@stok/shared'

/**
 * ============================================================================
 * GEZİNME TANIMI — T66 / T67
 *
 * Kenar çubuğu (≥1024px) ve alt çubuk (<1024px) AYNI listeyi okuyor. İki
 * yerde ayrı yazılsaydı biri güncellenip diğeri unutulurdu ve masaüstünde
 * görünen bir ekran telefonda kaybolurdu.
 *
 * Rol süzmesi bir GÖRGÜ KURALI, yetki kontrolü DEĞİL: asıl kontrol her
 * sayfanın kendi `requirePermission()` çağrısında. Menüden gizlemek,
 * adresi elle yazan kullanıcıyı durdurmaz (tehdit S6).
 *
 * MENÜDE SADECE VAR OLAN EKRANLAR DURUYOR. Tasarım incelemesi kararı TD2
 * Kategoriler, Raporlar ve Ayarlar'ı kapsama aldı ama ekranları henüz yok
 * (T73, T74, T75). Tıklayınca 404 veren bir menü satırı, referans görselin
 * menü zenginliğini taklit etmenin en kötü yolu: kullanıcı ürünü yarım
 * sanar. Satırlar ekranlarıyla BİRLİKTE gelecek.
 * ============================================================================
 */

export interface NavItem {
  href: string
  label: string
  /** Alt çubukta yer darlığı için kısaltılmış etiket. */
  shortLabel?: string
  adminOnly: boolean
  /** Alt gezinme çubuğunun dört sekmesinden biri mi. */
  primary: boolean
  /**
   * Bu maddeyi aktif sayan EK yollar. Ürün ekranlarına Stok tablosundan
   * giriliyor; `/urunler/...` altındayken menüde hiçbir şey yanmazsa
   * kullanıcı nerede olduğunu kaybediyor.
   */
  alsoMatches?: string[]
  icon: React.ReactNode
}

/**
 * Aktif madde eşleşmesi.
 *
 * `startsWith(href)` TEK BAŞINA YANLIŞ OLURDU: `/hareketler` yolu
 * `/hareket` ile başlıyor, yani Hareketler sayfasındayken Giriş/Çıkış de
 * yanardı. Ayırıcı eğik çizgi şart: `/hareketler`, `/hareket/` ile
 * başlamıyor.
 */
export function isActive(item: NavItem, pathname: string): boolean {
  const paths = [item.href, ...(item.alsoMatches ?? [])]
  return paths.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      // `aria-hidden`: etiket zaten yanında metin olarak var. İkonu ekran
      // okuyucuya ikinci kez okutmak, her menü satırını iki kez duyurur.
      aria-hidden
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {children}
    </svg>
  )
}

export const NAV: NavItem[] = [
  {
    href: '/panel',
    label: 'Panel',
    adminOnly: false,
    primary: true,
    icon: (
      <Icon>
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </Icon>
    ),
  },
  {
    // Depoda en sık yapılan iş bu, o yüzden İKİNCİ sırada ve alt çubukta.
    href: '/hareket',
    label: 'Giriş / Çıkış',
    shortLabel: 'Giriş/Çıkış',
    adminOnly: false,
    primary: true,
    icon: (
      <Icon>
        <path d="M12 5v14" />
        <path d="m19 12-7 7-7-7" />
      </Icon>
    ),
  },
  {
    href: '/stok',
    label: 'Stok',
    adminOnly: false,
    primary: true,
    // Ürün ekle / düzenle / toplu aktar ekranlarına buradan giriliyor.
    alsoMatches: ['/urunler'],
    icon: (
      <Icon>
        <path d="M3 6h18M3 12h18M3 18h12" />
      </Icon>
    ),
  },
  {
    href: '/kategoriler',
    label: 'Kategoriler',
    adminOnly: false,
    primary: false,
    icon: (
      <Icon>
        <path d="M3 7h7l2 3h9v9a2 2 0 0 1-2 2H3z" />
        <path d="M3 7V5a2 2 0 0 1 2-2h3l2 3" />
      </Icon>
    ),
  },
  {
    href: '/hareketler',
    label: 'Hareketler',
    adminOnly: false,
    primary: true,
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4l3 2" />
      </Icon>
    ),
  },
  {
    // Raporlar YÖNETİCİ İŞİ: Excel indirme yetkisi (export:excel) çalışanda
    // yok. Menüde göstermek, tıklayınca "yetkiniz yok" diyen bir satır
    // koymak olurdu.
    href: '/raporlar',
    label: 'Raporlar',
    adminOnly: true,
    primary: false,
    icon: (
      <Icon>
        <path d="M14 2v6h6" />
        <path d="M15 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M9 17v-3M12 17v-6M15 17v-4" />
      </Icon>
    ),
  },
  {
    href: '/kullanicilar',
    label: 'Kullanıcılar',
    adminOnly: true,
    primary: false,
    icon: (
      <Icon>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      </Icon>
    ),
  },
  {
    // Ayarlar HERKESE açık: parola ve tema kişisel, rol gerektirmiyor.
    // Yönetici bölümünde duruyor çünkü günlük iş değil, ayda bir açılıyor.
    href: '/ayarlar',
    label: 'Ayarlar',
    adminOnly: false,
    primary: false,
    icon: (
      <Icon>
        <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
        <path d="M1 14h6M9 8h6M17 16h6" />
      </Icon>
    ),
  },
  {
    href: '/saglik',
    label: 'Sağlık',
    adminOnly: true,
    primary: false,
    icon: (
      <Icon>
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </Icon>
    ),
  },
]

export function visibleNav(role: Role): NavItem[] {
  return NAV.filter((item) => !item.adminOnly || role === 'ADMIN')
}
