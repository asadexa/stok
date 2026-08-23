import { type Unit, formatQty } from '@stok/shared'
import { actorCan, exportStock, listCategories, listStock } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { ExportControl } from '@/components/export-control'
import { Pagination } from '@/components/pagination'
import { formatDateTime, formatMoney } from '@/lib/format'
import { type FormParams, errorQuery, messageFrom } from '@/server/form'
import { exportHref, exportPlanFor } from '@/server/export'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T19 — STOK TABLOSU
 *
 * Filtreleme ve sayfalama SUNUCUDA. On bin ürünü tarayıcıya gönderip orada
 * süzmek, deponun zayıf bağlantısında dakikalar sürer ve telefonun belleğini
 * doldurur.
 *
 * Filtreler adres çubuğunda (`/stok?ara=vida&kritik=1`). Üç sonucu var:
 * kullanıcı sayfayı yer imine ekleyebiliyor, bağlantıyı WhatsApp'tan
 * gönderebiliyor ve geri tuşu beklendiği gibi çalışıyor. İstemci state'inde
 * tutulsaydı üçü de olmazdı.
 *
 * Form GET, JavaScript gerektirmiyor: depodaki eski Android tarayıcıda da
 * arama çalışıyor.
 *
 * Kritik satırlar hem RENKLİ hem İKONLU hem de tablonun BAŞINDA (sıralamayı
 * `listStock` yapıyor). Renk tek başına anlam taşımıyor — depoda ışık kötü
 * ve renk körlüğü yaygın.
 * ============================================================================
 */

const PAGE_SIZE = 50

interface StokParams extends FormParams {
  ara?: string
  kategori?: string
  kritik?: string
  arsiv?: string
  atla?: string
  rapor?: string
  eposta?: string
}

/** Adres çubuğundan gelen sayı. Çöp girdi 0'a düşüyor, sayfa çökmüyor. */
function toOffset(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<StokParams>
}) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')

  const params = await searchParams
  const offset = toOffset(params.atla)
  const onlyCritical = params.kritik === '1'
  const includeArchived = params.arsiv === '1'
  const search = params.ara?.trim() || undefined
  const category = params.kategori?.trim() || undefined

  const db = appDb()
  const [page, categories] = await Promise.all([
    listStock(
      actor,
      { search, category, onlyCritical, includeArchived, limit: PAGE_SIZE, offset },
      { db },
    ),
    listCategories(actor, { db }),
  ])

  // Fiyat sütunları rolden değil CEVAPTAN türetiliyor: `listStock` yetkisi
  // olmayan role alanı hiç koymuyor. Rolü burada ikinci kez yorumlasaydık
  // iki yer ayrı düşebilirdi (tehdit S7).
  const showPrices = page.rows.some((r) => r.purchasePrice !== undefined)

  const filters = {
    ara: search,
    kategori: category,
    kritik: onlyCritical ? '1' : undefined,
    arsiv: includeArchived ? '1' : undefined,
  }
  const hasFilter = Object.values(filters).some(Boolean)

  // Export planı EKRANDAKİ FİLTRELERLE hesaplanıyor: kullanıcı "vida"
  // arayıp 12 satır görüyorsa dosya da 12 satır olmalı. Sayım yetkisiz
  // role hiç yapılmıyor.
  const canExport = actorCan(actor, 'export:excel')
  const exportParams = {
    search,
    category,
    onlyCritical,
    includeArchived,
  }
  const { plan: exportPlan, error: exportError } = canExport
    ? await exportPlanFor(actor, 'STOCK_EXPORT', exportParams)
    : { plan: null, error: null }

  async function queueExport() {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    const back = exportHref('/stok', filters)
    const join = back.includes('?') ? '&' : '?'

    // YÖNLENDİRMELER `try` DIŞINDA. Next'in `redirect()` fonksiyonu akış
    // kontrolü için fırlatıyor; içeride bırakılırsa başarı yönlendirmesi
    // kendi catch'ine düşer ve kullanıcı, iş gerçekten yapılmışken
    // "beklenmeyen hata" görür — sonra tekrar dener ve rapor iki kez
    // kuyruğa girer.
    let target: string
    try {
      const result = await exportStock(owner, exportParams, { db: appDb() })
      target =
        result.mode === 'queued'
          ? `${back}${join}rapor=kuyrukta&eposta=${encodeURIComponent(result.notifyEmail)}`
          : // Aradan satır silinip eşiğin altına düşmüş: artık anında inebilir.
            exportHref('/api/rapor/stok', filters)
    } catch (err) {
      target = `${back}${join}${errorQuery(err)}`
    }
    redirect(target)
  }

  const message = messageFrom(params)

  return (
    <Shell role={actor.role} active="/stok">
      {message ? (
        <p
          role="alert"
          className="mb-4 flex gap-2 rounded-md border border-kritik bg-kritik-bg p-3 text-sm text-kritik"
        >
          <span aria-hidden>⚠</span>
          <span>{message}</span>
        </p>
      ) : null}

      {params.rapor === 'kuyrukta' ? (
        <p className="mb-4 flex gap-2 rounded-md border border-giris bg-white p-3 text-sm text-slate-700">
          <span aria-hidden className="text-giris">
            ✓
          </span>
          <span>
            Rapor hazırlanıyor. Hazır olunca{' '}
            <span className="font-medium">{params.eposta}</span> adresine gönderilecek.
          </span>
        </p>
      ) : null}

      {actor.role === 'ADMIN' ? (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
          <ExportControl
            href={exportHref('/api/rapor/stok', filters)}
            plan={exportPlan}
            error={exportError}
            queueAction={queueExport}
          />
          <Link
            href="/urunler/yeni"
            className="h-14 rounded-md bg-slate-900 px-6 text-base font-medium leading-[3.5rem] text-white hover:bg-slate-700"
          >
            + Yeni ürün
          </Link>
        </div>
      ) : null}

      <form method="get" action="/stok" className="mb-4 flex flex-wrap items-end gap-3">
        <label className="block grow basis-64">
          <span className="text-sm font-medium">Ara</span>
          <input
            name="ara"
            type="search"
            defaultValue={search ?? ''}
            placeholder="Ürün adı veya stok kodu"
            /* 56 px: eldivenli elle basılabilmeli (PLAN.md Bölüm 11). */
            className="mt-1 h-14 w-full rounded-md border border-slate-300 bg-white px-3 text-base outline-none focus:border-slate-900"
          />
        </label>

        <label className="block basis-48">
          <span className="text-sm font-medium">Kategori</span>
          <select
            name="kategori"
            defaultValue={category ?? ''}
            className="mt-1 h-14 w-full rounded-md border border-slate-300 bg-white px-3 text-base outline-none focus:border-slate-900"
          >
            <option value="">Tümü</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="flex h-14 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="kritik"
            value="1"
            defaultChecked={onlyCritical}
            className="size-5"
          />
          Sadece kritik
        </label>

        <label className="flex h-14 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="arsiv"
            value="1"
            defaultChecked={includeArchived}
            className="size-5"
          />
          Arşiv dahil
        </label>

        <button
          type="submit"
          className="h-14 rounded-md bg-slate-900 px-6 text-base font-medium text-white hover:bg-slate-700"
        >
          Filtrele
        </button>

        {hasFilter ? (
          <Link href="/stok" className="h-14 leading-[3.5rem] text-sm text-slate-600 underline">
            Temizle
          </Link>
        ) : null}
      </form>

      <section aria-label="Stok tablosu" className="rounded-md border border-slate-200 bg-white">
        {page.rows.length === 0 ? (
          <div className="p-6 text-slate-600">
            {hasFilter ? (
              <p>Bu filtrelere uyan ürün yok.</p>
            ) : (
              <>
                <p>Henüz ürün yok.</p>
                {actor.role === 'ADMIN' ? (
                  <Link href="/urunler/yeni" className="mt-2 inline-block underline">
                    İlk ürünü ekleyin
                  </Link>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Ürün</th>
                  <th className="px-4 py-2 font-medium">Kategori</th>
                  <th className="px-4 py-2 font-medium">Konum</th>
                  <th className="px-4 py-2 text-right font-medium">Stok</th>
                  <th className="px-4 py-2 text-right font-medium">En az</th>
                  {showPrices ? (
                    <>
                      <th className="px-4 py-2 text-right font-medium">Alış</th>
                      <th className="px-4 py-2 text-right font-medium">Satış</th>
                    </>
                  ) : null}
                  <th className="px-4 py-2 font-medium">Son hareket</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={row.productId} className="border-t border-slate-100 align-top">
                    <td className="px-4 py-2">
                      {/* Ada tıklamak ürün kartına gidiyor: oradan hem
                          hareketlere hem düzenlemeye geçilebiliyor.
                          Doğrudan hareket loguna bağlansaydı, ürünü
                          düzenlemek için ayrı bir yol aramak gerekirdi. */}
                      <Link
                        href={`/urunler/${row.productId}`}
                        className="font-medium underline decoration-slate-300 underline-offset-2"
                      >
                        {row.name}
                      </Link>
                      <div className="tabular text-xs text-slate-500">
                        {row.sku}
                        {row.brand ? ` · ${row.brand}` : ''}
                        {row.archivedAt ? ' · arşivde' : ''}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{row.category ?? '—'}</td>
                    <td className="tabular px-4 py-2 text-slate-600">{row.locationCode ?? '—'}</td>
                    <td
                      className={`tabular px-4 py-2 text-right font-medium ${
                        row.critical ? 'text-kritik' : ''
                      }`}
                    >
                      {/* İkon + metin: renk tek başına "kritik" demiyor. */}
                      {row.critical ? <span aria-hidden>⚠ </span> : null}
                      {formatQty(row.qty, row.unit as Unit)}
                      {row.critical ? <span className="sr-only"> (kritik seviye)</span> : null}
                    </td>
                    <td className="tabular px-4 py-2 text-right text-slate-600">
                      {formatQty(row.minStock, row.unit as Unit)}
                    </td>
                    {showPrices ? (
                      <>
                        <td className="tabular px-4 py-2 text-right text-slate-600">
                          {row.purchasePrice == null ? '—' : `${formatMoney(row.purchasePrice)} ₺`}
                        </td>
                        <td className="tabular px-4 py-2 text-right text-slate-600">
                          {row.salePrice == null ? '—' : `${formatMoney(row.salePrice)} ₺`}
                        </td>
                      </>
                    ) : null}
                    <td className="tabular px-4 py-2 text-slate-600">
                      {row.lastMovementAt ? formatDateTime(row.lastMovementAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination
          basePath="/stok"
          params={filters}
          offset={page.offset}
          limit={page.limit}
          shown={page.rows.length}
          total={page.total}
          hasNext={page.offset + page.rows.length < page.total}
        />
      </section>
    </Shell>
  )
}
