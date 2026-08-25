import {
  AppError,
  type BarcodeKind,
  type Unit,
  BARCODE_KINDS,
  UNITS,
  UNIT_VALUES,
  createProductSchema,
  errorText,
  multiplierMatchesKind,
  updateProductSchema,
} from '@stok/shared'
import { type Db, products, withTenant } from '@stok/db'
import { and, eq, inArray } from 'drizzle-orm'
import ExcelJS from 'exceljs'
import { type Actor, requirePermission } from './authz.js'
import type { SheetColumn } from './excel.js'
import { addBarcode, createProduct, listBarcodes, updateProduct } from './products.js'
import { issuesOf, validationError } from './validate.js'
import { z } from 'zod'

/**
 * ============================================================================
 * T23 / E1 — TOPLU ÜRÜN İÇE AKTARMA
 *
 * Bu olmadan sistem İLK GÜN kurulamaz: 800 kalemlik bir depoyu tek tek
 * forma girmek kimsenin yapmayacağı bir iş, ve yapılmadığı için sistem
 * hiç kullanılmaya başlanmaz.
 *
 * ÜÇ ADIM, İKİSİ OKUMA:
 *
 *   1. çözümle   parseProductFile()  → satırlar, hiçbir yazma yok
 *   2. önizle    previewImport()     → her satır için karar + Türkçe sebep
 *   3. uygula    commitImport()      → sadece geçerli satırlar
 *
 * ÖNİZLEME ZORUNLU VE TEK BAŞINA DEĞERLİ. Kullanıcının elindeki dosya
 * çoğu zaman muhasebeden gelen, sütunları kayık, birimleri karışık bir
 * dosya. "Yükle ve dua et" akışı, 800 üründen 200'ünü yanlış kaydeder ve
 * hatayı fark etmek haftalar sürer.
 *
 * SATIR BAZLI HATA, DOSYA BAZLI RED DEĞİL. Tek bozuk satır yüzünden 799
 * doğru satırı reddetmek, kullanıcıyı dosyayı elle ayıklamaya zorlar.
 * Geçerli satırlar giriyor, bozuklar rapora düşüyor ve kullanıcı sadece
 * onları düzeltip tekrar yüklüyor.
 *
 * EKSİK SÜTUN "TEMİZLE" DEĞİL "DOKUNMA". Güncellenen bir üründe dosyada
 * olmayan sütun olduğu gibi kalıyor. Aksi halde sadece stok kodu ve ad
 * içeren bir düzeltme dosyası bütün fiyatları silerdi.
 * ============================================================================
 */

/** Tek istekte kabul edilen en fazla satır. */
export const IMPORT_ROW_LIMIT = 2_000

export type RowAction = 'create' | 'update' | 'error'

export interface ImportIssue {
  /** Kullanıcının dosyada arayacağı sütun başlığı. Boşsa satır geneli. */
  column: string
  message: string
}

export interface PreviewRow {
  /** Dosyadaki satır numarası (başlık satırı 1). Kullanıcı bunu arıyor. */
  rowNumber: number
  action: RowAction
  sku: string
  name: string
  issues: ImportIssue[]
  /** Doğrulanmış veri. `action === 'error'` ise yok. */
  data?: ParsedRow
  /** Güncellenecek ürünün kimliği. `action === 'update'` ise dolu. */
  productId?: string
}

export interface ImportPreview {
  rows: PreviewRow[]
  counts: { create: number; update: number; error: number }
}

export interface ParsedRow {
  sku: string
  name: string
  unit?: Unit
  category?: string | null
  brand?: string | null
  imageUrl?: string | null
  purchasePrice?: number | null
  salePrice?: number | null
  minStock?: number
  barcode?: string
  barcodeKind?: BarcodeKind
  qtyMultiplier?: number
}

/**
 * Çözümlenmiş dosyanın şeması.
 *
 * Neden gerekli: önizleme ile onay arasında dosya İSTEMCİDE duruyor
 * (gizli alanda) ve onayda geri geliyor. Yani onay adımındaki veri
 * kullanıcıdan gelen veridir ve doğrulanmadan kullanılamaz.
 *
 * ÖNEMLİ: onay adımı istemcinin gönderdiği SINIFLANDIRMAYA (yeni mi
 * güncelleme mi, hangi ürün) hiç güvenmiyor — sadece ham hücreleri alıp
 * `previewImport`'u SUNUCUDA yeniden çalıştırıyor. Böylece hem kurcalanmış
 * bir gönderim işe yaramıyor hem de önizlemeden sonra veritabanında olan
 * değişiklikler (başkası aynı stok kodunu yaratmış) hesaba katılıyor.
 */
export const parsedFileSchema = z.object({
  rows: z
    .array(
      z.object({
        rowNumber: z.number().int().nonnegative(),
        cells: z.record(z.string(), z.string()),
      }),
    )
    .max(IMPORT_ROW_LIMIT),
  columns: z.array(z.string()),
})

export function parseFileBlob(raw: unknown): ParsedFile {
  const parsed = parsedFileSchema.safeParse(raw)
  if (!parsed.success) throw validationError(issuesOf(parsed.error))
  return parsed.data as ParsedFile
}

export interface ImportOptions {
  db?: Db
  rowLimit?: number
}

// ---------------------------------------------------------------------------
// SÜTUN EŞLEME
// ---------------------------------------------------------------------------

/**
 * Başlık eşlemesi. Anahtarlar `tr_norm` mantığıyla sadeleştirilmiş hâlleri:
 * "Stok Kodu", "STOK KODU", "stok kodu" ve "Stok  Kodu" hepsi eşleşiyor.
 *
 * Neden esnek: dosya muhasebeden geliyor ve başlığın büyük harfli mi,
 * boşluklu mu olduğunu kullanıcı bilmiyor. Katı eşleşme, kullanıcıyı
 * "sütun bulunamadı" hatasıyla baş başa bırakır ve o hatanın sebebi
 * ekranda görünmez.
 *
 * `exportFileName`'in ürettiği stok raporunun başlıkları da burada:
 * kullanıcı raporu indirip düzeltip geri yükleyebilmeli.
 */
const COLUMN_ALIASES: Record<keyof ParsedRow, string[]> = {
  sku: ['stok kodu', 'stokkodu', 'kod', 'sku', 'urun kodu'],
  name: ['urun adi', 'ad', 'urun', 'isim', 'name'],
  unit: ['birim', 'unit'],
  category: ['kategori', 'category'],
  brand: ['marka', 'brand'],
  imageUrl: ['gorsel', 'gorsel url', 'gorsel adresi', 'resim', 'resim url', 'foto', 'fotograf', 'image', 'image url'],
  purchasePrice: ['alis fiyati', 'alis', 'alis fiyat'],
  salePrice: ['satis fiyati', 'satis', 'satis fiyat'],
  minStock: ['kritik seviye', 'kritik stok', 'min stok', 'minimum stok', 'kritik esik'],
  barcode: ['barkod', 'barcode'],
  barcodeKind: ['barkod turu', 'barkod tipi', 'tur'],
  qtyMultiplier: ['koli ici adet', 'carpan', 'koli adedi', 'koli ici'],
}

/**
 * Başlığı karşılaştırılabilir hâle getirir: Türkçe harfler sadeleşiyor,
 * noktalama ve fazla boşluk düşüyor. `packages/db` içindeki `tr_norm` ile
 * aynı harf eşlemesi — ikisi ayrı düşerse "Ürün Adı" başlığı bir yerde
 * eşleşip diğerinde eşleşmezdi.
 */
export function normalizeHeader(raw: string): string {
  const map: Record<string, string> = {
    İ: 'i', I: 'i', ı: 'i', Ş: 's', ş: 's', Ğ: 'g', ğ: 'g',
    Ü: 'u', ü: 'u', Ö: 'o', ö: 'o', Ç: 'c', ç: 'c',
  }
  return raw
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Başlık satırından sütun indekslerini çıkarır. */
function mapColumns(headers: string[]): Partial<Record<keyof ParsedRow, number>> {
  const found: Partial<Record<keyof ParsedRow, number>> = {}
  headers.forEach((header, index) => {
    const norm = normalizeHeader(header)
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [
      keyof ParsedRow,
      string[],
    ][]) {
      if (found[field] === undefined && aliases.includes(norm)) found[field] = index
    }
  })
  return found
}

// ---------------------------------------------------------------------------
// DOSYA ÇÖZÜMLEME
// ---------------------------------------------------------------------------

export interface RawRow {
  rowNumber: number
  cells: Record<keyof ParsedRow, string>
}

export interface ParsedFile {
  rows: RawRow[]
  /** Dosyada bulunan sütunlar. Ekranda "şunları gördüm" diye gösteriliyor. */
  columns: (keyof ParsedRow)[]
}

/**
 * `.xlsx` veya `.csv` dosyasını ham satırlara çevirir.
 *
 * CSV'yi de kabul ediyoruz çünkü kullanıcının elindeki dosya çoğu zaman
 * eski bir programdan CSV olarak çıkıyor. ÜRETİRKEN CSV kullanmıyoruz
 * (G2: kodlama tuzağı), ama OKURKEN reddetmek kullanıcıyı dönüştürmeye
 * zorlamak olurdu — ve okurken kodlama sorunu yok: baytları biz
 * yorumluyoruz, Excel değil.
 */
export async function parseProductFile(
  buffer: Buffer,
  fileName: string,
  options: ImportOptions = {},
): Promise<ParsedFile> {
  const limit = options.rowLimit ?? IMPORT_ROW_LIMIT
  const isCsv = fileName.toLowerCase().endsWith('.csv')

  const matrix = isCsv ? parseCsv(buffer) : await parseXlsx(buffer)
  const headerRow = matrix[0]
  if (!headerRow || headerRow.every((c) => c.trim() === '')) {
    throw new AppError('IMPORT_NO_HEADER', 'file has no header row')
  }

  const columns = mapColumns(headerRow)
  if (columns.sku === undefined || columns.name === undefined) {
    // Bu ikisi olmadan hiçbir satır anlamlandırılamaz; satır bazlı hata
    // vermek 800 kere aynı şeyi yazmak olurdu.
    throw new AppError('IMPORT_MISSING_COLUMN', 'sku and name columns are required', {
      found: headerRow.join(', '),
    })
  }

  const rows: RawRow[] = []
  for (let i = 1; i < matrix.length; i += 1) {
    const raw = matrix[i]!
    // Tamamen boş satır atlanıyor: Excel dosyalarının sonunda yüzlerce
    // boş satır olması çok yaygın ve bunları hata olarak raporlamak
    // raporu okunamaz hâle getirirdi.
    if (raw.every((c) => c.trim() === '')) continue

    if (rows.length >= limit) {
      throw new AppError('IMPORT_TOO_LARGE', `file has more than ${limit} rows`, { limit })
    }

    const cells = {} as Record<keyof ParsedRow, string>
    for (const [field, index] of Object.entries(columns) as [keyof ParsedRow, number][]) {
      cells[field] = (raw[index] ?? '').trim()
    }
    // Satır numarası DOSYADAKİ numara (1 tabanlı, başlık dahil): kullanıcı
    // hatayı Excel'de bu numarayla bulacak.
    rows.push({ rowNumber: i + 1, cells })
  }

  return { rows, columns: Object.keys(columns) as (keyof ParsedRow)[] }
}

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0])
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new AppError('IMPORT_NO_HEADER', 'workbook has no sheet')

  const matrix: string[][] = []
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellText(cell.value)
    })
    matrix.push(cells.map((c) => c ?? ''))
  })
  return matrix
}

/** Hücre değerini metne çevirir. Formül sonucu ve zengin metin dahil. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('')
    }
    // Formül hücresinde YAZILAN formül değil HESAPLANAN değer alınıyor:
    // kullanıcı ekranda 12,50 görüyorsa dosyada da o girmeli.
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue)
    if ('hyperlink' in value && 'text' in value) return String(value.text)
    return ''
  }
  return String(value)
}

/**
 * Küçük bir CSV çözümleyici. Tırnak içi ayırıcı ve çift tırnak kaçışı
 * destekleniyor; bunlar ürün adında gerçekten görülüyor ("15" cetvel").
 *
 * AYIRICI OTOMATİK: Türkçe Excel `;` ile kaydediyor çünkü ondalık ayırıcı
 * virgül. Sabit `,` varsayımı, Türkiye'de üretilmiş dosyaların çoğunu tek
 * sütun olarak okurdu.
 *
 * BOM ATILIYOR: Excel'in yazdığı UTF-8 BOM ilk başlığın başına yapışır ve
 * "Stok Kodu" sütunu eşleşmez.
 */
export function parseCsv(buffer: Buffer): string[][] {
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = countOutsideQuotes(firstLine, ';') > countOutsideQuotes(firstLine, ',') ? ';' : ','

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function countOutsideQuotes(line: string, ch: string): number {
  let count = 0
  let inQuotes = false
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes
    else if (c === ch && !inQuotes) count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// ÖNİZLEME
// ---------------------------------------------------------------------------

/** Sütun başlığını kullanıcıya gösterilecek hâle çevirir. */
const COLUMN_LABELS: Record<keyof ParsedRow, string> = {
  sku: 'Stok Kodu',
  name: 'Ürün Adı',
  unit: 'Birim',
  category: 'Kategori',
  brand: 'Marka',
  imageUrl: 'Görsel URL',
  purchasePrice: 'Alış Fiyatı',
  salePrice: 'Satış Fiyatı',
  minStock: 'Kritik Seviye',
  barcode: 'Barkod',
  barcodeKind: 'Barkod Türü',
  qtyMultiplier: 'Koli İçi Adet',
}

/**
 * Türkçe sayı: "1.234,56" → 1234.56.
 *
 * Nokta binlik, virgül ondalık. Bunu yapmazsak muhasebeden gelen her
 * fiyat ya reddedilir ya da bin kat yanlış okunur — ikisi de kötü ama
 * ikincisi çok daha kötü, çünkü sessiz.
 */
export function parseTurkishNumber(raw: string): number | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const hasComma = text.includes(',')
  const cleaned = hasComma ? text.replace(/\./g, '').replace(',', '.') : text
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : Number.NaN
}

function parseUnit(raw: string): Unit | undefined | null {
  const text = normalizeHeader(raw)
  if (text === '') return undefined
  const direct = UNIT_VALUES.find((u) => normalizeHeader(u) === text)
  if (direct) return direct
  // "Adet", "adet", "AD" gibi Türkçe etiketler de kabul ediliyor: dosyayı
  // dolduran kişi kod değil kelime yazar.
  const byLabel = UNIT_VALUES.find(
    (u) => normalizeHeader(UNITS[u].tr) === text || normalizeHeader(UNITS[u].short) === text,
  )
  return byLabel ?? null
}

function parseBarcodeKind(raw: string): BarcodeKind | undefined | null {
  const text = normalizeHeader(raw)
  if (text === '') return undefined
  const values = Object.keys(BARCODE_KINDS) as BarcodeKind[]
  return (
    values.find((k) => normalizeHeader(k) === text) ??
    values.find((k) => normalizeHeader(BARCODE_KINDS[k].tr) === text) ??
    null
  )
}

/**
 * Her satırı doğrular ve ne olacağını söyler. HİÇBİR ŞEY YAZMAZ.
 *
 * Doğrulama gerçek şemalarla yapılıyor (`createProductSchema` /
 * `updateProductSchema`), ayrı bir "import doğrulaması" ile değil: ikinci
 * bir kural seti, önizlemenin geçtiği ama kaydın patladığı satırlar üretirdi.
 */
export async function previewImport(
  actor: Actor,
  file: ParsedFile,
  options: ImportOptions = {},
): Promise<ImportPreview> {
  requirePermission(actor, 'product:create')

  const skus = [...new Set(file.rows.map((r) => r.cells.sku?.trim()).filter(Boolean))] as string[]
  const existing = await findExistingSkus(actor, skus, options)

  const seen = new Map<string, number>()
  const rows: PreviewRow[] = file.rows.map((raw) => evaluateRow(raw, file, existing, seen))

  return {
    rows,
    counts: {
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      error: rows.filter((r) => r.action === 'error').length,
    },
  }
}

function evaluateRow(
  raw: RawRow,
  file: ParsedFile,
  existing: Map<string, string>,
  seen: Map<string, number>,
): PreviewRow {
  const issues: ImportIssue[] = []
  const sku = raw.cells.sku?.trim() ?? ''
  const name = raw.cells.name?.trim() ?? ''

  const push = (column: keyof ParsedRow | '', message: string) =>
    issues.push({ column: column === '' ? '' : COLUMN_LABELS[column], message })

  if (sku === '') push('sku', 'Stok kodu boş')
  if (name === '') push('name', 'Ürün adı boş')

  // DOSYA İÇİ MÜKERRER. Yakalanmasaydı ikinci satır birinciyi sessizce
  // ezerdi ve kullanıcı hangi fiyatın kaydedildiğini asla bilemezdi.
  if (sku !== '') {
    const before = seen.get(sku)
    if (before !== undefined) {
      push('sku', `Bu stok kodu ${before}. satırda da var`)
    } else {
      seen.set(sku, raw.rowNumber)
    }
  }

  const data: ParsedRow = { sku, name }

  const unit = parseUnit(raw.cells.unit ?? '')
  if (unit === null) push('unit', 'Birim tanınmadı (Adet, Kilogram, Metre, Litre)')
  else if (unit !== undefined) data.unit = unit

  if (file.columns.includes('category')) data.category = raw.cells.category || null
  if (file.columns.includes('brand')) data.brand = raw.cells.brand || null
  if (file.columns.includes('imageUrl')) {
    const url = raw.cells.imageUrl?.trim() ?? ''
    // ÖNİZLEMEDE DOĞRULANIYOR, kaydederken değil. Adres arayüzde bir
    // `<img src>` içine giriyor ve bu dosya DIŞARIDAN geliyor; `javascript:`
    // veya `data:` şeması sayfaya kullanıcı içeriği sokmanın yolu olurdu.
    // Önizlemede yakalamak, 800 satırlık bir yüklemenin ortasında patlamak
    // yerine kullanıcıya hangi satırın bozuk olduğunu göstermek demek.
    if (url !== '' && !/^https?:\/\//i.test(url)) {
      push('imageUrl', 'Görsel adresi http:// veya https:// ile başlamalı')
    } else {
      data.imageUrl = url || null
    }
  }

  for (const field of ['purchasePrice', 'salePrice', 'minStock'] as const) {
    if (!file.columns.includes(field)) continue
    const parsed = parseTurkishNumber(raw.cells[field] ?? '')
    if (parsed === undefined) {
      // Boş hücre: fiyatta "temizle", kritik eşikte "dokunma".
      if (field !== 'minStock') data[field] = null
      continue
    }
    if (Number.isNaN(parsed)) {
      push(field, 'Sayı olarak okunamadı')
      continue
    }
    data[field] = parsed
  }

  const barcode = raw.cells.barcode?.trim() ?? ''
  if (barcode !== '') data.barcode = barcode

  const kind = parseBarcodeKind(raw.cells.barcodeKind ?? '')
  if (kind === null) push('barcodeKind', 'Barkod türü tanınmadı')
  else if (kind !== undefined) data.barcodeKind = kind

  const multiplier = parseTurkishNumber(raw.cells.qtyMultiplier ?? '')
  if (Number.isNaN(multiplier)) push('qtyMultiplier', 'Sayı olarak okunamadı')
  else if (multiplier !== undefined) data.qtyMultiplier = multiplier

  const productId = existing.get(sku)
  const isUpdate = productId !== undefined

  // Yeni üründe barkod ZORUNLU: barkodsuz ürün depoda okutulamaz, yani
  // içe aktarma "başarılı" görünüp kullanılamaz bir katalog üretirdi.
  if (!isUpdate && barcode === '') push('barcode', 'Yeni ürün için barkod zorunlu')

  if (data.barcodeKind && data.qtyMultiplier !== undefined) {
    if (!multiplierMatchesKind(data.barcodeKind, data.qtyMultiplier)) {
      push('qtyMultiplier', 'Barkod türü ile çarpan uyuşmuyor')
    }
  }

  // Şema doğrulaması: kayıt sırasında patlayacak her şey burada da patlasın.
  if (issues.length === 0) {
    const schemaIssues = isUpdate ? checkUpdate(data) : checkCreate(data)
    for (const issue of schemaIssues) {
      issues.push({ column: labelForPath(issue.path), message: issue.message })
    }
  }

  if (issues.length > 0) {
    return { rowNumber: raw.rowNumber, action: 'error', sku, name, issues }
  }
  return {
    rowNumber: raw.rowNumber,
    action: isUpdate ? 'update' : 'create',
    sku,
    name,
    issues: [],
    data,
    ...(productId ? { productId } : {}),
  }
}

function checkCreate(data: ParsedRow) {
  const parsed = createProductSchema.safeParse({
    sku: data.sku,
    name: data.name,
    ...(data.unit ? { unit: data.unit } : {}),
    ...(data.category ? { category: data.category } : {}),
    ...(data.brand ? { brand: data.brand } : {}),
    ...(data.imageUrl ? { imageUrl: data.imageUrl } : {}),
    ...(data.purchasePrice != null ? { purchasePrice: data.purchasePrice } : {}),
    ...(data.salePrice != null ? { salePrice: data.salePrice } : {}),
    ...(data.minStock !== undefined ? { minStock: data.minStock } : {}),
    barcodes: [
      {
        barcode: data.barcode ?? '',
        ...(data.barcodeKind ? { kind: data.barcodeKind } : {}),
        ...(data.qtyMultiplier !== undefined ? { qtyMultiplier: data.qtyMultiplier } : {}),
      },
    ],
  })
  return parsed.success ? [] : issuesOf(parsed.error)
}

function checkUpdate(data: ParsedRow) {
  const parsed = updateProductSchema.safeParse(updatePatch(data))
  return parsed.success ? [] : issuesOf(parsed.error)
}

/** Güncelleme yamasını üretir. Dosyada olmayan alan yamada da yok. */
function updatePatch(data: ParsedRow): Record<string, unknown> {
  const patch: Record<string, unknown> = { name: data.name }
  if (data.unit !== undefined) patch.unit = data.unit
  if (data.category !== undefined) patch.category = data.category
  if (data.brand !== undefined) patch.brand = data.brand
  if (data.imageUrl !== undefined) patch.imageUrl = data.imageUrl
  if (data.purchasePrice !== undefined) patch.purchasePrice = data.purchasePrice
  if (data.salePrice !== undefined) patch.salePrice = data.salePrice
  if (data.minStock !== undefined) patch.minStock = data.minStock
  return patch
}

/** zod yolunu kullanıcıya gösterilecek sütun başlığına çevirir. */
function labelForPath(path: string): string {
  const head = path.split('.')[0] as keyof ParsedRow
  if (path.startsWith('barcodes')) {
    return path.includes('qtyMultiplier') ? COLUMN_LABELS.qtyMultiplier : COLUMN_LABELS.barcode
  }
  return COLUMN_LABELS[head] ?? path
}

async function findExistingSkus(
  actor: Actor,
  skus: string[],
  options: ImportOptions,
): Promise<Map<string, string>> {
  if (skus.length === 0) return new Map()

  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .select({ id: products.id, sku: products.sku })
        .from(products)
        .where(and(eq(products.tenantId, actor.tenantId), inArray(products.sku, skus))),
    options.db,
  )
  return new Map(rows.map((r) => [r.sku, r.id]))
}

// ---------------------------------------------------------------------------
// UYGULAMA
// ---------------------------------------------------------------------------

export interface CommitResult {
  created: number
  updated: number
  failed: number
  /** Uygulanamayan satırlar. Önizlemedeki hatalar + kayıt sırasında çıkanlar. */
  errors: PreviewRow[]
}

/**
 * Önizlemede geçerli bulunan satırları uygular.
 *
 * TEK BÜYÜK TRANSACTION DEĞİL, SATIR SATIR. 800 satırlık bir aktarımda
 * 799'u yazıp sonuncuda geri almak, kullanıcıyı hiçbir ilerleme kaydetmeden
 * baştan başlatır — üstelik hata çoğu zaman tek bir bozuk satırdan geliyor.
 * Ürün ve barkodları kendi içinde atomik (`createProduct` tek transaction),
 * yani yarım ürün oluşmuyor; atomik olmayan tek şey "dosyanın tamamı".
 *
 * ÖNİZLEMEDE GÖRÜLMEYEN HATA YİNE DE OLABİLİR: başka bir admin aradaki
 * saniyelerde aynı stok kodunu yaratmış olabilir. O satır rapora düşüyor,
 * aktarım devam ediyor.
 */
export async function commitImport(
  actor: Actor,
  preview: ImportPreview,
  options: ImportOptions = {},
): Promise<CommitResult> {
  requirePermission(actor, 'product:create')
  requirePermission(actor, 'barcode:create')

  const result: CommitResult = {
    created: 0,
    updated: 0,
    failed: 0,
    errors: preview.rows.filter((r) => r.action === 'error'),
  }
  result.failed = result.errors.length

  for (const row of preview.rows) {
    if (row.action === 'error' || !row.data) continue
    try {
      if (row.action === 'create') {
        await createProduct(actor, createPayload(row.data), options)
        result.created += 1
      } else {
        await updateProduct(actor, row.productId!, updatePatch(row.data), options)
        // Barkod verilmişse ve üründe yoksa ekleniyor. Var olanı
        // güncellemek YOK: bir barkodun hangi ürüne ait olduğunu
        // değiştirmek toplu dosyayla yapılacak bir iş değil.
        if (row.data.barcode) await attachIfMissing(actor, row, options)
        result.updated += 1
      }
    } catch (err) {
      result.failed += 1
      result.errors.push({
        ...row,
        action: 'error',
        issues: [{ column: '', message: messageOf(err) }],
      })
    }
  }

  return result
}

function createPayload(data: ParsedRow): Record<string, unknown> {
  return {
    sku: data.sku,
    name: data.name,
    ...(data.unit ? { unit: data.unit } : {}),
    ...(data.category ? { category: data.category } : {}),
    ...(data.brand ? { brand: data.brand } : {}),
    ...(data.imageUrl ? { imageUrl: data.imageUrl } : {}),
    ...(data.purchasePrice != null ? { purchasePrice: data.purchasePrice } : {}),
    ...(data.salePrice != null ? { salePrice: data.salePrice } : {}),
    ...(data.minStock !== undefined ? { minStock: data.minStock } : {}),
    barcodes: [
      {
        barcode: data.barcode,
        ...(data.barcodeKind ? { kind: data.barcodeKind } : {}),
        ...(data.qtyMultiplier !== undefined ? { qtyMultiplier: data.qtyMultiplier } : {}),
      },
    ],
  }
}

async function attachIfMissing(
  actor: Actor,
  row: PreviewRow,
  options: ImportOptions,
): Promise<void> {
  const current = await listBarcodes(actor, row.productId!, options)
  if (current.some((b) => b.barcode === row.data!.barcode && b.archivedAt === null)) return

  await addBarcode(
    actor,
    row.productId!,
    {
      barcode: row.data!.barcode,
      ...(row.data!.barcodeKind ? { kind: row.data!.barcodeKind } : {}),
      ...(row.data!.qtyMultiplier !== undefined
        ? { qtyMultiplier: row.data!.qtyMultiplier }
        : {}),
    },
    options,
  )
}

/**
 * Hatayı kullanıcıya gösterilecek Türkçe metne çevirir.
 *
 * `errorText` KULLANILMIYOR çünkü bu metin bir Excel hücresine yazılıyor
 * ve satır bağlamı zaten raporda var; ayrıca `AppError` olmayan bir hata
 * geldiğinde iç ayrıntı sızmasın diye genel bir cümleye düşüyoruz.
 */
function messageOf(err: unknown): string {
  if (err instanceof AppError) return errorText(err.code, err.details)
  console.error('[import]', err)
  return 'Beklenmeyen bir hata oluştu'
}

// ---------------------------------------------------------------------------
// HATA RAPORU
// ---------------------------------------------------------------------------

/**
 * Hatalı satırları Excel olarak döndürür.
 *
 * Neden ekrandaki liste yetmiyor: 800 satırlık bir dosyada 60 hata varsa
 * kullanıcı onları ekrandan tek tek okuyup düzeltemez. Rapor, satır
 * numarası ve sütun adıyla birlikte iniyor; kullanıcı iki dosyayı yan yana
 * açıp düzeltiyor.
 */
export function importErrorRows(errors: PreviewRow[]): ImportErrorRow[] {
  return errors.flatMap((row) =>
    row.issues.map((issue) => ({
      rowNumber: row.rowNumber,
      sku: row.sku,
      name: row.name,
      column: issue.column,
      message: issue.message,
    })),
  )
}

export interface ImportErrorRow {
  rowNumber: number
  sku: string
  name: string
  column: string
  message: string
}

export function importErrorColumns(): SheetColumn<ImportErrorRow>[] {
  return [
    { header: 'Satır', width: 8, value: (r) => r.rowNumber },
    { header: 'Stok Kodu', width: 16, value: (r) => r.sku },
    { header: 'Ürün Adı', width: 32, value: (r) => r.name },
    { header: 'Sütun', width: 16, value: (r) => r.column },
    { header: 'Hata', width: 52, value: (r) => r.message },
  ]
}

/**
 * Örnek şablon satırları. Boş bir şablon indirmek, kullanıcıya sütunların
 * ne beklediğini göstermiyor — özellikle koli çarpanı gibi kavramlarda.
 */
export function templateRows(): Record<string, string | number>[] {
  return [
    {
      'Stok Kodu': 'KAL-001',
      'Ürün Adı': 'Kırmızı Tükenmez Kalem',
      Kategori: 'Yazı Gereçleri',
      Marka: 'Örnek Marka',
      Birim: 'Adet',
      'Kritik Seviye': 20,
      'Alış Fiyatı': 3.5,
      'Satış Fiyatı': 5,
      Barkod: '8690000000011',
      'Barkod Türü': 'Tekli',
      'Koli İçi Adet': 1,
      'Görsel URL': 'https://ornek-tedarikci.com/gorseller/kal-001.jpg',
    },
    {
      'Stok Kodu': 'KAL-002',
      'Ürün Adı': '12’li Kalem Kolisi',
      Kategori: 'Yazı Gereçleri',
      Marka: 'Örnek Marka',
      Birim: 'Adet',
      'Kritik Seviye': 5,
      'Alış Fiyatı': 38,
      'Satış Fiyatı': 55,
      Barkod: '8690000000028',
      'Barkod Türü': 'Koli',
      'Koli İçi Adet': 12,
    },
  ]
}
