import { SkCard, SkFilters, SkRegion, SkRows } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Hareket logu: filtreler + tablo.
 *
 * Kabuk düzende olduğu için kenar çubuğu ve üst şerit YERİNDE KALIYOR;
 * yalnızca içerik alanı iskelete dönüyor. Kullanıcı nerede olduğunu ve
 * nereye gidebileceğini kaybetmiyor.
 */
export default function Loading() {
  return (
    <SkRegion label="Hareketler yükleniyor">
      <SkFilters />
      <SkCard className="mt-4">
        <SkRows rows={8} />
      </SkCard>
    </SkRegion>
  )
}
