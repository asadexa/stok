import { categorySummary } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { EmptyState } from '@/components/empty-state'
import { formatMoney } from '@/lib/format'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T73 — KATEGORİLER (tasarım incelemesi, karar TD2)
 *
 * Referans görselde ayrı bir "Kategoriler" menüsü var. Bu ekran onun
 * karşılığı ve YENİ VERİ MODELİ GEREKTİRMİYOR: `products.category` zaten
 * serbest metin bir sütun ve bugüne kadar yalnızca stok tablosunda bir
 * filtre olarak kullanılıyordu.
 *
 * EKRAN NE İŞE YARIYOR: stok tablosu ürün ürün bakıyor, burası kategori
 * kategori. "Hangi kategoride ne kadar para bağlı" ve "hangi kategoride
 * kaç ürün kritik" soruları stok tablosunda 1.248 satır tarayarak
 * cevaplanamıyor.
 *
 * HER SATIR STOK TABLOSUNA BAĞLANIYOR. Kategori burada bir varış noktası
 * değil bir kapı: sayıyı gören kişinin bir sonraki sorusu her zaman
 * "hangi ürünler" oluyor.
 *
 * "Kalem" ile "kalem" AYRI GÖRÜNÜR ve bu bilinçli. Normalizasyon yapmak,
 * kullanıcının yazdığını sessizce değiştirip gizli bir eşleme kuralı
 * yaratmak olurdu. Fark gözle görünsün ki düzeltilebilsin.
 * ============================================================================
 */

const numFmt = new Intl.NumberFormat('tr-TR')

export default async function CategoriesPage() {
  const actor = await currentActor()
  if (!actor) redirect('/giris')

  const rows = await categorySummary(actor, { db: appDb() })
  const showValue = rows.some((r) => r.stockValue !== undefined)
  const totalProducts = rows.reduce((n, r) => n + r.productCount, 0)

  return (
    <section aria-label="Kategoriler" className="rounded-card border border-line bg-surface shadow-card">
      {rows.length === 0 ? (
        <EmptyState
          title="Henüz kategori yok"
          description="Kategori ayrı bir kayıt değil, ürünün bir alanı. İlk ürünü eklediğinizde veya toplu aktardığınızda buradaki liste kendiliğinden dolar."
          action={{ href: '/urunler/aktar', label: "Excel'den toplu aktar" }}
          secondary={{ href: '/urunler/yeni', label: 'Tek ürün ekle' }}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-3.5">
            <h2 className="font-display text-base font-semibold">
              {numFmt.format(rows.length)} kategori
            </h2>
            <span className="text-[12.5px] text-ink-3">
              {numFmt.format(totalProducts)} ürün · arşiv hariç
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-[13.5px]">
              <thead>
                <tr className="bg-surface-2 text-left text-[11.5px] tracking-wide text-ink-3 uppercase">
                  <th className="px-4 py-2.5 font-semibold">Kategori</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Ürün</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Kritik</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Toplam adet</th>
                  {showValue ? (
                    <th className="px-4 py-2.5 text-right font-semibold">Stok değeri</th>
                  ) : null}
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  // Kategorisiz satır da filtrelenebilmeli. `kategori=` boş
                  // değerle gönderilirse stok tablosu "tümü" anlar; bu yüzden
                  // kategorisiz için ayrı bir işaret gerekiyordu. Şimdilik o
                  // satır sadece listede duruyor, bağlantısı yok — yanlış
                  // filtreye götürmektense hiç götürmemek daha dürüst.
                  const href = row.value
                    ? `/stok?kategori=${encodeURIComponent(row.value)}`
                    : null
                  return (
                    <tr key={row.name} className="border-t border-line">
                      <td className="px-4 py-2.5 font-medium">
                        {href ? (
                          <Link href={href} className="underline-offset-2 hover:underline">
                            {row.name}
                          </Link>
                        ) : (
                          <span className="text-ink-2">{row.name}</span>
                        )}
                      </td>
                      <td className="tabular px-4 py-2.5 text-right whitespace-nowrap">
                        {numFmt.format(row.productCount)}
                      </td>
                      <td
                        className={`tabular px-4 py-2.5 text-right font-semibold whitespace-nowrap ${
                          row.criticalCount > 0 ? 'text-crit' : 'text-ink-3'
                        }`}
                      >
                        {row.criticalCount > 0 ? numFmt.format(row.criticalCount) : '—'}
                      </td>
                      <td className="tabular px-4 py-2.5 text-right whitespace-nowrap text-ink-2">
                        {numFmt.format(row.totalQty)}
                      </td>
                      {showValue ? (
                        <td className="tabular px-4 py-2.5 text-right whitespace-nowrap text-ink-2">
                          {row.stockValue === undefined
                            ? '—'
                            : `${formatMoney(row.stockValue)} ₺`}
                        </td>
                      ) : null}
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        {row.criticalCount > 0 && row.value ? (
                          <Link
                            href={`/stok?kategori=${encodeURIComponent(row.value)}&kritik=1`}
                            className="text-[13px] font-medium text-crit"
                          >
                            Kritikleri gör
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
