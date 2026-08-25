/**
 * ============================================================================
 * İSKELET EKRAN — T69 (tasarım incelemesi, karar TD3)
 *
 * NEDEN DÖNEN ÇARK DEĞİL: iskelet, gelecek içeriğin ŞEKLİNİ gösteriyor —
 * kaç satır, jeton nerede, rozet nerede. İçerik geldiğinde sayfa zıplamıyor.
 * Dönen bir çark ise "bir şey oluyor" der ama "ne geleceğini" söylemez ve
 * geldiğinde düzen sıfırdan kurulur.
 *
 * ERİŞİLEBİLİRLİK: gri kutular ekran okuyucu için gürültü, o yüzden hepsi
 * `aria-hidden`. Bekleyişi duyuran tek şey `role="status"` içindeki görünmez
 * "Yükleniyor" metni. `aria-live="polite"`, çünkü kullanıcının o an
 * yazdığını kesmemeli.
 *
 * Nabız animasyonu `globals.css` içindeki `.iskelet` sınıfından geliyor ve
 * `prefers-reduced-motion` açıkken duruyor.
 * ============================================================================
 */

/** Tek bir gri çubuk. Genişlik yüzde veya px olarak verilir. */
export function Sk({ w, h = 13, className = '' }: { w: string; h?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`iskelet block ${className}`}
      style={{ width: w, height: `${h}px` }}
    />
  )
}

/** Yükleniyor bölgesi. İskeletleri sarmalar ve bekleyişi duyurur. */
export function SkRegion({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

export function SkCard({
  children,
  className = '',
}: {
  /** Boş kart (yalnızca yükseklik veren yer tutucu) için verilmeyebilir. */
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div className={`rounded-[14px] border border-line bg-surface ${className}`}>{children}</div>
  )
}

/** Kart başlığı: bir başlık çubuğu, opsiyonel sağ bağlantı. */
export function SkCardHead({ w = '140px' }: { w?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line px-4 py-4">
      <Sk w={w} h={16} />
      <Sk w="48px" h={13} />
    </div>
  )
}

/**
 * Tablo iskeleti. Satır genişlikleri BİLEREK eşit değil: gerçek veride ürün
 * adları farklı uzunlukta ve tekdüze çubuklar sahte bir düzenlilik yaratıp
 * içerik gelince göze fazla değişmiş gibi geliyor.
 */
export function SkRows({ rows = 6, thumb = false }: { rows?: number; thumb?: boolean }) {
  const widths = ['72%', '54%', '63%', '45%', '68%', '58%', '76%', '50%']
  return (
    <div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-t border-line px-4 py-3 first:border-t-0">
          {thumb ? <Sk w="38px" h={38} className="shrink-0 rounded-[9px]" /> : null}
          <div className="min-w-0 flex-1">
            <Sk w={widths[i % widths.length] ?? '60%'} h={13} />
            <Sk w="30%" h={10} className="mt-1.5" />
          </div>
          <Sk w="72px" h={26} className="shrink-0 rounded-[7px]" />
        </div>
      ))}
    </div>
  )
}

/** KPI satırı: dört kart, her biri etiket + büyük sayı. */
export function SkKpis({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-[14px] border border-line bg-surface p-4">
          <div className="flex items-start justify-between">
            <Sk w="90px" h={13} />
            <Sk w="42px" h={42} className="rounded-[11px]" />
          </div>
          <Sk w="70%" h={31} className="mt-3" />
        </div>
      ))}
    </div>
  )
}

/** Filtre şeridi: arama + seçim + düğme. */
export function SkFilters() {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Sk w="240px" h={52} className="grow rounded-[10px]" />
      <Sk w="180px" h={52} className="rounded-[10px]" />
      <Sk w="120px" h={52} className="rounded-[10px]" />
    </div>
  )
}
