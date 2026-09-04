// biome-ignore-all lint/a11y/noSvgWithoutTitle: ikonlar dekoratif ve
// aria-hidden ortak `common` nesnesinden yayiliyor; Biome yayilmis
// prop.lari cozemedigi icin yanlis pozitif veriyor. Metin her zaman
// ikonun yaninda (PLAN.md Bolum 11: renk + ikon + metin).
/**
 * ============================================================================
 * DURUM ROZETİ — T70 (tasarım incelemesi, karar TD1)
 *
 * REFERANS GÖRSELDEN ALINAN VE DEĞİŞTİRİLEN ŞEY BURADA.
 *
 * Görselde rozet yalnızca RENK taşıyor: yeşil dolgu "Stokta", amber dolgu
 * "Düşük Stok". Bu üründe yetmiyor ve iki ölçülebilir sebebi var:
 *
 *   1. Renk körlüğü yaygın (erkeklerde ~%8) ve yeşil/amber ayrımı en sık
 *      kaybedilen ayrım.
 *   2. Depo aydınlatması kötü, ekran parlıyor. Pastel bir dolgu parlayan
 *      ekranda beyaza yaklaşıyor.
 *
 * Bu yüzden her rozet ÜÇ şey taşıyor: renk + ikon + metin. Üçü birden.
 * Renk kaybolsa da ikon ve metin ayakta kalıyor.
 *
 * Dolgu ve metin renkleri ölçüldü, hepsi 4,5:1 üstünde:
 *   ok    #E4F4EB / #0C6742 → 6,08:1
 *   warn  #FBF0DC / #7A4900 → 6,69:1
 *   crit  #FCEAE9 / #A81E18 → 6,31:1
 * Görselin kendi pastel tonları ölçüldüğünde 3:1'in altında kalıyordu;
 * pastel his korundu, kontrast düzeltildi.
 * ============================================================================
 */

export type BadgeTone = 'ok' | 'warn' | 'crit' | 'neutral'

const TONE: Record<BadgeTone, string> = {
  ok: 'bg-ok-soft text-ok-soft-ink',
  warn: 'bg-warn-soft text-warn-soft-ink',
  crit: 'bg-crit-soft text-crit-soft-ink',
  neutral: 'bg-surface-2 text-ink-2',
}

function ToneIcon({ tone }: { tone: BadgeTone }) {
  const common = {
    'aria-hidden': true,
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 3,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'shrink-0',
  }
  if (tone === 'ok') return <svg {...common}><path d="M20 6 9 17l-5-5" /></svg>
  if (tone === 'crit')
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10" />
        <path d="M15 9l-6 6M9 9l6 6" />
      </svg>
    )
  if (tone === 'warn')
    return (
      <svg {...common}>
        <path d="M12 9v5M12 18h.01" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0" />
      </svg>
    )
  return (
    <svg {...common} strokeWidth={2.5}>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M3 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

export function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 text-[12.5px] font-semibold ${TONE[tone]}`}
    >
      <ToneIcon tone={tone} />
      {children}
    </span>
  )
}

/**
 * Stok durumunu tek yerde karara bağlıyor.
 *
 * Eşik karşılaştırması ÜÇ ekranda geçiyor (panel, stok tablosu, ürün
 * detayı). Üçüne ayrı yazılsaydı biri `<=` diğeri `<` kullanır ve tam
 * eşikteki ürün bir ekranda kritik, diğerinde normal görünürdü.
 *
 * `<=` kullanılıyor: eşik "en az bu kadar olmalı" demek, yani eşiğe eşit
 * olan ürün zaten sınırda ve uyarılmalı. `listStock` da aynı karşılaştırmayı
 * yapıyor (stock.ts: `COALESCE(qty,0) <= min_stock`).
 */
export function stockStatus(qty: number, minStock: number, archived = false) {
  if (archived) return { tone: 'neutral' as BadgeTone, label: 'Arşiv' }
  if (qty <= 0) return { tone: 'crit' as BadgeTone, label: 'Stok yok' }
  if (qty <= minStock) return { tone: 'crit' as BadgeTone, label: 'Kritik' }
  // Eşiğin %50 üstüne kadar "düşük": eşiğe değmeden önce sipariş vermek
  // için zaman tanıyor. Eşiğe değdiği anda uyarmak, malı ancak biterken
  // haber vermek demek.
  if (qty <= minStock * 1.5) return { tone: 'warn' as BadgeTone, label: 'Düşük stok' }
  return { tone: 'ok' as BadgeTone, label: 'Stokta' }
}
