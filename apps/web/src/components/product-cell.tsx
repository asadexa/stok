import Link from 'next/link'

/**
 * ============================================================================
 * ÜRÜN HÜCRESİ — T70 (tasarım incelemesi, karar TD6.2)
 *
 * Referans görselde her satırda ürün fotoğrafı var. `products` tablosunda
 * görsel sütunu YOK; TD6.2 ile ekleniyor ama ayrı iş (T82-T84).
 *
 * BAŞ HARF KARESİ GEÇİCİ BİR ÇÖZÜM DEĞİL, KALICI GERİ DÜŞÜŞ.
 * 800 kalemlik bir katalogda satırların çoğu uzun süre fotoğrafsız kalacak;
 * fotoğraf geldiğinde bile gelmeyenler olacak. Fotoğrafsız satırın boş bir
 * gri kutu göstermesi, tabloyu bugünkünden daha karmaşık ama daha az
 * bilgilendirici yapardı. Baş harf en azından tarama sırasında ayırt edici.
 *
 * GÖRSEL `<img>` İLE BASILIYOR, `next/image` İLE DEĞİL. Adresler DIŞARIDAN
 * geliyor (tedarikçi kataloğu, toplu aktarma) ve `next/image` her alan adının
 * `next.config` içinde önceden tanımlanmasını istiyor — bilinmeyen bir alan
 * adı 400 döndürüyor. Kullanıcının girdiği geçerli bir adres, yapılandırmada
 * yazmıyor diye kırık görünürdü.
 *
 * `onError` YOK çünkü sunucu bileşeni. Kırık adres tarayıcının kendi kırık
 * görsel işaretini gösteriyor; `alt` metni de ürün adı olduğu için satır
 * yine okunabiliyor.
 *
 * BAŞ HARF TÜRKÇEYE GÖRE BÜYÜTÜLÜYOR. `toUpperCase()` tek başına yanlış:
 * JavaScript'te "isıtıcı".toUpperCase() → "ISITICI" (doğru), ama "i" harfi
 * Türkçe'de "İ" olmalı. `toLocaleUpperCase('tr')` bunu yapıyor. Yanlış
 * büyütülen bir baş harf, kullanıcının ürünü tanımasını zorlaştırır.
 * ============================================================================
 */

/** Ada göre baş harf: en fazla iki harf, Türkçe kurallarıyla büyütülmüş. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0]?.[0] ?? '?'
  const second = words[1]?.[0] ?? ''
  return (first + second).toLocaleUpperCase('tr-TR')
}

export function ProductThumb({
  name,
  imageUrl,
  size = 38,
}: {
  name: string
  imageUrl?: string | null
  size?: number
}) {
  const box =
    'grid shrink-0 place-items-center overflow-hidden rounded-chip border border-line bg-surface-2'

  if (imageUrl) {
    return (
      // KULLANICIDAN geliyor (T82: tedarikçi kataloğundaki URL). next/image
      // uzak adresleri `remotePatterns` ile önceden tanımlamayı istiyor;
      // rastgele bir adres için bu mümkün değil. Zorunlu geri düşüş T84.
      // biome-ignore lint/performance/noImgElement: görsel adresi
      <img
        src={imageUrl}
        // `alt=""`: görsel yanındaki metnin TEKRARI. Ürün adı hemen yanında
        // yazıyor; ekran okuyucuya iki kez okutmak gürültü.
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className={`${box} object-cover`}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <span
      aria-hidden
      className={`${box} font-display font-semibold text-ink-2`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
    >
      {initials(name)}
    </span>
  )
}

export function ProductCell({
  id,
  name,
  sku,
  brand,
  imageUrl,
  archived,
}: {
  id?: string
  name: string
  sku: string
  brand?: string | null
  imageUrl?: string | null
  archived?: boolean
}) {
  const label = (
    <>
      <span className={`block leading-tight font-medium ${archived ? 'text-ink-3' : ''}`}>
        {name}
      </span>
      {/* Stok kodu monospace: kod okunurken karakter karakter karşılaştırılıyor
          ve orantılı yazı tipinde 0/O, 1/l ayrımı kayboluyor. */}
      <span className="block font-mono text-[11.5px] leading-tight text-ink-3">
        {sku}
        {brand ? ` · ${brand}` : ''}
      </span>
    </>
  )

  return (
    <span className="flex items-center gap-3">
      <ProductThumb name={name} imageUrl={imageUrl} />
      <span className="min-w-0">
        {id ? (
          <Link href={`/urunler/${id}`} className="underline-offset-2 hover:underline">
            {label}
          </Link>
        ) : (
          label
        )}
      </span>
    </span>
  )
}
