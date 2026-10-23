import { AppError, type BarcodeKind, type Unit } from '@stok/shared'
import { normalizeHeader, readSheet } from './sheet'

/**
 * ============================================================================
 * ÜRÜN AKTARIM DOSYASI → HAM SATIRLAR (T23, T171)
 *
 * TARAYICIDA ÇALIŞIYOR (T171, T1-A): dosya kullanıcının sekmesinde okunuyor ve
 * sunucuya yalnız eşlenen hücreler gidiyor. 100 MB'lık bir dosyayı sunucuya
 * taşımak hem barındırmanın istek sınırını aşardı hem de sunucu belleğini dosya
 * boyutuna bağlardı. Sunucu bu satırlara GÜVENMİYOR: her satır `previewImport`'ta
 * yeniden doğrulanıyor, satır ve hücre sınırları sunucuda da denetleniyor. Bu
 * bugünkü güven modeliyle aynı: önizleme ile onay arasında dosya zaten
 * istemcide duruyordu (`dosyaJson`).
 *
 * Veritabanına ve Node'a bağımlı hiçbir şey import edilmiyor; edilseydi tarayıcı
 * paketi veritabanı istemcisini de taşırdı. Paket girişi `@stok/core/product-file`.
 * ============================================================================
 */

/**
 * Bir aktarımda en fazla veri satırı (T171). Ürün gereksinimi; büyük
 * işletmelerin katalogları için. Sunucu da aynı sınırı uyguluyor.
 */
export const IMPORT_ROW_LIMIT = 20_000

/**
 * Dosya boyutu üst sınırı (T171, K2). Ürün görselleri gömülü xlsx'ler büyük
 * olabiliyor; görseller okunmadığı için (`sheet.ts`) boyutun asıl yükü bellek
 * değil. Dosya sunucuya hiç gitmiyor; sınır kullanıcının sekmesini koruyor.
 */
export const IMPORT_FILE_BYTES_LIMIT = 100 * 1024 * 1024

/**
 * Okunan hücre başına en fazla karakter. Ürün alanlarının en uzunu görsel adresi
 * (500); daha uzun hücre şemada zaten reddediliyor. Hücre bu sınırın bir fazlasına
 * kısaltılıyor: hata yine görünür ("en fazla 500 karakter"), ama 20.000 satırın
 * bellekte ve geçici kayıtta tutacağı veri sınırlı kalıyor.
 */
export const IMPORT_CELL_LIMIT = 1_000

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
  /** Açılış stoğu, ürünün biriminde (T128). Boş ya da 0: devir yok. */
  openingQty?: number
}

export type ImportField = keyof ParsedRow

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
const COLUMN_ALIASES: Record<ImportField, string[]> = {
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
  // YALNIZ AÇIK ADLAR (T128). "Miktar", "Stok", "Adet" bilerek yok: stok
  // raporunun mevcut stok sütununun adı "Miktar" ve raporu düzenleyip geri
  // yükleyen kullanıcının o sütunu devir sayılsaydı, elde zaten kayıtlı olan
  // stok ikinci kez girerdi.
  openingQty: ['acilis stogu', 'acilis stok', 'acilis miktari', 'devir', 'devir miktari', 'devir stogu'],
}

/** Dosyada tanınabilen alanlar. Sunucu, istemcinin gönderdiği sütunları bununla denetliyor. */
export const IMPORT_FIELDS = Object.keys(COLUMN_ALIASES) as ImportField[]

/** Sütun başlığını kullanıcıya gösterilecek hâle çevirir. */
export const COLUMN_LABELS: Record<ImportField, string> = {
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
  openingQty: 'Açılış Stoğu',
}

/**
 * Açılış stoğu SANILABİLECEK ama okunmayan başlıklar. Sessizce yok sayılmıyor:
 * önizleme "bu sütun okunmadı, adı Açılış Stoğu olmalı" diyor. Demeseydi
 * kullanıcı stoklarının aktarıldığını sanırdı.
 */
const AMBIGUOUS_QTY_HEADERS = [
  'miktar',
  'stok',
  'adet',
  'mevcut stok',
  'stok miktari',
  'eldeki stok',
  'qty',
  'quantity',
]

/** Başlık satırından sütun indekslerini çıkarır. */
function mapColumns(headers: string[]): Partial<Record<ImportField, number>> {
  const found: Partial<Record<ImportField, number>> = {}
  headers.forEach((header, index) => {
    const norm = normalizeHeader(header)
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [ImportField, string[]][]) {
      if (found[field] === undefined && aliases.includes(norm)) found[field] = index
    }
  })
  return found
}

export interface RawRow {
  /** Dosyadaki satır numarası (başlık satırı 1). Kullanıcı bunu arıyor. */
  rowNumber: number
  cells: Record<ImportField, string>
}

export interface ParsedFile {
  rows: RawRow[]
  /** Dosyada bulunan sütunlar. Ekranda "şunları gördüm" diye gösteriliyor. */
  columns: ImportField[]
  /** Açılış stoğu sanılabilecek ama okunmayan başlıklar (dosyadaki yazımıyla). */
  ignoredQtyColumns?: string[]
}

export interface ProductFileOptions {
  rowLimit?: number
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
  data: Uint8Array,
  fileName: string,
  options: ProductFileOptions = {},
): Promise<ParsedFile> {
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

    const cells = {} as Record<ImportField, string>
    for (const [field, index] of Object.entries(columns) as [ImportField, number][]) {
      cells[field] = (raw[index] ?? '').trim().slice(0, IMPORT_CELL_LIMIT + 1)
    }
    // Satır numarası DOSYADAKİ numara (1 tabanlı, başlık dahil): kullanıcı
    // hatayı Excel'de bu numarayla bulacak.
    rows.push({ rowNumber: i + 1, cells })
  }

  const ignoredQtyColumns = headerRow
    .map((h) => h.trim())
    .filter((h) => AMBIGUOUS_QTY_HEADERS.includes(normalizeHeader(h)))

  return { rows, columns: Object.keys(columns) as ImportField[], ignoredQtyColumns }
}
