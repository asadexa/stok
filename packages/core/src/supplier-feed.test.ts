import { AppError } from '@stok/shared'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  type ParsedSupplierFile,
  SUPPLIER_HEADER_LIMIT,
  SUPPLIER_IGNORED_COLUMN_LIMIT,
  type SupplierDefaults,
  normalizeSupplierRows,
  parseSupplierFile,
  parseSupplierFileBlob,
} from './supplier-feed'

/**
 * T200 — tedarikçi dosyasını okuma. Saf: veritabanı yok. Dosya düzeyindeki
 * retler (tamamı reddedilir) ile satır düzeyindeki retler (yalnız o satır)
 * ayrı ayrı sınanıyor.
 */

const defaults: SupplierDefaults = { currency: 'TRY', taxMode: 'EXCLUDED', priceType: 'NET' }

function csv(text: string, bom = false): Buffer {
  return Buffer.from(`${bom ? '﻿' : ''}${text}`, 'utf8')
}

async function errorCode(fn: () => Promise<unknown>): Promise<string> {
  const err = await fn().then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err, 'reddedilmesi gerekirken kabul edildi').toBeInstanceOf(AppError)
  return (err as AppError).code
}

describe('dosya düzeyi: tamamı okunur ya da tamamı reddedilir', () => {
  it('Türkçe başlıklar, ; ayırıcı ve BOM ile okunur', async () => {
    const file = await parseSupplierFile(
      csv('Tedarikçi Kodu;Barkod;Ürün Adı;Fiyat;Stok\nT-1;869001;Kalem;12,50;40\n', true),
      'liste.csv',
    )
    expect(file.columns.map((c) => c.field)).toEqual([
      'supplierCode',
      'barcode',
      'name',
      'price',
      'stockQty',
    ])
    expect(file.rows).toEqual([
      {
        rowNumber: 2,
        cells: { supplierCode: 'T-1', barcode: '869001', name: 'Kalem', price: '12,50', stockQty: '40' },
      },
    ])
  })

  it('"Koli İçi Adet" ve "KDV" okunmaz, okunmayan sütun olarak görünür (T200)', async () => {
    const file = await parseSupplierFile(
      csv('Kod;Ürün Adı;Fiyat;Koli İçi Adet;KDV\nT-1;Kalem;10;12;20\n'),
      'liste.csv',
    )
    expect(file.ignoredColumns).toEqual(['Koli İçi Adet', 'KDV'])
    expect(file.columns.some((c) => c.field === 'priceQty')).toBe(false)
  })

  it('xlsx dosyası aynı okuyucuyla okunur', async () => {
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Liste')
    sheet.addRow(['Barkod', 'Ürün Adı', 'Liste Fiyatı'])
    sheet.addRow(['869002', 'Defter', 7.25])
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())

    const file = await parseSupplierFile(buffer, 'liste.xlsx')
    expect(file.headerPriceType).toBe('LIST')
    expect(file.rows[0]?.cells).toEqual({ barcode: '869002', name: 'Defter', price: '7.25' })
  })

  it('zorunlu sütun yoksa reddedilir ve bulunanları söyler', async () => {
    const err = await parseSupplierFile(csv('Kod;Ürün Adı\nT-1;Kalem\n'), 'liste.csv').then(
      () => undefined,
      (e: unknown) => e as AppError,
    )
    expect(err?.code).toBe('SUPPLIER_FEED_MISSING_COLUMN')
    expect(err?.details.found).toBe('Kod, Ürün Adı')
  })

  it('kod da barkod da yoksa reddedilir', async () => {
    expect(
      await errorCode(() => parseSupplierFile(csv('Ürün Adı;Fiyat\nKalem;10\n'), 'liste.csv')),
    ).toBe('SUPPLIER_FEED_MISSING_COLUMN')
  })

  it('aynı alana iki sütun eşleşirse reddedilir, ilki sessizce seçilmez', async () => {
    const err = await parseSupplierFile(
      csv('Kod;Ürün Adı;Liste Fiyatı;Net Fiyat\nT-1;Kalem;12;10\n'),
      'liste.csv',
    ).then(
      () => undefined,
      (e: unknown) => e as AppError,
    )
    expect(err?.code).toBe('SUPPLIER_FEED_DUPLICATE_COLUMN')
    expect(err?.details).toEqual({ field: 'Fiyat', columns: '"Liste Fiyatı", "Net Fiyat"' })
  })

  it('boş dosya başlıksız sayılır', async () => {
    expect(await errorCode(() => parseSupplierFile(csv(''), 'liste.csv'))).toBe('IMPORT_NO_HEADER')
  })

  it('yalnız başlık satırı olan dosya reddedilir', async () => {
    expect(
      await errorCode(() => parseSupplierFile(csv('Kod;Ürün Adı;Fiyat\n;;\n'), 'liste.csv')),
    ).toBe('SUPPLIER_FEED_NO_VALID_ROWS')
  })

  it('satır sınırı aşılırsa dosya reddedilir', async () => {
    const body = 'Kod;Ürün Adı;Fiyat\nA;a;1\nB;b;1\nC;c;1\n'
    expect(
      await errorCode(() => parseSupplierFile(csv(body), 'liste.csv', { rowLimit: 2 })),
    ).toBe('IMPORT_TOO_LARGE')
  })

  it('desteklenmeyen dosya türü reddedilir', async () => {
    expect(await errorCode(() => parseSupplierFile(csv('x'), 'liste.pdf'))).toBe(
      'SUPPLIER_FEED_UNREADABLE',
    )
  })
})

describe('JSON sözleşmesi ("örnek API verisi")', () => {
  it('kalemleri ham hücrelere çevirir, bilinmeyen anahtarları listeler', async () => {
    const json = JSON.stringify({
      items: [
        {
          supplierCode: 'J-1',
          barcode: '869003',
          name: 'Silgi',
          price: 3.5,
          currency: 'USD',
          priceQty: 1,
          updatedAt: '2026-10-18T09:00:00+03:00',
          images: ['a.png'],
        },
      ],
    })
    const file = await parseSupplierFile(Buffer.from(json), 'ornek.json')
    expect(file.rows[0]?.cells).toEqual({
      supplierCode: 'J-1',
      barcode: '869003',
      name: 'Silgi',
      price: '3.5',
      currency: 'USD',
      priceQty: '1',
      sourceUpdatedAt: '2026-10-18T09:00:00+03:00',
    })
    expect(file.ignoredColumns).toEqual(['images'])
  })

  it('bozuk JSON ve "items" olmayan JSON okunamaz', async () => {
    expect(await errorCode(() => parseSupplierFile(Buffer.from('{'), 'a.json'))).toBe(
      'SUPPLIER_FEED_UNREADABLE',
    )
    expect(await errorCode(() => parseSupplierFile(Buffer.from('[]'), 'a.json'))).toBe(
      'SUPPLIER_FEED_UNREADABLE',
    )
  })

  it('metin ya da sayı olmayan değer satır hatasıdır, dosya hatası değil', async () => {
    const json = JSON.stringify({
      items: [
        { supplierCode: 'J-1', name: 'Silgi', price: { amount: 3 } },
        { supplierCode: 'J-2', name: 'Kalem', price: 4 },
      ],
    })
    const file = await parseSupplierFile(Buffer.from(json), 'a.json')
    const result = normalizeSupplierRows(file, defaults)
    expect(result.items.map((i) => i.supplierCode)).toEqual(['J-2'])
    expect(result.errors[0]?.messages).toContain('Fiyat metin ya da sayı olmalı')
  })
})

describe('satır düzeyi: yalnız bozuk satır atlanır', () => {
  function rows(...cells: ParsedSupplierFile['rows'][number]['cells'][]): ParsedSupplierFile {
    return {
      rows: cells.map((c, i) => ({ rowNumber: i + 2, cells: c })),
      columns: [],
      ignoredColumns: [],
    }
  }

  it('tedarikçinin varsayılan koşulları uygulanır, satırdaki sütun önceliklidir', () => {
    const result = normalizeSupplierRows(
      rows(
        { supplierCode: 'A', name: 'a', price: '10' },
        { supplierCode: 'B', name: 'b', price: '10', currency: '$', taxMode: 'KDV Dahil' },
        { supplierCode: 'C', name: 'c', price: '10', currency: 'tl', priceType: 'Liste' },
      ),
      defaults,
    )
    expect(result.items.map((i) => [i.currency, i.taxMode, i.priceType])).toEqual([
      ['TRY', 'EXCLUDED', 'NET'],
      ['USD', 'INCLUDED', 'NET'],
      ['TRY', 'EXCLUDED', 'LIST'],
    ])
  })

  it.each([
    ['KDV Dahil', 'INCLUDED'],
    ['dahil', 'INCLUDED'],
    ['Included', 'INCLUDED'],
    ['KDV Hariç', 'EXCLUDED'],
    ['HARİÇ', 'EXCLUDED'],
    ['excluded', 'EXCLUDED'],
  ])('KDV durumu tam değerle tanınır: %s → %s', (taxMode, expected) => {
    const result = normalizeSupplierRows(rows({ supplierCode: 'A', name: 'a', price: '1', taxMode }), defaults)
    expect(result.items[0]?.taxMode).toBe(expected)
  })

  // T200 REVIEW: alt dize araması bu değerleri KDV DAHİL okuyordu ve fiyat
  // sessizce yanlış karşılaştırma grubuna giriyordu.
  it.each(['KDV Dahil Değil', 'Dahil değildir', 'Hariç değil', '+KDV', 'KDV %20'])(
    'olumsuz ya da belirsiz KDV ifadesi varsayılmaz, satır hatasıdır: %s',
    (taxMode) => {
      const result = normalizeSupplierRows(
        rows({ supplierCode: 'A', name: 'a', price: '1', taxMode }),
        defaults,
      )
      expect(result.items).toEqual([])
      expect(result.errors[0]?.messages).toEqual([`KDV durumu tanınmadı: ${taxMode}`])
    },
  )

  it('sütun adındaki fiyat türü varsayılanı ezer', () => {
    const file = { ...rows({ supplierCode: 'A', name: 'a', price: '10' }), headerPriceType: 'LIST' as const }
    expect(normalizeSupplierRows(file, defaults).items[0]?.priceType).toBe('LIST')
  })

  it('Türkçe sayı ve 4 ondalık okunur; fiyat miktarı yalnız açıkça verilirse dolar', () => {
    const result = normalizeSupplierRows(
      rows(
        { supplierCode: 'A', name: 'a', price: '1.234,5678', priceQty: '12' },
        { supplierCode: 'B', name: 'b', price: '0,0375' },
      ),
      defaults,
    )
    expect(result.items.map((i) => [i.price, i.priceQty])).toEqual([
      [1234.5678, 12],
      [0.0375, undefined],
    ])
  })

  it('kod yoksa barkod kod olur', () => {
    const result = normalizeSupplierRows(rows({ barcode: '869004', name: 'a', price: '1' }), defaults)
    expect(result.items[0]?.supplierCode).toBe('869004')
  })

  it.each([
    [{ supplierCode: 'A', name: 'a', price: '' }, 'Fiyat boş'],
    [{ supplierCode: 'A', name: 'a', price: 'yok' }, 'Fiyat sayı değil'],
    [{ supplierCode: 'A', name: 'a', price: '0' }, 'Fiyat: Fiyat sıfırdan büyük olmalı'],
    [{ supplierCode: 'A', name: 'a', price: '1,23456' }, 'Fiyat: Fiyatta en fazla 4 ondalık basamak olabilir'],
    [{ supplierCode: 'A', name: 'a', price: '1', currency: 'GBP' }, 'Para birimi tanınmadı: GBP'],
    [{ supplierCode: 'A', name: 'a', price: '1', stockQty: '-3' }, 'Stok: Stok eksi olamaz'],
    [{ name: 'a', price: '1' }, 'Tedarikçi kodu ve barkod boş'],
    [{ supplierCode: 'A', price: '1' }, 'Ürün adı boş'],
  ])('geçersiz satır atlanır ve sebebi yazılır: %o', (cells, message) => {
    const result = normalizeSupplierRows(
      rows(cells, { supplierCode: 'OK', name: 'geçerli', price: '5' }),
      defaults,
    )
    expect(result.items.map((i) => i.supplierCode)).toEqual(['OK'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.rowNumber).toBe(2)
    expect(result.errors[0]?.messages).toContain(message)
  })

  it('dosya içinde tekrar eden kod: ikinci satır reddedilir', () => {
    const result = normalizeSupplierRows(
      rows({ supplierCode: 'A', name: 'a', price: '1' }, { supplierCode: 'A', name: 'a2', price: '2' }),
      defaults,
    )
    expect(result.items.map((i) => i.name)).toEqual(['a'])
    expect(result.errors[0]?.messages).toEqual(['Bu kod 2. satırda da var'])
  })

  it('metin stok satırı reddetmez: stok boş kalır, uyarı yazılır', () => {
    const result = normalizeSupplierRows(
      rows({ supplierCode: 'A', name: 'a', price: '1', stockQty: 'Var' }),
      defaults,
    )
    expect(result.items[0]?.stockQty).toBeUndefined()
    expect(result.warnings[0]?.messages).toEqual(['Stok sayı değil (Var); boş bırakıldı'])
  })
})

describe('önizlemeden kayda geri gelen dosya', () => {
  it('geçerli blob kabul edilir', () => {
    const blob = {
      rows: [{ rowNumber: 2, cells: { supplierCode: 'A', name: 'a', price: '1' } }],
      columns: [{ field: 'price', header: 'Fiyat' }],
      ignoredColumns: [],
    }
    expect(parseSupplierFileBlob(blob).rows).toHaveLength(1)
  })

  it('bilinmeyen alan ya da bozuk yapı doğrulama hatasıdır', () => {
    expect(() =>
      parseSupplierFileBlob({ rows: [{ rowNumber: 2, cells: { productId: 'x' } }], columns: [], ignoredColumns: [] }),
    ).toThrow(AppError)
    expect(() => parseSupplierFileBlob({ rows: 'x' })).toThrow(AppError)
  })
})

/**
 * T200 1b REVIEW, B1: önizlemenin kabul ettiği dosya kayıtta YALNIZ uzunluk
 * kuralı farkı yüzünden reddedilmemeli. Ayrıştırıcı sınırsızdı, kayıt şeması
 * hücrede 1.000, sütun adında 200, okunmayan sütunda 200 adetle sınırlıydı:
 * 1.200 karakterlik ad, 240 karakterlik başlık ya da 210 okunmayan sütun
 * önizlemede "1 geçerli satır" gösterip kayıtta bütün dosyayı düşürüyordu.
 *
 * Tablo (CSV, XLSX) ve JSON ayrı ayrıştırıcılardan çıkıyor; üçü de sınanıyor.
 * "Kayıt" burada kayıt eyleminin yaptığı şey: blob JSON'a çevrilip
 * `parseSupplierFileBlob`'dan geçiyor, sonra aynı normalizasyon.
 */
describe('önizleme ile kayıt aynı dosyayı aynı sınıflandırır (uzun değer, çok sütun)', () => {
  const longName = 'Uzun açıklamalı ürün '.repeat(60).slice(0, 1_200)
  const longCode = `K${'0'.repeat(100)}`
  // Uzun başlık listenin başında: listeye girip kısaltıldığı görülsün.
  const extra = [`Not ${'x'.repeat(236)}`, ...Array.from({ length: 209 }, (_, i) => `Ek ${i + 1}`)]
  const values = [
    { code: 'GEC-1', barcode: '', name: 'Geçerli kalem', brand: 'Marka', price: '12,50' },
    { code: 'UZN-AD', barcode: '', name: longName, brand: '', price: '3' },
    { code: longCode, barcode: '', name: 'Uzun kodlu', brand: '', price: '4' },
    { code: 'UZN-BRK', barcode: '8'.repeat(65), name: 'Uzun barkodlu', brand: '', price: '5' },
    { code: 'UZN-MRK', barcode: '', name: 'Uzun markalı', brand: 'M'.repeat(101), price: '6' },
  ]
  // Eş ad noktalamayı yok sayıyor: 255 karakterlik başlık da fiyat sütunu.
  const header = ['Tedarikçi Kodu', 'Barkod', 'Ürün Adı', 'Marka', `Fiyat${'.'.repeat(250)}`, ...extra]
  const matrix = [header, ...values.map((v) => [v.code, v.barcode, v.name, v.brand, v.price, ...extra.map(() => 'x')])]

  async function fileOf(format: 'csv' | 'xlsx' | 'json'): Promise<Buffer> {
    if (format === 'csv') return csv(matrix.map((r) => r.join(';')).join('\n'))
    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook()
      const sheet = wb.addWorksheet('Liste')
      for (const row of matrix) sheet.addRow(row)
      return Buffer.from(await wb.xlsx.writeBuffer())
    }
    const items = values.map((v) => ({
      supplierCode: v.code,
      ...(v.barcode ? { barcode: v.barcode } : {}),
      name: v.name,
      ...(v.brand ? { brand: v.brand } : {}),
      price: Number(v.price.replace(',', '.')),
      ...Object.fromEntries(extra.map((key) => [key, 'x'])),
    }))
    return Buffer.from(JSON.stringify({ items }), 'utf8')
  }

  it.each(['csv', 'xlsx', 'json'] as const)('%s', async (format) => {
    const file = await parseSupplierFile(await fileOf(format), `liste.${format}`)
    const preview = normalizeSupplierRows(file, defaults)
    const saved = normalizeSupplierRows(parseSupplierFileBlob(JSON.parse(JSON.stringify(file))), defaults)

    expect(saved, 'kayıt önizlemeden farklı sınıflandırdı').toEqual(preview)
    expect(preview.items.map((i) => i.supplierCode)).toEqual(['GEC-1'])

    const errors = new Map(preview.errors.map((e) => [e.supplierCode, e]))
    expect(errors.get('UZN-AD')?.messages).toEqual(['Ürün Adı: Ürün adı en fazla 300 karakter olabilir'])
    expect(errors.get(longCode)?.messages).toEqual([
      'Tedarikçi Kodu: Tedarikçi kodu en fazla 100 karakter olabilir',
    ])
    expect(errors.get('UZN-BRK')?.messages).toEqual(['Barkod: Barkod en fazla 64 karakter olabilir'])
    expect(errors.get('UZN-MRK')?.messages).toEqual(['Marka: Marka en fazla 100 karakter olabilir'])
    // Değer kesilmedi: hata satırı dosyadaki adın tamamını taşıyor.
    expect(errors.get('UZN-AD')?.name).toBe(longName)

    // Okunmayan sütun metaverisi sınırlı ve kullanıcıya sayısı söyleniyor.
    expect(file.ignoredColumns).toHaveLength(SUPPLIER_IGNORED_COLUMN_LIMIT)
    expect(file.ignoredColumnsOmitted).toBe(extra.length - SUPPLIER_IGNORED_COLUMN_LIMIT)
    expect(file.ignoredColumns[0]).toHaveLength(SUPPLIER_HEADER_LIMIT)
    expect(file.ignoredColumns[0]?.endsWith('…')).toBe(true)
    for (const c of file.columns) expect(c.header.length).toBeLessThanOrEqual(SUPPLIER_HEADER_LIMIT)
  })
})
