import { Sk, SkRegion } from '@/components/skeleton'

/**
 * Yükleme durumu — T69 (karar TD3). Giriş ekranı.
 *
 * Bu ekranın kabuğu yok (henüz oturum yok), o yüzden iskelet formun
 * kendisini taklit ediyor ve sayfayı ortalıyor.
 */
export default function Loading() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <SkRegion label="Giriş ekranı yükleniyor">
        <div className="w-full max-w-sm">
          <Sk w="150px" h={26} />
          <Sk w="60px" h={12} className="mt-6" />
          <Sk w="100%" h={52} className="mt-1.5 rounded-[10px]" />
          <Sk w="60px" h={12} className="mt-4" />
          <Sk w="100%" h={52} className="mt-1.5 rounded-[10px]" />
          <Sk w="100%" h={52} className="mt-6 rounded-[10px]" />
        </div>
      </SkRegion>
    </main>
  )
}
