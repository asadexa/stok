import { SkCard, SkCardHead, SkRegion, SkRows } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Kullanıcı yönetimi: liste + satır içi düzenleme.
 *
 * Kabuk düzende olduğu için kenar çubuğu ve üst şerit YERİNDE KALIYOR;
 * yalnızca içerik alanı iskelete dönüyor. Kullanıcı nerede olduğunu ve
 * nereye gidebileceğini kaybetmiyor.
 */
export default function Loading() {
  return (
    <SkRegion label="Kullanıcılar yükleniyor">
      <SkCard>
        <SkCardHead w="110px" />
        <SkRows rows={4} />
      </SkCard>
    </SkRegion>
  )
}
