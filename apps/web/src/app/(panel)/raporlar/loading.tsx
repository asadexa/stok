import { Sk, SkCard, SkRegion } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Raporlar: her kart için satır sayısı planı hesaplanıyor (COUNT sorgusu).
 */
export default function Loading() {
  return (
    <SkRegion label="Raporlar yükleniyor">
      <div className="grid max-w-4xl gap-4">
        {[0, 1, 2].map((i) => (
          <SkCard key={i} className="p-5">
            <Sk w="150px" h={16} />
            <Sk w="80%" h={13} className="mt-2" />
            <Sk w="200px" h={52} className="mt-4 rounded-control" />
          </SkCard>
        ))}
      </div>
    </SkRegion>
  )
}
