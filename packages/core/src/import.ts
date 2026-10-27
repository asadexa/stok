import {
  ADET_MULTIPLIER_MESSAGE,
  AppError,
  type BarcodeKind,
  type ImportOpeningOutcome,
  type Unit,
  BARCODE_KINDS,
  UNITS,
  UNIT_VALUES,
  createProductSchema,
  errorText,
  formatQty,
  multiplierMatchesKind,
  qtyFitsUnit,
  qtySchema,
  unitDecimals,
  updateProductSchema,
} from '@stok/shared'
import {
  type Db,
  pgConstraint,
  pgErrorCode,
  productBarcodes,
  products,
  stockMovements,
  withTenant,
} from '@stok/db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { type Actor, requirePermission } from './authz'
import { createMovement } from './movements'
import {
  COLUMN_LABELS,
  IMPORT_CELL_LIMIT,
  IMPORT_FIELDS,
  type ImportField,
  type ParsedFile,
  type ParsedRow,
  type RawRow,
} from './product-file'
import { PRODUCT_VERSION, addBarcode, insertProduct, listBarcodes, patchProduct } from './products'
import { ambiguousNumberMessage, isAmbiguousTurkishNumber, normalizeHeader, parseTurkishNumber } from './sheet'
import { uuidV5 } from './uuid-v5'
import { issuesOf } from './validate'
import { z } from 'zod'

// Dosya okuma tarayıcıda da çalışan modüllerde (T171). Mevcut çağıranlar ve
// testler adları buradan almaya devam ediyor.
export {
  COLUMN_LABELS,
  IMPORT_CELL_LIMIT,
  IMPORT_FIELDS,
  IMPORT_FILE_BYTES_LIMIT,
  IMPORT_ROW_LIMIT,
  type ImportField,
  type ParsedFile,
  type ParsedRow,
  type RawRow,
  parseProductFile,
} from './product-file'
export {
  XLSX_PARTS_BYTE_LIMIT,
  ambiguousNumberMessage,
  cellText,
  isAmbiguousTurkishNumber,
  normalizeHeader,
  parseCsv,
  parseTurkishNumber,
  readSheet,
} from './sheet'

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
 *   3. uygula    applyRow()          → sadece geçerli satırlar, satır satır
 *
 * Ekran bu adımları aktarım kaydı üzerinden yürütüyor (`import-runs.ts`,
 * T171): dosya tarayıcıda çözümleniyor, önizleme ve uygulama sunucuda.
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
  /**
   * Güncellenecek ürünün ÖNİZLEME ANINDAKİ sürümü (T171, K3). Yazımda karşılaştırılıyor:
   * arada biri ürünü değiştirdiyse dosyadaki değer onu sessizce ezmiyor.
   */
  productVersion?: string
  /**
   * Yazılacak açılış stoğu (T128). Fiyat ve barkod önizlemede çözülüyor;
   * karar yine de yazma anında `createMovement`'ta veriliyor.
   */
  opening?: OpeningPlan
  /** Hata DEĞİL, satır yine işlenir: "devir atlanacak: üründe hareket var". */
  warnings?: string[]
}

export interface OpeningPlan {
  qty: number
  unit: Unit
  /** Ürünün tekli (çarpanı 1) barkodu: koli barkoduyla yazılsa miktar çarpılırdı. */
  barcode: string
  /** Alış fiyatı (PRC-05): liste fiyatına eşit, sapma sebebi gerekmiyor. */
  unitPrice: number
}

export interface ImportPreview {
  rows: PreviewRow[]
  counts: { create: number; update: number; error: number }
  /** Dosya düzeyi uyarılar (okunmayan "Miktar" sütunu gibi). */
  notices: string[]
}

/**
 * İstemciden gelen ham satırın şeması (T171).
 *
 * Neden gerekli: dosya tarayıcıda ayrıştırılıyor, yani buraya gelen hücreler
 * kullanıcıdan gelen veridir. Yalnız tanınan alanlar ve sınırlı uzunlukta
 * metin kabul ediliyor: bilinmeyen anahtar ya da sınırsız hücre, geçici kayda
 * ve belleğe istemcinin seçtiği kadar veri yazdırırdı. İçeriğin DOĞRULUĞU
 * burada değil, `previewImport`'ta satır satır sınanıyor.
 */
export const rawRowSchema = z.object({
  rowNumber: z.number().int().min(2).max(10_000_000),
  cells: z
    .object(
      Object.fromEntries(
        IMPORT_FIELDS.map((f) => [f, z.string().max(IMPORT_CELL_LIMIT + 1).optional()]),
      ) as Record<ImportField, z.ZodOptional<z.ZodString>>,
    )
    .strict(),
})

export interface ImportOptions {
  db?: Db
  rowLimit?: number
}

// ---------------------------------------------------------------------------
// ÖNİZLEME
// ---------------------------------------------------------------------------

/**
 * Okunamayan sayı hücresinin mesajı. Belirsiz Türkçe yazım ("1.234") ayrı
 * söyleniyor (K1): "okunamadı" demek kullanıcıyı hücrede bir yazım hatası
 * aramaya gönderirdi; asıl sorun yazımın iki anlama gelmesi.
 */
function numberIssue(cell: string, fallback: string): string {
  return isAmbiguousTurkishNumber(cell) ? ambiguousNumberMessage(cell) : fallback
}

/** Tanınmayan birimin satır hatası; iki aktarım aynı cümleyi kullanıyor. */
export const UNKNOWN_UNIT_MESSAGE = 'Birim tanınmadı (Adet/AD, Kilogram/KG, Metre/MT, Litre/LT)'

/**
 * Dosyadaki birim hücresi → birim. `undefined` boş hücre, `null` tanınmadı.
 * Envanter dosyası (T218) da bunu kullanıyor: iki aktarım aynı birimi farklı
 * okusaydı aynı dosya birinde geçip ötekinde reddedilirdi.
 */
export function parseUnit(raw: string): Unit | undefined | null {
  const text = normalizeHeader(raw)
  if (text === '') return undefined
  const direct = UNIT_VALUES.find((u) => normalizeHeader(u) === text)
  if (direct) return direct
  // "Adet", "adet" gibi Türkçe etiketler ve ERP kısaltmaları ("AD", "LT",
  // "MT", `UNITS[].aliases`) da kabul ediliyor: dosyayı dolduran kişi kod
  // değil kelime yazar, ERP raporu kısaltma basar.
  const byLabel = UNIT_VALUES.find(
    (u) =>
      normalizeHeader(UNITS[u].tr) === text ||
      normalizeHeader(UNITS[u].short) === text ||
      UNITS[u].aliases.some((a) => normalizeHeader(a) === text),
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
  const existing = await findExistingProducts(actor, skus, options)

  const seen = new Map<string, number>()
  const rows: PreviewRow[] = file.rows.map((raw) => evaluateRow(raw, file, existing, seen))

  return {
    rows,
    counts: {
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      error: rows.filter((r) => r.action === 'error').length,
    },
    notices: importNotices(file.ignoredQtyColumns ?? []),
  }
}

/** Dosya düzeyi uyarılar. Aktarım kaydı da (T171) aynı cümleleri saklıyor. */
export function importNotices(ignoredQtyColumns: string[]): string[] {
  return ignoredQtyColumns.map(
    (header) =>
      `"${header}" sütunu açılış stoğu olarak okunmadı. Açılış stoğu girmek için sütunun adı "Açılış Stoğu" olmalı.`,
  )
}

function evaluateRow(
  raw: RawRow,
  file: ParsedFile,
  existing: Map<string, ExistingProduct>,
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
  if (unit === null) push('unit', UNKNOWN_UNIT_MESSAGE)
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
      push(field, numberIssue(raw.cells[field] ?? '', 'Sayı olarak okunamadı'))
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
  if (Number.isNaN(multiplier)) {
    push('qtyMultiplier', numberIssue(raw.cells.qtyMultiplier ?? '', 'Sayı olarak okunamadı'))
  } else if (multiplier !== undefined) data.qtyMultiplier = multiplier

  if (file.columns.includes('openingQty')) {
    const opening = parseTurkishNumber(raw.cells.openingQty ?? '')
    // Boş ya da 0: devir yok. Hata değil; dosyaların çoğunda boş hücre olur.
    if (opening !== undefined && opening !== 0) {
      if (Number.isNaN(opening)) {
        push('openingQty', numberIssue(raw.cells.openingQty ?? '', 'Açılış stoğu sayı olarak okunamadı'))
      }
      else if (opening < 0) push('openingQty', 'Açılış stoğu sıfırdan büyük olmalı')
      else {
        const checked = qtySchema.safeParse(opening)
        if (checked.success) data.openingQty = opening
        else push('openingQty', checked.error.issues[0]?.message ?? 'Açılış stoğu geçersiz')
      }
    }
  }

  const existingProduct = existing.get(sku)
  const productId = existingProduct?.id
  const isUpdate = productId !== undefined

  // Yeni üründe barkod ZORUNLU: barkodsuz ürün depoda okutulamaz, yani
  // içe aktarma "başarılı" görünüp kullanılamaz bir katalog üretirdi.
  if (!isUpdate && barcode === '') push('barcode', 'Yeni ürün için barkod zorunlu')

  if (data.barcodeKind && data.qtyMultiplier !== undefined) {
    if (!multiplierMatchesKind(data.barcodeKind, data.qtyMultiplier)) {
      push('qtyMultiplier', 'Barkod türü ile çarpan uyuşmuyor')
    }
  }

  // Yeni üründe bu kural şemada; mevcut ürüne eklenecek barkodda birim DB'den
  // geliyor ve kayıt anında `addBarcode` reddederdi. Burada erken söyleniyor.
  const productUnit: Unit = data.unit ?? existingProduct?.unit ?? 'ADET'
  if (
    isUpdate &&
    data.qtyMultiplier !== undefined &&
    unitDecimals(productUnit) === 0 &&
    !Number.isInteger(data.qtyMultiplier)
  ) {
    push('qtyMultiplier', ADET_MULTIPLIER_MESSAGE)
  }

  // AÇILIŞ STOĞU (T128). Şartlar yalnız devir yazılacak satırda aranıyor:
  // devirsiz satır ve normal ürün aktarımı bu yüzden asla reddedilmiyor.
  const warnings: string[] = []
  let opening: OpeningPlan | undefined
  if (data.openingQty !== undefined) {
    const qty = data.openingQty
    // Erken uyarı; karar yazma anında `createMovement`'ta (T130).
    if (!qtyFitsUnit(qty, productUnit)) {
      push('openingQty', 'Bu ürün adetle sayılıyor; açılış stoğu tam sayı olmalı')
    }

    // PRC-05: devir fiyatsız yazılamaz. Satırda Alış Fiyatı sütunu varsa o
    // (boş hücre "fiyatı temizle" demek), yoksa üründe kayıtlı alış fiyatı.
    const unitPrice =
      data.purchasePrice !== undefined ? data.purchasePrice : (existingProduct?.purchasePrice ?? null)
    if (unitPrice === null) {
      push('openingQty', 'Açılış stoğu için alış fiyatı gerekli (Alış Fiyatı sütunu ya da üründe kayıtlı)')
    }

    // Tekli barkod: koli barkoduyla yazılsaydı devir çarpanla çarpılırdı.
    const rowHasUnitBarcode =
      barcode !== '' && (data.barcodeKind ?? 'UNIT') === 'UNIT' && (data.qtyMultiplier ?? 1) === 1
    const openingBarcode = rowHasUnitBarcode ? barcode : (existingProduct?.unitBarcode ?? null)
    if (openingBarcode === null && (isUpdate || barcode !== '')) {
      push(
        'openingQty',
        isUpdate
          ? 'Açılış stoğu için üründe tekli barkod yok; Barkod sütununa tekli barkod yazın'
          : 'Açılış stoğu için tekli barkod gerekli; bu satırdaki barkod koli barkodu',
      )
    }

    if (existingProduct?.hasMovements) {
      warnings.push('Devir atlanacak: üründe hareket var; ürün bilgisi güncellenecek')
    }
    if (unitPrice !== null && openingBarcode !== null) {
      opening = { qty, unit: productUnit, barcode: openingBarcode, unitPrice }
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
    ...(productId ? { productId, productVersion: existingProduct!.version } : {}),
    ...(opening ? { opening } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
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

interface ExistingProduct {
  id: string
  unit: Unit
  purchasePrice: number | null
  /** Aktif, çarpanı 1 olan bir barkod; yoksa null. */
  unitBarcode: string | null
  /** Önizleme için danışma bilgisi; yazma anındaki karar kilit altında. */
  hasMovements: boolean
  /** Satırın PostgreSQL sürümü (`xmin`), önizleme anında (T171, K3; `PRODUCT_VERSION`). */
  version: string
}

/**
 * Dosyadaki stok kodlarının mevcut ürünlerini TEK sorguyla okur: 2.000 satırlık
 * dosyada satır başına sorgu önizlemeyi saniyelerce uzatırdı.
 */
async function findExistingProducts(
  actor: Actor,
  skus: string[],
  options: ImportOptions,
): Promise<Map<string, ExistingProduct>> {
  if (skus.length === 0) return new Map()

  // Üç toplu sorgu, satır başına sorgu değil. Korelasyonlu alt sorgu
  // denendi ve dış tabloya referans nitelenmeden basıldığı için alt sorgunun
  // kendi sütununa çözülüyordu: tekli barkod hiç bulunmuyordu. Tipli
  // sorgu kurucusu bu sınıf hatayı kapatıyor.
  const { rows, unitBarcodes, moved } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const rows = await tx
        .select({
          id: products.id,
          sku: products.sku,
          unit: products.unit,
          purchasePrice: products.purchasePrice,
          version: PRODUCT_VERSION,
        })
        .from(products)
        .where(and(eq(products.tenantId, actor.tenantId), inArray(products.sku, skus)))
      const ids = rows.map((r) => r.id)
      if (ids.length === 0) return { rows, unitBarcodes: [], moved: [] }

      const unitBarcodes = await tx
        .select({ productId: productBarcodes.productId, barcode: productBarcodes.barcode })
        .from(productBarcodes)
        .where(
          and(
            eq(productBarcodes.tenantId, actor.tenantId),
            inArray(productBarcodes.productId, ids),
            isNull(productBarcodes.archivedAt),
            eq(productBarcodes.qtyMultiplier, '1'),
          ),
        )
        .orderBy(productBarcodes.barcode)
      const moved = await tx
        .selectDistinct({ productId: stockMovements.productId })
        .from(stockMovements)
        .where(
          and(eq(stockMovements.tenantId, actor.tenantId), inArray(stockMovements.productId, ids)),
        )
      return { rows, unitBarcodes, moved }
    },
    options.db,
  )

  const firstUnitBarcode = new Map<string, string>()
  for (const b of unitBarcodes) {
    if (!firstUnitBarcode.has(b.productId)) firstUnitBarcode.set(b.productId, b.barcode)
  }
  const hasMovements = new Set(moved.map((m) => m.productId))

  return new Map(
    rows.map((r) => [
      r.sku,
      {
        id: r.id,
        unit: r.unit as Unit,
        purchasePrice: r.purchasePrice === null ? null : Number(r.purchasePrice),
        unitBarcode: firstUnitBarcode.get(r.id) ?? null,
        hasMovements: hasMovements.has(r.id),
        version: r.version,
      },
    ]),
  )
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
  /** Açılış stoğu (T128): ürün sayımlarından ayrı, çünkü ürün yazılıp devir atlanabiliyor. */
  openings: { written: number; skipped: number; failed: number }
  /** Ürünü işlenmiş ama devri yazılmamış satırların açıklaması. */
  notices: RowNotice[]
}

export interface RowNotice {
  rowNumber: number
  sku: string
  name: string
  message: string
}

/**
 * Açılış stoğunun idempotency anahtarı: UUID v5 (RFC 9562), ad `tenant:ürün`.
 * Aynı ürün için her zaman aynı anahtar, yani içe aktarma ne kadar tekrar
 * çalıştırılırsa çalıştırılsın ürün başına en fazla bir içe aktarma devri
 * yazılıyor (INV-6, `movements_tenant_idem_uq`).
 *
 * AD ALANI DEĞİŞMEZ. Değişirse daha önce yazılmış devirler tanınmaz ve hareketsiz
 * kalmış ürünlerde ikinci kez yazılabilir.
 */
const OPENING_KEY_NAMESPACE = '5f3c2b1e-8a47-4d6e-9c21-7b0e4f1a6d38'

export function openingKey(tenantId: string, productId: string): string {
  return uuidV5(`${tenantId}:${productId}`, OPENING_KEY_NAMESPACE)
}

const OPENING_NOTE = 'Toplu içe aktarma: açılış stoğu'

/**
 * Önizlemede geçerli bulunan satırları uygular.
 *
 * TEK BÜYÜK TRANSACTION DEĞİL, SATIR SATIR. 800 satırlık bir aktarımda
 * 799'u yazıp sonuncuda geri almak, kullanıcıyı hiçbir ilerleme kaydetmeden
 * baştan başlatır — üstelik hata çoğu zaman tek bir bozuk satırdan geliyor.
 * Ürün ve barkodları kendi içinde atomik (`insertProduct` tek transaction),
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
    openings: { written: 0, skipped: 0, failed: 0 },
    notices: [],
  }
  result.failed = result.errors.length

  for (const row of preview.rows) {
    if (row.action === 'error' || !row.data) continue
    const outcome = await applyRow(actor, row, options)
    if (outcome.status !== 'DONE') {
      result.failed += 1
      result.errors.push({
        ...row,
        action: 'error',
        issues: [{ column: '', message: outcome.message ?? 'Beklenmeyen bir hata oluştu' }],
      })
      continue
    }
    if (row.action === 'create') result.created += 1
    else result.updated += 1

    if (outcome.opening) {
      result.openings[OPENING_COUNTER[outcome.opening.outcome]] += 1
      if (outcome.opening.message) {
        result.notices.push({
          rowNumber: row.rowNumber,
          sku: row.sku,
          name: row.name,
          message: outcome.opening.message,
        })
      }
    }
  }

  return result
}

const OPENING_COUNTER = { WRITTEN: 'written', SKIPPED: 'skipped', FAILED: 'failed' } as const

/**
 * Kesintiye uğramış (`IN_PROGRESS`) satırın veritabanına bakılarak verilen
 * kararı. `retry`: uygulanmadığı kanıtlandı, yeniden denenebilir. Değilse
 * `status` (varsayılan UNCERTAIN): yalnız uygulandığı KANITLANAN satır DONE olur.
 */
export type RowVerdict =
  | { retry: true }
  | { retry: false; status?: 'DONE' | 'UNCERTAIN'; message?: string; productId?: string }

/** Tek satırın uygulanmasının sonucu. Toplu aktarım kaydı (T171) bunu satıra yazıyor. */
export interface RowOutcome {
  /** `DONE`: ürün yazıldı. `CONFLICT`: önizlemeden sonra başkası değiştirdi (K3). */
  status: 'DONE' | 'FAILED' | 'CONFLICT'
  productId?: string
  /** Ürün yazılamadıysa nedeni. */
  message?: string
  /** Açılış stoğu planlıysa sonucu; ürün yazılamadıysa yok (denenmedi). */
  opening?: { outcome: ImportOpeningOutcome; message?: string }
}

export interface ApplyRowOptions extends ImportOptions {
  /**
   * Güncellemede önizleme anındaki sürümü şart koş (K3). Aktarım kaydı (T171)
   * veriyor; eski tek istekli `commitImport` vermiyor, çünkü o önizlemeyi
   * yazımdan hemen önce yeniden hesaplıyordu.
   */
  checkVersion?: boolean
}

/**
 * Önizlemede geçerli bulunmuş TEK satırı uygular: ürün, gerekirse barkod, sonra
 * açılış stoğu. Hiçbir hatayı dışarı atmıyor; sonucu söylüyor.
 *
 * Ürün işi başarısızsa devir DENENMİYOR: barkod başka bir ürüne aitse devir o
 * ürüne yazılırdı. Devir yazılamazsa ürün işi geri alınmıyor (satır satır
 * ilkesi); sonuç notu ne olduğunu söylüyor, tekrar çalıştırma eksik devri
 * tamamlıyor (DAT-18: idempotency anahtarı ürün başına sabit).
 */
export async function applyRow(
  actor: Actor,
  row: PreviewRow,
  options: ApplyRowOptions = {},
): Promise<RowOutcome> {
  const data = row.data!
  let productId: string
  try {
    if (row.action === 'create') {
      productId = await insertProduct(actor, createPayload(data), options)
    } else {
      await patchProduct(actor, row.productId!, updatePatch(data), {
        db: options.db,
        ...(options.checkVersion && row.productVersion ? { expectedVersion: row.productVersion } : {}),
      })
      // Barkod verilmişse ve üründe yoksa ekleniyor. Var olanı
      // güncellemek YOK: bir barkodun hangi ürüne ait olduğunu
      // değiştirmek toplu dosyayla yapılacak bir iş değil.
      if (data.barcode) await attachIfMissing(actor, row, options)
      productId = row.productId!
    }
  } catch (err) {
    // Çakışma ayrı: dosyada hata yok, başkası önizlemeden sonra davrandı.
    // "Yeni" satırda aynı stok kodu arada açıldıysa da çakışma; sessizce
    // güncellemeye dönüşmüyor.
    const conflict =
      options.checkVersion &&
      err instanceof AppError &&
      (err.code === 'PRODUCT_CHANGED' || (row.action === 'create' && err.code === 'SKU_EXISTS'))
    return { status: conflict ? 'CONFLICT' : 'FAILED', message: messageOf(err) }
  }

  if (!row.opening) return { status: 'DONE', productId }
  return { status: 'DONE', productId, opening: await writeOpening(actor, row, row.opening, productId, options) }
}

/**
 * Açılış stoğunu TEK YAZMA KAPISINDAN yazar (DAT-02): fiyat kuralı (PRC-05),
 * birim hassasiyeti (T130), kilit ve idempotency `createMovement`'ta.
 *
 * `requireFirstMovement`: ürünün hareketi varsa devir yazılmıyor, ürün
 * bilgisi yine güncellenmiş oluyor. Kontrol önizlemede değil kilit altında:
 * önizleme ile onay arasında satış girilmiş olabilir.
 */
async function writeOpening(
  actor: Actor,
  row: PreviewRow,
  plan: OpeningPlan,
  productId: string,
  options: ImportOptions,
): Promise<NonNullable<RowOutcome['opening']>> {
  const done = row.action === 'create' ? 'Ürün eklendi' : 'Ürün güncellendi'
  try {
    const written = await createMovement(
      actor,
      {
        idempotencyKey: openingKey(actor.tenantId, productId),
        barcode: plan.barcode,
        qty: plan.qty,
        reason: 'OPENING',
        unitPrice: plan.unitPrice,
        note: OPENING_NOTE,
        clientCreatedAt: new Date().toISOString(),
      },
      { db: options.db, requireFirstMovement: true },
    )
    if (written.duplicate) {
      return {
        outcome: 'SKIPPED',
        message: `${done}, devir daha önce yazılmış (${formatQty(Math.abs(written.delta), plan.unit)}); dosyadaki değer yazılmadı`,
      }
    }
    return { outcome: 'WRITTEN' }
  } catch (err) {
    if (err instanceof AppError && err.code === 'PRODUCT_HAS_MOVEMENTS') {
      return { outcome: 'SKIPPED', message: `${done}, devir atlandı: üründe hareket var` }
    }
    return { outcome: 'FAILED', message: `${done}, devir yazılamadı: ${messageOf(err)}` }
  }
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
 * `AppError` olmayan bir hata geldiğinde iç ayrıntı sızmasın diye genel bir
 * cümleye düşüyoruz.
 *
 * GÜNLÜĞE HAM HATA YAZILMIYOR (T171 güvence 7, T204): Drizzle'ın hata mesajı
 * sorgu parametrelerini, PostgreSQL'in "Failing row contains" ayrıntısı satır
 * değerlerini taşıyor; içe aktarılan alış fiyatları ve barkodlar günlüğe
 * düşerdi (INV-10). Yalnız hata sınıfı, SQLSTATE ve constraint adı yazılıyor.
 * Envanter aktarımı (T218) da aynı kuralla raporluyor.
 */
export function messageOf(err: unknown): string {
  if (err instanceof AppError) return errorText(err.code, err.details)
  console.error('[import] beklenmeyen hata', {
    type: err instanceof Error ? err.name : typeof err,
    code: pgErrorCode(err),
    constraint: pgConstraint(err),
  })
  return 'Beklenmeyen bir hata oluştu'
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
      // Devir ürünün biriminde (adet tam sayı) ve Alış Fiyatı'yla yazılıyor.
      // Koli satırında boş: devir tekli barkodla yazılır (T128).
      'Açılış Stoğu': 120,
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
