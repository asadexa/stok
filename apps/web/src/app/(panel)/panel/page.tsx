import { type Unit, formatQty, reasonLabel } from '@stok/shared'
import type { MovementReason } from '@stok/shared'
import { dashboardSummary, listMovements, listStock } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ActivityChart } from '@/components/activity-chart'
import { Badge, stockStatus } from '@/components/badge'
import { CategoryDonut } from '@/components/category-donut'
import { AllClear, EmptyState } from '@/components/empty-state'
import { KpiCard } from '@/components/kpi-card'
import { ProductThumb } from '@/components/product-cell'
import { formatMoney } from '@/lib/format'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T18 / T71 — YÖNETİCİ PANELİ
 *
 * BİLGİ SIRASI DEĞİŞMEDİ ve tartışmaya kapalı (PLAN.md Bölüm 11):
 *
 *   1. UYARILAR      "bir sorun var mı?"  ← patronun ekrana bakınca
 *                                            sorduğu İLK soru bu
 *   2. ÖZET           KPI satırı
 *   3. GRAFİK         hareket hacmi
 *   4. SON HAREKETLER kim ne yaptı
 *
 * T71 ile GRAFİK EKLENDİ ama sayının YERİNE değil, ALTINA. Eski Kural 01
 * "büyük net sayı, grafik değil" diyordu; yeni hâli "büyük net sayı VE
 * grafik". KPI rakamı hâlâ 31 px ve grafikten önce okunuyor.
 *
 * Grafik, referans görseldeki gibi stok DEĞERİ değil hareket HACMİ
 * gösteriyor: değerin zaman serisi bir maliyet yöntemi kararına bağlı
 * (U2) ve o karar verilmeden çizilecek her eğri uydurma olurdu.
 * Gerekçenin tamamı `components/activity-chart.tsx` içinde.
 * ============================================================================
 */

/** Kullanıcının gününün başlangıcı. "Bugün" sunucunun saat diliminde değil. */
function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

const timeFormat = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' })
const numFmt = new Intl.NumberFormat('tr-TR')

export default async function DashboardPage() {
  const actor = await currentActor()
  if (!actor) redirect('/giris')

  const db = appDb()
  const [summary, recent, critical] = await Promise.all([
    dashboardSummary(actor, startOfToday(), { db }),
    listMovements(actor, { limit: 8 }, { db }),
    listStock(actor, { onlyCritical: true, limit: 5 }, { db }),
  ])

  const isAdmin = actor.role === 'ADMIN'

  return (
    <>
      {/* ── 1. UYARILAR ─────────────────────────────────────────── */}
      <section aria-label="Uyarılar" className="mb-4 grid gap-3 sm:grid-cols-2">
        {summary.criticalCount > 0 ? (
          <Link
            href="/stok?kritik=1"
            className="flex items-center gap-3 rounded-card border border-crit bg-crit-soft p-4 text-crit-soft-ink hover:brightness-95"
          >
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-crit text-surface">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9v4M12 17h.01" />
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0" />
              </svg>
            </span>
            <span className="font-semibold">{summary.criticalCount} ürün kritik seviyede</span>
          </Link>
        ) : (
          // Boş durum OLUMLU: "hiç kritik ürün yok" değil, "her şey yolunda".
          <AllClear>Kritik seviyede ürün yok</AllClear>
        )}

        {summary.failedJobCount ? (
          // KRİTİK AÇIK G4: rapor gönderilemediyse yönetici bunu panelde görür.
          <Link
            href="/saglik"
            className="flex items-center gap-3 rounded-card border border-crit bg-crit-soft p-4 text-crit-soft-ink hover:brightness-95"
          >
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-crit text-surface">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9v4M12 17h.01" />
                <circle cx="12" cy="12" r="10" />
              </svg>
            </span>
            <span className="font-semibold">
              {summary.failedJobCount} arka plan işi başarısız oldu
            </span>
          </Link>
        ) : isAdmin ? (
          // Sağlık AYRINTISI kendi sayfasında (invariant taraması pahalı);
          // panelde sadece kapı duruyor.
          <Link
            href="/saglik"
            className="flex items-center gap-3 rounded-card border border-line bg-surface shadow-card p-4 text-ink-2 hover:bg-surface-2"
          >
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            </span>
            <span className="font-medium">Sistem sağlığını kontrol et</span>
          </Link>
        ) : null}
      </section>

      {/* ── 2. ÖZET ─────────────────────────────────────────────── */}
      <section aria-label="Özet" className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Toplam ürün"
          value={numFmt.format(summary.productCount)}
          foot={`${numFmt.format(summary.inStockCount)} tanesi stokta · arşiv hariç`}
          href="/stok"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21 16-9 5-9-5V8l9-5 9 5z" />
              <path d="M3.3 7 12 12l8.7-5" />
              <path d="M12 22V12" />
            </svg>
          }
        />

        <KpiCard
          label="Kritik seviyede"
          value={numFmt.format(summary.criticalCount)}
          unit="ürün"
          tone="crit"
          foot="Eşiğin altına düşenler"
          href="/stok?kritik=1"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4M12 17h.01" />
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0" />
            </svg>
          }
        />

        {/* Çalışan için bu sayılar KENDİ hareketleri (dashboardSummary kapsamı
            daraltıyor). Etiket bunu söylemezse çalışan deponun tamamına
            bakıyor sanır ve yanlış rakamla konuşur. */}
        <KpiCard
          label={isAdmin ? 'Bugün giriş' : 'Bugün girişleriniz'}
          value={numFmt.format(summary.today.inCount)}
          unit="hareket"
          tone="ok"
          foot={`${numFmt.format(summary.today.inQty)} adet mal kabul`}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
          }
        />

        {/*
          Stoktaki değer YALNIZCA fiyat yetkisi olana. `stockValue`
          tanımsızsa alan hiç konulmamış demek (core: price:read).
          Yerine çalışan için bugünün çıkışı gösteriliyor — boş kart
          bırakmak ızgarada delik açardı.
        */}
        {summary.stockValue !== undefined ? (
          <KpiCard
            label="Stoktaki değer"
            value={`${formatMoney(summary.stockValue)} ₺`}
            tone="warn"
            foot="Adet × alış fiyatı · bugünkü durum"
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20" />
                <path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            }
          />
        ) : (
          <KpiCard
            label="Bugün çıkışlarınız"
            value={numFmt.format(summary.today.outCount)}
            unit="hareket"
            tone="crit"
            foot={`${numFmt.format(summary.today.outQty)} adet çıkış`}
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </svg>
            }
          />
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-[2fr_1fr] xl:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {/* ── 3. GRAFİK ─────────────────────────────────────── */}
          <section
            aria-label="Hareket hacmi"
            className="rounded-card border border-line bg-surface shadow-card"
          >
            <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
              <h2 className="font-display text-base font-semibold">Hareket hacmi</h2>
              <span className="text-[12.5px] text-ink-3">son 14 gün</span>
              <Link href="/hareketler" className="ml-auto text-[13px] font-medium text-accent">
                Tümü
              </Link>
            </div>
            <div className="overflow-x-auto p-4">
              <div className="min-w-[560px]">
                <ActivityChart days={summary.activity} />
              </div>
            </div>
          </section>

          {/* ── 4. SON HAREKETLER ─────────────────────────────── */}
          <section
            aria-label="Son hareketler"
            className="rounded-card border border-line bg-surface shadow-card"
          >
            <div className="flex items-center border-b border-line px-4 py-3.5">
              <h2 className="font-display text-base font-semibold">Son hareketler</h2>
              <Link href="/hareketler" className="ml-auto text-[13px] font-medium text-accent">
                Tümü
              </Link>
            </div>

            {recent.length === 0 ? (
              // Boş liste de bir eylem sunuyor (Kural 09): panelde durup
              // "hareket yok" demek, kullanıcıyı çıkmaz sokakta bırakmak.
              <EmptyState
                title="Henüz hareket yok"
                description="İlk mal kabulünü veya satışı girdiğinizde son hareketler burada listelenir."
                action={{ href: '/hareket', label: 'Giriş / Çıkış gir' }}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-[13.5px]">
                  <thead>
                    <tr className="bg-surface-2 text-left text-[11.5px] tracking-wide text-ink-3 uppercase">
                      <th className="px-4 py-2.5 font-semibold">Saat</th>
                      <th className="px-4 py-2.5 font-semibold">Kullanıcı</th>
                      <th className="px-4 py-2.5 text-right font-semibold">Miktar</th>
                      <th className="px-4 py-2.5 font-semibold">Ürün</th>
                      <th className="px-4 py-2.5 font-semibold">İşlem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((m) => (
                      <tr key={m.id} className="border-t border-line">
                        <td className="tabular px-4 py-2.5 whitespace-nowrap text-ink-2">
                          {timeFormat.format(m.createdAt)}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">{m.userName}</td>
                        {/* İşaret metinde de var: renk tek başına anlam taşımıyor. */}
                        <td
                          className={`tabular px-4 py-2.5 text-right font-semibold whitespace-nowrap ${
                            m.delta > 0 ? 'text-ok' : 'text-crit'
                          }`}
                        >
                          {m.delta > 0 ? '↑ +' : '↓ '}
                          {formatQty(Math.abs(m.delta), 'ADET').replace(' adet', '')}
                        </td>
                        <td className="px-4 py-2.5">{m.productName}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-ink-2">
                          {reasonLabel(m.reason as MovementReason)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        {/* ── SAĞ RAY ───────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-4">
          {critical.rows.length > 0 ? (
            <section
              aria-label="Kritik ürünler"
              className="rounded-card border border-line bg-surface shadow-card"
            >
              <div className="flex items-center border-b border-line px-4 py-3.5">
                <h2 className="font-display text-base font-semibold">Kritik stok</h2>
                <Link href="/stok?kritik=1" className="ml-auto text-[13px] font-medium text-accent">
                  Tümü
                </Link>
              </div>
              <ul>
                {critical.rows.map((row) => {
                  const status = stockStatus(Number(row.qty), Number(row.minStock))
                  return (
                    <li
                      key={row.productId}
                      className="flex items-center gap-3 border-t border-line px-4 py-3 first:border-t-0"
                    >
                      <ProductThumb name={row.name} imageUrl={row.imageUrl} />
                      <span className="min-w-0 flex-1">
                        <Link
                          href={`/urunler/${row.productId}`}
                          className="block truncate leading-tight font-medium underline-offset-2 hover:underline"
                        >
                          {row.name}
                        </Link>
                        <span className="block font-mono text-[11.5px] leading-tight text-ink-3">
                          {row.sku}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <Badge tone={status.tone}>{status.label}</Badge>
                        <span className="tabular mt-1 block text-[12.5px] text-ink-3">
                          {formatQty(row.qty, row.unit as Unit)} / en az{' '}
                          {formatQty(row.minStock, row.unit as Unit)}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}

          {summary.categories.length > 0 ? (
            <section
              aria-label="Kategori dağılımı"
              className="rounded-card border border-line bg-surface shadow-card"
            >
              <h2 className="border-b border-line px-4 py-3.5 font-display text-base font-semibold">
                Kategori dağılımı
              </h2>
              <div className="p-4">
                <CategoryDonut slices={summary.categories} />
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </>
  )
}
