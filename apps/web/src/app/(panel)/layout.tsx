import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { currentActor } from '@/server/session'

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

  return <Shell role={actor.role}>{children}</Shell>
}
