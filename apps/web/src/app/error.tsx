'use client'

/**
 * Hata sınırı — kök — T69 (karar TD3).
 *
 * `(panel)` grubunun DIŞINDAKİ rotalar için (giriş ekranı, kök yönlendirme).
 * Kabuk yok, o yüzden kendi sayfa düzenini kuruyor.
 *
 * Panel içindeki hatalar `(panel)/error.tsx` tarafından yakalanıyor ve orada
 * kenar çubuğu korunuyor. İkisi ayrı, çünkü kullanıcıya sunulan çıkış yolu
 * farklı: burada "giriş ekranına dön", orada "başka bir ekrana geç".
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div
        role="alert"
        className="w-full max-w-md rounded-[14px] border border-crit bg-crit-soft p-6 text-crit-soft-ink"
      >
        <h1 className="font-display text-lg font-semibold">Sayfa açılamadı</h1>
        <p className="mt-2 text-sm">
          Beklenmeyen bir hata oluştu. Tekrar denemek çoğu zaman yeterli oluyor.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="h-13 rounded-[10px] bg-accent px-6 text-base font-semibold text-accent-ink hover:brightness-110"
          >
            Tekrar dene
          </button>
          <a
            href="/giris"
            className="h-13 rounded-[10px] border border-line-control bg-surface px-6 text-base font-semibold leading-[3.25rem] text-ink hover:bg-surface-2"
          >
            Giriş ekranı
          </a>
        </div>

        {error.digest ? (
          <p className="mt-5 text-xs">
            Sorun sürerse bu kodu iletin:{' '}
            <code className="font-mono font-semibold">{error.digest}</code>
          </p>
        ) : null}
      </div>
    </main>
  )
}
