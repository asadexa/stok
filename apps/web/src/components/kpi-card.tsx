import Link from 'next/link'

/**
 * ============================================================================
 * KPI KARTI — T70 (tasarım incelemesi, karar TD1)
 *
 * Referans görselin en belirgin öğesi: etiket + büyük sayı + sağ üstte tint
 * zeminli ikon karesi + altta değişim satırı.
 *
 * SAYI 31 px VE `tabular-nums`. İki metre öteden okunmalı (eski Kural 01
 * korundu). Tabular rakam olmadan "1.248" ile "987" farklı genişlikte basılır
 * ve dört kart yan yana dururken sayılar hizasız görünür.
 *
 * BİRİM VE KAPSAM SAYININ YANINDA. Yalnız bir rakam yorumsuz kalıyor:
 * "24" mü ürün mü hareket mi, bugün mü toplam mı? `unit` ve `foot` bunu
 * söylemek için var, süs için değil.
 *
 * GRADIENT YOK. Görselin kartlarında da yok; ikon karesinde tint dolgu var
 * ve metin o dolgunun üstünde durmuyor. Metin taşıyan hiçbir yüzeye gradient
 * konmuyor, çünkü kontrast konuma göre değişir.
 * ============================================================================
 */

export type KpiTone = 'accent' | 'ok' | 'warn' | 'crit'

const ICON_BG: Record<KpiTone, string> = {
  accent: 'bg-accent-soft text-accent-soft-ink',
  ok: 'bg-ok-soft text-ok-soft-ink',
  warn: 'bg-warn-soft text-warn-soft-ink',
  crit: 'bg-crit-soft text-crit-soft-ink',
}

const NUM_TONE: Record<KpiTone, string> = {
  accent: 'text-ink',
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
}

export function KpiCard({
  label,
  value,
  unit,
  foot,
  tone = 'accent',
  icon,
  href,
}: {
  label: string
  /** Biçimlenmiş hâli. Biçimlendirme çağıranda: para, adet ve sayı farklı. */
  value: string
  /** Sayının yanındaki küçük birim ("ürün", "hareket"). */
  unit?: string
  /** Alt satır. Kapsamı söylüyor ("dünden beri", "arşiv hariç"). */
  foot?: React.ReactNode
  tone?: KpiTone
  icon: React.ReactNode
  /** Verilirse kart tıklanabilir olur ve ilgili listeye götürür. */
  href?: string
}) {
  const body = (
    <>
      <div className="flex items-start gap-3">
        <span className="text-[13.5px] font-medium text-ink-2">{label}</span>
        <span
          aria-hidden
          className={`ml-auto grid size-[42px] shrink-0 place-items-center rounded-control ${ICON_BG[tone]}`}
        >
          {icon}
        </span>
      </div>

      <p className={`tabular mt-2 font-display text-[31px] leading-tight font-semibold tracking-tight ${NUM_TONE[tone]}`}>
        {value}
        {unit ? <span className="ml-1.5 text-base font-normal text-ink-3">{unit}</span> : null}
      </p>

      {foot ? <p className="mt-1.5 text-[12.5px] text-ink-3">{foot}</p> : null}
    </>
  )

  const shell = 'rounded-card border border-line bg-surface p-4 shadow-card'

  // Tıklanabilir kart gerçek bir `<a>`: JavaScript kapalıyken de çalışıyor,
  // orta tıkla yeni sekmede açılıyor ve klavyeyle sıraya giriyor.
  return href ? (
    <Link href={href} className={`${shell} block hover:border-line-control`}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  )
}
