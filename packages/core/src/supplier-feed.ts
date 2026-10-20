import {
  AppError,
  type Currency,
  SUPPLIER_PRICE_TYPE_VALUES,
  type SupplierFeedItem,
  type SupplierPriceType,
  type TaxMode,
  supplierFeedItemSchema,
} from '@stok/shared'
import { z } from 'zod'
import { normalizeHeader, parseTurkishNumber, readSheet } from './import'
import { issuesOf, validationError } from './validate'

/**
 * ============================================================================
 * T200 — TEDARİKÇİ DOSYASINI OKUMA (saf, I/O yok)
 *
 *   dosya (.xlsx / .csv / .json)
 *     → parseSupplierFile()      dosya düzeyi kontrol; ham hücreler
 *     → normalizeSupplierRows()  tedarikçinin varsayılanları + satır doğrulaması
 *     → SupplierFeedItem[] + satır hataları + uyarılar
 *
 * İKİ AYRI RET DÜZEYİ:
 *   dosya düzeyi  başlık yok, zorunlu sütun yok, aynı alana iki sütun, satır
 *                 sınırı aşıldı, veri satırı yok → DOSYANIN TAMAMI reddedilir.
 *                 Bunlar satırların neye göre okunacağını belirsiz bırakır;
 *                 tek satırı bile yazmak tahmin olurdu.
 *   satır düzeyi  fiyat boş, eksi stok, tanınmayan para birimi → yalnız o
 *                 satır atlanır ve listelenir (içe aktarmadaki ilke: tek bozuk
 *                 satır yüzünden 499 doğru satır reddedilmez).
 *
 * Ham hücreler (`ParsedSupplierFile`) önizleme ile kayıt arasında istemcide
 * bekliyor ve kayıtta geri geliyor; sunucu onları yeniden doğrular ve
 * sınıflandırmayı kendisi yapar (içe aktarmadaki gerekçe, `import.ts`).
 * ============================================================================
 */

/** Tek dosyada en fazla kalem. 4 MB yükleme sınırıyla birlikte ölçülecek. */
export const SUPPLIER_ROW_LIMIT = 5_000

/**
 * SÜTUN ADLARININ önizlemedeki sınırları: okunmayan sütunlardan en fazla bu
 * kadarı listelenir (kalanı sayılır), her ad bu uzunlukta "…" ile kısaltılır.
 *
 * Yalnız GÖSTERİM metaverisi; dosyadaki değerlere dokunmuyor. Ayrıştırıcı ve
 * kayıt şeması (`parsedSupplierFileSchema`) aynı sabitleri okuyor. Ayrı
 * yazılmışlardı: ayrıştırıcı sınırsızdı, şema 200'de kesiyordu ve 210 sütunlu
 * ya da uzun başlıklı bir dosya önizlemeden geçip kayıtta bütünüyle
 * reddediliyordu (T200 1b REVIEW, B1).
 */
export const SUPPLIER_HEADER_LIMIT = 200
export const SUPPLIER_IGNORED_COLUMN_LIMIT = 200

/** Sütun adını gösterim sınırına indirir; kısaltıldığı "…" ile görünür. */
function headerLabel(header: string): string {
  return header.length > SUPPLIER_HEADER_LIMIT
    ? `${header.slice(0, SUPPLIER_HEADER_LIMIT - 1)}…`
    : header
}

export type FeedField =
  | 'supplierCode'
  | 'barcode'
  | 'name'
  | 'brand'
  | 'price'
  | 'currency'
  | 'taxMode'
  | 'priceType'
  | 'priceQty'
  | 'stockQty'
  | 'sourceUpdatedAt'

const FEED_FIELDS: FeedField[] = [
  'supplierCode',
  'barcode',
  'name',
  'brand',
  'price',
  'currency',
  'taxMode',
  'priceType',
  'priceQty',
  'stockQty',
  'sourceUpdatedAt',
]

/** Kullanıcının dosyada arayacağı ad. */
export const FEED_FIELD_LABELS: Record<FeedField, string> = {
  supplierCode: 'Tedarikçi Kodu',
  barcode: 'Barkod',
  name: 'Ürün Adı',
  brand: 'Marka',
  price: 'Fiyat',
  currency: 'Para Birimi',
  taxMode: 'KDV Durumu',
  priceType: 'Fiyat Türü',
  priceQty: 'Fiyat Miktarı',
  stockQty: 'Stok',
  sourceUpdatedAt: 'Güncelleme Zamanı',
}

interface HeaderAlias {
  field: FeedField
  /** Sütun adı fiyatın türünü kendisi söylüyorsa ("Liste Fiyatı"). */
  priceType?: SupplierPriceType
}

/**
 * Tablo dosyası başlıkları (`normalizeHeader` hâliyle). Ürün içe aktarmasının
 * eş ad tablosundan AYRI: orada "Ürün Kodu" bizim stok kodumuz, tedarikçi
 * dosyasında tedarikçinin kodu.
 *
 * BİLEREK YOK:
 *   "Koli İçi Adet"  Çoğu listede bilgi amaçlı; fiyatın koliye ait olduğunu
 *                    söylemez. Fiyat miktarı sayılsaydı adet fiyatı koli
 *                    fiyatı gibi okunurdu (T200). Okunmayan sütun olarak görünür.
 *   "KDV"            Çoğu listede ORAN ("20"), durum değil. Durum sütunu
 *                    sayılsaydı her satır "tanınmayan KDV durumu" ile düşerdi.
 *   tarih sütunları  Saat dilimsiz tarih bir saat dilimi politikası ister
 *                    (`DAT-16` açık). Kaynak zamanı yalnız JSON'da, saat
 *                    dilimli ISO 8601 olarak okunur.
 */
const HEADER_ALIASES: Record<string, HeaderAlias> = {
  'tedarikci kodu': { field: 'supplierCode' },
  'tedarikci urun kodu': { field: 'supplierCode' },
  'urun kodu': { field: 'supplierCode' },
  'stok kodu': { field: 'supplierCode' },
  kod: { field: 'supplierCode' },
  sku: { field: 'supplierCode' },
  barkod: { field: 'barcode' },
  barcode: { field: 'barcode' },
  ean: { field: 'barcode' },
  gtin: { field: 'barcode' },
  'urun adi': { field: 'name' },
  ad: { field: 'name' },
  urun: { field: 'name' },
  isim: { field: 'name' },
  name: { field: 'name' },
  'urun aciklamasi': { field: 'name' },
  marka: { field: 'brand' },
  brand: { field: 'brand' },
  fiyat: { field: 'price' },
  'birim fiyat': { field: 'price' },
  'birim fiyati': { field: 'price' },
  price: { field: 'price' },
  'liste fiyati': { field: 'price', priceType: 'LIST' },
  'liste fiyat': { field: 'price', priceType: 'LIST' },
  'net fiyat': { field: 'price', priceType: 'NET' },
  'net fiyati': { field: 'price', priceType: 'NET' },
  'net birim fiyat': { field: 'price', priceType: 'NET' },
  'para birimi': { field: 'currency' },
  doviz: { field: 'currency' },
  'doviz cinsi': { field: 'currency' },
  currency: { field: 'currency' },
  'kdv durumu': { field: 'taxMode' },
  'vergi durumu': { field: 'taxMode' },
  'fiyat turu': { field: 'priceType' },
  'fiyat tipi': { field: 'priceType' },
  'fiyat miktari': { field: 'priceQty' },
  stok: { field: 'stockQty' },
  'stok miktari': { field: 'stockQty' },
  'stok adedi': { field: 'stockQty' },
  'mevcut stok': { field: 'stockQty' },
  mevcut: { field: 'stockQty' },
  miktar: { field: 'stockQty' },
  stock: { field: 'stockQty' },
}

/** JSON sözleşmesinin anahtarları ("örnek API verisi"; T201 de buna yazacak). */
const JSON_KEYS: Record<string, FeedField> = {
  supplierCode: 'supplierCode',
  barcode: 'barcode',
  name: 'name',
  brand: 'brand',
  price: 'price',
  currency: 'currency',
  taxMode: 'taxMode',
  priceType: 'priceType',
  priceQty: 'priceQty',
  stockQty: 'stockQty',
  updatedAt: 'sourceUpdatedAt',
}

export interface SupplierFileRow {
  /** Tabloda dosyadaki satır numarası (başlık 1); JSON'da kalemin sırası (1'den). */
  rowNumber: number
  cells: Partial<Record<FeedField, string>>
  /** JSON'da metin ya da sayı olmayan değer taşıyan alanlar. */
  typeErrors?: FeedField[]
}

export interface ParsedSupplierFile {
  rows: SupplierFileRow[]
  /** Tanınan sütunlar ve dosyadaki adları. Önizleme "şunları okudum" diye gösterir. */
  columns: { field: FeedField; header: string }[]
  /**
   * Okunmayan sütunlar, dosyadaki yazımıyla. Sessizce yok sayılmıyor. En fazla
   * `SUPPLIER_IGNORED_COLUMN_LIMIT` ad; uzun ad `headerLabel` ile kısaltılmış.
   */
  ignoredColumns: string[]
  /** Listeye sığmayan okunmayan sütun sayısı; ekran "…ve N sütun daha" der. */
  ignoredColumnsOmitted?: number
  /** Fiyat sütununun adından gelen tür ("Liste Fiyatı" → LIST). */
  headerPriceType?: SupplierPriceType
}

const feedFieldEnum = z.enum(FEED_FIELDS as [FeedField, ...FeedField[]])

/**
 * Önizlemeden kayda istemciden geri gelen dosyanın şeması. Gelen veri
 * kullanıcı verisidir; hücreler yine `normalizeSupplierRows`'tan geçer.
 *
 * HÜCREDE UZUNLUK SINIRI YOK, bilerek. Değerin uzunluk kuralı tek yerde:
 * `supplierFeedItemSchema` (kod 100, ad 300, marka 100, barkod 64), ve orada
 * satır düzeyinde Türkçe hata üretiyor. Burada ikinci bir sınır (1.000'di)
 * önizlemenin satır hatası saydığı uzun değeri kayıtta BÜTÜN dosyanın reddine
 * çeviriyordu. Değeri kesmek de çözüm değildi: kod ve ad sessizce değişirdi.
 * Blob'un toplam boyutunu çağıran sınırlıyor (web: `SUPPLIER_SAVE_BLOB_LIMIT`,
 * `JSON.parse`'tan önce).
 */
export const parsedSupplierFileSchema = z.object({
  rows: z
    .array(
      z.object({
        rowNumber: z.number().int().positive(),
        cells: z.record(feedFieldEnum, z.string()),
        typeErrors: z.array(feedFieldEnum).max(FEED_FIELDS.length).optional(),
      }),
    )
    .max(SUPPLIER_ROW_LIMIT),
  columns: z
    .array(z.object({ field: feedFieldEnum, header: z.string().max(SUPPLIER_HEADER_LIMIT) }))
    .max(FEED_FIELDS.length),
  ignoredColumns: z.array(z.string().max(SUPPLIER_HEADER_LIMIT)).max(SUPPLIER_IGNORED_COLUMN_LIMIT),
  ignoredColumnsOmitted: z.number().int().positive().optional(),
  headerPriceType: z
    .enum(SUPPLIER_PRICE_TYPE_VALUES as [SupplierPriceType, ...SupplierPriceType[]])
    .optional(),
})

export function parseSupplierFileBlob(raw: unknown): ParsedSupplierFile {
  const parsed = parsedSupplierFileSchema.safeParse(raw)
  if (!parsed.success) throw validationError(issuesOf(parsed.error))
  return parsed.data as ParsedSupplierFile
}

export interface ParseSupplierFileOptions {
  rowLimit?: number
}

/** Dosyayı ham hücrelere çevirir. Dosya düzeyindeki her sorunda fırlatır. */
export async function parseSupplierFile(
  buffer: Buffer,
  fileName: string,
  options: ParseSupplierFileOptions = {},
): Promise<ParsedSupplierFile> {
  const limit = options.rowLimit ?? SUPPLIER_ROW_LIMIT
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.json')) return parseJsonFeed(buffer, limit)
  if (lower.endsWith('.csv') || lower.endsWith('.xlsx')) {
    return parseTableFeed(await readSheet(buffer, fileName), limit)
  }
  throw new AppError('SUPPLIER_FEED_UNREADABLE', 'unsupported file type')
}

function parseTableFeed(matrix: string[][], limit: number): ParsedSupplierFile {
  const headerRow = matrix[0]
  if (!headerRow || headerRow.every((c) => c.trim() === '')) {
    throw new AppError('IMPORT_NO_HEADER', 'file has no header row')
  }

  const indexOf: Partial<Record<FeedField, number>> = {}
  const columns: { field: FeedField; header: string }[] = []
  const ignoredColumns: string[] = []
  let ignoredColumnsOmitted = 0
  let headerPriceType: SupplierPriceType | undefined

  headerRow.forEach((raw, index) => {
    const header = raw.trim()
    if (header === '') return
    const alias = HEADER_ALIASES[normalizeHeader(header)]
    if (!alias) {
      if (ignoredColumns.length < SUPPLIER_IGNORED_COLUMN_LIMIT) ignoredColumns.push(headerLabel(header))
      else ignoredColumnsOmitted += 1
      return
    }
    const earlier = columns.find((c) => c.field === alias.field)
    if (earlier) {
      throw new AppError('SUPPLIER_FEED_DUPLICATE_COLUMN', `two columns map to ${alias.field}`, {
        field: FEED_FIELD_LABELS[alias.field],
        columns: `"${earlier.header}", "${header}"`,
      })
    }
    indexOf[alias.field] = index
    // Eş ad başlıktaki noktalamayı yok sayıyor: "Fiyat........" de fiyattır.
    columns.push({ field: alias.field, header: headerLabel(header) })
    if (alias.priceType) headerPriceType = alias.priceType
  })

  const has = (f: FeedField) => indexOf[f] !== undefined
  if (!has('name') || !has('price') || (!has('supplierCode') && !has('barcode'))) {
    throw new AppError('SUPPLIER_FEED_MISSING_COLUMN', 'required columns missing', {
      found: headerRow
        .map((h) => h.trim())
        .filter(Boolean)
        .join(', '),
    })
  }

  const rows: SupplierFileRow[] = []
  for (let i = 1; i < matrix.length; i += 1) {
    const raw = matrix[i]!
    if (raw.every((c) => c.trim() === '')) continue
    if (rows.length >= limit) {
      throw new AppError('IMPORT_TOO_LARGE', `file has more than ${limit} rows`, { limit })
    }
    const cells: Partial<Record<FeedField, string>> = {}
    for (const [field, index] of Object.entries(indexOf) as [FeedField, number][]) {
      cells[field] = (raw[index] ?? '').trim()
    }
    rows.push({ rowNumber: i + 1, cells })
  }

  if (rows.length === 0) {
    throw new AppError('SUPPLIER_FEED_NO_VALID_ROWS', 'file has no data rows')
  }
  return {
    rows,
    columns,
    ignoredColumns,
    ...(ignoredColumnsOmitted > 0 ? { ignoredColumnsOmitted } : {}),
    headerPriceType,
  }
}

const jsonEnvelopeSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
})

function parseJsonFeed(buffer: Buffer, limit: number): ParsedSupplierFile {
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new AppError('SUPPLIER_FEED_UNREADABLE', 'invalid JSON')
    }
    throw err
  }

  const envelope = jsonEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    throw new AppError('SUPPLIER_FEED_UNREADABLE', 'JSON is not { items: [...] }')
  }
  const items = envelope.data.items
  if (items.length > limit) {
    throw new AppError('IMPORT_TOO_LARGE', `file has more than ${limit} rows`, { limit })
  }
  if (items.length === 0) {
    throw new AppError('SUPPLIER_FEED_NO_VALID_ROWS', 'file has no items')
  }

  const seenFields = new Set<FeedField>()
  const ignored = new Set<string>()
  const rows: SupplierFileRow[] = items.map((item, index) => {
    const cells: Partial<Record<FeedField, string>> = {}
    const typeErrors: FeedField[] = []
    for (const [key, value] of Object.entries(item)) {
      const field = JSON_KEYS[key]
      if (!field) {
        ignored.add(key)
        continue
      }
      seenFields.add(field)
      if (value === null || value === undefined) continue
      if (typeof value === 'string') cells[field] = value.trim()
      else if (typeof value === 'number') cells[field] = String(value)
      else typeErrors.push(field)
    }
    return typeErrors.length > 0
      ? { rowNumber: index + 1, cells, typeErrors }
      : { rowNumber: index + 1, cells }
  })

  const ignoredOmitted = Math.max(0, ignored.size - SUPPLIER_IGNORED_COLUMN_LIMIT)
  return {
    rows,
    columns: FEED_FIELDS.filter((f) => seenFields.has(f)).map((field) => ({
      field,
      header: Object.keys(JSON_KEYS).find((k) => JSON_KEYS[k] === field)!,
    })),
    ignoredColumns: [...ignored].slice(0, SUPPLIER_IGNORED_COLUMN_LIMIT).map(headerLabel),
    ...(ignoredOmitted > 0 ? { ignoredColumnsOmitted: ignoredOmitted } : {}),
  }
}

// ---------------------------------------------------------------------------
// SATIR DOĞRULAMASI
// ---------------------------------------------------------------------------

/** Dosyada sütunu olmayan satırlara uygulanan, tedarikçide beyan edilmiş koşullar. */
export interface SupplierDefaults {
  currency: Currency
  taxMode: TaxMode
  priceType: SupplierPriceType
}

export interface FeedItemRow extends SupplierFeedItem {
  rowNumber: number
}

export interface FeedRowIssue {
  rowNumber: number
  supplierCode: string
  name: string
  messages: string[]
}

export interface NormalizedFeed {
  items: FeedItemRow[]
  errors: FeedRowIssue[]
  warnings: FeedRowIssue[]
}

/** Para birimi: kod, Türkçe ad ya da sembol. Kullanıcı kod değil kelime yazar. */
const CURRENCY_WORDS: Record<string, Currency> = {
  try: 'TRY',
  tl: 'TRY',
  ytl: 'TRY',
  'turk lirasi': 'TRY',
  usd: 'USD',
  dolar: 'USD',
  'abd dolari': 'USD',
  eur: 'EUR',
  euro: 'EUR',
  avro: 'EUR',
}
const CURRENCY_SYMBOLS: Record<string, Currency> = { '₺': 'TRY', $: 'USD', '€': 'EUR' }

function parseCurrency(raw: string): Currency | null {
  return CURRENCY_SYMBOLS[raw.trim()] ?? CURRENCY_WORDS[normalizeHeader(raw)] ?? null
}

/**
 * KDV durumu: yalnız TAM değer, alt dize değil. Alt dize araması "KDV Dahil
 * Değil" ve "Dahil değildir" değerlerini KDV dahil okuyordu; fiyat sessizce
 * yanlış karşılaştırma grubuna giriyordu (T200 REVIEW). Burada olmayan her
 * değer satır hatası olur: tahmin edilen KDV durumu yanlış kıyas üretir.
 */
const TAX_MODE_WORDS: Record<string, TaxMode> = {
  dahil: 'INCLUDED',
  'kdv dahil': 'INCLUDED',
  included: 'INCLUDED',
  haric: 'EXCLUDED',
  'kdv haric': 'EXCLUDED',
  excluded: 'EXCLUDED',
}

function parseTaxMode(raw: string): TaxMode | null {
  return TAX_MODE_WORDS[normalizeHeader(raw)] ?? null
}

function parsePriceType(raw: string): SupplierPriceType | null {
  const text = normalizeHeader(raw)
  if (text === 'net' || text === 'net alis') return 'NET'
  if (text === 'list' || text === 'liste') return 'LIST'
  return null
}

/**
 * Ham satırları doğrular ve tedarikçinin varsayılanlarını uygular. Satırdaki
 * sütun varsayılandan önceliklidir. HİÇBİR ŞEY YAZMAZ.
 *
 * `priceQty` yalnız satır açıkça söylerse dolar; tedarikçinin birim beyanı ve
 * barkod bilgisi veritabanına bakan katmanda uygulanır (`suppliers.ts`).
 */
export function normalizeSupplierRows(
  file: ParsedSupplierFile,
  defaults: SupplierDefaults,
): NormalizedFeed {
  const items: FeedItemRow[] = []
  const errors: FeedRowIssue[] = []
  const warnings: FeedRowIssue[] = []
  const seen = new Map<string, number>()

  for (const row of file.rows) {
    const c = row.cells
    const messages: string[] = []
    const notes: string[] = []
    const supplierCode = c.supplierCode || c.barcode || ''
    const name = c.name ?? ''

    for (const field of row.typeErrors ?? []) {
      messages.push(`${FEED_FIELD_LABELS[field]} metin ya da sayı olmalı`)
    }
    if (supplierCode === '') messages.push('Tedarikçi kodu ve barkod boş')
    if (name === '') messages.push('Ürün adı boş')

    // DOSYA İÇİ MÜKERRER: ikinci satır birincinin fiyatını sessizce ezerdi.
    if (supplierCode !== '') {
      const before = seen.get(supplierCode)
      if (before !== undefined) messages.push(`Bu kod ${before}. satırda da var`)
      else seen.set(supplierCode, row.rowNumber)
    }

    const price = parseTurkishNumber(c.price ?? '')
    if (price === undefined) messages.push('Fiyat boş')
    else if (Number.isNaN(price)) messages.push('Fiyat sayı değil')

    let currency: Currency = defaults.currency
    if (c.currency) {
      const parsed = parseCurrency(c.currency)
      if (parsed) currency = parsed
      else messages.push(`Para birimi tanınmadı: ${c.currency}`)
    }

    let taxMode: TaxMode = defaults.taxMode
    if (c.taxMode) {
      const parsed = parseTaxMode(c.taxMode)
      if (parsed) taxMode = parsed
      else messages.push(`KDV durumu tanınmadı: ${c.taxMode}`)
    }

    let priceType: SupplierPriceType = file.headerPriceType ?? defaults.priceType
    if (c.priceType) {
      const parsed = parsePriceType(c.priceType)
      if (parsed) priceType = parsed
      else messages.push(`Fiyat türü tanınmadı: ${c.priceType}`)
    }

    const priceQty = c.priceQty ? parseTurkishNumber(c.priceQty) : undefined
    if (priceQty !== undefined && Number.isNaN(priceQty)) messages.push('Fiyat miktarı sayı değil')

    // Stok "Var", ">50" gibi metin gelebiliyor. Fiyat asıl bilgi; stoğu
    // okunamadı diye satırı reddetmek fiyatı da kaybettirirdi.
    let stockQty = c.stockQty ? parseTurkishNumber(c.stockQty) : undefined
    if (stockQty !== undefined && Number.isNaN(stockQty)) {
      notes.push(`Stok sayı değil (${c.stockQty}); boş bırakıldı`)
      stockQty = undefined
    }

    if (messages.length === 0) {
      const parsed = supplierFeedItemSchema.safeParse({
        supplierCode,
        barcode: c.barcode || undefined,
        name,
        brand: c.brand || undefined,
        price,
        currency,
        taxMode,
        priceType,
        priceQty,
        stockQty,
        sourceUpdatedAt: c.sourceUpdatedAt || undefined,
      })
      if (parsed.success) {
        items.push({ ...parsed.data, rowNumber: row.rowNumber })
      } else {
        for (const issue of parsed.error.issues) {
          // Alan adı önde: zod'un uzunluk mesajı hangi sütunun uzun olduğunu söylemiyor.
          const label = FEED_FIELD_LABELS[issue.path[0] as FeedField]
          messages.push(label ? `${label}: ${issue.message}` : issue.message)
        }
      }
    }

    if (messages.length > 0) {
      errors.push({ rowNumber: row.rowNumber, supplierCode, name, messages })
    } else if (notes.length > 0) {
      warnings.push({ rowNumber: row.rowNumber, supplierCode, name, messages: notes })
    }
  }

  return { items, errors, warnings }
}
