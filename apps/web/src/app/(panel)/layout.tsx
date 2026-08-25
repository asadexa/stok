import { redirect } from 'next/navigation'
import { SessionKeepAlive } from '@/components/session-keepalive'
import { Shell } from '@/components/shell'
import { currentActor, sessionNeedsPersist } from '@/server/session'

/**
 * ============================================================================
 * PANEL DÜZENİ — T66 / T69
 *
 * `(panel)` bir ROTA GRUBU: parantezli klasör adı adrese girmiyor, yani
 * `/panel`, `/stok`, `/hareket` adresleri değişmedi. Grup yalnızca ortak bir
 * düzen paylaşmak için var.
 *
 * KABUK NEDEN SAYFADAN BURAYA TAŞINDI: `loading.tsx` yalnızca kendi
 * düzeninin içinde render edilir. Kabuk sayfanın içindeyken "Stok"a
 * basıldığında yükleme durumu kenar çubuğunu da kaplardı — kullanıcı
 * menüsünü kaybeder, ekran tamamen boşalırdı. Şimdi çubuk ve üst şerit
 * yerinde kalıyor, sadece `<main>` içeriği iskelete dönüyor.
 *
 * OTURUM KONTROLÜ BURADA AMA SAYFALARDAKİLER KALDIRILMADI. Düzen, sayfayı
 * korumak için yeterli DEĞİL: Next.js düzenleri sayfadan bağımsız
 * önbelleklenebiliyor ve gelecekte eklenecek bir rota bu klasörün dışında
 * kalabilir. Yetki kontrolü her zaman veriye EN YAKIN yerde: sayfa kendi
 * `currentActor()` çağrısını ve `requirePermission()`'ını yapmaya devam
 * ediyor. Buradaki kontrol bir kolaylık (kabuğa rol lazım), güvenlik sınırı
 * değil. `currentActor()` `cache()` ile sarmalı, yani çift çağrı tek
 * sorguya iniyor.
 * ============================================================================
 */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')

  // Bu istekte oturum yenilendi ama render çerez yazamadıysa, istemci bir kez
  // route handler'a gidip çerezi kalıcılaştırıyor (T87). Aksi hâlde salt
  // gezinen kullanıcıda her sayfa bir yenileme sorgusu tetiklerdi.
  const needsPersist = await sessionNeedsPersist()

  return (
    <Shell role={actor.role}>
      {needsPersist ? <SessionKeepAlive /> : null}
      {children}
    </Shell>
  )
}
