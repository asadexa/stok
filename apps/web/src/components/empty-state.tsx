import Link from 'next/link'

/**
 * ============================================================================
 * BOŞ DURUM — T70 (Kural 09, korundu)
 *
 * "Henüz ürün yok" TEK BAŞINA ÇIKMAZ SOKAKTIR. Kullanıcı ekranın boş
 * olduğunu zaten görüyor; bilmediği şey oradan nasıl çıkacağı.
 *
 * Bu bileşen `action`'ı ZORUNLU tutuyor. Eskiden her sayfa boş durumunu elle
 * yazıyordu ve kural yalnızca disipline bağlıydı: yeni bir liste ekleyen
 * kişinin PLAN.md'yi hatırlaması gerekiyordu. Artık tip sistemi zorluyor —
 * eylemsiz boş durum yazmak derlenmiyor.
 *
 * İKİ FARKLI BOŞLUK VAR VE KARIŞTIRILMAMALI:
 *   - Hiç veri yok    → kurulum eylemi ("Excel'den toplu aktar")
 *   - Filtre boş döndü → filtreyi temizleme eylemi
 * İkincisine "ilk ürününüzü ekleyin" demek, elinde 1.248 ürün olan
 * kullanıcıya sistemin boş olduğunu söylemek olurdu.
 * ============================================================================
 */

export function EmptyState({
  title,
  description,
  action,
  secondary,
  tone = 'accent',
}: {
  title: string
  description: string
  /** ZORUNLU: boş durumun oradan çıkaran bir eylemi olmak zorunda. */
  action: { href: string; label: string }
  secondary?: { href: string; label: string }
  tone?: 'accent' | 'ok'
}) {
  return (
    <div className="px-6 py-11 text-center">
      <span
        aria-hidden
        className={`mx-auto mb-3.5 grid size-14 place-items-center rounded-[15px] ${
          tone === 'ok' ? 'bg-ok-soft text-ok-soft-ink' : 'bg-accent-soft text-accent-soft-ink'
        }`}
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m21 16-9 5-9-5V8l9-5 9 5z" />
          <path d="M3.3 7 12 12l8.7-5" />
          <path d="M12 22V12" />
        </svg>
      </span>

      <h3 className="font-display text-[17px] font-semibold">{title}</h3>
      <p className="mx-auto mt-1.5 max-w-[42ch] text-[13.5px] text-ink-2">{description}</p>

      <div className="mt-4 flex flex-wrap justify-center gap-2.5">
        <Link
          href={action.href}
          className="inline-flex h-11 items-center rounded-[9px] bg-accent px-4 text-sm font-semibold text-accent-ink hover:brightness-110"
        >
          {action.label}
        </Link>
        {secondary ? (
          <Link
            href={secondary.href}
            className="inline-flex h-11 items-center rounded-[9px] border border-line-control bg-surface px-4 text-sm font-semibold hover:bg-surface-2"
          >
            {secondary.label}
          </Link>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Olumlu boş durum: "kritik ürün yok" bir eksiklik değil, iyi haber.
 * Ayrı bileşen çünkü tonu da mesajı da farklı — eylem çağrısı YOK, çünkü
 * kullanıcının yapması gereken bir şey yok.
 */
export function AllClear({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-3 rounded-[14px] border border-line bg-surface p-4 text-ink-2">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-ok-soft text-ok-soft-ink">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      <span className="font-medium">{children}</span>
    </p>
  )
}
