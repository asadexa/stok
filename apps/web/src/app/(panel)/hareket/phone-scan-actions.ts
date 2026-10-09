'use server'

import { requirePermission } from '@stok/core'
import { AppError, errorText } from '@stok/shared'
import { renderSVG } from 'uqr'
import { phoneScannerEnabled } from '@/server/config'
import {
  closeForOwner,
  openSession,
  pairingUrl,
  parsePublicBase,
  scanStore,
} from '@/server/scan-sessions'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * WS-SCAN — LAPTOP: TELEFON OTURUMU AÇ / KES
 *
 * Yazma işleri server action: Next'in kaynak (origin) kontrolü ve `lax`
 * çerez CSRF'e karşı duruyor. Oturum çerezdeki aktörden kuruluyor; istemci
 * kiracı ya da kullanıcı gönderemiyor.
 *
 * QR SUNUCUDA ÜRETİLİYOR ve `<img src="data:…">` olarak basılıyor: istemci
 * paketine QR kütüphanesi inmiyor, sayfaya HTML enjekte edilmiyor.
 * ============================================================================
 */

export type StartPhoneScanResult =
  | { ok: true; sessionId: string; pairingUrl: string; qr: string; origin: string }
  | { ok: false; error: string }

function fail(err: unknown): { ok: false; error: string } {
  if (err instanceof AppError) return { ok: false, error: errorText(err.code, err.details) }
  console.error('[phone scan action]', err)
  return { ok: false, error: errorText('SERVER_ERROR') }
}

/** `publicBase`: laptop kullanıcısının panele yapıştırdığı tünel adresi. */
export async function startPhoneScan(publicBase: string): Promise<StartPhoneScanResult> {
  if (!phoneScannerEnabled()) return { ok: false, error: errorText('NOT_FOUND') }
  const actor = await currentActor()
  if (!actor) return { ok: false, error: errorText('TOKEN_INVALID') }

  try {
    requirePermission(actor, 'movement:create')
    // Adres oturum açılmadan önce doğrulanıyor: yanlış adres mevcut bağlı
    // telefonu düşürmesin.
    const origin = parsePublicBase(publicBase)
    const { sessionId, pairingToken } = openSession(scanStore(), actor, Date.now())
    const url = pairingUrl(origin, pairingToken)
    const svg = renderSVG(url, { border: 2 })
    return {
      ok: true,
      sessionId,
      pairingUrl: url,
      qr: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      origin,
    }
  } catch (err) {
    return fail(err)
  }
}

export async function endPhoneScan(): Promise<void> {
  const actor = await currentActor()
  if (!actor) return
  closeForOwner(scanStore(), actor)
}
