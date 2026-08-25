import type { Theme } from '@/server/theme'

/**
 * ============================================================================
 * TEMA ANAHTARI — T65
 *
 * ÜÇ DURUM VAR, İKİ DEĞİL: sistem → açık → koyu → sistem.
 *
 * "Sistem" atlanıp sadece açık/koyu bırakılsaydı, işletim sistemini akşam
 * karanlığa geçen kullanıcı uygulamayı elle çevirmek zorunda kalırdı.
 * Varsayılan durum bu ve seçilebilir olması gerekiyor.
 *
 * Sunucu eylemiyle çalışıyor, istemci state'iyle değil: tercih çerezde ve
 * `<html data-theme>` sunucuda basılıyor, yani JavaScript kapalıyken de
 * çalışıyor (depoda eski Android tarayıcılar var).
 *
 * ERİŞİLEBİLİRLİK: ikon tek başına anlam taşımıyor. `aria-label` hem şu
 * anki durumu hem de tıklayınca ne olacağını söylüyor, çünkü tıklayınca ne
 * olacağı bir ikondan tahmin edilemez. `title` aynı metni fareyle bekleyen
 * kullanıcıya da veriyor.
 * ============================================================================
 */

const NEXT_LABEL: Record<string, string> = {
  system: 'Açık temaya geç',
  light: 'Koyu temaya geç',
  dark: 'Sistem temasına dön',
}

const CURRENT_LABEL: Record<string, string> = {
  system: 'Sistem teması',
  light: 'Açık tema',
  dark: 'Koyu tema',
}

export function ThemeToggle({
  theme,
  action,
}: {
  theme: Theme | null
  action: () => Promise<void>
}) {
  const key = theme ?? 'system'
  const label = `${CURRENT_LABEL[key]}. ${NEXT_LABEL[key]}.`

  return (
    <form action={action}>
      <button
        type="submit"
        aria-label={label}
        title={label}
        className="grid size-11 place-items-center rounded-control border border-line-control bg-surface text-ink-2 hover:bg-surface-2"
      >
        {key === 'system' ? (
          <svg
            aria-hidden
            width="19"
            height="19"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
        ) : key === 'light' ? (
          <svg
            aria-hidden
            width="19"
            height="19"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
          </svg>
        ) : (
          <svg
            aria-hidden
            width="19"
            height="19"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9" />
          </svg>
        )}
      </button>
    </form>
  )
}
