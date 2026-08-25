import Link from 'next/link'

/**
 * ============================================================================
 * ÜRÜN HÜCRESİ — T70 (tasarım incelemesi, karar TD6.2)
 *
 * Referans görselde her satırda ürün fotoğrafı var. `products` tablosunda
 * görsel sütunu YOK; TD6.2 ile ekleniyor ama ayrı iş (T82-T84).
 *
 * BURADAKİ BAŞ HARF KARESİ GEÇİCİ BİR ÇÖZÜM DEĞİL, KALICI GERİ DÜŞÜŞ.
 * 800 kalemlik bir katalogda satırların çoğu uzun süre fotoğrafsız kalacak;
 * fotoğraf geldiğinde bile gelmeyenler olacak. Fotoğrafsız satırın boş bir
 * gri kutu göstermesi, tabloyu bugünkünden daha karmaşık ama daha az
 * bilgilendirici yapardı. Baş harf en azından tarama sırasında ayırt edici.
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

export function ProductThumb({ name, size = 38 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[9px] border border-line bg-surface-2 font-display font-semibold text-ink-2"
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
  archived,
}: {
  id?: string
  name: string
  sku: string
  brand?: string | null
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
      <ProductThumb name={name} />
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
