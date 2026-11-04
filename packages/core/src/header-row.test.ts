import { AppError, errorText } from '@stok/shared'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { importNotices } from './import'
import { parseInventoryFile } from './inventory-file'
import { parseProductFile } from './product-file'
import { HEADER_SCAN_ROWS, findHeaderRow, parseCsv } from './sheet'
import { parseSupplierFile, parseSupplierFileBlob } from './supplier-feed'

/**
 * ERP raporunun üstündeki başlık blokları (30 Ekim testi, bulgu 1): üç dosya
 * okuyucusu da başlığı ilk satırda değil, zorunlu sütunları taşıyan ilk satırda
 * buluyor (`findHeaderRow`). Veritabanı gerekmiyor: hepsi saf okuyucu.
 */

const csv = (lines: string[]) => Buffer.from(lines.join('\n'), 'utf8')

async function caught(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(AppError)
  return err as AppError
}

/** ERP raporu biçimi: birleştirilmiş rapor adı, tarih satırı, boş satır, başlık 4. satırda. */
async function erpWorkbook(header: string[], rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('Rapor')
  sheet.addRow(['MALZEME ENVANTER RAPORU'])
  sheet.mergeCells(1, 1, 1, header.length)
  sheet.addRow(['Rapor tarihi', '01.11.2026'])
  sheet.addRow([])
  sheet.addRow(header)
  for (const r of rows) sheet.addRow(r)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe('findHeaderRow', () => {
  const needsAB = (row: string[]) => Number(!row.includes('A')) + Number(!row.includes('B'))

  it('zorunluların hepsini taşıyan ilk satırı seçiyor; boş ve kısmi satırları atlıyor', () => {
    const matrix = [['Rapor'], [], ['', ''], ['A', 'x'], ['A', 'B'], ['A', 'B']]
    expect(findHeaderRow(matrix, needsAB)).toEqual({ index: 4, row: ['A', 'B'] })
  })

  it('bulamazsa en az eksikli satırı (eşitlikte ilkini) hata için döndürüyor', () => {
    expect(findHeaderRow([['Rapor'], ['A'], ['B'], ['Rapor 2']], needsAB)).toEqual({ row: ['A'], closestIndex: 1 })
    expect(findHeaderRow([['Rapor'], ['Tarih']], needsAB)).toEqual({ row: ['Rapor'], closestIndex: 0 })
  })

  it(`yalnız ilk ${HEADER_SCAN_ROWS} satıra bakıyor`, () => {
    const inside = [...Array.from({ length: HEADER_SCAN_ROWS - 1 }, () => ['x']), ['A', 'B']]
    expect(findHeaderRow(inside, needsAB).index).toBe(HEADER_SCAN_ROWS - 1)
    const outside = [...Array.from({ length: HEADER_SCAN_ROWS }, () => ['x']), ['A', 'B']]
    expect(findHeaderRow(outside, needsAB)).toEqual({ row: ['x'], closestIndex: 0 })
  })

  it('1. satırın altında `strict` ile soruyor; en yakını kısa adlar sayılarak seçiyor', () => {
    // `strict` iken "a" sayılmıyor: 2. satırdaki ['a', 'B'] başlık değil, en yakın.
    const shortA = (row: string[], strict: boolean) =>
      Number(!row.includes('A') && (strict || !row.includes('a'))) + Number(!row.includes('B'))
    expect(findHeaderRow([['a', 'B']], shortA)).toEqual({ index: 0, row: ['a', 'B'] })
    expect(findHeaderRow([['Rapor'], ['a', 'B']], shortA)).toEqual({ row: ['a', 'B'], closestIndex: 1 })
  })

  it('taranan satırların hepsi boşsa satır döndürmüyor', () => {
    expect(findHeaderRow([[], [''], ['  ']], needsAB)).toEqual({})
  })
})

describe('CSV ayırıcısı', () => {
  it('ayırıcısız rapor satırı `;` dosyasını `,` sandırmıyor', () => {
    const matrix = parseCsv(csv(['STOK RAPORU', 'Stok Kodu;Ürün Adı', 'X-1;Kalem']))
    expect(matrix[1]).toEqual(['Stok Kodu', 'Ürün Adı'])
    expect(matrix[2]).toEqual(['X-1', 'Kalem'])
  })

  it('Excel\'in `;;;` ile doldurduğu rapor satırında da `;` seçiliyor', () => {
    expect(parseCsv(csv(['STOK RAPORU;;', 'Stok Kodu;Ürün Adı;Birim']))[1]).toEqual([
      'Stok Kodu',
      'Ürün Adı',
      'Birim',
    ])
  })
})

describe('ürün dosyası', () => {
  it('ERP raporunda başlığı 4. satırda buluyor; satır numaraları dosyadaki numara', async () => {
    const file = await parseProductFile(
      await erpWorkbook(
        ['Malzeme Kodu', 'Malzeme Açıklaması', 'Envanter Miktarı'],
        [
          ['M-001', 'Kırmızı Kalem', 12],
          ['M-002', 'Mavi Kalem', 3],
        ],
      ),
      'erp.xlsx',
    )
    expect(file.headerRowNumber).toBe(4)
    expect(file.rows.map((r) => [r.rowNumber, r.cells.sku, r.cells.name])).toEqual([
      [5, 'M-001', 'Kırmızı Kalem'],
      [6, 'M-002', 'Mavi Kalem'],
    ])
    // Miktar sütunu sessizce yok sayılmıyor; uyarı envanter ekranını gösteriyor.
    expect(file.ignoredQtyColumns).toEqual(['Envanter Miktarı'])
    expect(importNotices(file.ignoredQtyColumns ?? [])[0]).toContain('Envanteri güncelle')
  })

  it('başlığı 1. satırda olan dosyada davranış aynı', async () => {
    const file = await parseProductFile(csv(['Stok Kodu,Ürün Adı', 'X-1,Kalem']), 'u.csv')
    expect(file.headerRowNumber).toBe(1)
    expect(file.rows).toEqual([{ rowNumber: 2, cells: { sku: 'X-1', name: 'Kalem' } }])
  })

  it('"Kod" ve "Ad" taşıyan rapor parametre satırı başlık sanılmıyor', async () => {
    // ERP raporlarının parametre bloğu: "Kod | <şube kodu> | Ad | <şube adı>".
    // "kod" ve "ad" ürün dosyasının eş adları; bu satır başlık seçilirse gerçek
    // başlık veri satırı olur ve sütunlar yanlış hücrelerden okunur.
    const file = await parseProductFile(
      csv(['MALZEME LİSTESİ', 'Kod,001,Ad,Merkez Şube', '', 'Stok Kodu,Ürün Adı', 'X-1,Kalem']),
      'u.csv',
    )
    expect(file.headerRowNumber).toBe(4)
    expect(file.rows).toEqual([{ rowNumber: 5, cells: { sku: 'X-1', name: 'Kalem' } }])
  })

  it('1. satırdaki başlıkta kısa adlar bugünkü gibi tanınıyor', async () => {
    const file = await parseProductFile(csv(['Kod,Ad', 'X-1,Kalem']), 'u.csv')
    expect(file.headerRowNumber).toBe(1)
    expect(file.rows).toEqual([{ rowNumber: 2, cells: { sku: 'X-1', name: 'Kalem' } }])
  })

  it('1. satırın altındaki başlıkta kısa ad sütunu okunmuyor; ad açık addan geliyor', async () => {
    // Kısa ad seçimde değil yalnız eşlemede sayılsaydı ilk sütun ("Ad") kazanırdı.
    const file = await parseProductFile(
      csv(['RAPOR', 'Ad,Stok Kodu,Ürün Adı', 'Şube,X-1,Kalem']),
      'u.csv',
    )
    expect(file.headerRowNumber).toBe(2)
    expect(file.rows).toEqual([{ rowNumber: 3, cells: { sku: 'X-1', name: 'Kalem' } }])
  })

  it('1. satırın altında yalnız kısa adlar varsa açık adı isteyen hata', async () => {
    const err = await caught(parseProductFile(csv(['RAPOR', 'Kod,Ad', 'X-1,Kalem']), 'u.csv'))
    expect(err.code).toBe('IMPORT_MISSING_COLUMN')
    expect(err.details).toMatchObject({ found: 'Kod, Ad', shortNames: 'Kod, Ad' })
    expect(errorText(err.code, err.details)).toContain('kısa adlar (Kod, Ad) tanınmaz; sütunun açık adını yazın')
  })

  it('başlık yoksa en yakın satırı ve taranan satır sayısını söylüyor', async () => {
    const err = await caught(
      parseProductFile(csv(['STOK RAPORU', 'Kod,Açıklama,Fiyat', 'X-1,Kalem,5']), 'u.csv'),
    )
    expect(err.code).toBe('IMPORT_MISSING_COLUMN')
    // "Kod" stok kodu eş adı: zorunlulardan birini taşıyan satır rapor adını geçiyor.
    expect(err.details.found).toBe('Kod, Açıklama, Fiyat')
    const text = errorText(err.code, err.details)
    expect(text).toContain(`ilk ${HEADER_SCAN_ROWS} satırda`)
    expect(text).toContain('Malzeme Kodu')
  })

  it('taranan satırların hepsi boşsa başlık yok hatası', async () => {
    const err = await caught(parseProductFile(csv(['', ';', '']), 'u.csv'))
    expect(err.code).toBe('IMPORT_NO_HEADER')
    expect(errorText(err.code, err.details)).toBe(`Dosyanın ilk ${HEADER_SCAN_ROWS} satırında sütun başlıkları bulunamadı`)
  })

  it('satır sınırı başlığın üstündeki satırları saymıyor', async () => {
    const lines = ['RAPOR', 'Tarih: 01.11.2026', '', 'Stok Kodu,Ürün Adı', 'A,a', 'B,b', 'C,c']
    await expect(parseProductFile(csv(lines), 'u.csv', { rowLimit: 3 })).resolves.toMatchObject({
      headerRowNumber: 4,
    })
    const err = await caught(parseProductFile(csv([...lines, 'D,d']), 'u.csv', { rowLimit: 3 }))
    expect(err.code).toBe('IMPORT_TOO_LARGE')
  })
})

describe('envanter dosyası', () => {
  it('ERP raporunda başlığı buluyor', async () => {
    const file = await parseInventoryFile(
      await erpWorkbook(['Malzeme Kodu', 'Malzeme Açıklaması', 'Ambar', 'Envanter Miktarı'], [['M-001', 'Kalem', 'Merkez', 7]]),
      'erp.xlsx',
    )
    expect(file.headerRowNumber).toBe(4)
    expect(file.rows).toEqual([
      { rowNumber: 5, cells: { sku: 'M-001', name: 'Kalem', depot: 'Merkez', qty: '7' } },
    ])
  })

  it('eksik sütunu rapor adına göre değil, en yakın başlık satırına göre söylüyor', async () => {
    const err = await caught(
      parseInventoryFile(await erpWorkbook(['Malzeme Kodu', 'Envanter Miktarı'], [['M-001', 7]]), 'erp.xlsx'),
    )
    expect(err.code).toBe('INVENTORY_MISSING_COLUMN')
    expect(err.details.missing).toBe('Ambar (Depo)')
    expect(err.details.found).toBe('Malzeme Kodu, Envanter Miktarı')
    expect(errorText(err.code, err.details)).toContain(`ilk ${HEADER_SCAN_ROWS} satırda`)
  })
})

describe('tedarikçi dosyası', () => {
  it('rapor satırlarının altındaki başlığı buluyor', async () => {
    const file = await parseSupplierFile(
      csv(['Fiyat Listesi;;', 'Geçerlilik: Kasım 2026;;', 'Tedarikçi Kodu;Ürün Adı;Fiyat', 'T-1;Kalem;12,50']),
      'liste.csv',
    )
    expect(file.headerRowNumber).toBe(3)
    expect(file.rows).toEqual([{ rowNumber: 4, cells: { supplierCode: 'T-1', name: 'Kalem', price: '12,50' } }])
  })

  it('başlığın üstünde "Fiyat"ı iki kez taşıyan satır tekrar hatası vermiyor', async () => {
    const file = await parseSupplierFile(
      csv(['Fiyat;Fiyat;', 'Tedarikçi Kodu;Ürün Adı;Fiyat', 'T-1;Kalem;5']),
      'liste.csv',
    )
    expect(file.headerRowNumber).toBe(2)
  })

  it('"Kod" ve "Ad" taşıyan parametre satırının altındaki başlığı buluyor; kısa ad okunmuyor', async () => {
    const file = await parseSupplierFile(
      csv(['Fiyat Listesi;;', 'Kod;001;Ad;Merkez;Fiyat', 'Tedarikçi Kodu;Ürün Adı;Fiyat;Kod', 'T-1;Kalem;5;X']),
      'liste.csv',
    )
    expect(file.headerRowNumber).toBe(3)
    expect(file.rows).toEqual([{ rowNumber: 4, cells: { supplierCode: 'T-1', name: 'Kalem', price: '5' } }])
    // Sessizce yok sayılmıyor: okunmayan sütun listesinde.
    expect(file.ignoredColumns).toEqual(['Kod'])
  })

  it('başlıkta tekrar eden sütun hâlâ reddediliyor', async () => {
    const err = await caught(parseSupplierFile(csv(['Kod;Ad;Fiyat;Fiyat', 'T-1;Kalem;5;6']), 'liste.csv'))
    expect(err.code).toBe('SUPPLIER_FEED_DUPLICATE_COLUMN')
  })

  it('başlık 1. satırda değilken önizleme dosyası kayıt şemasından geçiyor', async () => {
    // Önizleme dosyayı JSON olarak istemciye veriyor, kayıt onu geri alıyor
    // (`previewRefreshAction` → `saveRefreshAction`). `headerRowNumber` şemada
    // yok: düşürülmeli, reddedilmemeli; satır numaraları korunmalı.
    const file = await parseSupplierFile(
      csv(['Fiyat Listesi;;', '', 'Tedarikçi Kodu;Ürün Adı;Fiyat', 'T-1;Kalem;5', 'T-2;Silgi;3']),
      'liste.csv',
    )
    expect(file.headerRowNumber).toBe(3)
    const blob = parseSupplierFileBlob(JSON.parse(JSON.stringify(file)))
    expect(blob.rows.map((r) => r.rowNumber)).toEqual([4, 5])
    expect(blob.columns).toEqual(file.columns)
    expect(blob).not.toHaveProperty('headerRowNumber')
  })

  it('başlık yoksa taranan satır sayısını söylüyor', async () => {
    const err = await caught(parseSupplierFile(csv(['Liste', 'Kod;Ad', 'T-1;Kalem']), 'liste.csv'))
    expect(err.code).toBe('SUPPLIER_FEED_MISSING_COLUMN')
    expect(err.details).toMatchObject({ found: 'Kod, Ad', shortNames: 'Kod, Ad' })
    const text = errorText(err.code, err.details)
    expect(text).toContain(`ilk ${HEADER_SCAN_ROWS} satırda`)
    expect(text).toContain('kısa adlar (Kod, Ad) tanınmaz')
  })
})
