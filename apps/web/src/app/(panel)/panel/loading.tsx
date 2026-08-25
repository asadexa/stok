import { SkCard, SkCardHead, SkKpis, SkRegion, SkRows } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Panel: uyarı şeridi, KPI satırı, son hareketler.
 *
 * Kabuk düzende olduğu için kenar çubuğu ve üst şerit YERİNDE KALIYOR;
 * yalnızca içerik alanı iskelete dönüyor. Kullanıcı nerede olduğunu ve
 * nereye gidebileceğini kaybetmiyor.
 */
export default function Loading() {
  return (
    <SkRegion label="Panel yükleniyor">
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <SkCard className="h-16" />
        <SkCard className="h-16" />
      </div>

      <SkKpis />

      <SkCard className="mt-6">
        <SkCardHead w="120px" />
        <SkRows rows={5} />
      </SkCard>
    </SkRegion>
  )
}
