import { Sk, SkCard, SkRegion } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Ayarlar: profil sorgusu ve tema çerezi.
 */
export default function Loading() {
  return (
    <SkRegion label="Ayarlar yükleniyor">
      <div className="grid max-w-4xl gap-4">
        {[0, 1, 2].map((i) => (
          <SkCard key={i} className="p-5">
            <Sk w="120px" h={16} />
            <Sk w="70%" h={13} className="mt-2" />
            <Sk w="100%" h={i === 0 ? 44 : 92} className="mt-4 rounded-control" />
          </SkCard>
        ))}
      </div>
    </SkRegion>
  )
}
