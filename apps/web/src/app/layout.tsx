import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Stok Takip',
  description: 'Depo stok takip sistemi',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  )
}
