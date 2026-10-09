import { bearerToken } from '@stok/core'
import { errorResponse } from '@/server/http'
import { parseScanInput, recordScan, scanStore } from '@/server/scan-sessions'
import { NO_STORE, readJson, requireScanner } from '../shared'

/**
 * WS-SCAN — telefonun okuduğu barkodu laptop kullanıcısının oturumuna koyar.
 *
 * STOK HAREKETİ DEĞİL. Bu uç veritabanına gitmiyor, ürün aramıyor,
 * `createMovement` çağırmıyor; cevapta ürün, fiyat ya da stok yok. Laptop
 * okumayı polling'le görüp mevcut `/hareket?barkod=` akışını açıyor ve stok
 * yalnız kullanıcı orada Kaydet'e basınca değişiyor (tara.test.ts bunu
 * hareket sayısıyla sınıyor).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    requireScanner()
    const token = bearerToken(request.headers.get('authorization'))
    const input = parseScanInput(await readJson(request))
    return Response.json(recordScan(scanStore(), token, input, Date.now()), { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err)
  }
}
