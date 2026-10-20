import { SkCard, SkRegion, SkRows } from '@/components/skeleton'

/** Yükleme durumu: tedarikçi listesi. Kabuk yerinde kalıyor (T69). */
export default function Loading() {
  return (
    <SkRegion label="Tedarikçiler yükleniyor">
      <SkCard>
        <SkRows rows={5} />
      </SkCard>
    </SkRegion>
  )
}
