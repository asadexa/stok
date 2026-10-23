import { randomUUID } from 'node:crypto'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { AppError } from '@stok/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { parseProductFile } from './import'
import {
  type ImportRunProgress,
  appendImportRows,
  beginImportRun,
  cancelImportRun,
  finalizeImportPreview,
  getImportRunProgress,
  importRunReport,
  importRunReportColumns,
  processImportChunk,
  pruneTenantImportRuns,
  startImportRun,
} from './import-runs'
import { checkStockInvariant } from './movements'
import { getProductDetail, updateProduct } from './products'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T171 — TOPLU AKTARIM KAYDI
 *
 * Yükle → önizle → aktar (parça parça) → iptal ya da tamamla → rapor. Gerçek
 * PostgreSQL üzerinde: kira, iptal, sürüm çakışması, kesinti doğrulaması, RLS
 * ve temizlik veritabanı davranışı; sahte bir DB onları kanıtlamazdı.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME, 8)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }
let tenant: TestTenant
let other: TestTenant
let boss: Actor
let otherBoss: Actor
let staff: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'imprun', [
    { sku: 'VAR-1', name: 'Var Olan Bir', purchasePrice: '5.00' },
    { sku: 'VAR-2', name: 'Var Olan İki', purchasePrice: '6.00' },
    { sku: 'VAR-3', name: 'Var Olan Üç', purchasePrice: '7.00' },
  ])
  other = await seedTestTenant(admin.db, 'imprun-b', [{ sku: 'B-1', name: 'Başka İşletme' }])
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  otherBoss = { tenantId: other.tenantId, userId: other.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

let seq = 0
const uniq = (prefix: string) => `${prefix}${++seq}-${randomUUID().slice(0, 6)}`

const HEADER = 'Stok Kodu;Ürün Adı;Birim;Alış Fiyatı;Barkod;Açılış Stoğu'
const newRow = (opening = '') => `${uniq('YN-')};Yeni Ürün;Adet;3,50;${uniq('bc')};${opening}`
const csv = (lines: string[]) => new Uint8Array(Buffer.from(lines.join('\n'), 'utf8'))

/** Tarayıcının yaptığını yapar: dosyayı ayrıştırır, satırları parça parça gönderir, önizler. */
async function upload(lines: string[], { chunk = 1_000, actor = boss } = {}) {
  const file = await parseProductFile(csv(lines), 'aktarim.csv')
  const { runId } = await startImportRun(
    actor,
    {
      fileName: 'aktarim.csv',
      fileBytes: 1_234,
      totalRows: file.rows.length,
      columns: file.columns,
      ignoredQtyColumns: file.ignoredQtyColumns ?? [],
    },
    opts,
  )
  for (let i = 0; i < file.rows.length; i += chunk) {
    await appendImportRows(actor, runId, { rows: file.rows.slice(i, i + chunk) }, opts)
  }
  const preview = await finalizeImportPreview(actor, runId, opts)
  return { runId, preview }
}

/** Tarayıcının aktarım döngüsü: aktarım kapanana kadar parça iste. */
async function runToEnd(runId: string, chunk: { maxRows?: number } = {}) {
  await beginImportRun(boss, runId, opts)
  for (let i = 0; i < 1_000; i += 1) {
    const progress = await processImportChunk(boss, runId, { ...opts, ...chunk })
    if (progress.status !== 'RUNNING') return progress
  }
  throw new Error('aktarım kapanmadı')
}

async function rowStatuses(runId: string): Promise<string[]> {
  const rows = await admin.client<{ status: string }[]>`
    SELECT status FROM import_run_rows WHERE run_id = ${runId} ORDER BY row_number
  `
  return rows.map((r) => r.status)
}

async function setRow(runId: string, rowNumber: number, status: string, claimedAgo: string) {
  await admin.client`
    UPDATE import_run_rows
       SET status = ${status}, claimed_at = now() - ${claimedAgo}::interval, claim_token = ${randomUUID()}
     WHERE run_id = ${runId} AND row_number = ${rowNumber}
  `
}

async function counts(tenantId: string) {
  const [row] = await admin.client<{ products: number; movements: number; barcodes: number }[]>`
    SELECT (SELECT count(*)::int FROM products WHERE tenant_id = ${tenantId}) AS products,
           (SELECT count(*)::int FROM stock_movements WHERE tenant_id = ${tenantId}) AS movements,
           (SELECT count(*)::int FROM product_barcodes WHERE tenant_id = ${tenantId}) AS barcodes
  `
  return row!
}

async function openingCount(sku: string): Promise<number> {
  const [row] = await admin.client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_movements m JOIN products p ON p.id = m.product_id
     WHERE m.tenant_id = ${tenant.tenantId} AND p.sku = ${sku} AND m.reason = 'OPENING'
  `
  return row!.n
}

async function waitFor(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`beklenen durum oluşmadı: ${what}`)
}

/**
 * İşleyiciyi 3. veri satırının ORTASINDA bekletir: o satırın ürünü kilitli,
 * işleyici satırı almış ve ürün güncellemesinde bekliyor. `during` bu arada
 * çalışıyor; kilit bırakılınca işleyicinin döndürdüğü ilerleme veriliyor.
 * Süreye değil kilide dayanıyor: makine hızı sonucu değiştirmiyor (T109).
 */
async function whileRowBlocked(
  runId: string,
  productId: string,
  during: () => Promise<void>,
): Promise<ImportRunProgress> {
  let chunk: Promise<ImportRunProgress> | undefined
  await admin.client.begin(async (tx) => {
    await tx`SELECT 1 FROM products WHERE id = ${productId} FOR UPDATE`
    chunk = processImportChunk(boss, runId, { ...opts, budgetMs: 60_000 })
    await waitFor(async () => (await rowStatuses(runId))[2] === 'IN_PROGRESS', '3. veri satırı işleniyor')
    await during()
  })
  return chunk!
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (err: unknown) => (err instanceof AppError ? err.code : String(err)),
  )

describe('yükleme ve önizleme', () => {
  it('önizleme ürün, barkod ve stok verisini DEĞİŞTİRMİYOR; kararlar kayda yazılıyor', async () => {
    const before = await counts(tenant.tenantId)
    const { preview } = await upload([HEADER, newRow('10'), 'VAR-1;Var Olan Bir;;5;;', `;Adsız;Adet;1;${uniq('bc')};`])

    expect(preview.counts).toEqual({ create: 1, update: 1, error: 1 })
    expect(preview.openings).toBe(1)
    expect(preview.errors).toHaveLength(1)
    expect(preview.errors[0]!.rowNumber).toBe(4)
    expect(await counts(tenant.tenantId)).toEqual(before)
  })

  it('parçalara bölünmüş dosyada da mükerrer stok kodu yakalanıyor (önizleme bütün dosyada)', async () => {
    const sku = uniq('MK-')
    const { runId, preview } = await upload(
      [HEADER, `${sku};Bir;Adet;1;${uniq('bc')};`, newRow(), `${sku};İki;Adet;1;${uniq('bc')};`],
      { chunk: 1 },
    )

    expect(preview.counts).toEqual({ create: 2, update: 0, error: 1 })
    expect(await rowStatuses(runId)).toEqual(['PENDING', 'PENDING', 'INVALID'])
  })

  it('beyan edilenden fazla satır, aynı satırın tekrarı, eksik satırla önizleme reddediliyor', async () => {
    const file = await parseProductFile(csv([HEADER, newRow(), newRow()]), 'a.csv')
    const meta = { fileName: 'a.csv', fileBytes: 10, totalRows: 2, columns: file.columns }
    const [r1, r2] = file.rows as [(typeof file.rows)[0], (typeof file.rows)[0]]

    const tooMany = await startImportRun(boss, meta, opts)
    expect(await code(appendImportRows(boss, tooMany.runId, { rows: [r1, r2, { ...r2, rowNumber: 9 }] }, opts))).toBe(
      'IMPORT_RUN_STATE',
    )

    const dup = await startImportRun(boss, meta, opts)
    await appendImportRows(boss, dup.runId, { rows: [r1] }, opts)
    expect(await code(appendImportRows(boss, dup.runId, { rows: [r1] }, opts))).toBe('IMPORT_RUN_STATE')

    // Eksik satırla önizleme yok; tamamlanınca önizleme, sonra ekleme yok.
    expect(await code(finalizeImportPreview(boss, dup.runId, opts))).toBe('IMPORT_RUN_STATE')
    await appendImportRows(boss, dup.runId, { rows: [r2] }, opts)
    await finalizeImportPreview(boss, dup.runId, opts)
    expect(await code(appendImportRows(boss, dup.runId, { rows: [{ ...r2, rowNumber: 9 }] }, opts))).toBe(
      'IMPORT_RUN_STATE',
    )
  })

  it('tanınmayan hücre alanı ve sınırsız hücre şemada reddediliyor', async () => {
    const { runId } = await startImportRun(
      boss,
      { fileName: 'a.csv', fileBytes: 1, totalRows: 1, columns: ['sku', 'name'] },
      opts,
    )
    const bad = [
      { rowNumber: 2, cells: { sku: 'X', name: 'Y', salary: '1' } },
      { rowNumber: 2, cells: { sku: 'X', name: 'Y'.repeat(5_000) } },
    ]
    for (const row of bad) {
      expect(await code(appendImportRows(boss, runId, { rows: [row] }, opts))).toBe('VALIDATION_FAILED')
    }
  })

  it('başlık satırında Stok Kodu ya da Ürün Adı yoksa kayıt açılmıyor', async () => {
    expect(
      await code(startImportRun(boss, { fileName: 'a.csv', fileBytes: 1, totalRows: 1, columns: ['sku'] }, opts)),
    ).toBe('VALIDATION_FAILED')
  })
})

describe('aktarım', () => {
  it('karışık dosya: yeni, güncelleme, hatalı, devir; sayılar satır durumlarından', async () => {
    const created = uniq('YN-')
    const { runId } = await upload([
      HEADER,
      `${created};Yeni Kalem;Adet;3,50;${uniq('bc')};12`,
      'VAR-2;Var Olan İki (yeni ad);;6;;',
      `;Adsız;Adet;1;${uniq('bc')};`,
    ])

    const done = await runToEnd(runId)

    expect(done).toMatchObject({
      status: 'DONE',
      totalRows: 3,
      toProcess: 2,
      processed: 2,
      rows: { created: 1, updated: 1, invalid: 1, failed: 0, conflict: 0, uncertain: 0, pending: 0 },
      openings: { written: 1, skipped: 0, failed: 0 },
    })
    expect(await openingCount(created)).toBe(1)
    const p2 = await getProductDetail(boss, tenant.products['VAR-2']!.id, opts)
    expect(p2.name).toBe('Var Olan İki (yeni ad)')

    // Rapor yalnız kullanıcının düzeltmesi gereken satırı içeriyor (sorun başına bir satır).
    const report = await importRunReport(boss, runId, opts)
    expect([...new Set(report.map((r) => `${r.rowNumber} ${r.status}`))]).toEqual(['4 Hatalı'])
    expect(await checkStockInvariant(tenant.tenantId, opts)).toEqual([])
  })

  it('aktarım parça parça ilerliyor; ilerleme her parçada artıyor', async () => {
    const { runId } = await upload([HEADER, newRow(), newRow(), newRow(), newRow(), newRow()])
    await beginImportRun(boss, runId, opts)

    const seen: number[] = []
    for (;;) {
      const p = await processImportChunk(boss, runId, { ...opts, maxRows: 2 })
      seen.push(p.processed)
      if (p.status !== 'RUNNING') break
    }
    expect(seen).toEqual([2, 4, 5])
  })

  it('aynı dosya ikinci kez: ürünler güncelleniyor, açılış stoğu İKİNCİ KEZ YAZILMIYOR', async () => {
    const sku = uniq('TK-')
    const lines = [HEADER, `${sku};Tekrar;Adet;2;${uniq('bc')};7`]

    await runToEnd((await upload(lines)).runId)
    const before = await counts(tenant.tenantId)
    const second = await runToEnd((await upload(lines)).runId)

    expect(second.rows.updated).toBe(1)
    expect(second.openings).toEqual({ written: 0, skipped: 1, failed: 0 })
    expect(await openingCount(sku)).toBe(1)
    expect((await counts(tenant.tenantId)).movements).toBe(before.movements)
    expect(await checkStockInvariant(tenant.tenantId, opts)).toEqual([])
  })

  it('rapor her sorun için ayrı satır üretiyor; dosya sütunları sabit', async () => {
    const { runId } = await upload([HEADER, `${uniq('RAP-')};Ürün;kutu;bedava;${uniq('bc')};`])
    await runToEnd(runId)

    const report = await importRunReport(boss, runId, opts)
    expect(report.map((r) => [r.rowNumber, r.column]).sort()).toEqual([
      [2, 'Alış Fiyatı'],
      [2, 'Birim'],
    ])
    expect(importRunReportColumns().map((c) => c.header)).toEqual([
      'Satır',
      'Stok Kodu',
      'Ürün Adı',
      'Durum',
      'Sütun',
      'Açıklama',
    ])
  })

  it('onaysız parça işlenmiyor; tekrar onay zararsız; bitmiş aktarım yeniden başlamıyor', async () => {
    const { runId } = await upload([HEADER, newRow()])

    expect(await code(processImportChunk(boss, runId, opts))).toBe('IMPORT_RUN_STATE')
    await beginImportRun(boss, runId, opts)
    // İlk onayın yanıtı kaybolduysa kullanıcı yeniden basıyor: hata değil.
    expect((await beginImportRun(boss, runId, opts)).status).toBe('RUNNING')
    const done = await processImportChunk(boss, runId, opts)
    expect(done.status).toBe('DONE')
    expect(await code(beginImportRun(boss, runId, opts))).toBe('IMPORT_RUN_STATE')
    expect((await processImportChunk(boss, runId, opts)).status).toBe('DONE')
  })
})

describe('çakışma (K3)', () => {
  it('önizlemeden sonra başkası ürünü değiştirdiyse dosyadaki değer EZMİYOR', async () => {
    const id = tenant.products['VAR-3']!.id
    const { runId } = await upload([HEADER, 'VAR-3;Dosyadaki Ad;;7;;'])

    await updateProduct(boss, id, { name: 'Başkasının Değişikliği' }, opts)
    const done = await runToEnd(runId)

    expect(done.rows).toMatchObject({ conflict: 1, updated: 0 })
    expect((await getProductDetail(boss, id, opts)).name).toBe('Başkasının Değişikliği')
    const [line] = await importRunReport(boss, runId, opts)
    expect(line).toMatchObject({ status: 'Çakışma', message: expect.stringContaining('önizlemeden sonra') })
  })

  it('önizlemede "yeni" olan stok kodu arada açıldıysa güncellemeye DÖNÜŞMÜYOR', async () => {
    const sku = uniq('YK-')
    const { runId } = await upload([HEADER, `${sku};Dosyadaki;Adet;3;${uniq('bc')};`])

    // Aynı kodu başka bir aktarım (ya da kullanıcı) önizlemeden sonra ekliyor.
    await runToEnd((await upload([HEADER, `${sku};Önce Gelen;Adet;3;${uniq('bc')};`])).runId)
    const done = await runToEnd(runId)

    expect(done.rows).toMatchObject({ conflict: 1, created: 0, updated: 0 })
    const [product] = await admin.client<{ name: string }[]>`
      SELECT name FROM products WHERE tenant_id = ${tenant.tenantId} AND sku = ${sku}
    `
    expect(product!.name).toBe('Önce Gelen')
  })
})

describe('iptal', () => {
  it('işleyici çalışırken iptal: başlamış satır tamamlanıyor, yeni satır başlamıyor, yapılanlar kalıyor', async () => {
    const id = tenant.products['VAR-1']!.id
    const { runId } = await upload([HEADER, newRow(), newRow(), 'VAR-1;Var Olan Bir;;5;;', newRow(), newRow()])
    await beginImportRun(boss, runId, opts)

    const closed = await whileRowBlocked(runId, id, async () => {
      // Kira dolu: ikinci işleyici başlamıyor, iptal kilit beklemeden dönüyor.
      expect(await code(processImportChunk(boss, runId, opts))).toBe('IMPORT_RUN_BUSY')
      const asked = await cancelImportRun(boss, runId, opts)
      expect(asked).toMatchObject({ status: 'RUNNING', cancelRequested: true })
    })

    expect(closed.status).toBe('CANCELLED')
    expect(await rowStatuses(runId)).toEqual(['DONE', 'DONE', 'DONE', 'PENDING', 'PENDING'])

    const report = await importRunReport(boss, runId, opts)
    expect(report.map((r) => [r.rowNumber, r.message])).toEqual([
      [5, 'İptal edildiği için işlenmedi'],
      [6, 'İptal edildiği için işlenmedi'],
    ])
    // İptal edilmiş aktarım yeniden başlamıyor.
    expect((await processImportChunk(boss, runId, opts)).status).toBe('CANCELLED')
    expect(await rowStatuses(runId)).toEqual(['DONE', 'DONE', 'DONE', 'PENDING', 'PENDING'])
  })

  it('parçalar arasında iptal: aktarım hemen kapanıyor, sıradaki parça satır işlemiyor', async () => {
    const { runId } = await upload([HEADER, newRow(), newRow(), newRow()])
    await beginImportRun(boss, runId, opts)
    await processImportChunk(boss, runId, { ...opts, maxRows: 1 })

    expect((await cancelImportRun(boss, runId, opts)).status).toBe('CANCELLED')
    const after = await processImportChunk(boss, runId, opts)
    expect(after).toMatchObject({ status: 'CANCELLED', processed: 1 })
  })

  it('önizlemede iptal: hiçbir şey yazılmıyor', async () => {
    const before = await counts(tenant.tenantId)
    const { runId } = await upload([HEADER, newRow('3')])

    expect((await cancelImportRun(boss, runId, opts)).status).toBe('CANCELLED')
    expect(await code(beginImportRun(boss, runId, opts))).toBe('IMPORT_RUN_STATE')
    expect(await counts(tenant.tenantId)).toEqual(before)
  })
})

describe('kesinti doğrulaması (güvence 5)', () => {
  it('yarım kalmış "yeni" satır: ürün yoksa yeniden deneniyor', async () => {
    const { runId } = await upload([HEADER, newRow('4'), newRow()])
    await beginImportRun(boss, runId, opts)
    await setRow(runId, 2, 'IN_PROGRESS', '10 minutes')

    const done = await processImportChunk(boss, runId, opts)
    expect(done).toMatchObject({ status: 'DONE', rows: { created: 2, uncertain: 0 } })
  })

  it('yarım kalmış "yeni" satır: ürün varsa BELİRSİZ, gerçek durum mesajda', async () => {
    const sku = uniq('BL-')
    const { runId } = await upload([HEADER, `${sku};Belirsiz;Adet;3;${uniq('bc')};5`])
    await beginImportRun(boss, runId, opts)
    // İşleyici ürünü ve devri yazmış, sonucu yazamadan düşmüş gibi.
    await processImportChunk(boss, runId, opts)
    await setRow(runId, 2, 'IN_PROGRESS', '10 minutes')
    await admin.client`UPDATE import_runs SET status = 'RUNNING', finished_at = NULL WHERE id = ${runId}`

    const done = await processImportChunk(boss, runId, opts)

    expect(done).toMatchObject({ status: 'DONE', rows: { uncertain: 1, created: 0 } })
    const [line] = await importRunReport(boss, runId, opts)
    expect(line).toMatchObject({ status: 'Belirsiz', message: expect.stringContaining('Açılış stoğu kayıtlı') })
    expect(await openingCount(sku)).toBe(1)
  })

  it('yarım kalmış güncelleme: sürüm değişmediyse yeniden deneniyor', async () => {
    const { runId } = await upload([HEADER, 'VAR-1;Var Olan Bir (kesinti);;5;;'])
    await beginImportRun(boss, runId, opts)
    await setRow(runId, 2, 'IN_PROGRESS', '10 minutes')

    const done = await processImportChunk(boss, runId, opts)
    expect(done).toMatchObject({ status: 'DONE', rows: { updated: 1, uncertain: 0 } })
  })

  it('henüz eskimemiş IN_PROGRESS satır: aktarım "bitti" demiyor, eskiyince çözülüyor', async () => {
    const { runId } = await upload([HEADER, newRow(), newRow()])
    await beginImportRun(boss, runId, opts)
    await setRow(runId, 3, 'IN_PROGRESS', '1 second')

    const waiting = await processImportChunk(boss, runId, opts)
    expect(waiting).toMatchObject({ status: 'RUNNING', processed: 1 })

    await setRow(runId, 3, 'IN_PROGRESS', '10 minutes')
    const done = await processImportChunk(boss, runId, opts)
    expect(done).toMatchObject({ status: 'DONE', processed: 2, rows: { created: 2 } })
  })

})

describe('kira ve satır sahipliği (T5)', () => {
  it('kirası elinden alınan işleyici o satırdan sonra DURUYOR ve yeni sahibin kirasını silmiyor', async () => {
    const id = tenant.products['VAR-2']!.id
    const { runId } = await upload([HEADER, newRow(), newRow(), 'VAR-2;Var Olan İki;;6;;', newRow(), newRow()])
    await beginImportRun(boss, runId, opts)
    const newOwner = randomUUID()

    const stopped = await whileRowBlocked(runId, id, async () => {
      // İşleyici takılıyken kirası bitti ve başka biri aldı.
      await admin.client`
        UPDATE import_runs SET lease_token = ${newOwner}, lease_until = now() + interval '30 seconds' WHERE id = ${runId}
      `
    })

    expect(stopped.status).toBe('RUNNING')
    expect(await rowStatuses(runId)).toEqual(['DONE', 'DONE', 'DONE', 'PENDING', 'PENDING'])
    const [run] = await admin.client<{ lease_token: string }[]>`SELECT lease_token FROM import_runs WHERE id = ${runId}`
    expect(run!.lease_token).toBe(newOwner)
  })

  it('satırı başka işleyiciye geçmiş işleyicinin geç sonucu YAZILMIYOR', async () => {
    const id = tenant.products['VAR-2']!.id
    const { runId } = await upload([HEADER, newRow(), newRow(), 'VAR-2;Var Olan İki;;6;;', newRow()])
    await beginImportRun(boss, runId, opts)
    const newOwner = randomUUID()

    const progress = await whileRowBlocked(runId, id, async () => {
      // Kesinti doğrulaması satırı başka bir işleyiciye vermiş gibi.
      await admin.client`UPDATE import_run_rows SET claim_token = ${newOwner} WHERE run_id = ${runId} AND row_number = 4`
    })

    const [row] = await admin.client<{ status: string; claim_token: string }[]>`
      SELECT status, claim_token FROM import_run_rows WHERE run_id = ${runId} AND row_number = 4
    `
    expect(row).toEqual({ status: 'IN_PROGRESS', claim_token: newOwner })
    // Diğer satırlar işlendi; sahibi başkası olan satır bitmeden aktarım "bitti" demiyor.
    expect(progress).toMatchObject({ status: 'RUNNING', processed: 3 })
  })
})

describe('yetki ve kiracı izolasyonu', () => {
  it('çalışan toplu aktarım yapamıyor', async () => {
    const { runId } = await upload([HEADER, newRow()])
    expect(
      await code(startImportRun(staff, { fileName: 'a.csv', fileBytes: 1, totalRows: 1, columns: ['sku', 'name'] }, opts)),
    ).toBe('FORBIDDEN')
    expect(await code(getImportRunProgress(staff, runId, opts))).toBe('FORBIDDEN')
    expect(await code(importRunReport(staff, runId, opts))).toBe('FORBIDDEN')
  })

  it('başka işletmenin aktarımı görünmüyor, ilerletilemiyor, iptal edilemiyor', async () => {
    const { runId } = await upload([HEADER, newRow()])
    await beginImportRun(boss, runId, opts)

    for (const call of [
      () => getImportRunProgress(otherBoss, runId, opts),
      () => processImportChunk(otherBoss, runId, opts),
      () => cancelImportRun(otherBoss, runId, opts),
      () => beginImportRun(otherBoss, runId, opts),
      () => importRunReport(otherBoss, runId, opts),
      () => appendImportRows(otherBoss, runId, { rows: [{ rowNumber: 3, cells: { sku: 'X', name: 'Y' } }] }, opts),
    ]) {
      expect(await code(call())).toBe('NOT_FOUND')
    }
    expect((await getImportRunProgress(boss, runId, opts)).status).toBe('RUNNING')
  })

  it('bozuk aktarım kimliği NOT_FOUND', async () => {
    expect(await code(getImportRunProgress(boss, 'abc', opts))).toBe('NOT_FOUND')
  })
})

describe('temizlik (K4)', () => {
  it('yalnız süresi dolmuş aktarım kayıtları siliniyor; ürün, barkod ve hareketler yerinde', async () => {
    const old = await upload([HEADER, newRow('2')])
    await runToEnd(old.runId)
    const abandoned = await startImportRun(
      boss,
      { fileName: 'yarim.csv', fileBytes: 1, totalRows: 5, columns: ['sku', 'name'] },
      opts,
    )
    const recentUpload = await startImportRun(
      boss,
      { fileName: 'yeni.csv', fileBytes: 1, totalRows: 5, columns: ['sku', 'name'] },
      opts,
    )
    const oldPreview = await upload([HEADER, newRow()])
    const otherOld = await upload([HEADER, `${uniq('B-')};Başka;Adet;1;${uniq('bc')};`], { actor: otherBoss })

    await admin.client`UPDATE import_runs SET created_at = now() - interval '31 days' WHERE id IN (${old.runId}, ${otherOld.runId})`
    await admin.client`UPDATE import_runs SET created_at = now() - interval '25 hours' WHERE id IN (${abandoned.runId}, ${oldPreview.runId})`
    const before = await counts(tenant.tenantId)

    expect(await pruneTenantImportRuns(tenant.tenantId, opts)).toBe(2)

    const left = await admin.client<{ id: string }[]>`
      SELECT id FROM import_runs WHERE id IN (${old.runId}, ${abandoned.runId}, ${recentUpload.runId}, ${oldPreview.runId}, ${otherOld.runId})
    `
    expect(left.map((r) => r.id).sort()).toEqual([recentUpload.runId, oldPreview.runId, otherOld.runId].sort())
    const [orphans] = await admin.client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM import_run_rows WHERE run_id = ${old.runId}
    `
    expect(orphans!.n).toBe(0)
    expect(await counts(tenant.tenantId)).toEqual(before)
  })

  it('yeni aktarım açılırken eski kayıtlar da temizleniyor (cron kapalıyken)', async () => {
    const old = await upload([HEADER, newRow()])
    await admin.client`UPDATE import_runs SET created_at = now() - interval '31 days' WHERE id = ${old.runId}`

    await startImportRun(boss, { fileName: 'a.csv', fileBytes: 1, totalRows: 1, columns: ['sku', 'name'] }, opts)

    const [row] = await admin.client<{ n: number }[]>`SELECT count(*)::int AS n FROM import_runs WHERE id = ${old.runId}`
    expect(row!.n).toBe(0)
  })
})
