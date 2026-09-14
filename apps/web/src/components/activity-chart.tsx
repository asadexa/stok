/**
 * ============================================================================
 * HAREKET HACMİ GRAFİĞİ — T71 (tasarım incelemesi, karar TD1)
 *
 * NE GÖSTERİYOR: son 14 günün günlük giriş ve çıkış adedi.
 *
 * NE GÖSTERMİYOR VE NEDEN: referans görselde "Stok Değeri" zaman serisi var.
 * O seri bu üründe HESAPLANAMIYOR, çünkü geçmişe dönük stok değeri bir
 * maliyet yöntemi kararı gerektiriyor (PLAN.md ÇÖZÜLMEMİŞ KARAR U2:
 * ağırlıklı ortalama mı FIFO mu). Karar verilmeden çizilen her eğri uydurma
 * olurdu. Hareket hacmi bugün gerçekten hesaplanabiliyor ve gerçek bir
 * soruya cevap veriyor: "bugün olağandışı bir şey oldu mu?"
 *
 * NEDEN ÇUBUK, NEDEN ALAN DEĞİL: alan grafiği günler arasında SÜREKLİLİK
 * ima eder. Günlük hareket sayısı sürekli bir büyüklük değil, ayrık bir
 * sayım. İki gün arasını eğriyle bağlamak, olmayan bir ara değeri
 * göstermek olur.
 *
 * YÖN KONUMDAN OKUNUYOR: giriş sıfır çizgisinin ÜSTÜNDE, çıkış ALTINDA.
 * Renk ikinci kanal, tek kanal değil (Kural 03). Renk körü kullanıcı
 * yukarı/aşağıyı yine ayırt ediyor.
 * ============================================================================
 */

interface Day {
  day: string
  inQty: number
  outQty: number
}

const W = 720
const H = 190
const PAD_L = 44
const PAD_R = 8
const MID = 96 // sıfır çizgisi
const MAX_BAR = 68 // sıfırdan tepeye en fazla piksel

const dayFmt = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit' })
const numFmt = new Intl.NumberFormat('tr-TR')

/** Ekseni okunur bir yuvarlak sayıya tamamlar: 137 → 150, 1.240 → 1.500. */
function niceMax(value: number): number {
  if (value <= 0) return 10
  const mag = 10 ** Math.floor(Math.log10(value))
  return Math.ceil(value / (mag / 2)) * (mag / 2)
}

export function ActivityChart({ days }: { days: Day[] }) {
  const peak = Math.max(1, ...days.map((d) => Math.max(d.inQty, d.outQty)))
  const max = niceMax(peak)

  const band = (W - PAD_L - PAD_R) / days.length
  const barW = Math.min(14, band * 0.34)
  const scale = (n: number) => (n / max) * MAX_BAR

  const totalIn = days.reduce((s, d) => s + d.inQty, 0)
  const totalOut = days.reduce((s, d) => s + d.outQty, 0)

  // Ekran okuyucu grafiği "görmüyor"; özet cümle onun tek bilgi kaynağı.
  const summary =
    `Son ${days.length} günde ${numFmt.format(totalIn)} adet giriş, ` +
    `${numFmt.format(totalOut)} adet çıkış. En yoğun gün ${numFmt.format(peak)} adet.`

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={summary}
        className="overflow-visible"
      >
        {/* Izgara: sıfır çizgisi belirgin, diğerleri silik. */}
        <g stroke="var(--line)" strokeWidth="1">
          <line x1={PAD_L} y1={MID - MAX_BAR} x2={W - PAD_R} y2={MID - MAX_BAR} />
          <line x1={PAD_L} y1={MID + MAX_BAR} x2={W - PAD_R} y2={MID + MAX_BAR} />
        </g>
        <line
          x1={PAD_L}
          y1={MID}
          x2={W - PAD_R}
          y2={MID}
          stroke="var(--line-control)"
          strokeWidth="1"
        />

        {/* Y ekseni: sadece üç etiket. Daha fazlası okunmuyor, yer yiyor. */}
        <g fill="var(--ink-3)" fontFamily="var(--font-mono)" fontSize="10" textAnchor="end">
          <text x={PAD_L - 8} y={MID - MAX_BAR + 4}>{numFmt.format(max)}</text>
          <text x={PAD_L - 8} y={MID + 4}>0</text>
          <text x={PAD_L - 8} y={MID + MAX_BAR + 4}>{numFmt.format(max)}</text>
        </g>

        {days.map((d, i) => {
          const cx = PAD_L + band * i + band / 2
          const inH = scale(d.inQty)
          const outH = scale(d.outQty)
          const date = new Date(`${d.day}T00:00:00`)
          // Her günü etiketlemek 14 etikette çakışıyor; ikide bir yeter.
          const showLabel = i % 2 === 1 || i === days.length - 1
          return (
            <g key={d.day}>
              {d.inQty > 0 ? (
                <rect
                  x={cx - barW - 1}
                  y={MID - inH}
                  width={barW}
                  height={inH}
                  rx="2"
                  fill="var(--ok)"
                />
              ) : null}
              {d.outQty > 0 ? (
                <rect
                  x={cx + 1}
                  y={MID}
                  width={barW}
                  height={outH}
                  rx="2"
                  fill="var(--crit)"
                />
              ) : null}
              {showLabel ? (
                <text
                  x={cx}
                  y={H - 4}
                  fill="var(--ink-3)"
                  fontFamily="var(--font-sans)"
                  fontSize="10.5"
                  textAnchor="middle"
                >
                  {dayFmt.format(date)}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>

      {/* Lejant metin taşıyor, sadece renk noktası değil. */}
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[2px] bg-ok" />
          Giriş (çizginin üstünde) · <b className="tabular font-semibold">{numFmt.format(totalIn)}</b>
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[2px] bg-crit" />
          Çıkış (çizginin altında) · <b className="tabular font-semibold">{numFmt.format(totalOut)}</b>
        </span>
      </figcaption>
    </figure>
  )
}
