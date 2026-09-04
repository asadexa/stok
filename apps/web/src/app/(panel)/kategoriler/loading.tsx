import { SkCard, SkCardHead, SkRegion, SkRows } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Kategoriler: gruplama sorgusu tüm ürünleri tarıyor.
 */
export default function Loading() {
  return (
    <SkRegion label="Kategoriler yükleniyor">
      <SkCard>
        <SkCardHead w="150px" />
        <SkRows rows={6} />
      </SkCard>
    </SkRegion>
  )
}
