import { Sk, SkCard, SkRegion } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Sistem sağlığı: invariant taraması pahalı, bekleyiş burada gerçekten hissediliyor.
 *
 * Kabuk düzende olduğu için kenar çubuğu ve üst şerit YERİNDE KALIYOR;
 * yalnızca içerik alanı iskelete dönüyor. Kullanıcı nerede olduğunu ve
 * nereye gidebileceğini kaybetmiyor.
 */
export default function Loading() {
  return (
    <SkRegion label="Sistem sağlığı kontrol ediliyor">
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <SkCard key={i} className="p-4">
            <Sk w="120px" h={13} />
            <Sk w="60%" h={24} className="mt-2" />
            <Sk w="80%" h={12} className="mt-2" />
          </SkCard>
        ))}
      </div>
    </SkRegion>
  )
}
