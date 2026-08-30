import { closeAppDb } from '@stok/db'
import { TEST_PASSWORD, type TestTenant, seedTestTenant, testAdminDb } from '@stok/db/testing'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { endSession, startSession } from '@/server/session'
import { resetCookieJar } from '@/test/cookie-jar'
import { TEST_DB_NAME } from '@/test/db-name'

import { GET as aramaGET } from './arama/route'
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
