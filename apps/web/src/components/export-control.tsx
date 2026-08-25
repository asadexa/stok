import type { ExportPlan } from '@stok/core'

/**
 * ============================================================================
 * EXCEL'E AKTAR (T22)
 *
 * KARAR SAYFA ÇİZİLİRKEN VERİLİYOR, tıklandığında değil. Düğmenin üstünde
 * kaç satır ineceği yazıyor ve üç durumda üç farklı şey görünüyor:
 *
 *   anında     ─▶ düz bağlantı, dosya tıklayınca iner
 *   kuyrukta   ─▶ form düğmesi, "e-posta ile gelecek" yazıyor
 *   çok büyük  ─▶ düğme yok, ne yapması gerektiği yazıyor
 *
 * Neden böyle: tek bir "Excel'e aktar" düğmesi koyup kararı tıklamadan
 * sonraya bırakmak, kullanıcıya ne olacağını söylemeden söz vermek olurdu.
 * 45 bin satırlık bir raporu bekleyen kişi tarayıcının donmasını bekler;
 * oysa dosya e-posta ile gelecektir ve bunu önceden bilmesi gerekir.
 *
 * Anında inen yol düz `<a>`: JavaScript kapalıyken de çalışıyor, orta
 * tıkla yeni sekmede açılıyor ve indirme tarayıcının kendi işi. Sunucu
 * eyleminden yönlendirmek işe yaramazdı — App Router yönlendirmesi
 * yumuşak gezinme, dosya indirmesi değil.
 * ============================================================================
 */

const BUTTON =
  'inline-flex h-14 items-center rounded-md border border-line-control bg-surface px-5 text-base font-medium hover:bg-surface-2'

export function ExportControl({
  href,
  plan,
  error,
  queueAction,
}: {
  /** Anında inen yolun adresi. Salt okunur, yan etkisiz. */
  href: string
  plan: ExportPlan | null
  /** Planlama başarısızsa gösterilecek Türkçe metin. */
  error: string | null
  /** Kuyruğa alma yolunun sunucu eylemi. */
  queueAction: () => Promise<void>
}) {
  if (error) {
    return (
      <p className="flex gap-2 rounded-md border border-kritik bg-kritik-bg p-3 text-sm text-kritik">
        <span aria-hidden>⚠</span>
        <span>{error}</span>
      </p>
    )
  }
  if (!plan) return null

  const rows = plan.rowCount.toLocaleString('tr-TR')

  if (plan.mode === 'inline') {
    return (
      <a href={href} className={BUTTON}>
        Excel&apos;e aktar
        <span className="tabular ml-2 text-sm font-normal text-ink-3">{rows} satır</span>
      </a>
    )
  }

  return (
    <form action={queueAction} className="flex flex-wrap items-center gap-3">
      <button type="submit" className={BUTTON}>
        Raporu hazırla
        <span className="tabular ml-2 text-sm font-normal text-ink-3">{rows} satır</span>
      </button>
      <span className="text-sm text-ink-2">
        Bu boyuttaki rapor arka planda hazırlanıp e-posta ile gönderilir.
      </span>
    </form>
  )
}
