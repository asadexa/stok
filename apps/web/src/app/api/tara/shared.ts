import 'server-only'
import { validationError } from '@stok/core'
import { AppError } from '@stok/shared'
import { phoneScannerEnabled } from '@/server/config'

/**
 * ============================================================================
 * WS-SCAN UÇLARI — ORTAK PARÇALAR
 *
 * Telefon uçları (`eslestir`, `okut`, `telefon`) GİRİŞSİZ: kimlik yalnız
 * eşleşmede verilen `Authorization: Bearer` token'ı. Çerez yok, CORS da
 * açılmıyor; başka bir site bu başlığı koyamadığı için CSRF yüzeyi yok.
 * ============================================================================
 */

/**
 * Bayrak kapalıyken uçlar YOK (404). Kontrol sayfada değil burada: sayfa
 * gizlenip uç açık kalsaydı telefon tarafı tünelden yine erişilebilir olurdu.
 */
export function requireScanner(): void {
  if (!phoneScannerEnabled()) throw new AppError('NOT_FOUND', 'phone scanner disabled')
}

/** Polling sonucu önbelleğe girerse laptop eski okumayı yeniden görür ya da yenisini hiç görmez. */
export const NO_STORE = { 'Cache-Control': 'no-store' }

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    // Bozuk gövde sözleşmedeki doğrulama hatasına çevriliyor; ham 500'e
    // düşseydi telefon "sunucu hatası" gösterirdi.
    throw validationError([{ path: '', message: 'İstek gövdesi okunamadı' }])
  }
}
