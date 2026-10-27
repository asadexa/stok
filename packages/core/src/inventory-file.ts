import { AppError } from '@stok/shared'
import { IMPORT_CELL_LIMIT, IMPORT_FILE_BYTES_LIMIT, IMPORT_ROW_LIMIT } from './product-file'
import { normalizeHeader, readSheet } from './sheet'

/**
 * ============================================================================
 * ENVANTER DOSYASI → HAM SATIRLAR (T218, PRD-18)
 *
 * Gerçek işletme dosyası bir ERP envanter raporu: Malzeme Türü, Malzeme Kodu,
 * Malzeme Açıklaması, Ambar, Envanter Miktarı, Birim, Ortalama Değer, Envanter
 * Tutarı, Envanter Tutarı (RD). Yalnız beş sütun okunuyor.
 *
 * FİYAT VE TUTAR SÜTUNLARI SUNUCUYA GİTMİYOR. "Ortalama Değer" ortalama birim
 * maliyet, alış fiyatı değil (PRC-12); okunup taşınsaydı bir gün yanlış alana
 * yazılabilirdi. Okunmayan sütunların yalnız BAŞLIKLARI ekranda gösterilmek
 * için gidiyor, değerleri değil.
 *
 * Ürün aktarımındaki gibi TARAYICIDA çalışıyor (`product-file.ts`): veritabanına
 * ve Node'a bağımlı hiçbir şey import edilmiyor. Sunucu bu satırlara güvenmiyor;
 * her satır önizlemede yeniden doğrulanıyor.
 * ============================================================================
 */

export type InventoryField = 'sku' | 'name' | 'depot' | 'qty' | 'unit'

/**
 * Başlık eşlemesi (`normalizeHeader` hâlleri). Yalnız açık adlar: miktar
 * yalnız "Envanter Miktarı". "Miktar" ya da "Stok" eklenseydi, ürün
 * aktarımının stok raporundaki mevcut stok sütunu envanter sanılabilirdi
 * (DAT-18'in nedeni).
 */
const INVENTORY_ALIASES: Record<InventoryField, string[]> = {
  sku: ['malzeme kodu', 'stok kodu', 'urun kodu'],
  name: ['malzeme aciklamasi', 'malzeme adi', 'urun adi'],
  depot: ['ambar', 'ambar adi', 'depo', 'depo adi'],
  qty: ['envanter miktari'],
  unit: ['birim'],
}

export const INVENTORY_FIELDS = Object.keys(INVENTORY_ALIASES) as InventoryField[]

/**
 * Her satırda gereken sütunlar. Ad ve birim yalnız YENİ ürün satırında
 * gerekiyor; o kural satır bazında (önizlemede).
 */
export const INVENTORY_REQUIRED_FIELDS: readonly InventoryField[] = ['sku', 'qty', 'depot']

/** Kullanıcının dosyada arayacağı sütun adları. */
export const INVENTORY_COLUMN_LABELS: Record<InventoryField, string> = {
  sku: 'Malzeme Kodu',
  name: 'Malzeme Açıklaması',
  depot: 'Ambar (Depo)',
  qty: 'Envanter Miktarı',
  unit: 'Birim',
}

/** Okunmayan başlık listesinin sınırları; sunucu da aynılarını uyguluyor. */
export const INVENTORY_UNREAD_COLUMNS_LIMIT = 50
export const INVENTORY_HEADER_LIMIT = 200

export interface RawInventoryRow {
  /** Dosyadaki satır numarası (başlık 1). */
  rowNumber: number
  cells: Partial<Record<InventoryField, string>>
}

export interface ParsedInventoryFile {
  rows: RawInventoryRow[]
  /** Dosyada bulunan alanlar. */
  columns: InventoryField[]
  /** Okunmayan sütunların başlıkları (dosyadaki yazımıyla). Değerleri gönderilmiyor. */
  unreadColumns: string[]
}

/** `.xlsx` ya da `.csv` envanter dosyasını ham satırlara çevirir. */
export async function parseInventoryFile(
  data: Uint8Array,
  fileName: string,
  options: { rowLimit?: number } = {},
): Promise<ParsedInventoryFile> {
  const limit = options.rowLimit ?? IMPORT_ROW_LIMIT
  if (data.byteLength > IMPORT_FILE_BYTES_LIMIT) {
    throw new AppError('IMPORT_FILE_TOO_LARGE', 'file exceeds byte limit', {
      limitMb: IMPORT_FILE_BYTES_LIMIT / (1024 * 1024),
    })
  }

  const matrix = await readSheet(data, fileName)
  const headerRow = matrix[0]
  if (!headerRow || headerRow.every((c) => c.trim() === '')) {
    throw new AppError('IMPORT_NO_HEADER', 'file has no header row')
  }

  const found: Partial<Record<InventoryField, number>> = {}
  const unread: string[] = []
  headerRow.forEach((header, index) => {
    const norm = normalizeHeader(header)
    const field = INVENTORY_FIELDS.find((f) => INVENTORY_ALIASES[f].includes(norm))
    if (field && found[field] === undefined) found[field] = index
    else if (header.trim() !== '') unread.push(header.trim().slice(0, INVENTORY_HEADER_LIMIT))
  })

  // Kod, miktar ve depo olmadan hiçbir satır anlamlandırılamaz; satır bazlı
  // hata vermek binlerce kez aynı cümleyi yazmak olurdu.
  const missing = INVENTORY_REQUIRED_FIELDS.filter((f) => found[f] === undefined)
  if (missing.length > 0) {
    throw new AppError('INVENTORY_MISSING_COLUMN', 'required inventory columns are missing', {
      missing: missing.map((f) => INVENTORY_COLUMN_LABELS[f]).join(', '),
      found: headerRow.join(', '),
    })
  }

  const rows: RawInventoryRow[] = []
  for (let i = 1; i < matrix.length; i += 1) {
    const raw = matrix[i]!
    if (raw.every((c) => c.trim() === '')) continue
    if (rows.length >= limit) {
      throw new AppError('IMPORT_TOO_LARGE', `file has more than ${limit} rows`, { limit })
    }
    const cells: Partial<Record<InventoryField, string>> = {}
    for (const [field, index] of Object.entries(found) as [InventoryField, number][]) {
      cells[field] = (raw[index] ?? '').trim().slice(0, IMPORT_CELL_LIMIT + 1)
    }
    rows.push({ rowNumber: i + 1, cells })
  }

  return {
    rows,
    columns: Object.keys(found) as InventoryField[],
    unreadColumns: [...new Set(unread)].slice(0, INVENTORY_UNREAD_COLUMNS_LIMIT),
  }
}
