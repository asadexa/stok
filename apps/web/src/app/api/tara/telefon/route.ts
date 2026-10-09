import { bearerToken } from '@stok/core'
import { errorResponse } from '@/server/http'
import { heartbeat, scanStore } from '@/server/scan-sessions'
import { NO_STORE, requireScanner } from '../shared'

/**
 * WS-SCAN — telefonun nabzı. Laptop "Telefon bağlı" diyebilsin ve oturum
 * boşta kapanmasın diye görülme zamanını yazıyor; durum değiştirdiği için
 * POST, GET değil. Cevaptaki kapanma bilgisiyle telefon "bağlantı kapandı"
 * gösteriyor.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    requireScanner()
    const token = bearerToken(request.headers.get('authorization'))
    return Response.json(heartbeat(scanStore(), token, Date.now()), { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err)
  }
}
