import Link from 'next/link'

/**
 * 404.
 *
 * App Router bu dosya yoksa Next'in İngilizce varsayılan sayfasını
 * gösteriyor. Uygulamanın tamamı Türkçe; tek bir İngilizce ekran
 * kullanıcıya "bozuldu" hissi verir.
 *
 * Metin suçlayıcı değil: kullanıcı yanlış bir şey yapmadı, bağlantı
 * eskimiş olabilir.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <h1 className="text-2xl font-semibold">Sayfa bulunamadı</h1>
        <p className="mt-2 text-ink-2">
          Aradığınız sayfa taşınmış veya bağlantı eskimiş olabilir.
        </p>
        <Link
          href="/panel"
          className="mt-6 inline-block h-14 rounded-control bg-accent px-6 text-base font-medium leading-[3.5rem] text-accent-ink hover:brightness-110"
        >
          Panele dön
        </Link>
      </div>
    </main>
  )
}
