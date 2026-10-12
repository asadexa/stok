import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  DATE_FORMAT,
  MONEY_FORMAT,
  QTY_FORMAT,
  type MovementExportRow,
  type StockExportRow,
  buildWorkbook,
  exportFileName,
  movementColumns,
  stockColumns,
} from './excel'

/**
 * ============================================================================
 * T15 — KRİTİK AÇIK G2: TÜRKÇE KARAKTER VE BİÇİM
 *
 * Kapatılan hata: "Excel'de 'Kirmizi Defter' görünüyor."
 *
 * Bu hata tipinin özelliği SESSİZ olması: dosya iniyor, açılıyor, sayılar
 * doğru, sadece harfler bozuk. Hiç kimse hata almadığı için hiç kimse
 * bildirmiyor ve rapor aylarca yanlış gidiyor. Tek savunma, üretilen
 * dosyayı GERİ OKUYUP karşılaştıran bir test.
 *
 * Bu yüzden testler bellekteki nesneyi değil, `buildWorkbook`'un ürettiği
 * BAYTLARI exceljs ile yeniden açıp okuyor. Yazarken doğru olup okurken
 * bozulan bir kodlama hatası, sadece bu şekilde yakalanır.
 * ============================================================================
 */

/** PLAN.md G2'nin istediği fixture: Türkçe'ye özgü on iki harf. */
const TR_ALPHABET = 'Ğ Ü Ş İ Ö Ç ğ ü ş ı ö ç'

/** Gerçek hayatta bozulan adlar: ı/I/i/İ dört ayrı harf. */
const TR_NAMES = [
  'Kırmızı Tükenmez Kalem',
  'Isıtıcı Şerit',
  'ŞERİT BANT 50mm',
  'Çakı — Paslanmaz Çelik',
  'İnce Uçlu Kalemtıraş',
  'Öğütücü Bıçak Seti',
  'Ağır Hizmet Vidası',
  'Düz Tornavida (Büyük)',
]

async function readBack(buffer: Uint8Array) {
  const workbook = new ExcelJS.Workbook()
  // Cast: exceljs bağımlılığı (fast-csv üzerinden) @types/node@14 çekiyor
  // ve o sürümde Buffer jenerik değil. İki farklı Buffer tanımı aynı
  // projede bulununca derleyici "Buffer is not assignable to Buffer"
  // diyor. Çalışma zamanında tek bir Buffer var; sorun tamamen tiplerde.
  await workbook.xlsx.load((Buffer.from(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0]))
  const sheet = workbook.worksheets[0]!
  return { workbook, sheet }
}

function stockRow(overrides: Partial<StockExportRow> = {}): StockExportRow {
  return {
    sku: 'KAL-001',
    name: 'Kırmızı Tükenmez Kalem',
    category: 'Yazı Gereçleri',
    brand: 'Faber-Castell',
    unit: 'ADET',
    qty: 1234.5,
    minStock: 10,
    purchasePrice: 12.34,
    salePrice: 19.99,
    lastMovementAt: new Date(Date.UTC(2026, 7, 3, 14, 20, 0)),
    ...overrides,
  }
}

describe('G2 - Türkçe karakter gidiş-dönüş', () => {
  it('on iki Türkçe harf bozulmadan geri okunuyor', async () => {
    const buffer = await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(true),
      rows: [stockRow({ name: TR_ALPHABET })],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getRow(2).getCell(2).value).toBe(TR_ALPHABET)
  })

  it.each(TR_NAMES)('ürün adı bozulmuyor: %s', async (name) => {
    const buffer = await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(false),
      rows: [stockRow({ name })],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getRow(2).getCell(2).value).toBe(name)
  })

  it('sütun başlıkları da Türkçe ve bozulmuyor', async () => {
    // Başlıklar ayrı bir kod yolundan (columns API) yazılıyor; veri
    // doğruyken başlığın bozulması mümkün.
    const buffer = await buildWorkbook({ name: 'Stok', columns: stockColumns(true), rows: [] })
    const { sheet } = await readBack(buffer)
    const headers = stockColumns(true).map((_, i) => sheet.getRow(1).getCell(i + 1).value)

    expect(headers).toContain('Ürün Adı')
    expect(headers).toContain('Kritik Seviye')
    expect(headers).toContain('Alış Fiyatı')
  })

  it('sayfa adı ve not alanı da Türkçe taşıyor', async () => {
    const buffer = await buildWorkbook({
      name: 'Hareketler',
      columns: movementColumns(false),
      rows: [movementRow({ note: 'Şubat sevkiyatı — ıslak imza yok' })],
    })
    const { workbook, sheet } = await readBack(buffer)

    expect(workbook.worksheets[0]?.name).toBe('Hareketler')
    expect(sheet.getRow(2).getCell(9).value).toBe('Şubat sevkiyatı — ıslak imza yok')
  })

  it('sebep ve rol etiketleri Türkçe yazılıyor', async () => {
    // Excel'e ham enum ('SALE') yazsaydık rapor muhasebeciye anlamsız gider.
    const buffer = await buildWorkbook({
      name: 'Hareketler',
      columns: movementColumns(false),
      rows: [movementRow({ reason: 'SALE', userRole: 'STAFF' })],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getRow(2).getCell(5).value).toBe('Çalışan')
    expect(sheet.getRow(2).getCell(6).value).toBe('Satış')
  })
})

function movementRow(overrides: Partial<MovementExportRow> = {}): MovementExportRow {
  return {
    createdAt: new Date(Date.UTC(2026, 7, 3, 14, 20, 0)),
    sku: 'KAL-001',
    productName: 'Kırmızı Tükenmez Kalem',
    userName: 'Ayşe Yılmaz',
    userRole: 'ADMIN',
    reason: 'PURCHASE',
    delta: 12.5,
    unit: 'ADET',
    note: null,
    unitPrice: 3.75,
    ...overrides,
  }
}

describe('G2 - tarih biçimi', () => {
  it('tarih METİN değil gerçek Date olarak yazılıyor', async () => {
    // Metin yazsaydık Excel'de sıralama ve tarih filtresi çalışmazdı;
    // "son bir haftayı göster" isteyen kullanıcı bunu yapamazdı.
    const buffer = await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(false),
      rows: [stockRow()],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getRow(2).getCell(8).value).toBeInstanceOf(Date)
  })

  it('biçim gg.aa.yyyy ss:dd', async () => {
    // Türkiye'de aa/gg okuyan biri 03.08'i 8 Mart sanar. Biçim maskesi
    // varsayılana bırakılamaz.
    const buffer = await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(false),
      rows: [stockRow()],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getColumn(8).numFmt).toBe(DATE_FORMAT)
    expect(DATE_FORMAT).toBe('dd.mm.yyyy hh:mm')
  })

  it('hareket tarihi de aynı biçimde', async () => {
    const buffer = await buildWorkbook({
      name: 'Hareketler',
      columns: movementColumns(false),
      rows: [movementRow()],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getRow(2).getCell(1).value).toBeInstanceOf(Date)
    expect(sheet.getColumn(1).numFmt).toBe(DATE_FORMAT)
  })
})

describe('G2 - sayı biçimi', () => {
  it('miktar METİN değil sayı olarak yazılıyor', async () => {
    // Metin olsaydı kullanıcı sütunun toplamını alamaz, raporun yarısı
    // işe yaramazdı.
    const buffer = await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(false),
      rows: [stockRow({ qty: 1234.5 })],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getRow(2).getCell(6).value).toBe(1234.5)
    expect(typeof sheet.getRow(2).getCell(6).value).toBe('number')
  })

  it('miktar üç ondalık, para iki ondalık biçiminde', async () => {
    const buffer = await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(true),
      rows: [stockRow()],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getColumn(6).numFmt).toBe(QTY_FORMAT)
    expect(sheet.getColumn(8).numFmt).toBe(MONEY_FORMAT)
  })

  it('negatif miktar (çıkış) işaretiyle korunuyor', async () => {
    const buffer = await buildWorkbook({
      name: 'Hareketler',
      columns: movementColumns(false),
      rows: [movementRow({ delta: -7.25 })],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getRow(2).getCell(7).value).toBe(-7.25)
  })

  it('üç ondalıklı miktar yuvarlanmıyor', async () => {
    const buffer = await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(false),
      rows: [stockRow({ qty: 0.125, unit: 'KG' })],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getRow(2).getCell(6).value).toBe(0.125)
  })
})

describe('fiyat sütunları rol ile geliyor (tehdit S7)', () => {
  it('çalışan sürümünde fiyat sütunu HİÇ YOK', async () => {
    // Boş bırakmak yetmezdi: sütun başlığı bile "bu bilgi var ama sana
    // gösterilmiyor" demek olur ve Excel'de gizli sütun bir güvenlik
    // önlemi değildir.
    const buffer = await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(false),
      rows: [stockRow()],
    })
    const { sheet } = await readBack(buffer)
    const headers = sheet.getRow(1).values as unknown[]

    expect(headers).not.toContain('Alış Fiyatı')
    expect(headers).not.toContain('Satış Fiyatı')
    expect(JSON.stringify(sheet.getRow(2).values)).not.toContain('12.34')
  })

  it('admin sürümünde fiyat sütunları dolu', async () => {
    const buffer = await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(true),
      rows: [stockRow()],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getRow(2).getCell(8).value).toBe(12.34)
    expect(sheet.getRow(2).getCell(9).value).toBe(19.99)
  })
})

describe('çalışma kitabı yapısı', () => {
  it('başlık satırı donduruluyor ve kalın', async () => {
    const buffer = await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(false),
      rows: [stockRow()],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.views[0]?.state).toBe('frozen')
    expect(sheet.getRow(1).font?.bold).toBe(true)
  })

  it('boş rapor da geçerli bir dosya üretiyor', async () => {
    // Boş sonuç bir hata değil: "bu tarihte hareket yok" da bir cevap.
    // Bozuk dosya indirmek ise kullanıcıyı sisteme güvensiz yapar.
    const buffer = await buildWorkbook({ name: 'Stok', columns: stockColumns(false), rows: [] })
    const { sheet } = await readBack(buffer)

    expect(buffer.length).toBeGreaterThan(0)
    expect(sheet.rowCount).toBe(1) // sadece başlık
  })

  it('boş değerler boş hücre olarak yazılıyor', async () => {
    const buffer = await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(false),
      rows: [stockRow({ category: null, brand: null, lastMovementAt: null })],
    })
    const { sheet } = await readBack(buffer)

    expect(sheet.getRow(2).getCell(3).value).toBeNull()
    expect(sheet.getRow(2).getCell(8).value).toBeNull()
  })
})

describe('dosya adı', () => {
  it('Türkçe karakter ve boşluk içermiyor', async () => {
    // Bazı SMTP sunucuları ve eski tarayıcılar UTF-8 dosya adını bozuyor;
    // kullanıcı "rapor_A_ustos.xlsx" indiriyor.
    const name = exportFileName('stok', new Date(Date.UTC(2026, 7, 3, 14, 20)))

    expect(name).toMatch(/^[a-z0-9-]+\.xlsx$/)
    expect(name).toContain('20260803')
  })
})

/**
 * ============================================================================
 * WS-C-lite — EXCEL SAATİ Europe/Istanbul
 *
 * Kapatılan hata: 12:15'te girilen hareket Excel'de 09:15, gece 00:30'daki
 * bir önceki günde görünüyordu. exceljs seri sayıyı anın UTC duvar
 * saatinden üretiyor ve Excel hücresinde saat dilimi yok.
 *
 * NASIL OKUNUYOR: exceljs geri okurken seriyi UTC bileşenli bir `Date`'e
 * çeviriyor; yani okunan `Date`'in UTC bileşenleri tam olarak Excel'in
 * ekranda gösterdiği gün ve saat. `excelShows` onu Excel biçiminde yazıyor,
 * `serialOf` hücredeki ham sayıyı geri hesaplıyor.
 * ============================================================================
 */
function excelShows(value: unknown): string {
  expect(value).toBeInstanceOf(Date)
  const d = value as Date
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

function serialOf(value: unknown): number {
  return (value as Date).getTime() / 86_400_000 + 25_569
}

async function movementCellAt(at: Date): Promise<unknown> {
  const buffer = await buildWorkbook({
    name: 'Hareketler',
    columns: movementColumns(false),
    rows: [movementRow({ createdAt: at })],
  })
  const { sheet } = await readBack(buffer)
  return sheet.getRow(2).getCell(1).value
}

/** Süreç saat dilimini geçici olarak değiştirir; Node `process.env.TZ`
 *  atamasını anında uyguluyor. Vitest tek fork'ta sıralı koşuyor. */
async function withProcessTz<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.TZ
  process.env.TZ = tz
  try {
    return await fn()
  } finally {
    // `= undefined` "undefined" METNİNİ yazar ve UTC'ye düşer; silmek gerekiyor.
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

describe('WS-C-lite — Excel saati Europe/Istanbul', () => {
  it('normal saat: 09:15 UTC hareketi 12:15 görünüyor', async () => {
    const cell = await movementCellAt(new Date('2026-10-10T09:15:00Z'))

    expect(excelShows(cell)).toBe('10.10.2026 12:15')
    expect(serialOf(cell)).toBeCloseTo(46305.510416666664, 9)
  })

  it('UTC günü ile Türkiye günü farklı: 21:30 UTC hareketi ERTESİ gün 00:30', async () => {
    // UTC'de hâlâ 9 Ekim, Türkiye'de 10 Ekim. Eski davranışta satır
    // "09.10.2026 21:30" görünüyor ve gün bazlı süzmede yanlış güne düşüyordu.
    const cell = await movementCellAt(new Date('2026-10-09T21:30:00Z'))

    expect(excelShows(cell)).toBe('10.10.2026 00:30')
    expect(serialOf(cell)).toBeCloseTo(46305.020833333336, 9)
  })

  it('gece yarısı ve yıl sınırı: saat "24" olmuyor', async () => {
    const cell = await movementCellAt(new Date('2026-12-31T21:00:00Z'))

    expect(excelShows(cell)).toBe('01.01.2027 00:00')
  })

  it('sabit +3 değil, IANA: 2015 kışı +2, yazı +3', async () => {
    // Türkiye 2016'ya kadar yaz saati uyguluyordu; devir ve eski hareketler
    // o yıllara düşebilir. Sabit ofset kışın bir saat ileri gösterirdi.
    expect(excelShows(await movementCellAt(new Date('2015-01-15T10:00:00Z')))).toBe(
      '15.01.2015 12:00',
    )
    expect(excelShows(await movementCellAt(new Date('2015-07-01T10:00:00Z')))).toBe(
      '01.07.2015 13:00',
    )
  })

  it('stok "Son Hareket" ve gün sonu tarzı "Saat" sütunu da aynı kurala uyuyor', async () => {
    // Dönüşüm sütun tanımında değil `buildWorkbook`'ta: cron'un `hh:mm`
    // biçimli sütunu da, ileride eklenecek bir tarih sütunu da kapsanıyor.
    const at = new Date('2026-10-09T21:30:00Z')
    const stock = await readBack(
      await buildWorkbook({
        name: 'Stok',
        columns: stockColumns(false),
        rows: [stockRow({ lastMovementAt: at })],
      }),
    )
    const daily = await readBack(
      await buildWorkbook({
        name: 'Gün sonu',
        columns: [{ header: 'Saat', width: 10, value: (r: { at: Date }) => r.at, format: 'hh:mm' }],
        rows: [{ at }],
      }),
    )

    expect(excelShows(stock.sheet.getRow(2).getCell(8).value)).toBe('10.10.2026 00:30')
    expect(excelShows(daily.sheet.getRow(2).getCell(1).value)).toBe('10.10.2026 00:30')
    expect(daily.sheet.getColumn(1).numFmt).toBe('hh:mm')
  })

  it('sonuç sunucunun saat diliminden bağımsız (hücre ve dosya adı)', async () => {
    // Vercel/Supabase UTC, pilot laptop İstanbul, bir geliştirici başka bir
    // yerde: üçünde de aynı dosya çıkmalı.
    const at = new Date('2026-10-09T21:30:00Z')
    const seen: string[] = []
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/Istanbul']) {
      seen.push(
        await withProcessTz(tz, async () => {
          const cell = excelShows(await movementCellAt(at))
          return `${cell} | ${exportFileName('hareket', at)}`
        }),
      )
    }

    expect(new Set(seen)).toEqual(new Set(['10.10.2026 00:30 | hareket-20261010-0030.xlsx']))
  })

  it('dosya adı damgası İstanbul saatinde', () => {
    expect(exportFileName('hareket', new Date('2026-10-09T21:30:00Z'))).toBe(
      'hareket-20261010-0030.xlsx',
    )
  })

  it('iç değer değişmiyor: girdi Date UTC an olarak kalıyor, takvim günü ve sayı kaymıyor', async () => {
    const at = new Date('2026-10-09T21:30:00Z')
    const buffer = await buildWorkbook({
      name: 'Hareketler',
      columns: movementColumns(true),
      rows: [movementRow({ createdAt: at, priceDate: '2021-06-12', delta: 12.5 })],
    })
    const { sheet } = await readBack(buffer)

    // Dönüşüm yeni bir nesne üretmeli. Girdiyi yerinde değiştirseydi aynı
    // satır nesnesini kullanan her şey (e-posta, sayım) üç saat kaymış anı görürdü.
    expect(at.toISOString()).toBe('2026-10-09T21:30:00.000Z')
    // "Fiyat Tarihi" takvim günü, metin olarak yazılıyor ve saat dilimine girmiyor.
    expect(sheet.getRow(2).getCell(13).value).toBe('12.06.2021')
    expect(sheet.getRow(2).getCell(7).value).toBe(12.5)
  })
})
