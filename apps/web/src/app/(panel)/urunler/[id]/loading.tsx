import { Sk, SkCard, SkCardHead, SkRegion, SkRows } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Ürün ayrıntısı: başlık, alanlar, hareket geçmişi.
 *
 * Kabuk düzende olduğu için kenar çubuğu ve üst şerit YERİNDE KALIYOR;
 * yalnızca içerik alanı iskelete dönüyor. Kullanıcı nerede olduğunu ve
 * nereye gidebileceğini kaybetmiyor.
 */
export default function Loading() {
  return (
    <SkRegion label="Ürün yükleniyor">
      <Sk w="220px" h={22} />
      <SkCard className="mt-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i}>
              <Sk w="80px" h={12} />
              <Sk w="100%" h={52} className="mt-1.5 rounded-control" />
            </div>
          ))}
        </div>
      </SkCard>
      <SkCard className="mt-4">
        <SkCardHead w="130px" />
        <SkRows rows={5} />
      </SkCard>
    </SkRegion>
  )
}
