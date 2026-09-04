import { closeAppDb } from '@stok/db'
import { TEST_PASSWORD, type TestTenant, seedTestTenant, testAdminDb } from '@stok/db/testing'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { endSession, startSession } from '@/server/session'
import { resetCookieJar } from '@/test/cookie-jar'
import { TEST_DB_NAME } from '@/test/db-name'

import { GET as aramaGET } from './arama/route'
import { POST as cronPOST } from './cron/route'
import { POST as aktarimHatalariPOST } from './rapor/aktarim-hatalari/route'
import { GET as hareketGET } from './rapor/hareket/route'
import { GET as sablonGET } from './rapor/sablon/route'
import { GET as stokGET } from './rapor/stok/route'

/**
 * ============================================================================
 * T94 — ROTA YETKİ SINIRI
 *
 * NEDEN BU TESTLER VAR. `packages/core/src/role-matrix.test.ts` yetki
 * matrisinin KENDİSİNİ sınıyor. Ama bir ROTANIN o matrisi çağırdığını kimse
 * sınamıyordu: `requireActor()` satırı silinmiş bir uç typecheck'ten geçer,
 * core testlerinden geçer, CI yeşil yanar ve oturumsuz herkese açık kalır.
 *
 * Sahtelenen tek sınır `next/headers` (çerez kavanozu). Veritabanı, core'un
 * yetki mantığı ve rota kodunun kendisi GERÇEK koşuyor.
 *
 * ÜÇ ARIZA SINIFI:
 *   1. Rota `requireActor()` çağırmıyor  → oturumsuz istek 200 alır
 *   2. try/catch yok                     → hata sözleşmesi yerine ham 500
 *   3. Aktör core'a geçirilmiyor         → çalışan yetkisiz veriye ulaşır
 * ============================================================================
 */

const admin = testAdminDb(TEST_DB_NAME)
let tenant: TestTenant

function req(path: string, method: 'GET' | 'POST' = 'GET'): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), { method })
}

async function loginAs(email: string): Promise<void> {
  resetCookieJar()
  await startSession(email, TEST_PASSWORD)
}

interface RouteCase {
  ad: string
  path: string
  method: 'GET' | 'POST'
  handler: (r: NextRequest) => Promise<Response>
  /**
   * Çalışan bu uca ulaşabilmeli mi?
   * `null` → geçerli bir istek gövdesi gerekiyor, yetki tarafı core'un
   * kendi testlerinde kapsanıyor; burada yalnızca oturum sınırı sınanıyor.
   */
  calisan: boolean | null
}

const ROTALAR: RouteCase[] = [
  // Çalışan ürün arayabilmeli: barkodu okutmadan önce ürünü bulması gerekiyor.
  {
    ad: 'arama',
    path: '/api/arama?q=kalem',
    method: 'GET',
    handler: aramaGET,
    calisan: true,
  },

  // Toplu veri dışarı çıkarma: `export:excel` çalışanda YOK (tehdit S7).
  { ad: 'rapor/stok', path: '/api/rapor/stok', method: 'GET', handler: stokGET, calisan: false },
  {
    ad: 'rapor/hareket',
    path: '/api/rapor/hareket',
    method: 'GET',
    handler: hareketGET,
    calisan: false,
  },

  // ŞABLON BİLEREK AÇIK. Rotanın kendi gerekçesi: içerik kişiye özel değil,
  // şablon sabit. Yine de oturum isteniyor çünkü sütun adları ürünün iç
  // yapısını anlatıyor. Testin işi bu kararı DEĞİŞTİRMEK değil, sessizce
  // değişirse haber vermek.
  {
    ad: 'rapor/sablon',
    path: '/api/rapor/sablon',
    method: 'GET',
    handler: sablonGET,
    calisan: true,
  },

  // Gövdede çözümlenmiş dosya bekliyor (`dosyaJson`). Oturum sınırı burada
  // sınanabiliyor çünkü `requireActor()` gövde okunmadan ÖNCE fırlatıyor.
  {
    ad: 'rapor/aktarim-hatalari',
    path: '/api/rapor/aktarim-hatalari',
    method: 'POST',
    handler: aktarimHatalariPOST,
    calisan: null,
  },
]

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'webauthz')
})

afterAll(async () => {
  await admin.client.end()
  await closeAppDb()
})

beforeEach(() => {
  resetCookieJar()
})

describe('oturumsuz istek hiçbir uca giremiyor', () => {
  for (const rota of ROTALAR) {
    it(`${rota.ad} oturumsuz reddediyor`, async () => {
      const res = await rota.handler(req(rota.path, rota.method))

      // 200 gelirse `requireActor()` çağrılmamış demektir: uç herkese açık.
      expect(res.status, `${rota.ad} oturumsuz 200 döndü`).not.toBe(200)
      // 500 gelirse istisna try/catch'e düşmemiş, hata sözleşmesi işlememiş.
      expect(res.status, `${rota.ad} 500 döndü, hata sözleşmesi işlemedi`).not.toBe(500)

      const body = (await res.json()) as { code?: string }
      expect(body.code, `${rota.ad} beklenen hata kodunu döndürmedi`).toBe('TOKEN_INVALID')
    })
  }
})

describe('yönetici izin verilen uçlara ulaşıyor', () => {
  for (const rota of ROTALAR.filter((r) => r.calisan !== null)) {
    it(`${rota.ad} yöneticiye açık`, async () => {
      await loginAs(tenant.adminEmail)
      const res = await rota.handler(req(rota.path, rota.method))
      expect(res.status, `${rota.ad} yöneticiye ${res.status} döndü`).toBe(200)
    })
  }
})

describe('çalışan sınırı sunucuda duruyor (tehdit S6, S7)', () => {
  for (const rota of ROTALAR.filter((r) => r.calisan !== null)) {
    const beklenen = rota.calisan ? 'açık' : 'kapalı'
    it(`${rota.ad} çalışana ${beklenen}`, async () => {
      await loginAs(tenant.staffEmail)
      const res = await rota.handler(req(rota.path, rota.method))

      if (rota.calisan) {
        expect(res.status).toBe(200)
      } else {
        // Arayüzde butonu gizlemek yetki kontrolü DEĞİL: çalışan adresi
        // doğrudan yazabilir. Sınırın sunucuda durması gerekiyor.
        expect(res.status, `${rota.ad} çalışana açık kaldı`).toBe(403)
        const body = (await res.json()) as { code?: string }
        expect(body.code).toBe('FORBIDDEN')
      }
    })
  }
})

describe('oturum yaşam döngüsü', () => {
  it('çıkıştan sonra uçlar yeniden kapanıyor', async () => {
    await loginAs(tenant.adminEmail)
    expect((await aramaGET(req('/api/arama?q=kalem'))).status).toBe(200)

    await endSession()

    const res = await aramaGET(req('/api/arama?q=kalem'))
    expect(res.status, 'çıkıştan sonra uç hâlâ açık').not.toBe(200)
  })
})

/**
 * ============================================================================
 * T34 — CRON UCU
 *
 * Bu uç ROTALAR listesinde değil çünkü oturumla değil paylaşılan sırla
 * korunuyor: zamanlayıcının çerezi yok. Ama sınanan arıza sınıfı aynı —
 * "kontrol satırı silinmiş, uç herkese açık kalmış". Fark şu ki burada açık
 * kalmanın bedeli daha ağır: uç HER TENANT'ın gün sonu raporunu gönderiyor
 * ve kuyruğunu işliyor, yani kimliksiz bir istek bütün müşterilere
 * istediği kadar e-posta attırabilir.
 * ============================================================================
 */
describe('cron ucu (T34)', () => {
  const SIR = 'x'.repeat(40)
  let onceki: Record<string, string | undefined>

  function cronReq(authorization?: string): NextRequest {
    return new NextRequest(new URL('http://localhost/api/cron'), {
      method: 'POST',
      headers: authorization ? { authorization } : undefined,
    })
  }

  // Sorgular drizzle yerine doğrudan postgres.js istemcisiyle: `sql`
  // şablonu drizzle-orm'dan gelir ve o, apps/web'in bağımlılığı değil.
  // Sırf iki sayım sorgusu için bağımlılık eklemek, web paketini
  // veritabanı katmanına doğrudan bağlardı.
  async function isSayisi(): Promise<number> {
    const rows = await admin.client<{ n: string }[]>`SELECT count(*)::text AS n FROM background_jobs`
    return Number(rows[0]?.n ?? '0')
  }

  beforeAll(() => {
    onceki = {
      CRON_SECRET: process.env.CRON_SECRET,
      SMTP_URL: process.env.SMTP_URL,
      REPORT_FROM_EMAIL: process.env.REPORT_FROM_EMAIL,
    }
    // SMTP AYARI BURADA, testlerin içinde değil: eksik olsaydı kapı
    // açıldığında tur SMTP yapılandırması yüzünden düşer ve "uç kapalı"
    // testleri, kapı açık olsa BİLE yeşil yanardı — yanlış sebeple geçen
    // bir güvenlik testi, testin hiç olmamasından kötü.
    // Ulaşılamayan adres bilerek: sınanan şey turun BAŞLAYIP başlamadığı.
    process.env.SMTP_URL = 'smtp://127.0.0.1:1/?connectionTimeout=500&greetingTimeout=500'
    process.env.REPORT_FROM_EMAIL = 'rapor@ornek.test'
  })

  /**
   * Her test TEMİZ kuyrukla başlıyor. Aksi halde bir önceki testin
   * oluşturduğu işler `dedupeKey` yüzünden yeniden üretilmiyor ve turun
   * hiç iş işlemediği görülüyordu — testin sırasına bağlı, teşhisi pahalı
   * bir yanlış yeşil.
   */
  beforeEach(async () => {
    await admin.client`DELETE FROM background_jobs`
  })

  afterAll(async () => {
    for (const [k, v] of Object.entries(onceki)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await admin.client`DELETE FROM background_jobs`
  })

  it('CRON_SECRET tanımsızsa uç KAPALI', async () => {
    delete process.env.CRON_SECRET
    const once = await isSayisi()

    const res = await cronPOST(cronReq(`Bearer ${SIR}`))

    expect(res.status).toBe(500)
    // ASIL KONTROL: "sır yoksa doğrulama yapma" varsayılanı, ortam
    // değişkenini eklemeyi unutan kurulumda ucu internete açardı.
    expect(await isSayisi(), 'sır tanımsızken cron turu çalıştı').toBe(once)
  })

  it('KISA sır kabul edilmiyor', async () => {
    // 8 karakterlik bir sır kaba kuvvetle denenebilir ve bu uç kimlik
    // doğrulama sayacına (T51) TABİ DEĞİL: orası e-posta başına sayıyor,
    // burada kullanıcı yok. Tek savunma sırrın tahmin edilemezliği.
    process.env.CRON_SECRET = 'kisa-sir'
    const once = await isSayisi()

    const res = await cronPOST(cronReq('Bearer kisa-sir'))

    expect(res.status, 'kısa sır kabul edildi').toBe(500)
    expect(await isSayisi(), 'kısa sırla cron turu çalıştı').toBe(once)
  })

  it('sırsız istek 401', async () => {
    process.env.CRON_SECRET = SIR
    const once = await isSayisi()

    const res = await cronPOST(cronReq())

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code?: string }).code).toBe('TOKEN_INVALID')
    expect(await isSayisi(), 'sırsız istekte cron turu çalıştı').toBe(once)
  })

  it('YANLIŞ sır 401 — uzunluk aynı olsa bile', async () => {
    process.env.CRON_SECRET = SIR
    const once = await isSayisi()

    const res = await cronPOST(cronReq(`Bearer ${'y'.repeat(SIR.length)}`))

    expect(res.status).toBe(401)
    expect(await isSayisi(), 'yanlış sırla cron turu çalıştı').toBe(once)
  })

  it('SMTP YAPILANDIRILMAMIŞSA da tur çalışıyor', async () => {
    // Gerçek kurulumda ölçülerek bulundu: SMTP eksikken uç 500 dönüyor ve
    // turun tamamı düşüyordu — kuyruk işlenmiyor, invariant denetlenmiyor,
    // sayaçlar budanmıyor. Hiçbiri e-postaya bağlı değil.
    process.env.CRON_SECRET = SIR
    delete process.env.SMTP_URL
    const once = await isSayisi()

    const res = await cronPOST(cronReq(`Bearer ${SIR}`))
    const body = (await res.json()) as { code?: string; tenants?: { result?: { ran: number } }[] }

    expect(body.code, `tur düştü: ${JSON.stringify(body)}`).toBeUndefined()
    expect(body.tenants?.[0]?.result?.ran, 'kuyruk işlenmedi').toBeGreaterThan(0)
    expect(await isSayisi(), 'iş kuyruğa hiç girmedi').toBeGreaterThan(once)

    process.env.SMTP_URL = 'smtp://127.0.0.1:1/?connectionTimeout=500&greetingTimeout=500'
  })


  it('DOĞRU sırla tur çalışıyor', async () => {
    process.env.CRON_SECRET = SIR

    const res = await cronPOST(cronReq(`Bearer ${SIR}`))
    const body = (await res.json()) as {
      day?: string
      code?: string
      tenants?: { result?: { ran: number; succeeded: number; retried: number } }[]
    }

    // Gövde hata sözleşmesi değil cron sonucu: kapı açıldı, tur döndü.
    expect(body.code, `kapı açılmadı: ${JSON.stringify(body)}`).toBeUndefined()
    expect(body.tenants?.length, 'hiçbir tenant işlenmedi').toBeGreaterThan(0)

    const tur = body.tenants?.[0]?.result
    expect(tur?.ran, 'kuyruk hiç işlenmedi').toBeGreaterThan(0)
    // SMTP ölü: rapor GİTMEDİ. "başarılı" sayılması G4'ün ta kendisi.
    //
    // TOPLAM `succeeded` SAYISINA BAKILMIYOR: sağlık alarmı (T36) sorun
    // yokken e-posta göndermeden başarılı biter, yani toplam her zaman
    // sıfırdan büyük. Gevşek bir kontrol o yüzden yeşil yanardı.
    expect(tur?.retried, 'başarısız iş tekrar sırasına girmedi').toBeGreaterThan(0)

    // İlk tur 200: işin bir deneme hakkı daha var ve durumu kuyrukta
    // yazılı. Her geçici SMTP hatasında alarm çalmak, operatörü alarmı
    // yok saymaya alıştırırdı. Hak bittiğinde 500 dönüyor — bkz.
    // packages/core/src/cron.test.ts, "deneme hakkı bitince".
    expect(res.status).toBe(200)
  })
})
