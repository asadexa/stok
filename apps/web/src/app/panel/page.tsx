import { type Unit, formatQty, reasonLabel } from '@stok/shared'
import type { MovementReason } from '@stok/shared'
import { dashboardSummary, listMovements, listStock } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T18 — ADMIN PANELİ
 *
 * Sıralama PLAN.md Bölüm 11'den ve tartışmaya kapalı:
 *
 *   1. UYARILAR      "bir sorun var mı?"  ← patronun ekrana bakınca
 *                                            sorduğu İLK soru bu
 *   2. BUGÜN         giriş / çıkış özeti
 *   3. SON HAREKETLER kim ne yaptı
 *   4. (stok tablosu ayrı sayfada)
 *
 * Brief'te sıra "Güncel Stok, sonra Log" idi. O sıra, en çok bakılan
 * bilgiyi en alta koyuyordu.
 *
 * Grafik YOK. Depo yazılımı okunaklı tablo ve büyük net sayı ister;
 * pasta grafik ve gradient kart bu üründe güveni azaltır.
 * ============================================================================
 */

/** Kullanıcının gününün başlangıcı. "Bugün" sunucunun saat diliminde değil. */
function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

const timeFormat = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' })

export default async function DashboardPage() {
  const actor = await currentActor()
  if (!actor) redirect('/giris')

  const db = appDb()
  const [summary, recent, critical] = await Promise.all([
    dashboardSummary(actor, startOfToday(), { db }),
    listMovements(actor, { limit: 10 }, { db }),
    listStock(actor, { onlyCritical: true, limit: 5 }, { db }),
  ])

  return (
    <Shell role={actor.role} active="/panel">
      {/* 1. UYARILAR */}
      <section aria-label="Uyarılar" className="mb-6 grid gap-3 sm:grid-cols-2">
        {summary.criticalCount > 0 ? (
          <Link
            href="/stok?kritik=1"
            className="flex items-center gap-3 rounded-md border border-kritik bg-kritik-bg p-4 text-kritik hover:brightness-95"
          >
            <span aria-hidden className="text-xl">
              ⚠
            </span>
            <span className="font-medium">
              {summary.criticalCount} ürün kritik seviyede
            </span>
          </Link>
        ) : (
          // Boş durum olumlu: "hiç kritik ürün yok" değil, "her şey yolunda".
          <p className="flex items-center gap-3 rounded-md border border-slate-200 bg-white p-4 text-slate-600">
            <span aria-hidden className="text-xl text-giris">
              ✓
            </span>
            <span>Kritik seviyede ürün yok</span>
          </p>
        )}

        {actor.role === 'ADMIN' ? (
          // Sağlık AYRINTISI kendi sayfasında (invariant taraması pahalı),
          // panelde sadece kapı duruyor. Panelin ilk sorusu "bir sorun var
          // mı" ve o soruya giden yol görünür olmalı.
          <Link
            href="/saglik"
            className="flex items-center gap-3 rounded-md border border-slate-200 bg-white p-4 text-slate-700 hover:bg-slate-50"
          >
            <span aria-hidden className="text-xl">
              ⚙
            </span>
            <span>Sistem sağlığını kontrol et</span>
          </Link>
        ) : null}

        {summary.failedJobCount ? (
          // KRİTİK AÇIK G4: rapor gönderilemediyse admin bunu panelde görür.
          <p className="flex items-center gap-3 rounded-md border border-kritik bg-kritik-bg p-4 text-kritik">
            <span aria-hidden className="text-xl">
              ⚠
            </span>
            <span className="font-medium">
              {summary.failedJobCount} arka plan işi başarısız oldu
            </span>
          </p>
        ) : null}
      </section>

      {/* 2. BUGÜN
          Çalışan için bu sayılar KENDİ hareketleri (dashboardSummary
          kapsamı daraltıyor). Etiket bunu söylemezse çalışan deponun
          tamamına bakıyor sanır ve yanlış rakamla konuşur. */}
      <section aria-label="Bugün" className="mb-6 grid gap-3 sm:grid-cols-2">
        <SummaryCard
          label={actor.role === 'ADMIN' ? 'Bugün giriş' : 'Bugün girişleriniz'}
          count={summary.today.inCount}
          qty={summary.today.inQty}
          tone="giris"
        />
        <SummaryCard
          label={actor.role === 'ADMIN' ? 'Bugün çıkış' : 'Bugün çıkışlarınız'}
          count={summary.today.outCount}
          qty={summary.today.outQty}
          tone="cikis"
        />
      </section>

      {/* 3. SON HAREKETLER */}
      <section aria-label="Son hareketler" className="rounded-md border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="font-semibold">Son Hareketler</h2>
          <Link href="/hareketler" className="text-sm text-slate-600 underline">
            Tümü
          </Link>
        </div>

        {recent.length === 0 ? (
          <p className="p-6 text-slate-600">Henüz hareket yok.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Saat</th>
                <th className="px-4 py-2 font-medium">Kullanıcı</th>
                <th className="px-4 py-2 text-right font-medium">Miktar</th>
                <th className="px-4 py-2 font-medium">Ürün</th>
                <th className="px-4 py-2 font-medium">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((m) => (
                <tr key={m.id} className="border-t border-slate-100">
                  <td className="tabular px-4 py-2 text-slate-600">
                    {timeFormat.format(m.createdAt)}
                  </td>
                  <td className="px-4 py-2">{m.userName}</td>
                  <td
                    className={`tabular px-4 py-2 text-right font-medium ${
                      m.delta > 0 ? 'text-giris' : 'text-cikis'
                    }`}
                  >
                    {/* İşaret metinde de var: renk tek başına anlam taşımıyor. */}
                    {m.delta > 0 ? '↑ +' : '↓ '}
                    {formatQty(Math.abs(m.delta), 'ADET').replace(' adet', '')}
                  </td>
                  <td className="px-4 py-2">{m.productName}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {reasonLabel(m.reason as MovementReason)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {critical.rows.length > 0 ? (
        <section aria-label="Kritik ürünler" className="mt-6 rounded-md border border-slate-200 bg-white">
          <h2 className="border-b border-slate-200 px-4 py-3 font-semibold">
            Kritik seviyedeki ürünler
          </h2>
          <ul>
            {critical.rows.map((row) => (
              <li
                key={row.productId}
                className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-sm first:border-t-0"
              >
                <span>{row.name}</span>
                <span className="tabular text-kritik">
                  {formatQty(row.qty, row.unit as Unit)} / en az{' '}
                  {formatQty(row.minStock, row.unit as Unit)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Shell>
  )
}

function SummaryCard({
  label,
  count,
  qty,
  tone,
}: {
  label: string
  count: number
  qty: number
  tone: 'giris' | 'cikis'
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <p className="text-sm text-slate-600">{label}</p>
      {/* Büyük net sayı: iki metre öteden okunmalı. */}
      <p className={`tabular mt-1 text-3xl font-semibold ${tone === 'giris' ? 'text-giris' : 'text-cikis'}`}>
        {count}
        <span className="ml-2 text-base font-normal text-slate-500">
          hareket · {qty.toLocaleString('tr-TR')} adet
        </span>
      </p>
    </div>
  )
}
