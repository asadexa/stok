import { SkCard, SkCardHead, SkRegion, SkRows } from '@/components/skeleton'

/** Yükleme durumu: tedarikçi detayı (yükleme kutusu + kalem listesi). Kabuk yerinde (T69). */
export default function Loading() {
  return (
    <SkRegion label="Tedarikçi yükleniyor">
      <SkCard className="mb-6">
        <SkCardHead w="160px" />
        <SkRows rows={2} />
      </SkCard>
      <SkCard>
        <SkCardHead />
        <SkRows rows={6} />
      </SkCard>
    </SkRegion>
  )
}
