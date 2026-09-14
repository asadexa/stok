import { closeAppDb } from '@stok/db'
import { afterAll, describe, expect, it } from 'vitest'
import { GET } from './route'

/**
 * ============================================================================
 * T114 — SAĞLIK UCU
 *
 * SAHTE YOK. Uç gerçek veritabanına bağlanıyor, test de öyle sınıyor.
 * `pingDb` sahtelenseydi sınanan şey "sahtenin çözülmüş bir söz döndürdüğü"
 * olurdu; oysa bu ucun tek işi GERÇEK bağlantıyı denemek.
 *
 * İKİ TEST, İKİ AYRI ARIZA:
 *   1. Veritabanı ayakta → 200. Ucun hiç çalışmadığı durumu yakalar.
 *   2. Veritabanı erişilemez → 503. ASIL OLAN BU. Sadece 200 dönen, hiçbir
 *      şeye dokunmayan bir sağlık ucu birinci testten geçer ve üretimde en
 *      sık görülen arızada ("uygulama ayakta, veritabanı düşük") yeşil
 *      yanmaya devam eder — yani izlemeyi susturur.
 * ============================================================================
 */
describe('/api/v1/health (T114)', () => {
  afterAll(async () => {
    // Havuzu kapatıyoruz ki bir sonraki `appDb()` çağrısı doğru
    // DATABASE_URL ile yeniden kurulsun. Aksi halde bu dosyadan sonra
    // koşan her test ölü bağlantıyı miras alırdı.
    await closeAppDb()
  })

  it('veritabanı ayaktayken 200 ve sadece durum yazıyor', async () => {
    const res = await GET()
    const body = (await res.json()) as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok' })
    // GÖVDE DAR KALMALI: sürüm, şema ya da kiracı sayısı eklenmesi
    // kimliği doğrulanmamış çağırana altyapı haritası verirdi.
    expect(Object.keys(body)).toHaveLength(1)
  })

  it('veritabanına ulaşılamıyorsa 503 ve hata metni SIZMIYOR', async () => {
    const onceki = process.env.DATABASE_URL
    // Havuzu kapat, adresi ölü bir porta çevir, tekrar aç: `appDb()`
    // singleton'ı tembel kuruluyor, bu yüzden sıra önemli.
    await closeAppDb()
    process.env.DATABASE_URL =
      'postgresql://stok_app:yanlis@127.0.0.1:1/yokboyle?connect_timeout=2'

    try {
      const res = await GET()
      const body = (await res.json()) as Record<string, unknown>

      expect(res.status).toBe(503)
      expect(body).toEqual({ status: 'error' })
      // postgres.js'in bağlantı hatası kullanıcı adını, sunucuyu ve portu
      // içerebiliyor. Cevaba eklenmesi, kimliksiz bir çağırana bağlantı
      // dizesini vermek olurdu.
      const metin = JSON.stringify(body)
      expect(metin).not.toContain('stok_app')
      expect(metin).not.toContain('127.0.0.1')
      expect(metin).not.toContain('yanlis')
    } finally {
      process.env.DATABASE_URL = onceki
      await closeAppDb()
    }
  })
})
