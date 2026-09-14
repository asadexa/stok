import { closeAppDb } from '@stok/db'
import { TEST_PASSWORD, type TestTenant, seedTestTenant, testAdminDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES } from '@/server/config'
import { startSession } from '@/server/session'
import { resetCookieJar } from '@/test/cookie-jar'
import { TEST_DB_NAME } from '@/test/db-name'
import { analyzeAction } from './actions'

/**
 * ============================================================================
 * T118 — YÜKLEME BOYUTU SINIRI
 *
 * Sınırı aşan dosya, uygulama kontrolü olmadan Vercel'in HAM 413'üne
 * takılırdı: ekranda sebebi söylemeyen bir arıza, kullanıcı ne yapacağını
 * bilmiyor. Depoyu kuran kişi bunu kurulum günü, elinde tek bir büyük
 * Excel dosyasıyla yaşardı.
 *
 * GERÇEK OTURUM AÇILIYOR: boyut kontrolü `currentActor()`'dan SONRA
 * geliyor (yetki önce, doğru sıra bu). Oturumsuz çağrıda eylem
 * TOKEN_INVALID döner ve test sınıra hiç ulaşmazdı — yanlış sebeple geçen
 * bir test.
 * ============================================================================
 */
const admin = testAdminDb(TEST_DB_NAME)
let tenant: TestTenant

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'aktarboyut')
  resetCookieJar()
  await startSession(tenant.adminEmail, TEST_PASSWORD)
})

afterAll(async () => {
  await admin.client.end()
  await closeAppDb()
})

describe('analyzeAction boyut sınırı (T118)', () => {
  function formWith(bytes: number): FormData {
    const form = new FormData()
    // Excel değil düz dolgu: çözümleyiciye hiç ulaşmaması gerekiyor.
    // Ulaşsaydı hata "dosya bozuk" olurdu ve sınır testi yanlış sebeple
    // yeşil yanardı.
    form.set('dosya', new File([new Uint8Array(bytes)], 'urunler.xlsx'))
    return form
  }

  it('sınırın ÜSTÜNDEKİ dosya reddediliyor ve ne yapılacağı söyleniyor', async () => {
    const state = await analyzeAction({}, formWith(MAX_UPLOAD_BYTES + 1))

    expect(state.error).toBeDefined()
    // Ham 413 ya da "SERVER_ERROR" değil: kullanıcı sebebi ve çözümü
    // okuyabilmeli.
    expect(state.error).toMatch(/çok büyük/i)
    expect(state.error, 'ne yapılacağı söylenmiyor').toMatch(/böl/i)
    expect(state.error, 'izin verilen sınır yazmıyor').toMatch(/4 MB/)
    // Çözümleme hiç başlamamalı.
    expect(state.preview).toBeUndefined()
  })

  it('sınırın ALTINDAKİ dosya boyut kontrolüne takılmıyor', async () => {
    // ASIL KONTROL: her dosyayı reddeden bir kontrol de yukarıdaki testten
    // geçerdi. Bu dosya çözümleyiciye ULAŞMALI — orada bozuk olduğu için
    // başka bir hata alacak, ama "çok büyük" ALMAYACAK.
    const state = await analyzeAction({}, formWith(1024))

    expect(state.error ?? '').not.toMatch(/çok büyük/i)
  })
})

describe('MAX_UPLOAD_BYTES (T118)', () => {
  it("Vercel'in 4,5 MB platform tavanının ALTINDA", () => {
    // Bu sınır platform seviyesinde uygulanıyor: aşan istek uygulamaya hiç
    // ulaşmadan reddediliyor. Üstüne çıkan bir ayar ulaşılamaz bir sözdür
    // ve tam olarak eskiden öyleydi ('5mb').
    expect(MAX_UPLOAD_BYTES).toBeLessThan(4.5 * 1024 * 1024)
  })
})
