import { Sk, SkCard, SkRegion } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Giriş/Çıkış: barkod alanı + ürün kartı. Günde yüzlerce kez açılıyor.
 *
 * Kabuk düzende olduğu için kenar çubuğu ve üst şerit YERİNDE KALIYOR;
 * yalnızca içerik alanı iskelete dönüyor. Kullanıcı nerede olduğunu ve
 * nereye gidebileceğini kaybetmiyor.
 */
export default function Loading() {
  return (
    <SkRegion label="Giriş / Çıkış ekranı yükleniyor">
      <div className="max-w-2xl">
        <Sk w="60px" h={13} />
        {/* Barkod alanı 64 px: gerçek alanla aynı yükseklik, yoksa içerik
            gelince alan zıplar ve odak kayar. */}
        <Sk w="100%" h={64} className="mt-1.5 rounded-control" />

        <SkCard className="mt-4 p-4">
          <div className="flex items-center gap-4">
            <Sk w="52px" h={52} className="shrink-0 rounded-chip" />
            <div className="flex-1">
              <Sk w="55%" h={19} />
              <Sk w="35%" h={12} className="mt-1.5" />
            </div>
            <Sk w="70px" h={30} className="shrink-0" />
          </div>
        </SkCard>
      </div>
    </SkRegion>
  )
}
