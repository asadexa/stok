import Link from 'next/link'

/**
 * Sayfalama.
 *
 * "1 2 3 … 47" yerine sadece Önceki/Sonraki + "n-m / toplam". Depo verisinde
 * kullanıcı 34. sayfaya atlamıyor; arıyor. Sayfa numarası şeridi ekran
 * genişliği tüketip mobilde taşıyor.
 *
 * Bağlantılar gerçek `<a href>`: JavaScript kapalıyken de çalışıyor ve orta
 * tıkla yeni sekmede açılıyor. Buton + router.push bunların ikisini de
 * kaybettirirdi.
 */
export function Pagination({
  basePath,
  params,
  offset,
  limit,
  shown,
  total,
  hasNext,
}: {
  basePath: string
  /** Sayfa dışındaki tüm filtreler; bağlantılarda korunuyor. */
  params: Record<string, string | undefined>
  offset: number
  limit: number
  /** Bu sayfada gerçekten basılan satır sayısı. */
  shown: number
  /** Toplam biliniyorsa gösteriliyor; hareket logunda bilinmiyor. */
  total?: number
  hasNext: boolean
}) {
  if (offset === 0 && !hasNext) return null

  const href = (nextOffset: number) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value)
    }
    if (nextOffset > 0) search.set('atla', String(nextOffset))
    const query = search.toString()
    return query ? `${basePath}?${query}` : basePath
  }

  const first = shown === 0 ? 0 : offset + 1
  const last = offset + shown

  return (
    <nav
      aria-label="Sayfalama"
      className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm"
    >
      <span className="tabular text-ink-2">
        {first}–{last}
        {total === undefined ? '' : ` / ${total.toLocaleString('tr-TR')}`}
      </span>

      <span className="flex gap-2">
        <PageLink href={href(Math.max(0, offset - limit))} enabled={offset > 0}>
          ← Önceki
        </PageLink>
        <PageLink href={href(offset + limit)} enabled={hasNext}>
          Sonraki →
        </PageLink>
      </span>
    </nav>
  )
}

function PageLink({
  href,
  enabled,
  children,
}: {
  href: string
  enabled: boolean
  children: React.ReactNode
}) {
  // Devre dışı hâli `<span>`: tıklanamayan bir bağlantı, klavye ile
  // gezinen kullanıcıyı hiçbir yere götürmeyen bir durakla karşılaştırır.
  if (!enabled) {
    return (
      <span aria-disabled className="rounded-control border border-line px-3 py-2 text-ink-3">
        {children}
      </span>
    )
  }
  return (
    <Link
      href={href}
      className="rounded-control border border-line-control px-3 py-2 hover:bg-surface-2"
    >
      {children}
    </Link>
  )
}
