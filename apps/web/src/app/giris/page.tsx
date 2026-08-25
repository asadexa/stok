import { AppError, errorText } from '@stok/shared'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { logServerFault } from '@/server/form'
import { currentActor, startSession } from '@/server/session'

/**
 * Giriş ekranı.
 *
 * Sunucu eylemi (server action) kullanıyor, istemci tarafı fetch değil:
 * parola hiçbir zaman istemci JavaScript'inde bir değişkene girmiyor ve
 * JavaScript kapalıyken de çalışıyor. Depoda eski tarayıcılar var.
 *
 * Hata metni SUNUCUDA `errorText()` ile üretiliyor. Bu, hata sözleşmesinin
 * (D-2.2) "metin istemcide üretilir" kuralına aykırı DEĞİL: sunucu eylemi
 * burada istemcinin yerine geçiyor, sabit kod hâlâ tek kaynak ve REST
 * endpoint'leri kodu döndürmeye devam ediyor.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ hata?: string; bekle?: string; bilgi?: string }>
}) {
  if (await currentActor()) redirect('/panel')

  const params = await searchParams
  const message = params.hata
    ? errorText(params.hata, { retryAfterSeconds: Number(params.bekle ?? 0) })
    : null

  async function submit(formData: FormData) {
    'use server'

    const email = String(formData.get('email') ?? '')
    const password = String(formData.get('parola') ?? '')

    // İstemcinin gönderdiği adrese değil, proxy başlığına güveniliyor.
    // Gövdeden gelen bir değere göre sayaç tutmak, saldırgana her denemede
    // yeni bir kimlik uydurma imkanı verirdi (T51).
    const forwarded = (await headers()).get('x-forwarded-for')
    const clientIp = forwarded?.split(',')[0]?.trim()

    try {
      await startSession(email, password, clientIp)
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      // Sunucu kusuru olan hatalar loga: ekrandaki genel metin operatöre
      // hiçbir şey söylemiyor, terminaldeki satır teşhisi bitiriyor.
      logServerFault('giris', err)
      const wait = err.details.retryAfterSeconds
      redirect(`/giris?hata=${err.code}${typeof wait === 'number' ? `&bekle=${wait}` : ''}`)
    }
    redirect('/panel')
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form action={submit} className="w-full max-w-sm space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">Stok Takip</h1>
          <p className="mt-1 text-sm text-ink-2">Devam etmek için giriş yapın.</p>
        </div>

        {message ? (
          // Renk tek başına anlam taşımıyor: ikon + metin de var.
          <p
            role="alert"
            className="flex gap-2 rounded-control border border-kritik bg-kritik-bg p-3 text-sm text-kritik"
          >
            <span aria-hidden>⚠</span>
            <span>{message}</span>
          </p>
        ) : null}

        {/*
          BİLGİ KANALI HATA KANALINDAN AYRI (T75).

          Parola değiştirme başarılı olduğunda tüm oturumlar kapanıyor ve
          kullanıcı buraya düşüyor. Bunu `hata=` ile taşımak yanlış olurdu:
          `errorText` tanımadığı kodu "Beklenmeyen bir hata oluştu"ya
          çeviriyor, yani işlem BAŞARIYLA bittiği hâlde kullanıcı hata
          görürdü — ve büyük ihtimalle eski parolasıyla girmeyi denerdi.
        */}
        {params.bilgi === 'parola' ? (
          <p className="flex gap-2 rounded-control border border-giris bg-surface p-3 text-sm text-ink-2">
            <span aria-hidden className="text-giris">
              ✓
            </span>
            <span>
              Parolanız değiştirildi. Güvenlik için tüm oturumlar kapatıldı;
              <b> yeni parolanızla</b> giriş yapın.
            </span>
          </p>
        ) : null}

        <label className="block">
          <span className="text-sm font-medium">E-posta</span>
          <input
            name="email"
            type="email"
            required
            autoFocus
            autoComplete="username"
            className="mt-1 h-14 w-full rounded-control border border-line-control bg-surface px-3 text-base"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">Parola</span>
          <input
            name="parola"
            type="password"
            required
            autoComplete="current-password"
            className="mt-1 h-14 w-full rounded-control border border-line-control bg-surface px-3 text-base"
          />
        </label>

        {/* 56 px: eldivenli elle basılabilmeli. */}
        <button
          type="submit"
          className="h-14 w-full rounded-control bg-accent text-base font-medium text-accent-ink hover:brightness-110"
        >
          Giriş yap
        </button>
      </form>
    </main>
  )
}
