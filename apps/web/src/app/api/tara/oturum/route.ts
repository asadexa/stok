import { requirePermission, validationError } from '@stok/core'
import type { NextRequest } from 'next/server'
import { errorResponse } from '@/server/http'
import { scanStore, viewForOwner } from '@/server/scan-sessions'
import { requireActor } from '@/server/session'
import { NO_STORE, requireScanner } from '../shared'

/**
 * WS-SCAN — laptopun polling'i: `GET /api/tara/oturum?since=<seq>`.
 *
 * SALT OKUNUR. Tarama oturumunda hiçbir şeyi değiştirmiyor (onay yok,
 * görülme zamanı yok); aynı okumanın ikinci kez uygulanmasını istemci kendi
 * `since` değeriyle önlüyor.
 *
 * YALNIZ AKTÖRÜN KENDİ OTURUMU. Parametrede oturum kimliği yok: başka
 * kullanıcının oturumunu soracak bir yüzey de yok.
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    requireScanner()
    const actor = await requireActor()
    requirePermission(actor, 'movement:create')

    const raw = request.nextUrl.searchParams.get('since') ?? '0'
    const since = Number(raw)
    if (!Number.isSafeInteger(since) || since < 0) {
      throw validationError([{ path: 'since', message: 'since geçersiz' }])
    }

    const session = viewForOwner(scanStore(), actor, since, Date.now())
    return Response.json({ session }, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err)
  }
}
