import {
  CURRENCIES,
  type Currency,
  SUPPLIER_CHANGE_KINDS,
  SUPPLIER_PRICE_TYPES,
  type SupplierChangeKind,
  type SupplierPriceType,
  TAX_MODES,
  type TaxMode,
  type Unit,
  formatQty,
} from '@stok/shared'
import { formatPercent, formatSupplierPrice } from '@/lib/format'
import { Badge } from './badge'

/**
 * ============================================================================
 * TEDARİKÇİ FİYATININ GÖSTERİMİ (T200) — tedarikçi sayfası ve ürün sayfası ortak
 *
 * Fiyat HER ZAMAN koşuluyla birlikte gösteriliyor. "12,50" tek başına ürün
 * kartının alış fiyatının yanında okunur ve KDV durumu bilinmeyen o fiyatla
 * kıyaslanırdı; PRD-15 tam olarak bunu yasaklıyor.
 *
 * İki ekran ayrı yazsaydı biri "KDV hariç"i, öteki fiyat miktarını unuturdu.
 * ============================================================================
 */

export interface PriceConditions {
  currency: Currency
  taxMode: TaxMode
  priceType: SupplierPriceType
}

/** "TL · KDV hariç · Net alış" */
export function conditionLabel(c: PriceConditions): string {
  return `${CURRENCIES[c.currency].short} · ${TAX_MODES[c.taxMode].tr} · ${SUPPLIER_PRICE_TYPES[c.priceType].tr}`
}

const plainQtyFmt = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 3 })

/**
 * Fiyatın ait olduğu miktar. Ürün biliniyorsa onun biriminde ("12 adet"),
 * bilinmiyorsa "ürün birimi" (eşleşmemiş kalemin birimi yok).
 */
export function priceQtyLabel(priceQty: string | null, unit?: Unit): string {
  if (priceQty === null) return 'Fiyat miktarı belirsiz'
  if (unit) return formatQty(Number(priceQty), unit)
  return `${plainQtyFmt.format(Number(priceQty))} ürün birimi`
}

/** "12,50 TL" — tablo hücresi. Koşul ayrı satırda ya da grup başlığında. */
export function SupplierPrice({ price, currency }: { price: string; currency: Currency }) {
  // `whitespace-nowrap`: uzun kodlu bir satırın yanında fiyat sütunu daralınca
  // "10,00" ile "TL" iki satıra bölünüyordu. Rakam bölünmez; gerekirse tablo kayar.
  return (
    <span className="tabular font-semibold whitespace-nowrap">
      {formatSupplierPrice(price)} {CURRENCIES[currency].short}
    </span>
  )
}

/**
 * Fiyat geçmişi satırının rozeti. Yön ve yüzde YALNIZ karşılaştırılabilir
 * değişimde (`PRICE`); koşulu değişen ya da miktarı belirsiz iki fiyat
 * arasında artış/azalış söylemek yanlış bir kıyas olurdu (ADR-006).
 *
 * Artış uyarı tonunda: alıcı için maliyetin yükselmesi. Anlam yalnız renkte
 * değil; ▲/▼ ve "arttı"/"azaldı" metni de var.
 */
export function ChangeBadge({
  kind,
  direction,
  changePct,
}: {
  kind: SupplierChangeKind
  direction: 1 | -1 | null
  changePct: string | null
}) {
  if (kind === 'PRICE' && direction !== null && changePct !== null) {
    const up = direction > 0
    return (
      <Badge tone={up ? 'warn' : 'ok'} icon={<span aria-hidden>{up ? '▲' : '▼'}</span>}>
        {formatPercent(changePct)} {up ? 'arttı' : 'azaldı'}
      </Badge>
    )
  }
  return <Badge tone="neutral">{SUPPLIER_CHANGE_KINDS[kind].tr}</Badge>
}
