import { randomUUID } from 'node:crypto'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz.js'
import {
  IMPORT_ROW_LIMIT,
  type ParsedFile,
  commitImport,
  importErrorRows,
  parseCsv,
  parseProductFile,
  parseTurkishNumber,
  previewImport,
  templateRows,
} from './import.js'
import { getProductDetail, listBarcodes } from './products.js'
import { listStock } from './stock.js'
import { TEST_DB_NAME } from './test/db-name.js'

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

function csv(lines: string[]): Buffer {
  return Buffer.from(lines.join('\n'), 'utf8')
}

async function parse(lines: string[], name = 'urunler.csv') {
  return parseProductFile(csv(lines), name, opts)
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
    const file = await parseProductFile(withBom, 'x.csv', opts)
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
      parseProductFile(csv(lines), 'x.csv', { ...opts, rowLimit: 5 }),
    ).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE' })
  })

  it('xlsx dosyasını da okuyor', async () => {
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Ürünler')
    sheet.addRow(['Stok Kodu', 'Ürün Adı', 'Alış Fiyatı'])
    sheet.addRow(['X-1', 'Şeffaf Poşet', 12.5])
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())

    const file = await parseProductFile(buffer, 'urunler.xlsx', opts)
    expect(file.rows[0]?.cells.name).toBe('Şeffaf Poşet')
    expect(file.rows[0]?.cells.purchasePrice).toBe('12.5')
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

describe('hata raporu ve şablon', () => {
  it('her sorun için ayrı satır üretiyor', async () => {
    const plan = await preview([
      'Stok Kodu,Ürün Adı,Barkod,Birim,Alış Fiyatı',
      `${uniq('RAP-')},Ürün,${uniq('bc')},kutu,bedava`,
    ])
    const rows = importErrorRows(plan.rows.filter((r) => r.action === 'error'))

    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.column).sort()).toEqual(['Alış Fiyatı', 'Birim'])
    expect(rows.every((r) => r.rowNumber === 2)).toBe(true)
  })

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

  it('varsayılan satır sınırı 2000', () => {
    expect(IMPORT_ROW_LIMIT).toBe(2_000)
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
    expect(result.rows[0]?.data.imageUrl).toBe('https://ornek.com/a.jpg')
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
    expect(result.rows[0]?.data.imageUrl).toBeNull()
  })
})
