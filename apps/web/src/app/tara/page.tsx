import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { phoneScannerEnabled } from '@/server/config'
import { Scanner } from './scanner'

/**
 * ============================================================================
 * WS-SCAN — /tara, TELEFONLA OKUT
 *
 * PANEL DÜZENİNİN DIŞINDA VE GİRİŞSİZ: telefon kullanıcı olarak oturum
 * açmıyor. Laptopun QR'ıyla eşleşip yalnız barkod metni gönderiyor; ürün,
 * fiyat ya da stok okumuyor (`/api/tara/*`). Görünüp görünmemesi yalnız
 * bayrağa bağlı (`phoneScannerEnabled`).
 * ============================================================================
 */
export default async function ScanPage() {
  // Bayrak İSTEK ANINDA okunmalı. Sayfa derlemede önceden üretilseydi
  // `next build` anındaki değer gömülür, `next start`'a verilen bayrak hiçbir
  // şeyi değiştirmezdi. Bugün kök düzen çerez okuduğu için sayfa zaten
  // dinamik; bu satır o tesadüfe yaslanmamak için.
  await connection()
  if (!phoneScannerEnabled()) notFound()

  return <Scanner />
}
