import type { ProductOffer, ProductOffers } from '@stok/core'
import type { Unit } from '@stok/shared'
import Link from 'next/link'
import { Badge } from '@/components/badge'
import { EmptyState } from '@/components/empty-state'
import {
  ChangeBadge,
  SupplierPrice,
  conditionLabel,
  priceQtyLabel,
} from '@/components/supplier-price'
import { formatDateTime } from '@/lib/format'

/**
 * ============================================================================
 * ÜRÜN SAYFASINDA TEDARİKÇİ FİYATLARI (T200 1b) — yalnız yönetici
 *
 * Gruplar `listProductOffers`'tan: para birimi + KDV + fiyat türü + bilinen
 * fiyat miktarı aynı olan teklifler. "En düşük fiyat" kararı SQL'de ve yalnız
 * birden çok teklifli grupta veriliyor (ADR-006). Miktarı belirsiz teklifler
 * ayrı ve sırasız: TL ile USD'yi, koli ile adedi aynı sıraya koymak yanlış
 * kıyas olurdu.
 *
 * "Stok" değil "Tedarikçi stoğu": hemen üstteki "Eldeki stok" ile aynı adı
 * taşısaydı tedarikçinin rafı bizim rafımız sanılırdı.
 *
 * Çalışan için bu bileşen hiç çağrılmıyor ve sorgu hiç çalışmıyor (sayfa
 * `actorCan` ile ayırıyor); çağrılsaydı core 403 fırlatırdı (INV-10).
 * ============================================================================
 */
export function SupplierOffers({ offers, unit }: { offers: ProductOffers; unit: Unit }) {
  const empty = offers.groups.length === 0 && offers.uncertain.length === 0
  return (
    <aside
      aria-label="Tedarikçi fiyatları"
      className="mb-6 rounded-card border border-line bg-surface shadow-card lg:sticky lg:top-4 lg:row-span-2"
    >
      <h2 className="border-b border-line px-4 py-3 font-semibold">Tedarikçi fiyatları</h2>

      {empty ? (
        <EmptyState
          title="Bağlı tedarikçi kalemi yok"
          description="Tedarikçinin fiyat listesini yükleyin; barkodu bu ürünle eşleşen kalemler buraya gelir."
          action={{ href: '/tedarikciler', label: 'Tedarikçilere git' }}
        />
      ) : null}

      {offers.groups.map((group) => (
        <section
          key={`${group.currency}-${group.taxMode}-${group.priceType}-${group.priceQty}`}
          aria-label={`${conditionLabel(group)} · ${priceQtyLabel(group.priceQty, unit)}`}
          className="border-b border-line px-4 py-3"
        >
          <h3 className="text-sm font-semibold">
            {conditionLabel(group)} · {priceQtyLabel(group.priceQty, unit)}
          </h3>
          <ul>
            {group.offers.map((offer) => (
              <OfferRow key={offer.supplierItemId} offer={offer} />
            ))}
          </ul>
        </section>
      ))}

      {offers.uncertain.length > 0 ? (
        <section aria-label="Fiyat miktarı belirsiz" className="border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold">Fiyat miktarı belirsiz</h3>
          <p className="mt-1 text-xs text-ink-2">
            Karşılaştırmaya girmez: fiyatın kaç birim için olduğu bilinmiyor. Tedarikçi ayarında
            “1 ürün birimi” beyan edilirse ya da dosyada “Fiyat Miktarı” sütunu olursa karşılaştırılır.
          </p>
          <ul>
            {offers.uncertain.map((offer) => (
              <OfferRow key={offer.supplierItemId} offer={offer} showConditions />
            ))}
          </ul>
        </section>
      ) : null}

      {empty ? null : (
        <p className="px-4 py-3 text-xs text-ink-2">
          Tedarikçi fiyatı ve stoğu bilgi amaçlıdır; ürün kartının fiyatını ve stoğunuzu değiştirmez.
        </p>
      )}
    </aside>
  )
}

const stockFmt = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 3 })

function OfferRow({ offer, showConditions = false }: { offer: ProductOffer; showConditions?: boolean }) {
  return (
    <li className="border-t border-line py-2 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {/* `wrap-anywhere`: 100 karakterlik boşluksuz kod dar ekranda sayfayı kaydırmasın. */}
        <span className="min-w-0 wrap-anywhere">
          <Link href={`/tedarikciler/${offer.supplierId}`} className="font-medium underline">
            {offer.supplierName}
          </Link>
          <span className="ml-2 text-xs text-ink-3">{offer.supplierCode}</span>
        </span>
        <span className="flex items-center gap-2">
          <SupplierPrice price={offer.price} currency={offer.currency} />
          {offer.isLowest ? <Badge tone="ok">En düşük fiyat</Badge> : null}
        </span>
      </div>
      {showConditions ? <p className="text-xs text-ink-2">{conditionLabel(offer)}</p> : null}
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
        <span>
          Tedarikçi stoğu:{' '}
          {offer.stockQty === null ? 'bildirilmedi' : stockFmt.format(Number(offer.stockQty))}
        </span>
        <span>Son alındı: {formatDateTime(offer.fetchedAt)}</span>
        {offer.lastChange ? (
          <ChangeBadge
            kind={offer.lastChange.kind}
            direction={offer.lastChange.direction}
            changePct={offer.lastChange.changePct}
          />
        ) : null}
      </p>
    </li>
  )
}
