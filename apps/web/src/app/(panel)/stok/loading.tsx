import { SkCard, SkFilters, SkRegion, SkRows } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Stok: filtre şeridi + yoğun tablo. En yavaş ekran, sayım sorgusu yüzünden.
 *
 * Kabuk düzende olduğu için kenar çubuğu ve üst şerit YERİNDE KALIYOR;
 * yalnızca içerik alanı iskelete dönüyor. Kullanıcı nerede olduğunu ve
 * nereye gidebileceğini kaybetmiyor.
 */
export default function Loading() {
  return (
    <SkRegion label="Stok tablosu yükleniyor">
      <SkFilters />
      <SkCard className="mt-4">
        {/* Ürün jetonlu satır: gerçek tabloda da baş harf karesi var. */}
        <SkRows rows={8} thumb />
      </SkCard>
    </SkRegion>
  )
}
