import { randomUUID } from 'node:crypto'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz'
import {
  IMPORT_CELL_LIMIT,
  IMPORT_FILE_BYTES_LIMIT,
  IMPORT_ROW_LIMIT,
  type ParsedFile,
  XLSX_PARTS_BYTE_LIMIT,
  commitImport,
  isAmbiguousTurkishNumber,
  parseCsv,
  parseProductFile,
  parseTurkishNumber,
  previewImport,
  templateRows,
} from './import'
import { getProductDetail, listBarcodes } from './products'
import { listStock } from './stock'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T23 / E1 — TOPLU ÜRÜN İÇE AKTARMA
 *
 * En kritik grup ÖNİZLEME DOĞRULUĞU: önizlemenin "yazılacak" dediği satır
 * gerçekten yazılabilmeli, "hatalı" dediği de gerçekten hatalı olmalı.
 * Aksi halde kullanıcı 800 satırlık bir dosyayı onaylıyor ve 200'ü
 * sessizce düşüyor.
 *
 * İkinci kritik grup TÜRKÇE SAYI: muhasebeden gelen dosyada fiyat
 * "1.234,56" biçiminde. Yanlış okunması sessiz ve bin katlık bir hata.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }

let tenant: TestTenant
let boss: Actor
let staff: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'import')
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

let seq = 0
/** Benzersiz stok kodu/barkod: testler aynı veritabanını paylaşıyor. */
function uniq(prefix: string) {
  seq += 1
  return `${prefix}${seq}-${randomUUID().slice(0, 6)}`
}

/** ExcelJS'in tipleri Node `Buffer`'ını değil kendi `Buffer` arayüzünü bekliyor; çalışma zamanında Node Buffer doğru. */
function excelBuffer(b: Buffer): ArrayBuffer {
  return b as unknown as ArrayBuffer
}

function csv(lines: string[]): Buffer {
  return Buffer.from(lines.join('\n'), 'utf8')
}

async function parse(lines: string[], name = 'urunler.csv') {
  return parseProductFile(csv(lines), name)
}

async function preview(lines: string[]) {
  return previewImport(boss, await parse(lines), opts)
}

describe('dosya çözümleme', () => {
  it('noktalı virgülle ayrılmış Türkçe Excel CSV\'sini okuyor', async () => {
    // Türkçe Excel `;` ile kaydediyor çünkü ondalık ayırıcı virgül.
    // Sabit `,` varsayımı bu dosyaları tek sütun olarak okurdu.
    const rows = parseCsv(csv(['Stok Kodu;Ürün Adı', 'A-1;Çelik Vida']))
    expect(rows[0]).toEqual(['Stok Kodu', 'Ürün Adı'])
    expect(rows[1]).toEqual(['A-1', 'Çelik Vida'])
  })

  it('BOM ilk başlığa yapışmıyor', async () => {
    // Excel UTF-8 BOM yazıyor; atılmazsa "Stok Kodu" sütunu eşleşmez ve
    // kullanıcı "sütun bulunamadı" hatasının sebebini asla göremez.
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv(['Stok Kodu,Ürün Adı', 'A-1,Vida'])])
    const file = await parseProductFile(withBom, 'x.csv')
    expect(file.rows[0]?.cells.sku).toBe('A-1')
  })

  it('tırnak içindeki ayırıcı ve çift tırnak korunuyor', async () => {
    const rows = parseCsv(csv(['a,b', '"15"" cetvel, mavi",2']))
    expect(rows[1]?.[0]).toBe('15" cetvel, mavi')
  })

  it('başlıklar büyük/küçük harf ve Türkçe karakterden bağımsız eşleşiyor', async () => {
    const file = await parse(['STOK KODU,ÜRÜN ADI,KRİTİK SEVİYE', 'A-1,Vida,5'])
    expect(file.columns).toEqual(expect.arrayContaining(['sku', 'name', 'minStock']))
  })

  it('tamamen boş satırlar atlanıyor', async () => {
    // Excel dosyalarının sonunda yüzlerce boş satır olması çok yaygın;
    // hepsini hata olarak raporlamak raporu okunamaz hâle getirirdi.
    const file = await parse(['Stok Kodu,Ürün Adı', 'A-1,Vida', ',', '', ' , '])
    expect(file.rows).toHaveLength(1)
  })

  it('satır numarası DOSYADAKİ numara', async () => {
    // Kullanıcı hatayı Excel'de bu numarayla arayacak.
    const file = await parse(['Stok Kodu,Ürün Adı', 'A-1,Bir', 'A-2,İki'])
    expect(file.rows.map((r) => r.rowNumber)).toEqual([2, 3])
  })

  it('zorunlu sütunlar yoksa dosya reddediliyor', async () => {
    // Satır bazlı hata vermek 800 kere aynı şeyi yazmak olurdu.
    await expect(parse(['Miktar,Fiyat', '1,2'])).rejects.toMatchObject({
      code: 'IMPORT_MISSING_COLUMN',
    })
  })

  it('boş dosya reddediliyor', async () => {
    await expect(parse([''])).rejects.toMatchObject({ code: 'IMPORT_NO_HEADER' })
  })

  it('satır sınırı aşılırsa reddediliyor', async () => {
    const lines = ['Stok Kodu,Ürün Adı', ...Array.from({ length: 6 }, (_, i) => `A-${i},Ürün`)]
    await expect(
      parseProductFile(csv(lines), 'x.csv', { rowLimit: 5 }),
    ).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE' })
  })

  it('xlsx dosyasını da okuyor', async () => {
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Ürünler')
    sheet.addRow(['Stok Kodu', 'Ürün Adı', 'Alış Fiyatı'])
    sheet.addRow(['X-1', 'Şeffaf Poşet', 12.5])
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())

    const file = await parseProductFile(buffer, 'urunler.xlsx')
    expect(file.rows[0]?.cells.name).toBe('Şeffaf Poşet')
    // Sayı hücresi virgüllü ondalıkla metne çevriliyor (K1): Türkçe okuyucuda tek anlamlı.
    expect(file.rows[0]?.cells.purchasePrice).toBe('12,5')
  })

  it('önekli SpreadsheetML xlsx dosyasını da okuyor (.NET Open XML SDK, ChatGPT)', async () => {
    // Bu biçim ExcelJS'te TypeError atıyor, ekranda "beklenmeyen hata"
    // görünüyordu. Parçalar SDK çıktısı gibi elle yazıldı: önek `x:`, mutlak
    // rels hedefi, `t="str"` hücreler, boş `<x:sst/>`.
    const ns = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    const zip = new JSZip()
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Default Extension="xml" ContentType="application/xml" /><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" /><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" /></Types>',
    )
    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="${rel}/officeDocument" Target="/xl/workbook.xml" Id="R1" /></Relationships>`,
    )
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="${rel}/worksheet" Target="/xl/worksheets/sheet1.xml" Id="R2" /><Relationship Type="${rel}/sharedStrings" Target="/xl/sharedStrings.xml" Id="R3" /></Relationships>`,
    )
    zip.file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="utf-8"?><x:workbook ${ns}><x:sheets><x:sheet name="Urunler" sheetId="1" r:id="R2" xmlns:r="${rel}" /></x:sheets></x:workbook>`,
    )
    zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="utf-8"?><x:sst ${ns} />`)
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="utf-8"?><x:worksheet ${ns}><x:sheetData>
        <x:row r="1"><x:c r="A1" t="str"><x:v>Stok Kodu</x:v></x:c><x:c r="B1" t="str"><x:v>Ürün Adı</x:v></x:c><x:c r="C1" t="str"><x:v>Alış Fiyatı</x:v></x:c></x:row>
        <x:row r="2"><x:c r="A2" t="str"><x:v>X-1</x:v></x:c><x:c r="B2" t="str"><x:v>Şeffaf Poşet</x:v></x:c><x:c r="C2"><x:v>12.5</x:v></x:c></x:row>
      </x:sheetData></x:worksheet>`,
    )
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })

    const file = await parseProductFile(buffer, 'urunler.xlsx')
    expect(file.rows).toEqual([
      { rowNumber: 2, cells: { sku: 'X-1', name: 'Şeffaf Poşet', purchasePrice: '12,5' } },
    ])
  })
})

describe('Türkçe sayı', () => {
  it('binlik nokta ve ondalık virgül doğru okunuyor', () => {
    // Yanlış okunması bin katlık ve SESSİZ bir hata.
    expect(parseTurkishNumber('1.234,56')).toBe(1234.56)
    expect(parseTurkishNumber('12,5')).toBe(12.5)
    expect(parseTurkishNumber('1234.56')).toBe(1234.56) // virgülsüz: nokta ondalık
    expect(parseTurkishNumber('  40 ')).toBe(40)
  })

  it('boş hücre undefined, çöp girdi NaN', () => {
    expect(parseTurkishNumber('')).toBeUndefined()
    expect(Number.isNaN(parseTurkishNumber('abc'))).toBe(true)
  })

  it('belirsiz yazım ("1.234") sayı DEĞİL; tek anlamlı yazımlar okunuyor (K1)', () => {
    // Binlik mi ondalık mı anlaşılmıyor: bin kat fark. Sessizce bir anlam
    // seçilseydi açılış stoğu append-only deftere yanlış yazılırdı.
    for (const raw of ['1.234', '12.500', '999.000', '-1.250']) {
      expect(Number.isNaN(parseTurkishNumber(raw)), raw).toBe(true)
      expect(isAmbiguousTurkishNumber(raw), raw).toBe(true)
    }
    // Tek anlamlı: virgüllü, binliksiz, 3'ten farklı ondalık, sıfırla başlayan.
    expect(parseTurkishNumber('1.234,00')).toBe(1234)
    expect(parseTurkishNumber('1234')).toBe(1234)
    expect(parseTurkishNumber('1,234')).toBe(1.234)
    expect(parseTurkishNumber('12.50')).toBe(12.5)
    expect(parseTurkishNumber('1.5')).toBe(1.5)
    expect(parseTurkishNumber('0.125')).toBe(0.125)
    expect(isAmbiguousTurkishNumber('0.125')).toBe(false)
  })

  it('önizleme belirsiz sayıyı satır hatası yapıyor ve NEDENİNİ söylüyor (K1)', async () => {
    const p = await preview([
      'Stok Kodu;Ürün Adı;Barkod;Alış Fiyatı',
      `${uniq('K1-')};Belirsiz Fiyat;${uniq('bc')};1.234`,
      `${uniq('K1-')};Açık Fiyat;${uniq('bc')};1.234,00`,
    ])
    expect(p.rows[0]?.action).toBe('error')
    expect(p.rows[0]?.issues[0]).toMatchObject({ column: 'Alış Fiyatı' })
    expect(p.rows[0]?.issues[0]?.message).toContain('belirsiz')
    expect(p.rows[1]?.action).toBe('create')
    expect(p.rows[1]?.data?.purchasePrice).toBe(1234)
  })

  it('xlsx SAYI hücresi belirsiz sayılmıyor: 1,125 kg ve 1234 aynen okunuyor (K1)', async () => {
    // `String(1.125)` "1.125" verirdi ve K1 kuralı kesin bir sayıyı reddederdi.
    // Kilogramlı üründe kritik seviye 3 ondalık alıyor (DAT-17).
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Ürünler')
    sheet.addRow(['Stok Kodu', 'Ürün Adı', 'Birim', 'Barkod', 'Kritik Seviye', 'Alış Fiyatı'])
    sheet.addRow([uniq('NUM-'), 'Kesirli', 'Kilogram', uniq('bc'), 1.125, 12.5])
    sheet.addRow([uniq('NUM-'), 'Tam', 'Adet', uniq('bc'), 1234, 1234])
    const file = await parseProductFile(Buffer.from(await wb.xlsx.writeBuffer()), 'sayi.xlsx')
    const p = await previewImport(boss, file, opts)
    expect(p.rows.map((r) => r.action)).toEqual(['create', 'create'])
    expect(p.rows[0]?.data).toMatchObject({ minStock: 1.125, purchasePrice: 12.5 })
    expect(p.rows[1]?.data).toMatchObject({ minStock: 1234, purchasePrice: 1234 })
  })
})

describe('dosya güvenliği ve sınırlar (T171)', () => {
  it('görselli, köprülü, tablolu xlsx yalnız değerleriyle okunuyor; görsel açılmıyor', async () => {
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Ürünler')
    sheet.addRow(['Stok Kodu', 'Ürün Adı', 'Alış Fiyatı'])
    sheet.addRow(['G-1', { text: 'Bağlantılı Ürün', hyperlink: 'https://ornek.com' }, 12.5])
    sheet.getCell('C2').note = 'yorum'
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    sheet.addImage(wb.addImage({ buffer: excelBuffer(png), extension: 'png' }), 'E2:F4')
    sheet.addTable({ name: 'T1', ref: 'H1', columns: [{ name: 'a' }], rows: [[1]] })
    wb.addWorksheet('İkinci').addRow(['yalnız ilk sayfa okunur'])

    const file = await parseProductFile(Buffer.from(await wb.xlsx.writeBuffer()), 'gorselli.xlsx')
    expect(file.rows).toEqual([
      { rowNumber: 2, cells: { sku: 'G-1', name: 'Bağlantılı Ürün', purchasePrice: '12,5' } },
    ])
  })

  it('gömülü görsel AÇILMIYOR: açılmış hâli sınırı aşan görsel dosyayı reddettirmiyor', async () => {
    // Açılsaydı 70 MB'lık görsel 64 MiB'lık bütçeyi tek başına aşardı.
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Ürünler')
    sheet.addRow(['Stok Kodu', 'Ürün Adı'])
    sheet.addRow(['IMG-1', 'Görselli Ürün'])
    const image = new Uint8Array(70 * 1024 * 1024)
    sheet.addImage(wb.addImage({ buffer: excelBuffer(Buffer.from(image.buffer)), extension: 'png' }), 'C2:D3')
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())
    expect(buffer.byteLength).toBeLessThan(5 * 1024 * 1024)

    const file = await parseProductFile(buffer, 'buyuk-gorsel.xlsx')
    expect(file.rows).toEqual([{ rowNumber: 2, cells: { sku: 'IMG-1', name: 'Görselli Ürün' } }])
  })

  it('açılınca sınırı aşan xlsx sıkıştırma bombası gibi reddediliyor', async () => {
    // 70 MB'lık tek tip içerik birkaç yüz KB'a sıkışır; sınır sayfa açılırken
    // aşılıyor ve geri kalanı hiç açılmıyor.
    const zip = new JSZip()
    zip.file('xl/workbook.xml', '<workbook/>')
    zip.file('xl/worksheets/sheet1.xml', 'a'.repeat(XLSX_PARTS_BYTE_LIMIT + 1024))
    const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    expect(bomb.byteLength).toBeLessThan(1024 * 1024)
    await expect(parseProductFile(bomb, 'bomba.xlsx')).rejects.toMatchObject({
      code: 'IMPORT_XLSX_TOO_LARGE',
    })
  })

  it('zip olmayan .xlsx anlaşılır hatayla reddediliyor', async () => {
    await expect(parseProductFile(Buffer.from('bu bir excel değil'), 'sahte.xlsx')).rejects.toMatchObject({
      code: 'IMPORT_UNREADABLE',
    })
  })

  it('dosya boyutu sınırı uygulanıyor (100 MB)', async () => {
    const big = new Uint8Array(IMPORT_FILE_BYTES_LIMIT + 1)
    await expect(parseProductFile(big, 'buyuk.csv')).rejects.toMatchObject({
      code: 'IMPORT_FILE_TOO_LARGE',
    })
  })

  it('uzun hücre sınıra kısaltılıyor ve satır yine HATA oluyor', async () => {
    const long = 'x'.repeat(5_000)
    const file = await parse(['Stok Kodu;Ürün Adı;Barkod', `${uniq('L-')};${long};${uniq('bc')}`])
    expect(file.rows[0]?.cells.name).toHaveLength(IMPORT_CELL_LIMIT + 1)
    const p = await previewImport(boss, file, opts)
    expect(p.rows[0]?.action).toBe('error')
    expect(p.rows[0]?.issues[0]?.column).toBe('Ürün Adı')
  })
})

describe('önizleme', () => {
  it('yeni ürünü create diye işaretliyor', async () => {
    const sku = uniq('YENI-')
    const result = await preview([
      'Stok Kodu,Ürün Adı,Barkod,Alış Fiyatı',
      `${sku},Yeni Ürün,${uniq('bc')},"1.234,56"`,
    ])

    expect(result.counts).toEqual({ create: 1, update: 0, error: 0 })
    expect(result.rows[0]?.data?.purchasePrice).toBe(1234.56)
  })

  it('var olan stok kodunu update diye işaretliyor', async () => {
    const result = await preview([
      'Stok Kodu,Ürün Adı',
      `${tenant.products['KAL-001']!.sku},Yeni Ad`,
    ])
    expect(result.counts.update).toBe(1)
    expect(result.rows[0]?.productId).toBe(tenant.products['KAL-001']!.id)
  })

  it('dosya içinde mükerrer stok kodu yakalanıyor', async () => {
    // Yakalanmasaydı ikinci satır birinciyi sessizce ezerdi ve kullanıcı
    // hangi fiyatın kaydedildiğini asla bilemezdi.
    const sku = uniq('DUP-')
    const result = await preview([
      'Stok Kodu,Ürün Adı,Barkod',
      `${sku},Birinci,${uniq('bc')}`,
      `${sku},İkinci,${uniq('bc')}`,
    ])

    expect(result.counts.error).toBe(1)
    expect(result.rows[1]?.issues[0]?.message).toContain('2. satırda da var')
  })

  it('yeni üründe barkod zorunlu', async () => {
    // Barkodsuz ürün depoda okutulamaz: aktarım "başarılı" görünüp
    // kullanılamaz bir katalog üretirdi.
    const result = await preview(['Stok Kodu,Ürün Adı', `${uniq('NB-')},Barkodsuz`])
    expect(result.counts.error).toBe(1)
    expect(result.rows[0]?.issues[0]?.column).toBe('Barkod')
  })

  it('güncellemede barkod zorunlu değil', async () => {
    const result = await preview([
      'Stok Kodu,Ürün Adı',
      `${tenant.products['DEF-001']!.sku},Güncel Ad`,
    ])
    expect(result.counts.update).toBe(1)
  })

  it('tanınmayan birim ve barkod türü hata veriyor', async () => {
    const result = await preview([
      'Stok Kodu,Ürün Adı,Barkod,Birim,Barkod Türü',
      `${uniq('BR-')},Ürün,${uniq('bc')},kutu,paket`,
    ])
    const columns = result.rows[0]!.issues.map((i) => i.column)
    expect(columns).toContain('Birim')
    expect(columns).toContain('Barkod Türü')
  })

  it('Türkçe birim etiketi kabul ediliyor', async () => {
    // Dosyayı dolduran kişi kod değil kelime yazar.
    const result = await preview([
      'Stok Kodu,Ürün Adı,Barkod,Birim',
      `${uniq('BI-')},Ürün,${uniq('bc')},Kilogram`,
    ])
    expect(result.rows[0]?.data?.unit).toBe('KG')
  })

  it('koli çarpanı kuralı önizlemede uygulanıyor (D7)', async () => {
    const result = await preview([
      'Stok Kodu,Ürün Adı,Barkod,Barkod Türü,Koli İçi Adet',
      `${uniq('KO-')},Koli,${uniq('bc')},Koli,1`,
    ])
    expect(result.counts.error).toBe(1)
    expect(result.rows[0]?.issues[0]?.message).toContain('çarpan')
  })

  it('bozuk sayı sütunu adıyla raporlanıyor', async () => {
    const result = await preview([
      'Stok Kodu,Ürün Adı,Barkod,Alış Fiyatı',
      `${uniq('SA-')},Ürün,${uniq('bc')},bedava`,
    ])
    expect(result.rows[0]?.issues[0]).toEqual({
      column: 'Alış Fiyatı',
      message: 'Sayı olarak okunamadı',
    })
  })

  it('hiçbir şey yazmıyor', async () => {
    const sku = uniq('KURU-')
    await preview(['Stok Kodu,Ürün Adı,Barkod', `${sku},Kuru Çalışma,${uniq('bc')}`])

    const page = await listStock(boss, { search: sku, includeArchived: true }, opts)
    expect(page.total).toBe(0)
  })

  it('çalışan önizleme yapamıyor', async () => {
    const file = await parse(['Stok Kodu,Ürün Adı', 'A-1,Ürün'])
    await expect(previewImport(staff, file, opts)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('uygulama', () => {
  it('geçerli satırları yazıyor, bozukları rapora düşürüyor', async () => {
    // Tek bozuk satır yüzünden doğru satırları reddetmek, kullanıcıyı
    // dosyayı elle ayıklamaya zorlardı.
    const good = uniq('IYI-')
    const bad = uniq('KOTU-')
    const plan = await preview([
      'Stok Kodu,Ürün Adı,Barkod,Alış Fiyatı',
      `${good},İyi Satır,${uniq('bc')},10`,
      `${bad},Kötü Satır,${uniq('bc')},bedava`,
    ])
    const result = await commitImport(boss, plan, opts)

    expect(result).toMatchObject({ created: 1, updated: 0, failed: 1 })
    expect((await listStock(boss, { search: good }, opts)).total).toBe(1)
    expect((await listStock(boss, { search: bad }, opts)).total).toBe(0)
  })

  it('ürünü barkoduyla birlikte yaratıyor', async () => {
    const sku = uniq('TAM-')
    const barcode = uniq('bc')
    const plan = await preview([
      'Stok Kodu,Ürün Adı,Kategori,Birim,Kritik Seviye,Alış Fiyatı,Barkod,Barkod Türü,Koli İçi Adet',
      `${sku},Çelik Ütü,Hırdavat,Kilogram,"2,5","1.499,90",${barcode},Koli,24`,
    ])
    await commitImport(boss, plan, opts)

    const page = await listStock(boss, { search: sku }, opts)
    const row = page.rows[0]!
    expect(row).toMatchObject({
      name: 'Çelik Ütü',
      category: 'Hırdavat',
      unit: 'KG',
      minStock: 2.5,
      purchasePrice: 1499.9,
    })
    const barcodes = await listBarcodes(boss, row.productId, opts)
    expect(barcodes[0]).toMatchObject({ barcode, kind: 'CASE', qtyMultiplier: 24 })
  })

  it('güncellemede dosyada OLMAYAN sütuna dokunulmuyor', async () => {
    // Sadece stok kodu ve ad içeren bir düzeltme dosyası bütün fiyatları
    // silmemeli.
    const sku = uniq('KOR-')
    await commitImport(
      boss,
      await preview([
        'Stok Kodu,Ürün Adı,Barkod,Alış Fiyatı,Marka',
        `${sku},İlk Ad,${uniq('bc')},50,Eski Marka`,
      ]),
      opts,
    )

    await commitImport(
      boss,
      await preview(['Stok Kodu,Ürün Adı', `${sku},Yeni Ad`]),
      opts,
    )

    const row = (await listStock(boss, { search: sku }, opts)).rows[0]!
    expect(row.name).toBe('Yeni Ad')
    expect(row.purchasePrice).toBe(50)
    expect(row.brand).toBe('Eski Marka')
  })

  it('güncellemede BOŞ fiyat hücresi alanı temizliyor', async () => {
    // Sütun dosyada VAR ama hücre boş: kullanıcı bilerek sildi.
    const sku = uniq('TEM-')
    await commitImport(
      boss,
      await preview(['Stok Kodu,Ürün Adı,Barkod,Alış Fiyatı', `${sku},Ürün,${uniq('bc')},50`]),
      opts,
    )
    await commitImport(
      boss,
      await preview(['Stok Kodu,Ürün Adı,Alış Fiyatı', `${sku},Ürün,`]),
      opts,
    )

    expect((await listStock(boss, { search: sku }, opts)).rows[0]?.purchasePrice).toBeNull()
  })

  it('güncellemede yeni barkod ekleniyor, mevcut olan iki kez eklenmiyor', async () => {
    const sku = uniq('BAR-')
    const first = uniq('bc')
    await commitImport(
      boss,
      await preview(['Stok Kodu,Ürün Adı,Barkod', `${sku},Ürün,${first}`]),
      opts,
    )

    const second = uniq('bc')
    await commitImport(
      boss,
      await preview(['Stok Kodu,Ürün Adı,Barkod', `${sku},Ürün,${second}`]),
      opts,
    )
    // Aynı dosya ikinci kez yüklenirse barkod tekrar eklenmemeli.
    await commitImport(
      boss,
      await preview(['Stok Kodu,Ürün Adı,Barkod', `${sku},Ürün,${second}`]),
      opts,
    )

    const detail = await getProductDetail(
      boss,
      (await listStock(boss, { search: sku }, opts)).rows[0]!.productId,
      opts,
    )
    expect(detail.barcodes.map((b) => b.barcode).sort()).toEqual([first, second].sort())
  })

  it('kayıt sırasında çıkan çakışma rapora düşüyor, aktarım durmuyor', async () => {
    // Önizlemeden sonra başka bir admin aynı barkodu kullanmış olabilir.
    const taken = uniq('bc')
    await commitImport(
      boss,
      await preview(['Stok Kodu,Ürün Adı,Barkod', `${uniq('ONC-')},Önce,${taken}`]),
      opts,
    )

    const plan = await preview([
      'Stok Kodu,Ürün Adı,Barkod',
      `${uniq('CAK-')},Çakışan,${taken}`,
      `${uniq('SON-')},Sonraki,${uniq('bc')}`,
    ])
    const result = await commitImport(boss, plan, opts)

    expect(result.created).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.errors[0]?.issues[0]?.message).toContain('barkodu')
  })

  it('çalışan uygulayamıyor', async () => {
    const plan = await preview(['Stok Kodu,Ürün Adı,Barkod', `${uniq('YET-')},Ürün,${uniq('bc')}`])
    await expect(commitImport(staff, plan, opts)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

// Hata raporu aktarım kaydından üretiliyor: `import-runs.test.ts` (T171).
describe('şablon', () => {
  it('şablon kendi başlıklarıyla geri okunabiliyor', async () => {
    // Şablonu indirip doldurup yükleyen kullanıcı, sütun adı yüzünden
    // hata almamalı — şablon ile çözümleyici aynı listeden beslenmeli.
    const rows = templateRows()
    const header = Object.keys(rows[0]!)
    const lines = [
      header.join(','),
      ...rows.map((r) => header.map((h) => String(r[h] ?? '')).join(',')),
    ]
    const file: ParsedFile = await parse(lines)

    expect(file.rows).toHaveLength(2)
    expect(file.columns).toEqual(
      expect.arrayContaining(['sku', 'name', 'unit', 'category', 'brand', 'minStock', 'barcode']),
    )
  })

  it('varsayılan satır sınırı 20.000 (T171)', () => {
    expect(IMPORT_ROW_LIMIT).toBe(20_000)
  })
})

/**
 * T84 — toplu aktarmada görsel adresi.
 *
 * Adres arayüzde bir `<img src>` içine giriyor ve bu dosya DIŞARIDAN geliyor.
 * Şema kısıtlanmasaydı, hazırladığı Excel'i yükleten biri sayfaya kendi
 * içeriğini sokabilirdi.
 */
describe('T84 - görsel URL sütunu', () => {
  it('http/https adresi kabul ediliyor', async () => {
    const sku = uniq('GRS')
    const result = await preview([
      'Stok Kodu;Ürün Adı;Barkod;Görsel URL',
      `${sku};Görselli Ürün;${uniq('869')};https://ornek.com/a.jpg`,
    ])
    expect(result.rows[0]?.issues).toEqual([])
    expect(result.rows[0]?.data?.imageUrl).toBe('https://ornek.com/a.jpg')
  })

  it('javascript: şeması REDDEDİLİYOR', async () => {
    const result = await preview([
      'Stok Kodu;Ürün Adı;Barkod;Görsel URL',
      `${uniq('GRS')};Kötü Ürün;${uniq('869')};javascript:alert(1)`,
    ])
    const row = result.rows[0]
    expect(row?.issues.some((i) => i.column === 'Görsel URL')).toBe(true)
    // Sorunlu satır 'error' işaretleniyor ve `data` HİÇ üretilmiyor: kötü
    // adres onay adımına geçemiyor.
    expect(row?.action).toBe('error')
    expect(row?.data).toBeUndefined()
  })

  it('boş hücre sorun değil, görsel yok demek', async () => {
    const result = await preview([
      'Stok Kodu;Ürün Adı;Barkod;Görsel URL',
      `${uniq('GRS')};Görselsiz;${uniq('869')};`,
    ])
    expect(result.rows[0]?.issues).toEqual([])
    expect(result.rows[0]?.data?.imageUrl).toBeNull()
  })
})
