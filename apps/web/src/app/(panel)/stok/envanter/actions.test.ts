import { randomUUID } from 'node:crypto'
import { parseInventoryFile } from '@stok/core/inventory-file'
import { closeAppDb } from '@stok/db'
import { TEST_PASSWORD, type TestTenant, seedTestTenant, testAdminDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSession } from '@/server/session'
import { resetCookieJar } from '@/test/cookie-jar'
import { TEST_DB_NAME } from '@/test/db-name'
import {
  appendInventoryRowsAction,
  beginInventoryAction,
  inventoryReportAction,
  previewInventoryAction,
  processInventoryChunkAction,
  startInventoryAction,
} from './actions'

/**
 * ============================================================================
 * T219 — ENVANTERİ GÜNCELLE EYLEMLERİ, GERÇEK OTURUM VE GERÇEK VERİTABANIYLA
 *
 * Satır kuralları core'da (`inventory-runs.test.ts`). Burada sınanan kapı:
 * oturum aktöre dönüşüyor mu, akış eylemler üzerinden yürüyor mu, ekrandaki
 * "yeni sayım" onayı sunucuya gerçekten taşınıyor mu (taşınmasaydı aynı
 * dosya ya hiç uygulanamaz ya da onaysız uygulanırdı).
 * ============================================================================
 */
const admin = testAdminDb(TEST_DB_NAME)
let tenant: TestTenant

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'envantereylem')
})

afterAll(async () => {
  await admin.client.end()
  await closeAppDb()
})

async function login(email: string) {
  resetCookieJar()
  await startSession(email, TEST_PASSWORD)
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`eylem hata döndü: ${result.error}`)
  return result.value
}

const HEADER = 'Malzeme Kodu;Malzeme Açıklaması;Ambar;Envanter Miktarı;Birim;Ortalama Değer'

/** Tarayıcının yaptığı: dosyayı oku, satırları gönder, önizle. */
async function upload(lines: string[], fileName = 'envanter.csv') {
  const file = await parseInventoryFile(new Uint8Array(Buffer.from([HEADER, ...lines].join('\n'), 'utf8')), fileName)
  const { runId } = unwrap(
    await startInventoryAction({
      fileName,
      fileBytes: 100,
      totalRows: file.rows.length,
      columns: file.columns,
      unreadColumns: file.unreadColumns,
    }),
  )
  unwrap(await appendInventoryRowsAction(runId, file.rows))
  return { runId, preview: unwrap(await previewInventoryAction(runId)) }
}

async function drain(runId: string, confirmNewCount?: boolean) {
  let progress = unwrap(await beginInventoryAction(runId, confirmNewCount))
  while (progress.status === 'RUNNING') progress = unwrap(await processInventoryChunkAction(runId))
  return progress
}

describe('envanter eylemleri', () => {
  it('yükle → önizle → uygula → rapor eylemler üzerinden yürüyor; fiyat sütunu okunmuyor', async () => {
    await login(tenant.adminEmail)
    const sku = `EV-${randomUUID().slice(0, 8)}`
    const { runId, preview } = await upload([
      `${sku};Eylem Kalemi;Eylem Merkez;10;AD;12,50`,
      `${sku};Eylem Kalemi;Eylem Şube;20;AD;12,50`,
      `${sku}-B;Boş Miktarlı;Eylem Merkez;;AD;1`,
    ])
    expect(preview.counts).toMatchObject({ newProducts: 1, create: 2, error: 1, increase: 2 })
    expect(preview.depots).toEqual([
      { name: 'Eylem Merkez', isNew: true },
      { name: 'Eylem Şube', isNew: true },
    ])
    expect(preview.notices.join(' ')).toContain('Ortalama Değer')

    const progress = await drain(runId)
    expect(progress).toMatchObject({ status: 'DONE', rows: { created: 2, invalid: 1 } })
    const report = unwrap(await inventoryReportAction(runId))
    expect(report.map((r) => r.rowNumber)).toEqual([4])

    const [product] = await admin.client<{ purchase: string | null; sale: string | null }[]>`
      SELECT purchase_price::text AS purchase, sale_price::text AS sale FROM products
       WHERE tenant_id = ${tenant.tenantId} AND sku = ${sku}`
    expect(product).toEqual({ purchase: null, sale: null })
  })

  it('aynı içerik: onaysız başlamıyor, ekrandaki onayla başlıyor', async () => {
    await login(tenant.adminEmail)
    const sku = `RP-${randomUUID().slice(0, 8)}`
    const first = await upload([`${sku};Tekrar Kalemi;Eylem Merkez;5;AD;1`], 'sayim-1.csv')
    await drain(first.runId)

    // Arada stok değişti: aynı dosya yeniden yazılacak bir fark taşıyor.
    const second = await upload([`${sku};Tekrar Kalemi;Eylem Merkez;8;AD;1`], 'sayim-2.csv')
    await drain(second.runId)

    const again = await upload([`${sku};Tekrar Kalemi;Eylem Merkez;5;AD;1`], 'sayim-1-kopya.csv')
    expect(again.preview.repeatOf).toMatchObject({ fileName: 'sayim-1.csv' })

    const refused = await beginInventoryAction(again.runId)
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.error).toContain('daha önce uygulandı')

    const progress = await drain(again.runId, true)
    expect(progress).toMatchObject({ status: 'DONE', rows: { updated: 1 } })
  })

  it('çalışan envanter aktarımı başlatamıyor', async () => {
    await login(tenant.staffEmail)
    const result = await startInventoryAction({
      fileName: 'a.csv',
      fileBytes: 1,
      totalRows: 1,
      columns: ['sku', 'qty', 'depot'],
    })
    expect(result).toEqual({ ok: false, error: 'Bu işlem için yetkiniz yok', retryable: false })
  })

  it('oturumsuz çağrı fırlatmıyor, Türkçe hata dönüyor', async () => {
    resetCookieJar()
    const result = await previewInventoryAction(randomUUID())
    expect(result).toEqual({ ok: false, error: 'Oturum geçersiz, tekrar giriş yapın', retryable: false })
  })
})
