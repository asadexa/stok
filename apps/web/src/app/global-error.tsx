'use client'

import './globals.css'

/**
 * ============================================================================
 * KÖK HATA SINIRI — T69 (karar TD3)
 *
 * Son çare. Kök düzenin KENDİSİ patladığında devreye giriyor, o yüzden
 * `<html>` ve `<body>` etiketlerini kendisi basmak ZORUNDA: düzen render
 * edilemediği için ortada bir belge iskeleti yok.
 *
 * Aynı sebeple `globals.css` burada AYRICA import ediliyor. `layout.tsx`
 * çalışmadığı için oradaki import da çalışmıyor; olmasaydı bu ekran
 * biçimsiz, tarayıcı varsayılanıyla gelirdi — yani sistemin en kötü anında
 * en kötü görünen ekranı olurdu.
 *
 * Yazı tipi değişkenleri burada YOK (onlar `layout.tsx` içinde `next/font`
 * ile bağlanıyor), o yüzden metin yedek yüzle basılıyor. Bu kabul edilebilir:
 * bu ekranın işi güzel görünmek değil, okunabilir olmak.
 * ============================================================================
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="tr">
      <body>
        <main className="flex min-h-screen items-center justify-center p-6">
          <div
            role="alert"
            className="w-full max-w-md rounded-[14px] border border-crit bg-crit-soft p-6 text-crit-soft-ink"
          >
            <h1 className="text-lg font-semibold">Uygulama açılamadı</h1>
            <p className="mt-2 text-sm">
              Sistem beklenmeyen bir hatayla durdu. Sayfayı yenilemek işe yaramazsa
              sunucunun çalıştığını kontrol edin.
            </p>

            <button
              type="button"
              onClick={reset}
              className="mt-5 h-13 rounded-[10px] bg-accent px-6 text-base font-semibold text-accent-ink hover:brightness-110"
            >
              Yeniden dene
            </button>

            {error.digest ? (
              <p className="mt-5 text-xs">
                Sunucu logunda bu kodu arayın:{' '}
                <code className="font-mono font-semibold">{error.digest}</code>
              </p>
            ) : null}
          </div>
        </main>
      </body>
    </html>
  )
}
