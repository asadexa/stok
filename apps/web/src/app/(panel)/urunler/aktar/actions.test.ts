import { randomUUID } from 'node:crypto'
import { parseProductFile } from '@stok/core'
import { closeAppDb } from '@stok/db'
import { TEST_PASSWORD, type TestTenant, seedTestTenant, testAdminDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES } from '@/server/config'
import { startSession } from '@/server/session'
import { resetCookieJar } from '@/test/cookie-jar'
import { TEST_DB_NAME } from '@/test/db-name'
import {
  appendImportRowsAction,
  beginImportAction,
  cancelImportAction,
  importReportAction,
  previewImportAction,
  processImportChunkAction,
  startImportAction,
} from './actions'

/**
 * ============================================================================
 * T171 — TOPLU AKTARIM EYLEMLERİ, GERÇEK OTURUM VE GERÇEK VERİTABANIYLA
 *
 * Eylemler ince bir kapı: yetki ve aktarım mantığı core'da ve orada ayrıntılı
 * sınanıyor (`import-runs.test.ts`). Burada sınanan kapının kendisi: oturum
 * aktöre dönüşüyor mu, hata fırlatmak yerine Türkçe metin dönüyor mu, akış
 * eylemler üzerinden baştan sona yürüyor mu.
 *
 * GERÇEK OTURUM AÇILIYOR: oturumsuz çağrıda eylem TOKEN_INVALID döner ve
 * akış testi hiçbir şeyi sınamadan "hata döndü" diye geçebilirdi.
 * ============================================================================
 */
const admin = testAdminDb(TEST_DB_NAME)
let tenant: TestTenant

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'aktareylem')
})

afterAll(async () => {
  await admin.client.end()
  await closeAppDb()
})

async function login(email: string) {
  resetCookieJar()
  await startSession(email, TEST_PASSWORD)
}

async function parsed(lines: string[]) {
  return parseProductFile(new Uint8Array(Buffer.from(lines.join('\n'), 'utf8')), 'eylem.csv')
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`eylem hata döndü: ${result.error}`)
  return result.value
}

describe('aktarım eylemleri', () => {
  it('yükle → önizle → aktar → rapor eylemler üzerinden baştan sona yürüyor', async () => {
    await login(tenant.adminEmail)
    const file = await parsed([
      'Stok Kodu;Ürün Adı;Birim;Alış Fiyatı;Barkod;Açılış Stoğu',
      `EY-${randomUUID().slice(0, 8)};Eylem Kalemi;Adet;2,50;${randomUUID().slice(0, 12)};4`,
      ';Adsız;Adet;1;;',
    ])

    const { runId } = unwrap(
      await startImportAction({
        fileName: 'eylem.csv',
        fileBytes: 100,
        totalRows: file.rows.length,
        columns: file.columns,
        ignoredQtyColumns: file.ignoredQtyColumns,
      }),
    )
    unwrap(await appendImportRowsAction(runId, file.rows))
    const preview = unwrap(await previewImportAction(runId))
    expect(preview.counts).toEqual({ create: 1, update: 0, error: 1 })

    let progress = unwrap(await beginImportAction(runId))
    while (progress.status === 'RUNNING') progress = unwrap(await processImportChunkAction(runId))

    expect(progress).toMatchObject({ status: 'DONE', rows: { created: 1, invalid: 1 }, openings: { written: 1 } })
    const report = unwrap(await importReportAction(runId))
    expect(report.every((r) => r.rowNumber === 3)).toBe(true)
  })

  it('oturumsuz çağrı fırlatmıyor, Türkçe hata dönüyor', async () => {
    resetCookieJar()
    const result = await startImportAction({ fileName: 'a.csv', fileBytes: 1, totalRows: 1, columns: ['sku', 'name'] })

    expect(result).toEqual({ ok: false, error: 'Oturum geçersiz, tekrar giriş yapın', retryable: false })
  })

  it('çalışan aktarım başlatamıyor', async () => {
    await login(tenant.staffEmail)
    const result = await startImportAction({ fileName: 'a.csv', fileBytes: 1, totalRows: 1, columns: ['sku', 'name'] })

    expect(result).toEqual({ ok: false, error: 'Bu işlem için yetkiniz yok', retryable: false })
  })

  it('bozuk girdi ve bilinmeyen kayıt fırlatmıyor, hata metni dönüyor', async () => {
    await login(tenant.adminEmail)

    expect((await startImportAction({ totalRows: 'çok' })).ok).toBe(false)
    expect(await cancelImportAction('yok')).toEqual({ ok: false, error: 'Kayıt bulunamadı', retryable: false })
  })
})

describe('MAX_UPLOAD_BYTES (T118)', () => {
  it("Vercel'in 4,5 MB platform tavanının ALTINDA", () => {
    // Bu sınır platform seviyesinde uygulanıyor: aşan istek uygulamaya hiç
    // ulaşmadan reddediliyor. Üstüne çıkan bir ayar ulaşılamaz bir sözdür
    // ve tam olarak eskiden öyleydi ('5mb'). Aktarımın ekleme parçaları da
    // bu gövde sınırının altında kalacak şekilde bölünüyor (T171).
    expect(MAX_UPLOAD_BYTES).toBeLessThan(4.5 * 1024 * 1024)
  })
})
