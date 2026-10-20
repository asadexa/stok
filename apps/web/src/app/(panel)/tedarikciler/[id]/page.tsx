import {
  AppError,
  SEARCH_MAX_LENGTH,
  SUPPLIER_MATCH_STATES,
  type SupplierMatchState,
  UNITS,
} from '@stok/shared'
import {
  type PriceChangeRow,
  type SearchResult,
  type SupplierItemRow,
  actorCan,
  bindSupplierItem,
  getSupplier,
  ignoreSupplierItem,
  listPriceChanges,
  listSupplierItems,
  searchAll,
  updateSupplier,
} from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { AllClear } from '@/components/empty-state'
import { Alert, Notice, SubmitButton } from '@/components/field'
import { Pagination } from '@/components/pagination'
import {
  ChangeBadge,
  SupplierPrice,
  conditionLabel,
  priceQtyLabel,
} from '@/components/supplier-price'
import { formatCount, formatDateTime } from '@/lib/format'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from '@/server/config'
import { type FormParams, messageFrom, preserveFields, safeErrorQuery, text } from '@/server/form'
import { currentActor } from '@/server/session'
import {
  SUPPLIER_FORM_FIELDS,
  SupplierFormFields,
  type SupplierFormValues,
  supplierInput,
} from '../supplier-form'
import { previewRefreshAction, saveRefreshAction } from './actions'
import { RefreshWizard } from './refresh-wizard'

/**
 * ============================================================================
 * T200 1b — TEDARİKÇİ DETAYI
 *
 * Sıra "önce iş, sonra sorun, sonra kayıt": Verileri Getir → eşleşme
 * bekleyenler → son fiyat değişimleri → bütün kalemler.
 *
 * Bağlama, yok sayma ve ayarlar düz formlar (JavaScript'siz çalışır); yalnız
 * "Verileri Getir" sihirbazı JavaScript istiyor (`actions.ts`).
 *
 * YANLIŞ EŞLEŞMEYE KARŞI: bağlama sonuçlarında ürün adı, stok kodu ve birimi
 * kalemin adının yanında görünüyor; arşivli ürün listelenmiyor; her eşleşme
 * "Bağlantıyı kaldır" ile geri alınabiliyor (kalem `IGNORED` olur ve otomatik
 * eşleşmeye bir daha girmez).
 * ============================================================================
 */

interface DetayParams extends FormParams, SupplierFormValues {
  yeni?: string
  guncellendi?: string
  baglandi?: string
  yoksayildi?: string
  ayarlar?: string
  durum?: string
  /** Kalem tablosunun ofseti; `Pagination` bileşeninin parametresi. */
  atla?: string
  bagla?: string
  ara?: string
  /**
   * Bağlama panelinin nerede açılacağı: `bekleyen` ya da `kalemler`. Aynı
   * kalem iki listede birden görünüyor; konum olmadan panel iki kez çiziliyor,
   * iki arama kutusu oluyordu (e2e'de yakalandı).
   */
  yer?: string
}

const PAGE_SIZE = 25

/** Kalem tablosu süzgeçleri: adres çubuğundaki Türkçe anahtar → eşleşme durumu. */
const ITEM_FILTERS: Record<string, { label: string; state?: SupplierMatchState }> = {
  tumu: { label: 'Tümü' },
  bekleyen: { label: 'Eşleşme bekleyen', state: 'UNMATCHED' },
  barkod: { label: 'Barkodla eşleşen', state: 'AUTO' },
  elle: { label: 'Elle bağlanan', state: 'MANUAL' },
  yoksay: { label: 'Yok sayılan', state: 'IGNORED' },
}

function offsetOf(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 0
}

export default async function SupplierPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<DetayParams>
}) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')
  if (!actorCan(actor, 'supplier:read')) redirect('/panel')

  const { id } = await params
  const query = await searchParams
  const message = messageFrom(query)
  const db = appDb()

  // Yalnız NOT_FOUND sayfayı 404'e çeviriyor; başka bir hata yutulmuyor.
  const supplier = await getSupplier(actor, id, { db }).catch((err: unknown) => {
    if (err instanceof AppError && err.code === 'NOT_FOUND') return null
    throw err
  })
  if (!supplier) notFound()

  const filterKey = query.durum && query.durum in ITEM_FILTERS ? query.durum : 'tumu'
  const itemOffset = offsetOf(query.atla)
  const bindingId = query.bagla
  const bindPlace = query.yer === 'kalemler' ? 'kalemler' : 'bekleyen'
  // "Ürün ara" kutuyu kalemin adıyla dolduruyor ve ad 300 karaktere kadar
  // geçerli; arama ise en fazla SEARCH_MAX_LENGTH. Kırpılmasaydı doğrulama
  // hatası aşağıdaki `Promise.all`'u düşürüp genel hata ekranını açıyordu
  // (T200 1b REVIEW, B2). Kutu düzenlenebilir; kullanıcı aramayı değiştirir.
  const searchText = (query.ara ?? '').trim().slice(0, SEARCH_MAX_LENGTH).trim()

  // Bekleyenler bölümü ilk sayfayı gösteriyor; devamı kalem tablosunun
  // "Eşleşme bekleyen" süzgecinde. Tek sayfada iki sayfalayıcı aynı adres
  // parametresini (`atla`) paylaşıp birbirini ilerletirdi.
  const [pending, items, changes, search] = await Promise.all([
    listSupplierItems(actor, id, { matchState: 'UNMATCHED', limit: PAGE_SIZE }, { db }),
    listSupplierItems(
      actor,
      id,
      { matchState: ITEM_FILTERS[filterKey]!.state, limit: PAGE_SIZE, offset: itemOffset },
      { db },
    ),
    listPriceChanges(actor, id, 50, { db }),
    bindingId && searchText !== '' ? searchAll(actor, searchText, { db }) : Promise.resolve(null),
  ])

  // -------------------------------------------------------------------------
  // Sunucu eylemleri. Yetki ve kiracı kontrolü core'da; yönlendirme `try` dışında.
  // -------------------------------------------------------------------------

  async function saveSettings(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')
    let target: string
    try {
      await updateSupplier(owner, id, supplierInput(form), { db: appDb() })
      target = `/tedarikciler/${id}?guncellendi=1`
    } catch (err) {
      target = `/tedarikciler/${id}?${safeErrorQuery('supplier settings', err)}&${preserveFields(form, SUPPLIER_FORM_FIELDS)}&ayarlar=1#ayarlar`
    }
    redirect(target)
  }

  async function bindItem(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')
    let target: string
    try {
      await bindSupplierItem(owner, text(form, 'kalemId'), text(form, 'urunId'), { db: appDb() })
      target = `/tedarikciler/${id}?baglandi=1#eslesme`
    } catch (err) {
      target = `/tedarikciler/${id}?${safeErrorQuery('supplier bind', err)}#eslesme`
    }
    redirect(target)
  }

  async function ignoreItem(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')
    let target: string
    try {
      await ignoreSupplierItem(owner, text(form, 'kalemId'), { db: appDb() })
      target = `/tedarikciler/${id}?yoksayildi=1#eslesme`
    } catch (err) {
      target = `/tedarikciler/${id}?${safeErrorQuery('supplier ignore', err)}#eslesme`
    }
    redirect(target)
  }

  /** Kalem tablosunda süzgeç ve sayfa korunuyor: arama sonrası kullanıcı yerini kaybetmesin. */
  const tableContext = { durum: filterKey, atla: itemOffset > 0 ? String(itemOffset) : '' }

  const bindPanel = (item: SupplierItemRow, place: 'bekleyen' | 'kalemler') =>
    bindingId === item.id && bindPlace === place ? (
      <BindPanel
        supplierId={id}
        item={item}
        query={searchText}
        result={search}
        bind={bindItem}
        keep={place === 'kalemler' ? { ...tableContext, yer: place } : { yer: place }}
      />
    ) : null

  const searchHref = (item: SupplierItemRow, place: 'bekleyen' | 'kalemler') => {
    const search = new URLSearchParams(place === 'kalemler' ? tableContext : {})
    for (const [key, value] of [...search.entries()]) if (value === '') search.delete(key)
    search.set('bagla', item.id)
    search.set('ara', item.name)
    search.set('yer', place)
    return `/tedarikciler/${id}?${search.toString()}#${place === 'kalemler' ? 'kalemler' : 'eslesme'}`
  }

  const settingsValues: SupplierFormValues = query.ayarlar
    ? query
    : {
        ad: supplier.name,
        paraBirimi: supplier.defaultCurrency,
        kdv: supplier.defaultTaxMode,
        fiyatTuru: supplier.defaultPriceType,
        fiyatMiktari: supplier.unitPriceDeclared ? '1' : '',
      }

  return (
    <>
      <h2 className="mb-4 font-display text-lg font-semibold">Tedarikçi</h2>
      <div className="mb-2 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">{supplier.name}</h1>
        <Link href="/tedarikciler" className="text-sm text-ink-2 underline">
          Tedarikçilere dön
        </Link>
      </div>
      <p className="mb-4 text-sm text-ink-2">
        Varsayılan:{' '}
        {conditionLabel({
          currency: supplier.defaultCurrency,
          taxMode: supplier.defaultTaxMode,
          priceType: supplier.defaultPriceType,
        })}{' '}
        · Fiyat miktarı: {supplier.unitPriceDeclared ? '1 ürün birimi' : 'belirsiz'} ·{' '}
        {formatCount(supplier.itemCount)} kalem · Son veri alma:{' '}
        {supplier.lastRefreshedAt ? formatDateTime(supplier.lastRefreshedAt) : 'henüz yok'}
      </p>

      <div className="mb-4 space-y-3">
        {message ? <Alert>{message}</Alert> : null}
        {query.yeni ? <Notice>Tedarikçi eklendi. Şimdi fiyat listesini yükleyin.</Notice> : null}
        {query.guncellendi ? (
          <Notice>
            Ayarlar kaydedildi. Yeni ayarlar yalnız bundan sonraki yüklemelerde kullanılır; kayıtlı
            fiyatlar ve fiyat geçmişi değişmez.
          </Notice>
        ) : null}
        {query.baglandi ? <Notice>Kalem ürüne bağlandı.</Notice> : null}
        {query.yoksayildi ? (
          <Notice>
            Kalem yok sayıldı: otomatik eşleşmeye bir daha girmez. Gerekirse elle bağlayabilirsiniz.
          </Notice>
        ) : null}
      </div>

      <details
        id="ayarlar"
        open={query.ayarlar === '1'}
        className="mb-6 max-w-2xl rounded-card border border-line bg-surface shadow-card"
      >
        <summary className="cursor-pointer px-5 py-4 font-semibold">Tedarikçi ayarlarını düzenle</summary>
        <form action={saveSettings} className="space-y-5 border-t border-line p-5">
          <p className="text-sm text-ink-2">
            Değişiklik yalnız bundan sonraki yüklemeleri etkiler. Kayıtlı fiyatlar ve fiyat geçmişi
            geriye dönük değişmez; sonraki yüklemede koşulu değişen kalemler geçmişte “Koşul değişimi”
            olarak görünür.
          </p>
          <SupplierFormFields values={settingsValues} />
          <SubmitButton tone="secondary">Ayarları kaydet</SubmitButton>
        </form>
      </details>

      <section
        id="verileri-getir"
        aria-label="Verileri getir"
        className="mb-6 rounded-card border border-line bg-surface shadow-card p-5"
      >
        <h2 className="mb-4 font-semibold">Verileri Getir</h2>
        <RefreshWizard
          supplierId={id}
          maxUploadBytes={MAX_UPLOAD_BYTES}
          uploadLabel={MAX_UPLOAD_LABEL}
          preview={previewRefreshAction}
          save={saveRefreshAction}
        />
      </section>

      <section id="eslesme" aria-label="Eşleşme bekleyenler" className="mb-6">
        <h2 className="mb-3 font-semibold">Eşleşme bekleyenler ({formatCount(pending.total)})</h2>
        {pending.total === 0 ? (
          <AllClear>Eşleşme bekleyen kalem yok.</AllClear>
        ) : (
          <div className="rounded-card border border-line bg-surface shadow-card">
            <ul>
              {pending.rows.map((item) => (
                <li key={item.id} className="border-t border-line px-4 py-3 first:border-t-0">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    {/*
                      `wrap-anywhere`: tedarikçi kodu 100 karaktere kadar boşluksuz
                      gelebiliyor. Kırılmazsa dar ekranda satır taşıp bütün sayfayı
                      yatay kaydırıyordu (390 px'te 768 px ölçüldü).
                      `min-w-[12rem]`: taban 0 olan `flex-1` dar ekranda adı fiyat
                      ve iki düğmeyle aynı satıra sıkıştırıyor, ad kelime kelime
                      alt alta diziliyordu. Bu genişliğin altında düğmeler alt
                      satıra iniyor.
                    */}
                    <div className="min-w-[12rem] flex-1 wrap-anywhere">
                      <span className="font-medium">{item.name}</span>
                      <span className="block text-xs text-ink-2">
                        {item.supplierCode}
                        {item.barcode && item.barcode !== item.supplierCode ? ` · ${item.barcode}` : ''}
                      </span>
                    </div>
                    <div className="text-sm">
                      <SupplierPrice price={item.price} currency={item.currency} />
                    </div>
                    <Link
                      href={searchHref(item, 'bekleyen')}
                      className="rounded-control border border-line-control px-3 py-2 text-sm hover:bg-surface-2"
                    >
                      Ürün ara
                    </Link>
                    <form action={ignoreItem}>
                      <input type="hidden" name="kalemId" value={item.id} />
                      <button
                        type="submit"
                        className="rounded-control border border-line-control px-3 py-2 text-sm hover:bg-surface-2"
                      >
                        Yok say
                      </button>
                    </form>
                  </div>
                  {bindPanel(item, 'bekleyen')}
                </li>
              ))}
            </ul>
            {pending.total > pending.rows.length ? (
              <p className="border-t border-line px-4 py-3 text-sm">
                …ve {formatCount(pending.total - pending.rows.length)} kalem daha.{' '}
                <Link href={`/tedarikciler/${id}?durum=bekleyen#kalemler`} className="underline">
                  Tümünü kalem tablosunda gör
                </Link>
              </p>
            ) : null}
          </div>
        )}
      </section>

      <section id="degisimler" aria-label="Son fiyat değişimleri" className="mb-6">
        <h2 className="mb-3 font-semibold">Son fiyat değişimleri</h2>
        {changes.length === 0 ? (
          <AllClear>Henüz fiyat değişimi yok. Değişmeyen fiyat geçmişe yazılmaz.</AllClear>
        ) : (
          <div className="rounded-card border border-line bg-surface shadow-card">
            <ul>
              {changes.map((c) => (
                <ChangeRow key={c.id} change={c} />
              ))}
            </ul>
          </div>
        )}
      </section>

      <section id="kalemler" aria-label="Kalemler" className="mb-6">
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="font-semibold">Kalemler ({formatCount(items.total)})</h2>
          <nav aria-label="Kalem süzgeci" className="flex flex-wrap gap-2 text-sm">
            {Object.entries(ITEM_FILTERS).map(([key, f]) => (
              <Link
                key={key}
                href={`/tedarikciler/${id}?durum=${key}#kalemler`}
                aria-current={key === filterKey ? 'page' : undefined}
                className={`rounded-chip px-3 py-1.5 ${
                  key === filterKey ? 'bg-accent-soft text-accent-soft-ink' : 'text-ink-2 hover:bg-surface-2'
                }`}
              >
                {f.label}
              </Link>
            ))}
          </nav>
        </div>
        {items.total === 0 ? (
          <AllClear>
            {filterKey === 'tumu' ? 'Henüz kalem yok. Fiyat listesini yukarıdan yükleyin.' : 'Bu süzgeçte kalem yok.'}
          </AllClear>
        ) : (
          <div className="rounded-card border border-line bg-surface shadow-card">
            {/*
              `relative`: son sütun başlığındaki `sr-only` etiketi `position:
              absolute`. Sarmalayıcı konumlandırılmazsa etiket kaydırma alanının
              kırpmasından kaçıyor ve dar ekranda BÜTÜN sayfa yatay kayıyor
              (390 px'te belge 754 px ölçüldü).
            */}
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[880px] text-sm">
                <thead className="text-left text-ink-3">
                  <tr>
                    <th className="px-4 py-2 font-medium">Kalem</th>
                    <th className="px-4 py-2 font-medium">Fiyat</th>
                    <th className="px-4 py-2 font-medium">Tedarikçi stoğu</th>
                    <th className="px-4 py-2 font-medium">Eşleşme</th>
                    <th className="px-4 py-2 font-medium">Son alındı</th>
                    <th className="px-4 py-2 font-medium">
                      <span className="sr-only">İşlem</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.rows.map((item) => (
                    <ItemRows
                      key={item.id}
                      item={item}
                      searchHref={searchHref(item, 'kalemler')}
                      ignore={ignoreItem}
                      panel={bindPanel(item, 'kalemler')}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              basePath={`/tedarikciler/${id}`}
              params={{ durum: filterKey }}
              offset={itemOffset}
              limit={PAGE_SIZE}
              shown={items.rows.length}
              total={items.total}
              hasNext={itemOffset + items.rows.length < items.total}
            />
          </div>
        )}
      </section>
    </>
  )
}

const stockFmt = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 3 })

function stockText(value: string | null): string {
  return value === null ? 'Bildirilmedi' : stockFmt.format(Number(value))
}

function ItemRows({
  item,
  searchHref,
  ignore,
  panel,
}: {
  item: SupplierItemRow
  searchHref: string
  ignore: (form: FormData) => Promise<void>
  panel: React.ReactNode
}) {
  const linked = item.matchState === 'AUTO' || item.matchState === 'MANUAL'
  return (
    <>
      <tr className="border-t border-line align-top">
        <td className="px-4 py-3">
          <span className="font-medium">{item.name}</span>
          <span className="block text-xs text-ink-2">
            {item.supplierCode}
            {item.barcode && item.barcode !== item.supplierCode ? ` · ${item.barcode}` : ''}
          </span>
        </td>
        <td className="px-4 py-3">
          <SupplierPrice price={item.price} currency={item.currency} />
          <span className="block text-xs text-ink-2">
            {conditionLabel(item)} · {priceQtyLabel(item.priceQty)}
          </span>
        </td>
        <td className="tabular px-4 py-3">{stockText(item.stockQty)}</td>
        <td className="px-4 py-3">
          {item.productId && item.productName ? (
            <>
              <Link href={`/urunler/${item.productId}`} className="font-medium underline">
                {item.productName}
              </Link>
              <span className="block text-xs text-ink-2">
                {item.productSku} · {SUPPLIER_MATCH_STATES[item.matchState].tr}
              </span>
            </>
          ) : (
            <span className="text-ink-2">{SUPPLIER_MATCH_STATES[item.matchState].tr}</span>
          )}
        </td>
        <td className="px-4 py-3 text-ink-2">{formatDateTime(item.fetchedAt)}</td>
        <td className="px-4 py-3 text-right">
          {linked ? (
            <form action={ignore}>
              <input type="hidden" name="kalemId" value={item.id} />
              <button
                type="submit"
                className="whitespace-nowrap rounded-control border border-line-control px-3 py-2 text-sm hover:bg-surface-2"
              >
                Bağlantıyı kaldır
              </button>
            </form>
          ) : (
            <Link
              href={searchHref}
              className="whitespace-nowrap rounded-control border border-line-control px-3 py-2 text-sm hover:bg-surface-2"
            >
              Ürün ara
            </Link>
          )}
        </td>
      </tr>
      {panel ? (
        <tr>
          <td colSpan={6} className="px-4 pb-3">
            {panel}
          </td>
        </tr>
      ) : null}
    </>
  )
}

function ChangeRow({ change: c }: { change: PriceChangeRow }) {
  const conditionChanged = c.kind === 'CONDITION'
  const oldSide = { currency: c.oldCurrency, taxMode: c.oldTaxMode, priceType: c.oldPriceType }
  const newSide = { currency: c.newCurrency, taxMode: c.newTaxMode, priceType: c.newPriceType }
  return (
    <li className="border-t border-line px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 wrap-anywhere">
          <span className="font-medium">{c.itemName}</span>
          <span className="block text-xs text-ink-2">
            {c.supplierCode} · {formatDateTime(c.createdAt)}
          </span>
        </div>
        <ChangeBadge kind={c.kind} direction={c.direction} changePct={c.changePct} />
      </div>
      <p className="mt-1 text-sm">
        <SupplierPrice price={c.oldPrice} currency={c.oldCurrency} />
        <span aria-hidden> → </span>
        <span className="sr-only"> yerine </span>
        <SupplierPrice price={c.newPrice} currency={c.newCurrency} />
      </p>
      {conditionChanged ? (
        <p className="text-xs text-ink-2">
          Önce: {conditionLabel(oldSide)} · {priceQtyLabel(c.oldPriceQty)} — Şimdi:{' '}
          {conditionLabel(newSide)} · {priceQtyLabel(c.newPriceQty)}
        </p>
      ) : (
        <p className="text-xs text-ink-2">
          {conditionLabel(newSide)} · {priceQtyLabel(c.newPriceQty)}
        </p>
      )}
    </li>
  )
}

/**
 * Elle bağlama: ürün ara → "Bu ürüne bağla". GET formu ve düz POST: JavaScript
 * gerekmiyor. Arama `searchAll` (Ctrl+K paletinin kaynağı): barkod tam, ad ve
 * stok kodu parça eşleşmesi; arşivli ürün gelmiyor (bağlama da reddediyor).
 */
function BindPanel({
  supplierId,
  item,
  query,
  result,
  bind,
  keep,
}: {
  supplierId: string
  item: SupplierItemRow
  query: string
  result: SearchResult | null
  bind: (form: FormData) => Promise<void>
  /** Arama formunun taşıdığı bağlam: panelin konumu, kalem tablosunun süzgeci ve sayfası. */
  keep: Record<string, string>
}) {
  const hits = new Map<string, { productId: string; name: string; sku: string; unit: keyof typeof UNITS }>()
  if (result?.barcode && !result.barcode.archived) {
    hits.set(result.barcode.productId, result.barcode)
  }
  for (const p of result?.products ?? []) hits.set(p.productId, p)

  return (
    <div className="mt-3 space-y-3 rounded-control border border-line-control bg-surface-2 p-3">
      <p className="text-sm">
        <span className="font-semibold">{item.name}</span> için ürün seçin. Yanlış eşleşme
        karşılaştırmayı bozar: ad, stok kodu ve birimi kontrol edin.
      </p>
      <form method="get" action={`/tedarikciler/${supplierId}`} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="bagla" value={item.id} />
        {Object.entries(keep)
          .filter(([, value]) => value !== '')
          .map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
        <label className="text-sm">
          <span className="block text-ink-2">Ürün adı, stok kodu ya da barkod</span>
          <input
            name="ara"
            type="search"
            defaultValue={query}
            maxLength={SEARCH_MAX_LENGTH}
            className="mt-1 h-11 w-72 max-w-full rounded-control border border-line-control bg-surface px-2"
          />
        </label>
        <button
          type="submit"
          className="h-11 rounded-control border border-line-control bg-surface px-4 text-sm hover:bg-surface-2"
        >
          Ara
        </button>
      </form>
      {hits.size === 0 ? (
        <p className="text-sm text-ink-2">
          {query === '' ? 'Aramak için bir şey yazın.' : 'Ürün bulunamadı. Başka bir ad, stok kodu ya da barkod deneyin.'}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-control border border-line bg-surface">
          {[...hits.values()].map((p) => (
            <li key={p.productId} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{p.name}</span>
                <span className="block text-xs text-ink-2">
                  {p.sku} · {UNITS[p.unit].tr}
                </span>
              </span>
              <form action={bind}>
                <input type="hidden" name="kalemId" value={item.id} />
                <input type="hidden" name="urunId" value={p.productId} />
                <button
                  type="submit"
                  className="rounded-control border border-line-control px-3 py-2 hover:bg-surface-2"
                >
                  Bu ürüne bağla
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
