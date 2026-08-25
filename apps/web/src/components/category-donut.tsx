/**
 * ============================================================================
 * KATEGORİ DAĞILIMI — T71 (tasarım incelemesi, karar TD1)
 *
 * Referans görselden alınan halka grafik. Bir uyarıyla:
 *
 * BİLGİYİ LEJANT TAŞIYOR, HALKA DEĞİL. Beş dilimin üçü birbirine yakınsa
 * (%35 / %25 / %20) açı farkı gözle okunmuyor. Bu yüzden her satırda sayı
 * VE yüzde yazılı; halka bir büyüklük SEZGİSİ veriyor, ölçüm aracı değil.
 * Halkayı kaldırsak bilgi kaybolmuyordu — bilinçli olarak duruyor.
 *
 * DİLİM RENKLERİ ANLAM RENGİ DEĞİL. Kategoriler sıralı ya da iyi/kötü
 * değil; sadece birbirinden ayrılmaları gerekiyor. Bu yüzden paletteki
 * giriş/çıkış/kritik renkleri BURADA KULLANILMIYOR: yeşil bir dilim
 * "iyi kategori" gibi okunurdu. Ayrı ve nötr bir dizi kullanılıyor.
 *
 * Altı dilimden fazlası gelmiyor (core: beşten sonrası "Diğer"de toplanıyor).
 * ============================================================================
 */

interface Slice {
  name: string
  count: number
}

/**
 * Kategori dilim renkleri. Anlam taşımıyor, yalnızca ayırt ediyor.
 * Açık ve koyu temada da ayırt edilebilir olsunlar diye orta tonlardan
 * seçildi; hiçbiri --ok / --warn / --crit ile karışacak kadar yakın değil.
 */
const SLICE = ['#5B5BD6', '#3B82C4', '#2F9E8F', '#B0722B', '#8A5FA8', '#7A8194']

const numFmt = new Intl.NumberFormat('tr-TR')

export function CategoryDonut({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((s, c) => s + c.count, 0)
  if (total === 0) return null

  // `stroke-dasharray` yüzdelerle çalışsın diye çevre 100 birime
  // ayarlanıyor: r = 100 / 2π. Böylece dilim uzunluğu doğrudan yüzde.
  const R = 15.915
  let offset = 25 // 25 = saat 12 yönünden başlat

  const pct = (n: number) => (n / total) * 100

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg
        width="130"
        height="130"
        viewBox="0 0 42 42"
        role="img"
        aria-label={`Kategori dağılımı: ${slices
          .map((s) => `${s.name} ${Math.round(pct(s.count))} yüzde`)
          .join(', ')}`}
        className="shrink-0"
      >
        <circle cx="21" cy="21" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="6" />
        {slices.map((s, i) => {
          const len = pct(s.count)
          const el = (
            <circle
              key={s.name}
              cx="21"
              cy="21"
              r={R}
              fill="none"
              stroke={SLICE[i % SLICE.length]}
              strokeWidth="6"
              strokeDasharray={`${len} ${100 - len}`}
              strokeDashoffset={offset}
            />
          )
          offset -= len
          return el
        })}
      </svg>

      <ul className="min-w-[190px] flex-1 space-y-2 text-[13px]">
        {slices.map((s, i) => (
          <li key={s.name} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ background: SLICE[i % SLICE.length] }}
            />
            <span className="min-w-0 truncate">{s.name}</span>
            {/* Sayı VE yüzde: yüzde tek başına "35 üründen 35'i mi, 1.248'den
                mi" sorusunu cevaplamıyor. */}
            <span className="tabular ml-auto shrink-0 text-ink-3">
              {numFmt.format(s.count)}
            </span>
            <span className="tabular w-11 shrink-0 text-right font-semibold">
              %{Math.round(pct(s.count))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
