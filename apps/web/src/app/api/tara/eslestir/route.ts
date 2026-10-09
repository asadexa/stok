import { errorResponse } from '@/server/http'
import { pairPhone, scanStore } from '@/server/scan-sessions'
import { NO_STORE, readJson, requireScanner } from '../shared'

/**
 * WS-SCAN — telefon QR'daki tek kullanımlık token'ı kalıcı telefon token'ına
 * çeviriyor. Token adres çubuğundan değil gövdeden geliyor: telefon onu
 * fragment'ten okuyup gönderiyor, yani hiçbir erişim loguna düşmüyor.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    requireScanner()
    const body = await readJson(request)
    const token =
      typeof body === 'object' && body !== null && typeof (body as { token?: unknown }).token === 'string'
        ? (body as { token: string }).token
        : ''
    return Response.json(pairPhone(scanStore(), token, Date.now()), { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err)
  }
}
