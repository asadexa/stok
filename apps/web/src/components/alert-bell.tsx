import type { AlertSummary } from '@stok/core'
import Link from 'next/link'

/**
 * ============================================================================
 * BİLDİRİM ZİLİ — T80 (PLAN.md E7 web karşılığı)
 *
 * PLAN.md E7 v1 kapsamındaydı ve gerekçesi yazılıydı: "Uyarı ekranda
 * beklerse kimse görmez." Kritik stok bugüne kadar yalnızca panelde ve stok
 * tablosunda görünüyordu; Giriş/Çıkış ekranında saatlerce çalışan biri
 * kritik seviyeye düşen malı hiç fark etmiyordu.
 *
 * AÇILIR LİSTE `<details>` İLE, JavaScript'siz. Native açılır öğe klavyeyle
 * çalışıyor, ekran okuyucuya "genişletildi/daraltıldı" diye duyuruluyor ve
 * depodaki eski Android tarayıcıda da açılıyor. Elle yazılmış bir dropdown
 * bunların üçünü de yeniden icat etmek zorunda kalırdı.
 *
 * SAYI GERÇEK, SÜS DEĞİL. Referans görselde zilin üstünde "3" yazıyor ama
 * arkasında bir şey yok. Buradaki sayı kritik ürün + başarısız arka plan
 * işi toplamı ve iki maddenin ikisi de tıklanabilir bir yere gidiyor.
 * Boş zil koymaktansa hiç koymamak daha iyiydi; şimdi ikisi de gerekmiyor.
 *
 * SIFIRDA ROZET YOK ama zil duruyor. Rozeti gizlemek "sorun yok" demenin
 * en sessiz yolu; zili gizlemek ise kullanıcıya kontrol edecek bir yer
 * bırakmamak olurdu.
 * ============================================================================
 */
export function AlertBell({ summary }: { summary: AlertSummary }) {
  const failed = summary.failedJobCount ?? 0
  const total = summary.criticalCount + failed

  return (
    <details className="relative">
      <summary
        // `list-none` + `marker:hidden`: tarayıcının varsayılan üçgeni
        // ikonun yanında ikinci bir işaret olurdu.
        className="grid size-11 cursor-pointer list-none place-items-center rounded-[10px] border border-line-control bg-surface text-ink-2 marker:hidden hover:bg-surface-2 [&::-webkit-details-marker]:hidden"
        aria-label={
          total > 0 ? `Bildirimler: ${total} uyarı` : 'Bildirimler: bekleyen uyarı yok'
        }
      >
        <span className="relative">
          <svg
            aria-hidden
            width="19"
            height="19"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
            <path d="M4 9a8 8 0 0 1 16 0c0 5 2 6 2 6H2s2-1 2-6" />
          </svg>
          {total > 0 ? (
            <span
              aria-hidden
              className="tabular absolute -top-2 -right-2.5 grid h-[19px] min-w-[19px] place-items-center rounded-full border-2 border-surface bg-crit px-1 text-[11px] font-semibold text-surface"
            >
              {total > 99 ? '99+' : total}
            </span>
          ) : null}
        </span>
      </summary>

      <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[14px] border border-line bg-surface shadow-card">
        <p className="border-b border-line px-4 py-3 font-display text-sm font-semibold">
          Bildirimler
        </p>

        {total === 0 ? (
          // Olumlu boş durum: "bildirim yok" değil, "her şey yolunda".
          <p className="flex items-center gap-2.5 px-4 py-4 text-[13.5px] text-ink-2">
            <span
              aria-hidden
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-ok-soft text-ok-soft-ink"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            Bekleyen uyarı yok
          </p>
        ) : (
          <ul>
            {summary.criticalCount > 0 ? (
              <BellRow
                href="/stok?kritik=1"
                tone="crit"
                title={`${summary.criticalCount} ürün kritik seviyede`}
                detail="Stok eşiğin altına düştü"
              />
            ) : null}
            {failed > 0 ? (
              <BellRow
                href="/saglik"
                tone="crit"
                title={`${failed} arka plan işi başarısız`}
                detail="Rapor gönderilemedi olabilir"
              />
            ) : null}
          </ul>
        )}
      </div>
    </details>
  )
}

function BellRow({
  href,
  title,
  detail,
}: {
  href: string
  tone: 'crit'
  title: string
  detail: string
}) {
  return (
    <li className="border-t border-line first:border-t-0">
      <Link href={href} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-crit-soft text-crit-soft-ink"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0" />
          </svg>
        </span>
        <span className="min-w-0">
          <span className="block text-[13.5px] leading-tight font-semibold">{title}</span>
          <span className="block text-[12.5px] leading-tight text-ink-3">{detail}</span>
        </span>
      </Link>
    </li>
  )
}
