import { randomUUID } from 'node:crypto'
import { AppError } from '@stok/shared'
import { backgroundJobs, stockMovements, withTenant } from '@stok/db'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import ExcelJS from 'exceljs'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz.js'
import {
  INLINE_ROW_LIMIT,
  QUEUED_ROW_LIMIT,
  createExportJobHandler,
  exportMovements,
  exportStock,
  planExport,
} from './exports.js'
import { RETRY_DELAY_SECONDS, getJob, listFailedJobs, listJobs, runQueuedJobs } from './jobs.js'
import { createInMemoryTransport } from './mail.js'
import { createMovement } from './movements.js'
import { TEST_DB_NAME } from './test/db-name.js'

/**
 * ============================================================================
 * T14 — KRİTİK AÇIK G1 (büyük rapor) ve G4 (sessiz cron hatası)
 *
 * G1'in eski hali: 50 bin satırlık istek serverless zaman sınırına takılıyor
 * ve kullanıcı yarım dosya ya da sessiz 500 alıyor.
 *
 * G4'ün eski hali: gün sonu raporu gönderilemiyor ve kimse fark etmiyor.
 *
 * İkisinin de testi aynı sorunun iki yüzü: işin ne olduğu değil, işin
 * BAŞARISIZ OLDUĞUNUN GÖRÜNÜR olması.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

let tenant: TestTenant
let boss: Actor
let staff: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'export', [
    { sku: 'EX-1', name: 'Kırmızı Tükenmez Kalem' },
    { sku: 'EX-2', name: 'Isıtıcı Şerit', unit: 'METRE' },
    { sku: 'EX-3', name: 'Arşivli Ürün', archived: true },
  ])
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }

  await createMovement(
    boss,
    {
      idempotencyKey: randomUUID(),
      barcode: tenant.products['EX-1']!.barcode,
      qty: 40,
      reason: 'PURCHASE',
      unitCost: 3.5,
      clientCreatedAt: new Date().toISOString(),
    },
    { db: app.db },
  )
  await createMovement(
    staff,
    {
      idempotencyKey: randomUUID(),
      barcode: tenant.products['EX-2']!.barcode,
      qty: 12.5,
      reason: 'PURCHASE',
      clientCreatedAt: new Date().toISOString(),
    },
    { db: app.db },
  )
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

const opts = { db: app.db }

/**
 * Testler KÜÇÜK eşiklerle koşuyor. 20 bin gerçek hareket yazmak testi
 * dakikalarca sürdürür (her satır projeksiyon trigger'ını tetikliyor) ve
 * ölçtüğümüz şey eşiğin DAVRANIŞI, ledger'ın hızı değil. Eşiklerin
 * varsayılan değerleri ayrıca aşağıda doğrulanıyor.
 */
const small = { ...opts, inlineRowLimit: 5, queuedRowLimit: 12 }

/**
 * Başarısız iş `RETRY_DELAY_SECONDS` boyunca yeniden alınmıyor. Testler
 * bu yüzden saati ilerletiyor — `sleep(60_000)` ile beklemek testi bir
 * dakika uzatır ve ölçtüğümüz şey gecikmenin SÜRESİ değil, VARLIĞI.
 */
function atTick(n: number) {
  return { ...opts, now: () => T0 + n * (RETRY_DELAY_SECONDS + 1) * 1000 }
}

const T0 = Date.UTC(2026, 3, 1, 8, 0, 0)

async function expectAppError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err, `beklenen hata: ${code}, ama çağrı başarılı oldu`).toBeInstanceOf(AppError)
  expect((err as AppError).code).toBe(code)
  return err as AppError
}

/** `inline` olduğunu doğrulayıp daraltan yardımcı. */
async function asInline(promise: Promise<Awaited<ReturnType<typeof exportStock>>>) {
  const res = await promise
  if (res.mode !== 'inline') throw new Error(`beklenen inline, gelen ${res.mode}`)
  return res
}

async function jobCount(): Promise<number> {
  const rows = await admin.db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM background_jobs`)
  return Number([...rows][0]?.n ?? 0)
}

async function sheetOf(buffer: Uint8Array) {
  const workbook = new ExcelJS.Workbook()
  // Cast: exceljs bağımlılığı (fast-csv üzerinden) @types/node@14 çekiyor
  // ve o sürümde Buffer jenerik değil. İki farklı Buffer tanımı aynı
  // projede bulununca derleyici "Buffer is not assignable to Buffer"
  // diyor. Çalışma zamanında tek bir Buffer var; sorun tamamen tiplerde.
  await workbook.xlsx.load((Buffer.from(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0]))
  return workbook.worksheets[0]!
}

describe('T22 - ekrandaki filtre ile aynı satırlar', () => {
  it('arama filtresi export\'a da uygulanıyor', async () => {
    // Başta uygulanmıyordu: kullanıcı "ısıtıcı" arayıp 1 satır görüyor,
    // Excel'e aktar deyince eline bütün katalog geliyordu. Ekranda
    // görünenle dosyadakinin farklı olması, raporun yanlış olması demek.
    const sheet = await sheetOf((await asInline(exportStock(boss, { search: 'isitici' }, opts))).buffer)

    // 1 başlık + 1 veri satırı.
    expect(sheet.rowCount).toBe(2)
    expect(String(sheet.getRow(2).getCell(2).value)).toBe('Isıtıcı Şerit')
  })

  it('arama stok koduna da bakıyor ve Türkçe normalize ediliyor', async () => {
    const bySku = await asInline(exportStock(boss, { search: 'EX-2' }, opts))
    const byName = await asInline(exportStock(boss, { search: 'IŞITICI' }, opts))

    expect((await sheetOf(bySku.buffer)).rowCount).toBe(2)
    expect((await sheetOf(byName.buffer)).rowCount).toBe(2)
  })

  it('eşleşme yoksa dosya sadece başlık satırı içeriyor', async () => {
    // Boş dosya değil BAŞLIKLI dosya: kullanıcı dosyayı açtığında
    // "bozuk mu indi" diye düşünmemeli, "sonuç yok" görmeli.
    const res = await asInline(exportStock(boss, { search: 'zzzyok' }, opts))
    expect((await sheetOf(res.buffer)).rowCount).toBe(1)
  })
})

describe('T22 - planExport', () => {
  it('eşik altında inline, üstünde queued diyor ve hiçbir şey yazmıyor', async () => {
    const before = await jobCount()

    const plan = await planExport(boss, 'STOCK_EXPORT', {}, opts)
    expect(plan).toEqual({ mode: 'inline', rowCount: 2 }) // arşivli hariç

    const queued = await planExport(boss, 'STOCK_EXPORT', { includeArchived: true }, {
      ...opts,
      inlineRowLimit: 2,
      queuedRowLimit: 100,
    })
    expect(queued.mode).toBe('queued')

    // ASIL İDDİA: planlama yan etkisiz. İndirme adresi bir GET ve
    // kullanıcı sayfayı yenilediğinde yeni iş kuyruğa alınmamalı.
    expect(await jobCount()).toBe(before)
  })

  it('sert sınırın üstünde reddediyor ve sayıları hataya koyuyor', async () => {
    const err = await expectAppError(
      planExport(boss, 'STOCK_EXPORT', {}, { ...opts, inlineRowLimit: 1, queuedRowLimit: 1 }),
      'EXPORT_TOO_LARGE',
    )
    expect(err.details).toMatchObject({ rowCount: 2, limit: 1 })
  })

  it('planlama exportStock ile aynı filtreyi görüyor', async () => {
    const plan = await planExport(boss, 'STOCK_EXPORT', { search: 'isitici' }, opts)
    const res = await asInline(exportStock(boss, { search: 'isitici' }, opts))

    expect(plan.rowCount).toBe(res.rowCount)
  })

  it('çalışan planlama yapamıyor', async () => {
    await expectAppError(planExport(staff, 'STOCK_EXPORT', {}, opts), 'FORBIDDEN')
  })

  it('hareket planı çalışanın kapsamıyla sınırlı olurdu (admin tümünü sayıyor)', async () => {
    const plan = await planExport(boss, 'MOVEMENT_EXPORT', {}, opts)
    expect(plan.rowCount).toBe(2) // biri admin, biri çalışan tarafından yazıldı
  })
})

describe('yetki', () => {
  it('çalışan Excel indiremez', async () => {
    // Toplu veri dışarı çıkarma admin işi (rol matrisi satır 7).
    const err = await expectAppError(exportStock(staff, {}, opts), 'FORBIDDEN')
    expect(err.details.permission).toBe('export:excel')
    await expectAppError(exportMovements(staff, {}, opts), 'FORBIDDEN')
  })
})

describe('senkron indirme (eşik altı)', () => {
  it('stok raporu dosya olarak dönüyor', async () => {
    const res = await exportStock(boss, {}, opts)

    expect(res.mode).toBe('inline')
    if (res.mode !== 'inline') return
    expect(res.fileName).toMatch(/^stok-\d{8}-\d{4}\.xlsx$/)
    expect(res.rowCount).toBe(2) // arşivli ürün hariç

    const sheet = await sheetOf(res.buffer)
    expect(sheet.getRow(2).getCell(1).value).toBe('EX-1')
    expect(sheet.getRow(2).getCell(2).value).toBe('Kırmızı Tükenmez Kalem')
    expect(sheet.getRow(2).getCell(6).value).toBe(40)
  })

  it('arşivli ürün istenirse dahil ediliyor', async () => {
    const res = await exportStock(boss, { includeArchived: true }, opts)
    expect(res.rowCount).toBe(3)
  })

  it('hiç hareketi olmayan ürün BOŞ değil SIFIR gösteriyor', async () => {
    // Boş hücre "veri yok" demek; doğru cevap "sıfır adet".
    const res = await exportStock(boss, { includeArchived: true }, opts)
    if (res.mode !== 'inline') throw new Error('inline bekleniyordu')

    const sheet = await sheetOf(res.buffer)
    const archived = [2, 3, 4].map((r) => sheet.getRow(r)).find((r) => r.getCell(1).value === 'EX-3')
    expect(archived?.getCell(6).value).toBe(0)
  })

  it('hareket raporu dosya olarak dönüyor', async () => {
    const res = await exportMovements(boss, {}, opts)

    expect(res.mode).toBe('inline')
    if (res.mode !== 'inline') return
    expect(res.rowCount).toBe(2)

    const sheet = await sheetOf(res.buffer)
    expect(sheet.getRow(2).getCell(1).value).toBeInstanceOf(Date)
    expect(sheet.getRow(2).getCell(6).value).toBe('Satın alma')
  })

  it('boş sonuç geçerli dosya üretiyor, hata değil', async () => {
    const res = await exportMovements(boss, { reason: 'DAMAGE' }, opts)

    expect(res.mode).toBe('inline')
    if (res.mode !== 'inline') return
    expect(res.rowCount).toBe(0)
    expect(res.buffer.length).toBeGreaterThan(0)
  })

  it('bozuk filtre VALIDATION_FAILED', async () => {
    await expectAppError(exportStock(boss, { category: 123 }, opts), 'VALIDATION_FAILED')
    await expectAppError(exportMovements(boss, { from: 'dün' }, opts), 'VALIDATION_FAILED')
  })
})

describe('G1 - eşik üstü istek kuyruğa alınıyor', () => {
  it('eşiği aşan hareket raporu kuyruğa giriyor', async () => {
    const big = await seedTestTenant(admin.db, 'export-big', [{ sku: 'B-1', name: 'Çok Satır' }])
    const bigBoss: Actor = { tenantId: big.tenantId, userId: big.adminUserId, role: 'ADMIN' }
    await bulkInsertMovements(big, small.inlineRowLimit + 2)

    const res = await exportMovements(bigBoss, {}, small)

    expect(res.mode).toBe('queued')
    if (res.mode !== 'queued') return
    expect(res.rowCount).toBeGreaterThanOrEqual(small.inlineRowLimit)
    expect(res.notifyEmail).toBe(big.adminEmail)

    const job = await getJob(bigBoss, res.jobId, opts)
    expect(job?.kind).toBe('MOVEMENT_EXPORT')
    expect(job?.status).toBe('QUEUED')
    // Rol işin içinde saklanıyor: dosyayı işçi değil, isteyen kişinin
    // yetkisi şekillendiriyor.
    expect(job?.params.role).toBe('ADMIN')
  })

  it('kuyruktaki iş çalışınca dosya e-postayla gidiyor', async () => {
    const big = await seedTestTenant(admin.db, 'export-run', [{ sku: 'R-1', name: 'Kuyruk Ürünü' }])
    const bigBoss: Actor = { tenantId: big.tenantId, userId: big.adminUserId, role: 'ADMIN' }
    await bulkInsertMovements(big, small.inlineRowLimit + 2)

    const queued = await exportMovements(bigBoss, {}, small)
    expect(queued.mode).toBe('queued')

    const mail = createInMemoryTransport()
    const stats = await runQueuedJobs(
      big.tenantId,
      { MOVEMENT_EXPORT: createExportJobHandler(mail, opts) },
      opts,
    )

    expect(stats).toMatchObject({ ran: 1, succeeded: 1, failed: 0 })
    expect(mail.sent).toHaveLength(1)
    expect(mail.sent[0]?.to).toBe(big.adminEmail)
    expect(mail.sent[0]?.attachments?.[0]?.filename).toMatch(/^hareket-.*\.xlsx$/)

    // Ek gerçekten okunabilir bir Excel dosyası olmalı, boş bayt dizisi değil.
    const sheet = await sheetOf(mail.sent[0]!.attachments![0]!.content)
    expect(sheet.rowCount).toBeGreaterThan(small.inlineRowLimit)

    if (queued.mode === 'queued') {
      const job = await getJob(bigBoss, queued.jobId, opts)
      expect(job?.status).toBe('SUCCEEDED')
      expect(job?.result?.rowCount).toBeGreaterThan(small.inlineRowLimit)
    }
  })

  it('sert sınırın üstü REDDEDİLİYOR', async () => {
    // Arka plan işinin de sınırı olmalı: sınırsız bir iş kuyruğu tıkar
    // ve gün sonu raporunu geciktirir. Kullanıcının yapabileceği somut
    // bir şey var: tarih aralığını daraltmak.
    const huge = await seedTestTenant(admin.db, 'export-huge', [{ sku: 'H-1', name: 'Devasa' }])
    const hugeBoss: Actor = { tenantId: huge.tenantId, userId: huge.adminUserId, role: 'ADMIN' }
    await bulkInsertMovements(huge, small.queuedRowLimit + 1)

    const err = await expectAppError(exportMovements(hugeBoss, {}, small), 'EXPORT_TOO_LARGE')
    expect(err.http).toBe(413)
    expect(err.details.limit).toBe(small.queuedRowLimit)
    expect(err.details.rowCount).toBe(small.queuedRowLimit + 1)
  })

  it('stok raporu için de aynı üç yol geçerli', async () => {
    const many = await seedTestTenant(
      admin.db,
      'export-stock-big',
      Array.from({ length: 8 }, (_, i) => ({ sku: `S-${i}`, name: `Ürün ${i}` })),
    )
    const manyBoss: Actor = { tenantId: many.tenantId, userId: many.adminUserId, role: 'ADMIN' }

    const res = await exportStock(manyBoss, {}, small)
    expect(res.mode).toBe('queued')
    if (res.mode !== 'queued') return
    expect(res.rowCount).toBe(8)

    const mail = createInMemoryTransport()
    await runQueuedJobs(many.tenantId, { STOCK_EXPORT: createExportJobHandler(mail, opts) }, opts)
    expect(mail.sent[0]?.attachments?.[0]?.filename).toMatch(/^stok-.*\.xlsx$/)
  })

  it('varsayılan eşikler plandaki değerler', () => {
    // Testler küçük eşiklerle koşuyor; ürünün gerçekten hangi sayılarla
    // çalıştığı burada sabitleniyor (D-4.2: 20 bin).
    expect(INLINE_ROW_LIMIT).toBe(20_000)
    expect(QUEUED_ROW_LIMIT).toBe(200_000)
  })
})

describe('G4 - başarısız iş admin panelinde görünüyor', () => {
  it('e-posta gidemezse iş bir kez daha deneniyor', async () => {
    const t = await seedTestTenant(admin.db, 'export-retry', [{ sku: 'T-1', name: 'Tekrar' }])
    const tBoss: Actor = { tenantId: t.tenantId, userId: t.adminUserId, role: 'ADMIN' }
    await bulkInsertMovements(t, small.inlineRowLimit + 1)
    const queued = await exportMovements(tBoss, {}, small)
    if (queued.mode !== 'queued') throw new Error('queued bekleniyordu')

    let attempts = 0
    const flaky = {
      async send() {
        attempts++
        if (attempts === 1) throw new AppError('MAIL_DELIVERY_FAILED', 'smtp timeout')
      },
    }
    const handlers = { MOVEMENT_EXPORT: createExportJobHandler(flaky, opts) }

    const first = await runQueuedJobs(t.tenantId, handlers, atTick(0))
    expect(first).toMatchObject({ ran: 1, succeeded: 0, failed: 0, retried: 1 })
    expect((await getJob(tBoss, queued.jobId, opts))?.status).toBe('QUEUED')

    // HEMEN tekrar denenmiyor: bozuk SMTP'ye saniyeler içinde ikinci kez
    // bağlanmak, tek tekrar hakkını hiçbir şey değişmeden harcamak olurdu.
    const tooSoon = await runQueuedJobs(t.tenantId, handlers, atTick(0))
    expect(tooSoon.ran).toBe(0)

    const second = await runQueuedJobs(t.tenantId, handlers, atTick(1))
    expect(second).toMatchObject({ ran: 1, succeeded: 1 })
    expect((await getJob(tBoss, queued.jobId, opts))?.status).toBe('SUCCEEDED')
    expect(attempts).toBe(2)
  })

  it('hak bitince iş FAILED kalıyor ve hata kodu saklanıyor', async () => {
    // Bu, G4'ün kapanış noktası: hata log'da değil, sorgulanabilir bir
    // satırda duruyor.
    const t = await seedTestTenant(admin.db, 'export-fail', [{ sku: 'X-1', name: 'Hata' }])
    const tBoss: Actor = { tenantId: t.tenantId, userId: t.adminUserId, role: 'ADMIN' }
    await bulkInsertMovements(t, small.inlineRowLimit + 1)
    const queued = await exportMovements(tBoss, {}, small)
    if (queued.mode !== 'queued') throw new Error('queued bekleniyordu')

    const broken = {
      async send() {
        throw new AppError('MAIL_DELIVERY_FAILED', 'relay access denied')
      },
    }
    const handlers = { MOVEMENT_EXPORT: createExportJobHandler(broken, opts) }

    await runQueuedJobs(t.tenantId, handlers, atTick(0))
    const after = await runQueuedJobs(t.tenantId, handlers, atTick(1))
    expect(after).toMatchObject({ ran: 1, failed: 1 })

    const job = await getJob(tBoss, queued.jobId, opts)
    expect(job?.status).toBe('FAILED')
    expect(job?.attempts).toBe(2)
    expect(job?.lastErrorCode).toBe('MAIL_DELIVERY_FAILED')
    expect(job?.lastErrorMessage).toContain('relay access denied')
    expect(job?.finishedAt).toBeInstanceOf(Date)
  })

  it('FAILED iş bir daha çalışmıyor (sessiz kurtarma yok)', async () => {
    // "Sessizce tekrar denendi ve sonunda geçti" ile "hiç çalışmadı"
    // arasındaki farkı kaybetmek G4'ü geri getirirdi.
    const t = await seedTestTenant(admin.db, 'export-final', [{ sku: 'Y-1', name: 'Son' }])
    const tBoss: Actor = { tenantId: t.tenantId, userId: t.adminUserId, role: 'ADMIN' }
    await bulkInsertMovements(t, small.inlineRowLimit + 1)
    await exportMovements(tBoss, {}, small)

    const broken = {
      async send() {
        throw new AppError('MAIL_DELIVERY_FAILED', 'kalıcı hata')
      },
    }
    const handlers = { MOVEMENT_EXPORT: createExportJobHandler(broken, opts) }
    await runQueuedJobs(t.tenantId, handlers, atTick(0))
    await runQueuedJobs(t.tenantId, handlers, atTick(1))

    const third = await runQueuedJobs(t.tenantId, handlers, atTick(2))
    expect(third.ran).toBe(0)
  })

  it('admin başarısız işleri listeleyebiliyor, çalışan LİSTELEYEMİYOR', async () => {
    const t = await seedTestTenant(admin.db, 'export-list', [{ sku: 'L-1', name: 'Liste' }])
    const tBoss: Actor = { tenantId: t.tenantId, userId: t.adminUserId, role: 'ADMIN' }
    const tStaff: Actor = { tenantId: t.tenantId, userId: t.staffUserId, role: 'STAFF' }
    await bulkInsertMovements(t, small.inlineRowLimit + 1)
    await exportMovements(tBoss, {}, small)

    const broken = {
      async send() {
        throw new AppError('MAIL_DELIVERY_FAILED', 'kalıcı')
      },
    }
    const handlers = { MOVEMENT_EXPORT: createExportJobHandler(broken, opts) }
    await runQueuedJobs(t.tenantId, handlers, atTick(0))
    await runQueuedJobs(t.tenantId, handlers, atTick(1))

    const failed = await listFailedJobs(tBoss, opts)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.lastErrorCode).toBe('MAIL_DELIVERY_FAILED')

    // İş kayıtları başka kullanıcıların taleplerini ve e-posta
    // adreslerini içeriyor.
    await expectAppError(listJobs(tStaff, {}, opts), 'FORBIDDEN')
  })

  it('işleyicisi olmayan iş sessizce kuyrukta dönmüyor', async () => {
    // Yapılandırma hatası: atlanırsa iş sonsuza kadar QUEUED kalır ve
    // kimse fark etmez.
    const t = await seedTestTenant(admin.db, 'export-nohandler', [{ sku: 'N-1', name: 'Yok' }])
    const tBoss: Actor = { tenantId: t.tenantId, userId: t.adminUserId, role: 'ADMIN' }
    await bulkInsertMovements(t, small.inlineRowLimit + 1)
    await exportMovements(tBoss, {}, small)

    await runQueuedJobs(t.tenantId, {}, atTick(0))
    const after = await runQueuedJobs(t.tenantId, {}, atTick(1))

    expect(after.failed).toBe(1)
    const failed = await listFailedJobs(tBoss, opts)
    expect(failed[0]?.lastErrorMessage).toContain('no handler')
  })

  it('başka tenantın başarısız işi görünmüyor', async () => {
    const failed = await listFailedJobs(boss, opts)
    expect(failed).toEqual([])
  })
})

/**
 * Doğrudan ledger'a toplu hareket yazar, `createMovement` kapısını atlayarak.
 * 20 bin hareketi tek tek servis üzerinden yazmak testi dakikalarca sürdürür
 * ve ölçtüğümüz şey eşiğin davranışı, ledger'ın hızı değil.
 */
async function bulkInsertMovements(t: TestTenant, count: number): Promise<void> {
  const product = Object.values(t.products)[0]!
  await admin.db.execute(sql`
    INSERT INTO stock_movements
      (tenant_id, product_id, user_id, delta, reason, idempotency_key, created_at)
    SELECT ${t.tenantId}::uuid,
           ${product.id}::uuid,
           ${t.adminUserId}::uuid,
           1,
           'PURCHASE',
           gen_random_uuid()::text,
           now() - (g || ' seconds')::interval
      FROM generate_series(1, ${count}) AS g
  `)
}

describe('kuyruk temizliği', () => {
  it('bu dosyanın yazdığı hareketler projeksiyonla tutarlı', async () => {
    // Toplu insert trigger'ı atlamıyor: 20 bin satır da projeksiyona
    // işlemeli, yoksa invariant kırılır.
    const rows = await withTenant(
      tenant.tenantId,
      (tx) => tx.select({ n: sql<string>`count(*)::text` }).from(stockMovements),
      app.db,
    )
    expect(Number(rows[0]?.n)).toBe(2)
  })

  it('iş kayıtları tenant kapsamlı', async () => {
    const rows = await withTenant(
      tenant.tenantId,
      (tx) => tx.select({ id: backgroundJobs.id }).from(backgroundJobs),
      app.db,
    )
    expect(rows).toEqual([])
  })
})
