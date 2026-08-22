import { type Unit, formatQty, reasonLabel, roleLabel } from '@stok/shared'
import type { MovementReason, Role } from '@stok/shared'
import ExcelJS from 'exceljs'

/**
 * ============================================================================
 * EXCEL ÜRETİMİ — KRİTİK AÇIK G2
 *
 * Kapatılan hata: "Excel'de 'Kirmizi Defter' görünüyor". Sessiz bozulma,
 * hata tiplerinin en kötüsü: dosya iniyor, açılıyor, sayılar doğru, sadece
 * harfler yanlış. Kimse hata almadığı için kimse bildirmiyor ve rapor
 * aylarca bozuk gidiyor.
 *
 * ÜÇ AYRI TUZAK VAR:
 *
 * 1. KODLAMA. CSV'de Türkçe karakter BOM'suz bozulur, Excel dosyayı
 *    Windows-1254 sanır. Bu yüzden CSV DEĞİL `.xlsx` üretiyoruz: xlsx bir
 *    zip içinde UTF-8 XML ve kodlama belirsizliği yok. CSV export
 *    isteniyorsa BOM zorunlu — ama v1'de o yol hiç açılmıyor.
 *
 * 2. TARİH. Excel'e metin olarak yazılan tarih sıralanamaz ve filtrelenemez.
 *    Hücreye gerçek `Date` yazıp BİÇİMİ `gg.aa.yyyy ss:dd` veriyoruz
 *    (PLAN.md Bölüm 5). Türkiye'de `aa/gg` okuyan biri 03.08 tarihini
 *    3 Ağustos yerine 8 Mart sanar.
 *
 * 3. SAYI. Miktar ve para gerçek sayı olarak yazılıyor, metin olarak değil.
 *    Ondalık ayırıcı Excel'in kendi yerel ayarından gelir; biz sadece
 *    biçim maskesini `#,##0.000` veriyoruz. Metin yazsaydık kullanıcı
 *    toplam alamazdı ve raporun yarısı işe yaramazdı.
 *
 * Bu üçünün her biri T15 fixture testinde ayrı ayrı doğrulanıyor.
 * ============================================================================
 */

/** PLAN.md Bölüm 5: `gg.aa.yyyy ss:dd`. */
export const DATE_FORMAT = 'dd.mm.yyyy hh:mm'
/** Miktar: NUMERIC(14,3) ile aynı hassasiyet. */
export const QTY_FORMAT = '#,##0.000'
/** Para: iki basamak. */
export const MONEY_FORMAT = '#,##0.00'

export interface SheetColumn<T> {
  header: string
  width: number
  value: (row: T) => string | number | Date | null
  format?: string
}

export interface StockExportRow {
  sku: string
  name: string
  category: string | null
  brand: string | null
  unit: Unit
  qty: number
  minStock: number
  purchasePrice?: number | null
  salePrice?: number | null
  lastMovementAt: Date | null
}

export interface MovementExportRow {
  createdAt: Date
  sku: string
  productName: string
  userName: string
  userRole: Role
  reason: MovementReason
  delta: number
  unit: Unit
  note: string | null
  unitCost?: number | null
}

/**
 * Fiyat sütunları OPSİYONEL: çalışan indirdiğinde hiç oluşturulmuyorlar
 * (tehdit S7). Boş bırakmak yetmezdi — sütun başlığı bile "bu bilgi var
 * ama sana gösterilmiyor" demek olurdu ve Excel'de gizli sütun diye bir
 * güvenlik önlemi yoktur.
 */
export function stockColumns(includePrices: boolean): SheetColumn<StockExportRow>[] {
  const base: SheetColumn<StockExportRow>[] = [
    { header: 'Stok Kodu', width: 16, value: (r) => r.sku },
    { header: 'Ürün Adı', width: 40, value: (r) => r.name },
    { header: 'Kategori', width: 20, value: (r) => r.category },
    { header: 'Marka', width: 18, value: (r) => r.brand },
    { header: 'Birim', width: 10, value: (r) => r.unit },
    { header: 'Miktar', width: 14, value: (r) => r.qty, format: QTY_FORMAT },
    { header: 'Kritik Seviye', width: 14, value: (r) => r.minStock, format: QTY_FORMAT },
    {
      header: 'Son Hareket',
      width: 18,
      value: (r) => r.lastMovementAt,
      format: DATE_FORMAT,
    },
  ]
  if (!includePrices) return base

  return [
    ...base.slice(0, 7),
    { header: 'Alış Fiyatı', width: 14, value: (r) => r.purchasePrice ?? null, format: MONEY_FORMAT },
    { header: 'Satış Fiyatı', width: 14, value: (r) => r.salePrice ?? null, format: MONEY_FORMAT },
    ...base.slice(7),
  ]
}

export function movementColumns(includePrices: boolean): SheetColumn<MovementExportRow>[] {
  const base: SheetColumn<MovementExportRow>[] = [
    { header: 'Tarih', width: 18, value: (r) => r.createdAt, format: DATE_FORMAT },
    { header: 'Stok Kodu', width: 16, value: (r) => r.sku },
    { header: 'Ürün Adı', width: 40, value: (r) => r.productName },
    { header: 'Kullanıcı', width: 22, value: (r) => r.userName },
    { header: 'Rol', width: 12, value: (r) => roleLabel(r.userRole) },
    { header: 'İşlem', width: 20, value: (r) => reasonLabel(r.reason) },
    { header: 'Miktar', width: 14, value: (r) => r.delta, format: QTY_FORMAT },
    { header: 'Birim', width: 10, value: (r) => r.unit },
    { header: 'Not', width: 30, value: (r) => r.note },
  ]
  if (!includePrices) return base
  return [
    ...base,
    { header: 'Birim Maliyet', width: 14, value: (r) => r.unitCost ?? null, format: MONEY_FORMAT },
  ]
}

export interface SheetSpec<T> {
  name: string
  columns: SheetColumn<T>[]
  rows: T[]
}

/**
 * Satırları çalışma kitabına yazar ve baytları döner.
 *
 * `worksheet.addRow` yerine sütun sütun yazmıyoruz çünkü exceljs'in
 * `columns` API'si başlık, genişlik ve biçimi tek yerde tutuyor; iki
 * ayrı listeyi elle hizalamak, bir sütun eklendiğinde verinin bir
 * kayması demek olurdu — ve o kayma Excel'de tamamen normal görünür.
 */
export async function buildWorkbook<T>(spec: SheetSpec<T>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Stok'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet(spec.name, {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  sheet.columns = spec.columns.map((c) => ({ header: c.header, width: c.width }))

  const header = sheet.getRow(1)
  header.font = { bold: true }
  header.alignment = { vertical: 'middle' }

  for (const row of spec.rows) {
    sheet.addRow(spec.columns.map((c) => c.value(row)))
  }

  // Biçim maskeleri sütun bazında: satır satır uygulamak 50 bin satırda
  // ölçülebilir yavaşlık ve gereksiz XML üretiyor.
  spec.columns.forEach((c, i) => {
    if (c.format) sheet.getColumn(i + 1).numFmt = c.format
  })

  // Otomatik filtre: raporu alan kişi tarih veya kullanıcı bazlı süzmek
  // isteyecek. Sonradan eklemek kullanıcı işi olmamalı.
  if (spec.rows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.columns.length } }
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

/**
 * Dosya adı. Türkçe karakter ve boşluk YOK: bazı SMTP sunucuları ve
 * eski tarayıcılar `Content-Disposition` içindeki UTF-8 dosya adını
 * bozuyor ve kullanıcı "rapor_A_ustos.xlsx" indiriyor.
 */
export function exportFileName(prefix: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = [
    at.getFullYear(),
    pad(at.getMonth() + 1),
    pad(at.getDate()),
    pad(at.getHours()),
    pad(at.getMinutes()),
  ]
  return `${prefix}-${stamp.slice(0, 3).join('')}-${stamp.slice(3).join('')}.xlsx`
}

/** Miktarı birimiyle birlikte METİN olarak isteyen yerler için (e-posta gövdesi). */
export function qtyText(qty: number, unit: Unit): string {
  return formatQty(qty, unit)
}
