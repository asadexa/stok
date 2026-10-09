import { randomUUID } from 'node:crypto'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import { commitImport, openingKey, parseProductFile, previewImport } from './import'
import { checkStockInvariant, createMovement } from './movements'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T128 — İÇE AKTARMADA AÇILIŞ STOĞU
 *
 * Devir doğrudan yazılmıyor: her satır `createMovement` üzerinden OPENING
 * hareketi. Tekrar çalıştırma ikinci devri yazmıyor; hareketi olan ürünün
 * devri atlanıyor ama ürün bilgisi güncelleniyor. "Miktar" gibi belirsiz
 * başlıklar devir SAYILMIYOR ve bu söyleniyor.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME, 8)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }
let tenant: TestTenant
let boss: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'openimp', [
    { sku: 'VAR-HAREKETLI', name: 'Hareketi Olan Ürün', purchasePrice: '7.00' },
    { sku: 'VAR-HAREKETSIZ', name: 'Hareketsiz Ürün', purchasePrice: '4.00' },
  ])
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  await createMovement(
    boss,
    {
      idempotencyKey: randomUUID(),
      barcode: tenant.products['VAR-HAREKETLI']!.barcode,
      qty: 2,
      reason: 'PURCHASE',
      clientCreatedAt: new Date().toISOString(),
    },
    opts,
  )
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

let seq = 0
const uniq = (prefix: string) => `${prefix}${++seq}-${randomUUID().slice(0, 6)}`

const HEADER = 'Stok Kodu;Ürün Adı;Birim;Alış Fiyatı;Barkod;Barkod Türü;Koli İçi Adet;Açılış Stoğu'
/** Fiyat sütunu YOK: devir üründe kayıtlı alış fiyatıyla yazılır. Sütun olup hücre boş olsaydı fiyat temizlenirdi. */
const HEADER_NO_PRICE = 'Stok Kodu;Ürün Adı;Açılış Stoğu'

async function plan(lines: string[]) {
  const file = await parseProductFile(Buffer.from(lines.join('\n'), 'utf8'), 'devir.csv', opts)
  return previewImport(boss, file, opts)
}

async function movementsOf(productSku: string) {
  return admin.client<{ reason: string; delta: string; unit_price: string | null; note: string | null; idempotency_key: string; product_id: string }[]>`
    SELECT m.reason, m.delta::text, m.unit_price::text, m.note, m.idempotency_key, m.product_id
      FROM stock_movements m JOIN products p ON p.id = m.product_id
     WHERE m.tenant_id = ${tenant.tenantId} AND p.sku = ${productSku}
  `
}

async function movementCount(): Promise<number> {
  const [row] = await admin.client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_movements WHERE tenant_id = ${tenant.tenantId}
  `
  return row!.n
}

const issuesOf = (row: { issues: { column: string; message: string }[] }) =>
  row.issues.map((i) => `${i.column}: ${i.message}`)

describe('önizleme', () => {
  it('Açılış Stoğu sütunu okunuyor; fiyat Alış Fiyatı, barkod tekli barkod', async () => {
    const sku = uniq('DV-')
    const p = await plan([HEADER, `${sku};Kalem;Adet;3,50;${uniq('bc')};Tekli;1;120`])
    const row = p.rows[0]!

    expect(row.action).toBe('create')
    expect(row.opening).toMatchObject({ qty: 120, unit: 'ADET', unitPrice: 3.5 })
  })

  it('"Miktar" başlığı devir sayılmıyor ve bu SÖYLENİYOR', async () => {
    const p = await plan([
      'Stok Kodu;Ürün Adı;Alış Fiyatı;Barkod;Miktar',
      `${uniq('MK-')};Defter;5;${uniq('bc')};40`,
    ])

    expect(p.rows[0]!.opening).toBeUndefined()
    expect(p.notices).toEqual([
      '"Miktar" sütunu açılış stoğu olarak okunmadı. Açılış stoğu girmek için sütunun adı "Açılış Stoğu" olmalı.',
    ])
  })

  it('devirsiz satırda tekli barkod şartı YOK: koli barkodlu yeni ürün ve barkodsuz güncelleme hatasız', async () => {
    const p = await plan([
      HEADER,
      `${uniq('KL-')};Koli Ürün;Adet;30;${uniq('bc')};Koli;12;`,
      'VAR-HAREKETSIZ;Hareketsiz Ürün (yeni ad);;;;;;',
    ])

    expect(p.rows.map((r) => r.action)).toEqual(['create', 'update'])
  })

  it.each([
    ['adetli üründe kesirli devir', 'Adet;3;{bc};Tekli;1;0,5', 'Açılış Stoğu: Bu ürün adetle sayılıyor; açılış stoğu tam sayı olmalı'],
    ['negatif devir', 'Adet;3;{bc};Tekli;1;-4', 'Açılış Stoğu: Açılış stoğu sıfırdan büyük olmalı'],
    ['üç ondalıktan fazla', 'Kilogram;3;{bc};Tekli;1;1,2345', 'Açılış Stoğu: En fazla 3 ondalık basamak'],
    ['sayı değil', 'Adet;3;{bc};Tekli;1;çok', 'Açılış Stoğu: Açılış stoğu sayı olarak okunamadı'],
    ['fiyatsız devir', 'Adet;;{bc};Tekli;1;10', 'Açılış Stoğu: Açılış stoğu için alış fiyatı gerekli (Alış Fiyatı sütunu ya da üründe kayıtlı)'],
    ['koli barkodlu yeni ürüne devir', 'Adet;3;{bc};Koli;12;10', 'Açılış Stoğu: Açılış stoğu için tekli barkod gerekli; bu satırdaki barkod koli barkodu'],
  ])('satır hatası: %s', async (_ad, rest, expected) => {
    const p = await plan([HEADER, `${uniq('ER-')};Ürün;${rest.replace('{bc}', uniq('bc'))}`])
    const row = p.rows[0]!

    expect(row.action).toBe('error')
    expect(issuesOf(row)).toContain(expected)
  })

  it('Alış Fiyatı sütunu var ama hücre boşsa fiyat TEMİZLENİYOR, devir fiyatsız kalıp reddediliyor', async () => {
    const p = await plan([HEADER, 'VAR-HAREKETSIZ;Hareketsiz Ürün;;;;;;5'])
    expect(issuesOf(p.rows[0]!)).toContain(
      'Açılış Stoğu: Açılış stoğu için alış fiyatı gerekli (Alış Fiyatı sütunu ya da üründe kayıtlı)',
    )
  })

  it('kilogramda 2,5 devir kabul', async () => {
    const p = await plan([HEADER, `${uniq('KG-')};Çivi;Kilogram;80;${uniq('bc')};Tekli;1;2,5`])
    expect(p.rows[0]!.opening).toMatchObject({ qty: 2.5, unit: 'KG' })
  })

  it('mevcut adetli ürüne 2,5 çarpanlı koli barkodu önizlemede reddediliyor', async () => {
    const p = await plan([HEADER, `VAR-HAREKETSIZ;Hareketsiz Ürün;;;${uniq('bc')};Koli;2,5;`])
    expect(issuesOf(p.rows[0]!)).toContain(
      'Koli İçi Adet: Adetle sayılan üründe koli içi adet tam sayı olmalı',
    )
  })

  it('hareketi olan ürünün devri "atlanacak" uyarısı alıyor ama satır hata değil', async () => {
    const p = await plan([HEADER_NO_PRICE, 'VAR-HAREKETLI;Hareketi Olan Ürün;5'])
    const row = p.rows[0]!
    expect(issuesOf(row)).toEqual([])

    expect(row.action).toBe('update')
    expect(row.warnings).toEqual(['Devir atlanacak: üründe hareket var; ürün bilgisi güncellenecek'])
  })

  it('önizleme hiçbir şey yazmıyor', async () => {
    const before = await movementCount()
    await plan([HEADER, `${uniq('NW-')};Kalem;Adet;3;${uniq('bc')};Tekli;1;50`])
    expect(await movementCount()).toBe(before)
  })
})

describe('uygulama', () => {
  it('yeni ürünlere devir createMovement yoluyla OPENING olarak yazılıyor', async () => {
    const a = uniq('YA-')
    const b = uniq('YB-')
    const p = await plan([
      HEADER,
      `${a};Kalem;Adet;3,50;${uniq('bc')};Tekli;1;120`,
      `${b};Kablo;Metre;12;${uniq('bc')};Tekli;1;7,25`,
    ])
    const result = await commitImport(boss, p, opts)

    expect(result.created).toBe(2)
    expect(result.openings).toEqual({ written: 2, skipped: 0, failed: 0 })
    const [ma] = await movementsOf(a)
    expect(ma).toMatchObject({
      reason: 'OPENING',
      delta: '120.000',
      unit_price: '3.50',
      note: 'Toplu içe aktarma: açılış stoğu',
    })
    expect(ma!.idempotency_key).toBe(openingKey(tenant.tenantId, ma!.product_id))
    expect((await movementsOf(b))[0]).toMatchObject({ reason: 'OPENING', delta: '7.250' })
    expect(await checkStockInvariant(tenant.tenantId, opts)).toEqual([])
  })

  it('aynı dosya ikinci kez: yeni hareket yok, "daha önce yazılmış" notu', async () => {
    const sku = uniq('TK-')
    const lines = [HEADER, `${sku};Silgi;Adet;2;${uniq('bc')};Tekli;1;30`]
    await commitImport(boss, await plan(lines), opts)
    const before = await movementCount()

    // Dosyadaki değer değişmiş olsa da ikinci devir yazılmıyor (append-only).
    const second = await commitImport(boss, await plan([lines[0]!, lines[1]!.replace(/;30$/, ';45')]), opts)

    expect(await movementCount()).toBe(before)
    expect(second.updated).toBe(1)
    expect(second.openings).toEqual({ written: 0, skipped: 1, failed: 0 })
    expect(second.notices.map((n) => n.message)).toEqual([
      'Ürün güncellendi, devir daha önce yazılmış (30 adet); dosyadaki değer yazılmadı',
    ])
  })

  it('hareketi olan üründe ürün güncelleniyor, devir yazılmıyor, not düşülüyor', async () => {
    const before = await movementsOf('VAR-HAREKETLI')
    const result = await commitImport(
      boss,
      await plan([HEADER_NO_PRICE, 'VAR-HAREKETLI;Hareketi Olan Ürün (yeni ad);5']),
      opts,
    )

    expect(result.updated).toBe(1)
    expect(result.openings).toEqual({ written: 0, skipped: 1, failed: 0 })
    expect(result.notices.map((n) => n.message)).toEqual([
      'Ürün güncellendi, devir atlandı: üründe hareket var',
    ])
    expect(await movementsOf('VAR-HAREKETLI')).toEqual(before)
    const [name] = await admin.client<{ name: string }[]>`
      SELECT name FROM products WHERE tenant_id = ${tenant.tenantId} AND sku = 'VAR-HAREKETLI'
    `
    expect(name!.name).toBe('Hareketi Olan Ürün (yeni ad)')
  })

  it('mevcut hareketsiz üründe kayıtlı tekli barkod ve kayıtlı alış fiyatıyla devir yazılıyor', async () => {
    const result = await commitImport(boss, await plan([HEADER_NO_PRICE, 'VAR-HAREKETSIZ;Hareketsiz Ürün;9']), opts)

    expect(result.openings.written).toBe(1)
    expect((await movementsOf('VAR-HAREKETSIZ'))[0]).toMatchObject({
      reason: 'OPENING',
      delta: '9.000',
      unit_price: '4.00',
    })
  })

  /**
   * Satırdaki barkod BAŞKA ürüne aitse barkod eklenemiyor ve satır hata oluyor.
   * Devir o durumda denenmemeli: denenseydi barkod öteki ürüne çözülür ve
   * devir yanlış ürüne yazılırdı.
   */
  it('ürün işi başarısızsa devir denenmiyor (barkod başka ürüne ait)', async () => {
    const owner = uniq('SAHIP-')
    const other = uniq('DIGER-')
    const sharedBarcode = uniq('ortak')
    await commitImport(
      boss,
      await plan([
        'Stok Kodu;Ürün Adı;Alış Fiyatı;Barkod',
        `${owner};Barkodun Sahibi;5;${sharedBarcode}`,
        `${other};Öteki Ürün;5;${uniq('bc')}`,
      ]),
      opts,
    )

    const result = await commitImport(
      boss,
      await plan([HEADER, `${other};Öteki Ürün;Adet;5;${sharedBarcode};Tekli;1;8`]),
      opts,
    )

    expect(result.failed).toBe(1)
    expect(result.openings).toEqual({ written: 0, skipped: 0, failed: 0 })
    expect(await movementsOf(owner)).toEqual([])
    expect(await movementsOf(other)).toEqual([])
  })

  it('aynı dosyanın iki eşzamanlı uygulaması ürün başına TEK devir yazıyor', async () => {
    const skus = [uniq('ES-'), uniq('ES-'), uniq('ES-')]
    const lines = [HEADER, ...skus.map((s) => `${s};Eş Zaman;Adet;5;${uniq('bc')};Tekli;1;10`)]
    // Ürünler önce yaratılıyor; devir iki eşzamanlı uygulamada yarışıyor.
    const file = await parseProductFile(Buffer.from(lines.join('\n'), 'utf8'), 'es.csv', opts)
    await commitImport(boss, await previewImport(boss, { ...file, columns: file.columns.filter((c) => c !== 'openingQty') }, opts), opts)

    const [one, two] = await Promise.all([
      commitImport(boss, await previewImport(boss, file, opts), opts),
      commitImport(boss, await previewImport(boss, file, opts), opts),
    ])

    expect(one.openings.written + two.openings.written).toBe(3)
    for (const sku of skus) {
      expect((await movementsOf(sku)).filter((m) => m.reason === 'OPENING')).toHaveLength(1)
    }
    expect(await checkStockInvariant(tenant.tenantId, opts)).toEqual([])
  })
})

describe('openingKey', () => {
  it('aynı kiracı+ürün aynı anahtar; farklı ürün ya da kiracı farklı; UUID v5', () => {
    const t = randomUUID()
    const p = randomUUID()

    expect(openingKey(t, p)).toBe(openingKey(t, p))
    expect(openingKey(t, p)).not.toBe(openingKey(t, randomUUID()))
    expect(openingKey(t, p)).not.toBe(openingKey(randomUUID(), p))
    expect(openingKey(t, p)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
