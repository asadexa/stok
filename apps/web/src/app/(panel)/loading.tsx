import { SkCard, SkCardHead, SkRegion, SkRows } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Grup varsayılanı: kendi iskeleti olmayan rotalar buraya düşer.
 *
 * Kabuk düzende olduğu için kenar çubuğu ve üst şerit YERİNDE KALIYOR;
 * yalnızca içerik alanı iskelete dönüyor. Kullanıcı nerede olduğunu ve
 * nereye gidebileceğini kaybetmiyor.
 */
export default function Loading() {
  return (
    <SkRegion label="Sayfa yükleniyor">
      <SkCard>
        <SkCardHead />
        <SkRows rows={6} />
      </SkCard>
    </SkRegion>
  )
}
