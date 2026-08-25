'use client'

/**
 * ============================================================================
 * HATA SINIRI — PANEL — T69 (karar TD3)
 *
 * Bu dosya `(panel)` grubunun İÇİNDE, yani hata düzenin altında yakalanıyor:
 * kenar çubuğu ve üst şerit yerinde kalıyor. Kullanıcı bir ekranda patlayan
 * sorgudan sonra menüsüz bir boşlukta kalmıyor, başka bir ekrana gidebiliyor.
 *
 * NE GÖSTERİLİYOR VE NEDEN:
 *
 *   - Ne olduğu, sade Türkçeyle. "Bir şeyler ters gitti" değil: hangi işlemin
 *     tamamlanamadığı.
 *   - Ne yapılacağı: "Tekrar dene" düğmesi. Geçici hataların çoğu (veritabanı
 *     bağlantısı, ağ) ikinci denemede geçiyor.
 *   - `digest`: Next.js üretimde hata metnini istemciye GÖNDERMİYOR (yığın
 *     izi sızdırmamak için) ama bir özet kimliği veriyor. Sunucu logunda aynı
 *     kimlik var. Ekranda göstermek, telefonla arayan kullanıcının okuyacağı
 *     tek şeyi veriyor — onsuz teşhis "saat kaçta oldu" tahminine kalıyor.
 *
 * Özür dilenmiyor, suçlanmıyor: ne olduğu ve ne yapılacağı yazıyor.
 * ============================================================================
 */
export default function PanelError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div
      role="alert"
      className="mx-auto max-w-xl rounded-[14px] border border-crit bg-crit-soft p-6 text-crit-soft-ink"
    >
      <h2 className="font-display text-lg font-semibold">Bu ekran yüklenemedi</h2>
      <p className="mt-2 text-sm">
        Veri okunurken bir hata oluştu. Kayıtlarınıza bir şey olmadı; bu ekran
        yalnızca okuma yapıyor.
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
          href="/panel"
          className="h-13 rounded-[10px] border border-line-control bg-surface px-6 text-base font-semibold leading-[3.25rem] text-ink hover:bg-surface-2"
        >
          Panele dön
        </a>
      </div>

      {error.digest ? (
        <p className="mt-5 text-xs">
          Sorun sürerse bu kodu iletin:{' '}
          <code className="font-mono font-semibold">{error.digest}</code>
        </p>
      ) : null}
    </div>
  )
}
