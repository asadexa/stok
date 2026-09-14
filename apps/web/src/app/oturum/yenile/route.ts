import { persistSession } from '@/server/session'

/**
 * ============================================================================
 * OTURUM ÇEREZİNİ KALICILAŞTIRMA — T87
 *
 * Sorun: `currentActor()` süresi dolmuş access token'ı sayfa render edilirken
 * yeniliyor, ama Next.js 15 render sırasında çerez yazmaya izin vermiyor.
 * Yenileme çalışıyor, istek tamamlanıyor — çerez ESKİ kalıyor. Sonuç: salt
 * gezinen bir kullanıcı (form göndermeyen) her sayfa açılışında bir yenileme
 * sorgusu tetikliyor, kalıcı olarak.
 *
 * Bu uç o döngüyü kırıyor. Route handler'da çerez yazma serbest.
 *
 * NEDEN `POST`, `GET` DEĞİL:
 *
 *   - `GET` yan etkisiz olmalı; burada yan etki var (çerez döndürme).
 *   - Tarayıcı ve Next.js `GET` adreslerini ÖNCEDEN ÇEKİYOR (prefetch).
 *     Önceden çekilen bir yenileme, kullanıcı o sayfaya hiç gitmeden token
 *     döndürürdü.
 *   - `<img src>` veya üçüncü taraf bir sayfadaki bağlantı `GET`'i
 *     tetikleyebilir; `POST` + `sameSite: lax` çerezi bunu engelliyor.
 *
 * YÖNLENDİRME HEDEFİ PARAMETRESİ YOK. `?next=` alsaydı açık yönlendirme
 * (open redirect) yüzeyi açılırdı ve doğrulaması unutulmaya müsait bir
 * kontrol olurdu. İstemci zaten bulunduğu sayfada kalıyor; gidecek yer yok.
 *
 * OTURUM YOKSA DA 204 DÖNÜYOR, 401 DEĞİL. Bu uç bir kimlik kontrolü değil
 * bir bakım işi: çağıran istemci zaten oturumlu bir sayfada duruyor ve
 * cevabı okumuyor. 401 döndürmek, tarayıcı konsoluna hiçbir işe yaramayan
 * kırmızı bir satır yazdırmaktan başka bir şey yapmazdı.
 * ============================================================================
 */
export async function POST(): Promise<Response> {
  await persistSession().catch(() => false)
  return new Response(null, { status: 204 })
}
