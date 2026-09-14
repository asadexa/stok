import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, Outfit } from 'next/font/google'
import { readTheme } from '@/server/theme'
import './globals.css'

/**
 * ============================================================================
 * KÖK DÜZEN — T65
 *
 * YAZI TİPLERİ `next/font` İLE, CDN BAĞLANTISIYLA DEĞİL. Üç sebep:
 *   1. Dosyalar derleme anında indirilip kendi sunucumuzdan servis ediliyor;
 *      depo sunucusu LAN'da çalışırken dışarıya çıkmaya gerek kalmıyor.
 *   2. `display: swap` + ön yükleme, yüz değişirken düzen kaymasını önlüyor.
 *   3. Üçüncü taraf bir alan adına istek gitmiyor.
 *
 * `latin-ext` alt kümesi ZORUNLU: Türkçe'nin ğ ı İ ş ç ö ü harfleri temel
 * `latin` alt kümesinde YOK. Sadece `latin` istenirse tarayıcı o harfler
 * için yedek yüze düşer ve "Isıtıcı Şerit" iki farklı yazı tipiyle basılır.
 * ============================================================================
 */

const outfit = Outfit({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-outfit',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
})

const plexSans = IBM_Plex_Sans({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-plex-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
})

const plexMono = IBM_Plex_Mono({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-plex-mono',
  display: 'swap',
  weight: ['400', '500'],
})

export const metadata: Metadata = {
  title: 'Stok Takip',
  description: 'Depo stok takip sistemi',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Tema çerezden SUNUCUDA okunuyor: `data-theme` ilk baytta doğru geliyor,
  // sayfa hiçbir an yanlış temada görünmüyor (server/theme.ts).
  const theme = await readTheme()

  return (
    <html
      lang="tr"
      // Seçim yoksa nitelik HİÇ basılmıyor ve karar `prefers-color-scheme`e
      // kalıyor. Boş string basmak, "açık seçilmiş" ile karışırdı.
      data-theme={theme ?? undefined}
      className={`${outfit.variable} ${plexSans.variable} ${plexMono.variable}`}
    >
      <body>{children}</body>
    </html>
  )
}
