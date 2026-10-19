import { AppError } from '@stok/shared'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  type ParsedSupplierFile,
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
