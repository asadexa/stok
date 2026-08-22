import 'server-only'
import { AppError, type ApiErrorBody } from '@stok/shared'
import { NextResponse } from 'next/server'

/**
 * ============================================================================
 * HATA → HTTP EŞLEMESİ
 *
 * Hata sözleşmesi (D-2.2) `packages/shared/src/errors.ts` içinde tanımlı:
 * her kodun bir HTTP durumu var. Bu dosya o eşlemeyi UYGULAYAN tek yer —
 * route handler'lar kendi durum kodlarını seçmiyor, yoksa aynı hata iki
 * endpoint'te iki farklı kodla döner ve mobil outbox hangisine güveneceğini
 * bilemez.
 *
 * TANIMSIZ HATA 500 OLUYOR VE LOG'A YAZILIYOR, ama gövdesi genel kalıyor:
 * `err.message` doğrudan istemciye giderse SQL parçaları, tablo adları ve
 * dosya yolları dışarı sızar.
 * ============================================================================
 */

export function errorResponse(err: unknown): NextResponse<ApiErrorBody> {
  if (err instanceof AppError) {
    const response = NextResponse.json(err.toBody(), { status: err.http })

    // 429 ve 503'te istemcinin ne kadar bekleyeceğini bilmesi gerek.
    // Standart başlık, istemcide özel bir alan okumaktan iyi.
    const retryAfter = err.details.retryAfterSeconds
    if (typeof retryAfter === 'number') {
      response.headers.set('Retry-After', String(Math.ceil(retryAfter)))
    }
    return response
  }

  // Beklenmeyen hata: ayrıntı LOG'A, istemciye genel cevap.
  console.error('[unhandled]', err)
  return NextResponse.json(
    { code: 'SERVER_ERROR', message: 'unexpected error' } satisfies ApiErrorBody,
    { status: 500 },
  )
}

/**
 * Route handler sarmalayıcısı. Her handler'ı bununla sarmak, "bu endpoint'te
 * try/catch yazmayı unuttum" durumunu imkansız kılıyor — unutulan yerde
 * Next.js ham yığın izini döndürürdü.
 */
export function route<T>(handler: () => Promise<T>) {
  return async (): Promise<NextResponse> => {
    try {
      return NextResponse.json(await handler())
    } catch (err) {
      return errorResponse(err)
    }
  }
}
