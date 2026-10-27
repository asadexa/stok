import { createHash } from 'node:crypto'
import {
  AppError,
  type ImportRowAction,
  type Unit,
  UNITS,
  createProductSchema,
  formatQty,
  inventoryAdjustmentSchema,
  unitDecimals,
} from '@stok/shared'
import { type Db, type Tx, depots, importRunRows, products, stockMovements, withTenant } from '@stok/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type Actor, requirePermission } from './authz'
import {
  type ImportIssue,
  type RowOutcome,
  type RowVerdict,
  UNKNOWN_UNIT_MESSAGE,
  messageOf,
  parseUnit,
} from './import'
import {
  INVENTORY_COLUMN_LABELS,
  INVENTORY_FIELDS,
  type InventoryField,
  type RawInventoryRow,
} from './inventory-file'
import { createMovement } from './movements'
import { fitsDecimals, formatScaled, parseScaled, scaledFromNumber, scaledToNumber } from './numeric'
import { IMPORT_CELL_LIMIT } from './product-file'
import { insertProduct } from './products'
import { ambiguousNumberMessage, isAmbiguousTurkishNumber, parseTurkishNumber } from './sheet'
import { uuidV5 } from './uuid-v5'
import { issuesOf } from './validate'

/**
 * ============================================================================
 * T218 — ENVANTER DOSYASI: önizleme kararları ve satırın uygulanması
 *
 * Dosyadaki miktar o deponun YENİ TOPLAMI (PRD-18): mevcut stoğa eklenmiyor,
 * fark kadar sayım düzeltmesi yazılıyor. Örnek: Depo 1 = 10, Depo 2 = 20,
 * dosyada Depo 1 = 5 → Depo 1'e −5, Depo 2'ye dokunulmuyor, toplam 25.
 *
 * Kayıt, parça işleyici, kira ve iptal T171'in aktarım kaydından
 * (`import-runs.ts`); bu modül yalnız envantere özgü kısım: hücreleri doğrula,
 * ürünü ve depoyu eşleştir, satırın ne olacağına karar ver, satırı uygula.
 *
 * DEFTER: her yazım `createMovement`'ın envanter seçeneğinden (DAT-24) geçiyor;
 * işaret ve sebep orada farktan türüyor, depo miktarı kilit altında önizlemedeki
 * değerle karşılaştırılıyor (değiştiyse STOCK_CHANGED → satır Çakışma). Hareket
 * anahtarı (aktarım, satır) çiftinden türüyor: aynı satır iki kez işlense de
 * ikinci hareket yazılmıyor (INV-6).
 *
 * FİYAT YAZILMIYOR. Dosyada fiyat sütunu okunmuyor bile (`inventory-file.ts`);
 * yeni ürün fiyatsız açılıyor, sayım düzeltmesi fiyat taşımıyor (PRC-05 yalnız
 * devri bağlıyor).
 * ============================================================================
 */

/**
 * İstemciden gelen ham satırın şeması. Yalnız tanınan beş alan ve sınırlı
 * metin: fiyat ya da başka bir sütun bu kayda giremiyor.
 */
export const rawInventoryRowSchema = z.object({
  rowNumber: z.number().int().min(2).max(10_000_000),
  cells: z
    .object(
      Object.fromEntries(
        INVENTORY_FIELDS.map((f) => [f, z.string().max(IMPORT_CELL_LIMIT + 1).optional()]),
      ) as Record<InventoryField, z.ZodOptional<z.ZodString>>,
    )
    .strict(),
})

/** Önizlemenin bir satır için kayda yazdığı plan. Uygulama bunu okuyor. */
export interface InventoryRowData {
  sku: string
  name: string
  unit: Unit
  /** Depo adı (kırpılmış, iç boşlukları teklenmiş): yeni depo bu adla açılıyor. */
  depotName: string
  /** Depo anahtarı; veritabanındaki `depots.name_key` ile aynı ifadeden. */
  depotKey: string
  /** Onayda depo açıldıktan sonra dolduruluyor (`resolveRunDepots`). */
  depotId?: string
  /** Dosyadaki miktar: deponun yeni toplamı. */
  targetQty: number
  /** Önizleme anındaki depo miktarı; yazımda kilit altında karşılaştırılıyor. */
  expectedQty: number
  newDepot: boolean
  /** Yalnız `create`: yeni ürünü açan satır. Kendisiyse ürünü bu satır açıyor. */
  creatorRow?: number
}

export type InventoryRowAction = Extract<
  ImportRowAction,
  'create' | 'update' | 'unchanged' | 'unassigned' | 'error'
>

export interface InventoryPreviewRow {
  rowNumber: number
  action: InventoryRowAction
  sku: string
  name: string
  issues: ImportIssue[]
  data?: InventoryRowData
  /** Mevcut ürünün kimliği (`update`, `unchanged`, `unassigned`). */
  productId?: string
  /** Hata değil ama söylenmesi gereken: depoya atama bekliyor. */
  message?: string
  /** Önizleme sayımı için; kayda yazılmıyor. */
  ambiguous?: boolean
}

export interface InventoryPreview {
  rows: InventoryPreviewRow[]
  counts: {
    /** Yeni ürün satırı (aynı ürünün iki depo satırı iki satır). */
    create: number
    /** Açılacak ürün sayısı (malzeme kodu başına bir). */
    newProducts: number
    update: number
    unchanged: number
    unassigned: number
    error: number
    /** Hataların içinden: belirsiz eşleşme. */
    ambiguous: number
    /** Yazılacak satırların (yeni ürün ve güncelleme) içinden: depo miktarı artacak. */
    increase: number
    /** Yazılacak satırların içinden: depo miktarı azalacak. */
    decrease: number
  }
  /** Dosyadaki geçerli satırların depoları; `isNew` onayda açılacak. */
  depots: { name: string; isNew: boolean }[]
  /** Sunucuda, kaydedilen hücrelerden hesaplanan içerik parmak izi (K3). */
  contentHash: string
}

const label = (field: InventoryField) => INVENTORY_COLUMN_LABELS[field]

/** Hedef miktarın kuralları envanter kapısıyla AYNI şemadan: iki ayrı kural seti önizlemede geçip yazımda patlayan satır üretirdi. */
const TARGET_QTY = inventoryAdjustmentSchema.shape.targetQty

/** Depo adı üst sınırı; veritabanında `depots_name_ck` aynısını zorluyor. */
const DEPOT_NAME_MAX = 100

interface ParsedCells {
  rowNumber: number
  sku: string
  nameCell: string
  depotName: string
  qty?: number
  qtyText: string
  unit?: Unit
  issues: ImportIssue[]
}

function hasControlChar(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 32 || (code >= 127 && code <= 159)) return true
  }
  return false
}

/**
 * Hücreleri okur. Boş ya da belirsiz hiçbir değer varsayılana dönüşmüyor
 * (CEO-6): boş miktar 0 sayılsaydı depo sessizce sıfırlanır, boş depo
 * "atanmamış" sayılsaydı miktar yanlış kovaya yazılırdı.
 */
function parseCells(row: RawInventoryRow): ParsedCells {
  const issues: ImportIssue[] = []
  const push = (field: InventoryField, message: string) => issues.push({ column: label(field), message })

  const sku = row.cells.sku?.trim() ?? ''
  if (sku === '') push('sku', 'Malzeme kodu boş')

  const depotName = (row.cells.depot ?? '').trim().replace(/\s+/g, ' ')
  if (depotName === '') push('depot', 'Depo (Ambar) boş; miktarın hangi depoya ait olduğu bilinmiyor')
  else if (depotName.length > DEPOT_NAME_MAX) push('depot', `Depo adı en fazla ${DEPOT_NAME_MAX} karakter olabilir`)
  else if (hasControlChar(depotName)) push('depot', 'Depo adında görünmeyen (kontrol) karakter var')

  const qtyText = (row.cells.qty ?? '').trim()
  let qty: number | undefined
  const parsed = parseTurkishNumber(qtyText)
  if (parsed === undefined) {
    push('qty', 'Envanter miktarı boş; boş hücre 0 sayılmaz')
  } else if (Number.isNaN(parsed)) {
    push(
      'qty',
      isAmbiguousTurkishNumber(qtyText) ? ambiguousNumberMessage(qtyText) : 'Envanter miktarı sayı olarak okunamadı',
    )
  } else {
    const checked = TARGET_QTY.safeParse(parsed)
    if (checked.success) qty = parsed
    else push('qty', checked.error.issues[0]?.message ?? 'Envanter miktarı geçersiz')
  }

  const unit = parseUnit(row.cells.unit ?? '')
  if (unit === null) push('unit', UNKNOWN_UNIT_MESSAGE)

  return {
    rowNumber: row.rowNumber,
    sku,
    nameCell: row.cells.name?.trim() ?? '',
    depotName,
    ...(qty !== undefined ? { qty } : {}),
    qtyText,
    ...(unit ? { unit } : {}),
    issues,
  }
}

function fitsUnit(qty: number, unit: Unit): boolean {
  return fitsDecimals(scaledFromNumber(qty), unitDecimals(unit))
}

/** Ondalıksız birim yalnız adet (`UNITS`); kesirli adet satır hatası. */
const FRACTIONAL_COUNT_MESSAGE = 'Bu ürün adetle sayılıyor; miktar tam sayı olmalı'

interface LookedUp {
  /** Dosyadaki depo adı → depo anahtarı (veritabanı ifadesiyle). */
  depotKeyOf: Map<string, string>
  depotByKey: Map<string, { id: string; name: string }>
  productBySku: Map<string, { id: string; name: string; unit: Unit; archived: boolean }>
  /** Tam eşleşmeyen kod → aynı sayılabilecek mevcut ürün kodları. */
  looseProducts: Map<string, string[]>
  /** Tam eşleşmeyen kod → gevşek anahtarı (dosya içi çakışma için). */
  looseKeyOf: Map<string, string>
  /** Ürün → depo (null = atanmamış) → miktar (ölçekli). */
  stock: Map<string, Map<string | null, bigint>>
}

/**
 * Önizlemenin bütün okumaları TOPLU: 20.000 satırda satır başına sorgu
 * önizlemeyi dakikalara çıkarırdı.
 *
 * Depo anahtarı ve gevşek kod anahtarı VERİTABANINDA hesaplanıyor: depo
 * anahtarı `depots.name_key`'in aynı ifadesi; JS'te ikinci bir kopyası bir gün
 * ayrışır ve "Merkez Depo" ikinci bir depo açardı.
 */
async function lookup(tenantId: string, depotNames: string[], skus: string[], db?: Db): Promise<LookedUp> {
  return withTenant(
    tenantId,
    async (tx) => {
      const depotKeys =
        depotNames.length === 0
          ? []
          : [
              // `\\s`: şablon dizgesinde tek ters bölü düşer ve SQL'e 's+' gider;
              // "Deposu" "depo u" olur, anahtar `name_key` ile eşleşmezdi.
              ...(await tx.execute<{ name: string; key: string }>(sql`
                SELECT n.name, tr_norm(regexp_replace(btrim(n.name), '\\s+', ' ', 'g')) AS key
                  FROM jsonb_array_elements_text(${JSON.stringify(depotNames)}::jsonb) AS n(name)
              `)),
            ]
      const existingDepots = await tx
        .select({ id: depots.id, name: depots.name, key: depots.nameKey })
        .from(depots)
        .where(eq(depots.tenantId, tenantId))

      const exact =
        skus.length === 0
          ? []
          : await tx
              .select({
                id: products.id,
                sku: products.sku,
                name: products.name,
                unit: products.unit,
                archivedAt: products.archivedAt,
              })
              .from(products)
              .where(and(eq(products.tenantId, tenantId), inArray(products.sku, skus)))
      const matched = new Set(exact.map((p) => p.sku))
      const unmatched = skus.filter((s) => !matched.has(s))

      // BELİRSİZ EŞLEŞME: büyük/küçük harf ve baştaki sıfırlar dışında aynı kod.
      // "abc-1" ile "ABC-1", "00123" ile "123" aynı malzeme olabilir de olmayabilir
      // de; otomatik eşleştirmek ya da yeni ürün açmak ikisi de sessiz hata olurdu.
      const loose =
        unmatched.length === 0
          ? []
          : [
              ...(await tx.execute<{ file_sku: string; loose: string; product_sku: string | null }>(sql`
                SELECT f.sku AS file_sku, ltrim(tr_norm(f.sku), '0') AS loose, p.sku AS product_sku
                  FROM jsonb_array_elements_text(${JSON.stringify(unmatched)}::jsonb) AS f(sku)
                  LEFT JOIN products p
                    ON p.tenant_id = ${tenantId}::uuid
                   AND ltrim(tr_norm(p.sku), '0') = ltrim(tr_norm(f.sku), '0')
              `)),
            ]

      const ids = exact.map((p) => p.id)
      const sums =
        ids.length === 0
          ? []
          : await tx
              .select({
                productId: stockMovements.productId,
                depotId: stockMovements.depotId,
                qty: sql<string>`COALESCE(SUM(${stockMovements.delta}), 0)::text`,
              })
              .from(stockMovements)
              .where(and(eq(stockMovements.tenantId, tenantId), inArray(stockMovements.productId, ids)))
              .groupBy(stockMovements.productId, stockMovements.depotId)

      const looseProducts = new Map<string, string[]>()
      const looseKeyOf = new Map<string, string>()
      for (const r of loose) {
        looseKeyOf.set(r.file_sku, r.loose)
        if (r.product_sku !== null) looseProducts.set(r.file_sku, [...(looseProducts.get(r.file_sku) ?? []), r.product_sku])
      }
      const stock = new Map<string, Map<string | null, bigint>>()
      for (const s of sums) {
        const byDepot = stock.get(s.productId) ?? new Map<string | null, bigint>()
        byDepot.set(s.depotId, parseScaled(s.qty))
        stock.set(s.productId, byDepot)
      }

      return {
        depotKeyOf: new Map(depotKeys.map((d) => [d.name, d.key])),
        depotByKey: new Map(existingDepots.map((d) => [d.key as string, { id: d.id, name: d.name }])),
        productBySku: new Map(
          exact.map((p) => [
            p.sku,
            { id: p.id, name: p.name, unit: p.unit as Unit, archived: p.archivedAt !== null },
          ]),
        ),
        looseProducts,
        looseKeyOf,
        stock,
      }
    },
    db,
  )
}

/**
 * Bütün dosya için satır kararlarını verir. HİÇBİR ŞEY YAZMAZ: ne ürün, ne
 * depo, ne hareket. Depo miktarları bu anda okunuyor; uygulama kilit altında
 * bunlarla karşılaştırıyor.
 *
 * Satır kararları:
 *   error       dosyada düzeltilecek bir şey var (boş/negatif/belirsiz miktar,
 *               boş depo, belirsiz eşleşme, yeni üründe ad ya da birim yok…)
 *   unassigned  üründe deposu bilinmeyen eski stok var: yazılmıyor, yalnız o
 *               satır; dosyanın geri kalanı işleniyor (S2)
 *   unchanged   depo zaten bu miktarda: hareket yok
 *   update      mevcut ürün, depo miktarı değişecek
 *   create      yeni ürün (barkodsuz, fiyatsız; kod başına bir kez) ve stoğu
 */
export async function previewInventory(
  actor: Actor,
  raw: RawInventoryRow[],
  options: { db?: Db } = {},
): Promise<InventoryPreview> {
  requirePermission(actor, 'count:approve')

  const parsed = raw.map(parseCells)
  const depotNames = [...new Set(parsed.map((p) => p.depotName).filter((n) => n !== ''))]
  const skus = [...new Set(parsed.map((p) => p.sku).filter((s) => s !== ''))]
  const found = await lookup(actor.tenantId, depotNames, skus, options.db)
  const keyOf = (p: ParsedCells) => found.depotKeyOf.get(p.depotName) ?? ''

  // AYNI MALZEME AYNI DEPODA İKİ KEZ: iki farklı sayımdan hangisi doğru,
  // dosyadan anlaşılamıyor. İlkini seçmek ötekini sessizce yok saymak olurdu;
  // iki satır da hatalı.
  const pairs = new Map<string, number[]>()
  for (const p of parsed) {
    if (p.sku === '' || p.depotName === '') continue
    const k = `${p.sku}\u0000${keyOf(p)}`
    pairs.set(k, [...(pairs.get(k) ?? []), p.rowNumber])
  }
  for (const p of parsed) {
    if (p.sku === '' || p.depotName === '') continue
    const same = pairs.get(`${p.sku}\u0000${keyOf(p)}`)!
    if (same.length > 1) {
      const others = same.filter((n) => n !== p.rowNumber).join(', ')
      p.issues.push({ column: label('sku'), message: `Bu malzeme bu depoda başka satırda da var (satır ${others})` })
    }
  }

  // Tam eşleşmeyen kodların gevşek anahtarları: dosyada aynı sayılabilecek iki
  // farklı yeni kod da belirsiz (iki ayrı ürün mü, yazım farkı mı).
  const looseGroups = new Map<string, Set<string>>()
  for (const [sku, key] of found.looseKeyOf) {
    looseGroups.set(key, (looseGroups.get(key) ?? new Set()).add(sku))
  }

  const rows: InventoryPreviewRow[] = []
  const newBySku = new Map<string, ParsedCells[]>()
  const errorRow = (p: ParsedCells, extra: Partial<InventoryPreviewRow> = {}): InventoryPreviewRow => ({
    rowNumber: p.rowNumber,
    action: 'error',
    sku: p.sku,
    name: p.nameCell,
    issues: p.issues,
    ...extra,
  })

  for (const p of parsed) {
    if (p.issues.length > 0) {
      rows.push(errorRow(p))
      continue
    }
    const qty = p.qty!
    const depotKey = keyOf(p)
    const depot = found.depotByKey.get(depotKey)
    const product = found.productBySku.get(p.sku)

    if (!product) {
      const existing = found.looseProducts.get(p.sku)
      const siblings = [...(looseGroups.get(found.looseKeyOf.get(p.sku) ?? '') ?? [])].filter((s) => s !== p.sku)
      if (existing?.length || siblings.length > 0) {
        const message = existing?.length
          ? `Belirsiz eşleşme: sistemde "${existing[0]}" kodlu ürün var; kod tam aynı değil. Kodu düzeltin.`
          : `Belirsiz eşleşme: dosyada "${siblings[0]}" kodu da var; aynı ürün mü anlaşılmıyor. Kodu düzeltin.`
        p.issues.push({ column: label('sku'), message })
        rows.push(errorRow(p, { ambiguous: true }))
        continue
      }
      // Yeni ürün: kararı kodun BÜTÜN satırları görüldükten sonra (aşağıda).
      newBySku.set(p.sku, [...(newBySku.get(p.sku) ?? []), p])
      rows.push(errorRow(p)) // yer tutucu; aşağıda değiştiriliyor
      continue
    }

    if (product.archived) p.issues.push({ column: label('sku'), message: 'Ürün arşivlenmiş; envanteri güncellenmez' })
    if (p.unit && p.unit !== product.unit) {
      p.issues.push({
        column: label('unit'),
        message: `Birim ürünün biriminden farklı (ürün: ${UNITS[product.unit].tr})`,
      })
    }
    if (!fitsUnit(qty, product.unit)) p.issues.push({ column: label('qty'), message: FRACTIONAL_COUNT_MESSAGE })
    if (p.issues.length > 0) {
      rows.push(errorRow(p, { name: product.name }))
      continue
    }

    const byDepot = found.stock.get(product.id)
    const expected = depot ? (byDepot?.get(depot.id) ?? 0n) : 0n
    const unassigned = byDepot?.get(null) ?? 0n
    const target = scaledFromNumber(qty)
    const data: InventoryRowData = {
      sku: p.sku,
      name: product.name,
      unit: product.unit,
      depotName: p.depotName,
      depotKey,
      targetQty: qty,
      expectedQty: scaledToNumber(expected),
      newDepot: !depot,
    }
    const base = { rowNumber: p.rowNumber, sku: p.sku, name: product.name, issues: [], data, productId: product.id }
    if (unassigned !== 0n) {
      rows.push({
        ...base,
        action: 'unassigned',
        message: `Depoya atama bekliyor: üründe deposu bilinmeyen ${formatQty(scaledToNumber(unassigned), product.unit)} stok var; bu satır yazılmadı. Önce depoya atanmalı.`,
      })
    } else {
      rows.push({ ...base, action: target === expected ? 'unchanged' : 'update' })
    }
  }

  // YENİ ÜRÜNLER, kod başına: ad ilk dolu açıklamadan, birim bütün satırlarda
  // aynı olmalı (farklı birim aynı miktarı farklı ölçerdi). Ürünü kodun ilk
  // geçerli satırı açıyor; aynı kodun diğer depo satırları onu kullanıyor.
  const decided = new Map<number, InventoryPreviewRow>()
  for (const [sku, group] of newBySku) {
    const name = group.find((p) => p.nameCell !== '')?.nameCell
    const units = [...new Set(group.map((p) => p.unit).filter((u): u is Unit => u !== undefined))]
    let fail: ImportIssue | undefined
    if (!name) fail = { column: label('name'), message: 'Yeni ürün için Malzeme Açıklaması gerekli' }
    else if (units.length === 0) fail = { column: label('unit'), message: 'Yeni ürün için Birim gerekli' }
    else if (units.length > 1) fail = { column: label('unit'), message: 'Bu malzeme kodunun satırlarında farklı birimler var' }
    else {
      const checked = createProductSchema.safeParse({ sku, name, unit: units[0], barcodes: [] })
      if (!checked.success) {
        const issue = issuesOf(checked.error)[0]!
        fail = { column: issue.path.startsWith('name') ? label('name') : label('sku'), message: issue.message }
      }
    }

    let creator: number | undefined
    for (const p of group) {
      if (fail) {
        p.issues.push(fail)
        decided.set(p.rowNumber, errorRow(p))
        continue
      }
      const unit = units[0]!
      if (!fitsUnit(p.qty!, unit)) {
        p.issues.push({ column: label('qty'), message: FRACTIONAL_COUNT_MESSAGE })
        decided.set(p.rowNumber, errorRow(p))
        continue
      }
      creator ??= p.rowNumber
      const depotKey = keyOf(p)
      decided.set(p.rowNumber, {
        rowNumber: p.rowNumber,
        action: 'create',
        sku,
        name: name!,
        issues: [],
        data: {
          sku,
          name: name!,
          unit,
          depotName: p.depotName,
          depotKey,
          targetQty: p.qty!,
          expectedQty: 0,
          newDepot: !found.depotByKey.has(depotKey),
          creatorRow: creator,
        },
      })
    }
  }
  const finalRows = rows.map((r) => decided.get(r.rowNumber) ?? r)

  const depotsSeen = new Map<string, { name: string; isNew: boolean }>()
  for (const r of finalRows) {
    if (!r.data || depotsSeen.has(r.data.depotKey)) continue
    const existing = found.depotByKey.get(r.data.depotKey)
    depotsSeen.set(r.data.depotKey, { name: existing?.name ?? r.data.depotName, isNew: !existing })
  }

  const count = (a: InventoryRowAction) => finalRows.filter((r) => r.action === a).length
  // Yön, uygulamanın yazacağı farkın işareti: miktarlar ölçekli tamsayı olarak
  // karşılaştırılıyor (INV-8), kayan noktada 0,1 + 0,2 gibi bir fark yanlış
  // yöne sayılabilirdi.
  const direction = (r: InventoryPreviewRow) =>
    r.data && (r.action === 'create' || r.action === 'update')
      ? scaledFromNumber(r.data.targetQty) - scaledFromNumber(r.data.expectedQty)
      : 0n
  return {
    rows: finalRows,
    counts: {
      create: count('create'),
      newProducts: new Set(finalRows.filter((r) => r.action === 'create').map((r) => r.sku)).size,
      update: count('update'),
      unchanged: count('unchanged'),
      unassigned: count('unassigned'),
      error: count('error'),
      ambiguous: finalRows.filter((r) => r.ambiguous).length,
      increase: finalRows.filter((r) => direction(r) > 0n).length,
      decrease: finalRows.filter((r) => direction(r) < 0n).length,
    },
    depots: [...depotsSeen.values()],
    contentHash: contentHashOf(parsed, keyOf),
  }
}

/**
 * İçerik parmak izi (K3). Yalnız dosya adına güvenilmiyor: aynı içerik başka
 * adla da gelebilir. Satır sırası, depo adının yazımı ("MERKEZ  DEPO") ve
 * sayının yazımı ("5" / "5,000") fark yaratmıyor; okunamayan hücre olduğu gibi
 * giriyor. Hesap sunucuda, kaydedilmiş hücrelerden.
 */
function contentHashOf(parsed: ParsedCells[], keyOf: (p: ParsedCells) => string): string {
  const lines = parsed
    .map((p) =>
      [
        p.depotName === '' ? '' : keyOf(p),
        p.sku,
        p.qty !== undefined ? formatScaled(scaledFromNumber(p.qty)) : p.qtyText,
      ].join('\t'),
    )
    .sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

// ---------------------------------------------------------------------------
// UYGULAMA
// ---------------------------------------------------------------------------

/**
 * Envanter hareketinin idempotency anahtarı: UUID v5, ad `aktarım:satır`.
 * Aynı satır iki kez işlenirse (kesinti sonrası yeniden deneme, iki işleyici)
 * ikinci hareket yazılmıyor. Yeni bir aktarım yeni anahtarlar alıyor: aynı
 * içeriği yeniden yüklemek (onaylı yeni sayım) o anki stoğa göre çalışıyor.
 *
 * AD ALANI DEĞİŞMEZ: değişirse yarıda kalmış bir aktarımın yazılmış satırları
 * tanınmaz ve ikinci kez yazılabilir.
 */
const INVENTORY_KEY_NAMESPACE = '3b8f4e2a-6c1d-4f7b-a9e5-2d7c0b4a8e61'

export function inventoryKey(runId: string, rowNumber: number): string {
  return uuidV5(`${runId}:${rowNumber}`, INVENTORY_KEY_NAMESPACE)
}

/**
 * Onayda: dosyanın uygulanacak satırlarının depolarını açar ve her satıra
 * depo kimliğini yazar. Tek transaction'da, aktarımı RUNNING yapan
 * transaction'ın içinde: depo ancak onaylı aktarımda açılıyor.
 *
 * Eşzamanlı ikinci açılışa dayanıklı (`ON CONFLICT`): aynı adı aynı anda
 * başka biri açtıysa o depo kullanılıyor. Ad, anahtarın dosyadaki ilk yazımı.
 */
export async function resolveRunDepots(tx: Tx, tenantId: string, runId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO depots (tenant_id, name)
    SELECT ${tenantId}::uuid, min(r.data->>'depotName')
      FROM import_run_rows r
     WHERE r.tenant_id = ${tenantId}::uuid AND r.run_id = ${runId}::uuid AND r.status = 'PENDING'
     GROUP BY r.data->>'depotKey'
    ON CONFLICT (tenant_id, name_key) DO NOTHING
  `)
  await tx.execute(sql`
    UPDATE import_run_rows r
       SET data = r.data || jsonb_build_object('depotId', d.id)
      FROM depots d
     WHERE r.tenant_id = ${tenantId}::uuid AND r.run_id = ${runId}::uuid AND r.status = 'PENDING'
       AND d.tenant_id = r.tenant_id AND d.name_key = r.data->>'depotKey'
  `)
}

type RunRow = typeof importRunRows.$inferSelect

/**
 * Önizlemede geçerli bulunmuş TEK envanter satırını uygular: gerekirse ürünü
 * açar, sonra fark hareketini yazar. Hiçbir hatayı dışarı atmıyor.
 *
 * Ürün açıldı ama hareket yazılamadıysa ürün geri alınmıyor (satır satır
 * ilkesi, T171); satır "Yazılamadı" olur ve dosyayı yeniden yüklemek eksik
 * stoğu güvenle tamamlar: ürün artık var, beklenen miktar 0.
 */
export async function applyInventoryRow(
  actor: Actor,
  run: { id: string; fileName: string },
  row: RunRow,
  options: { db?: Db } = {},
): Promise<RowOutcome> {
  const data = row.data as unknown as InventoryRowData
  let productId = row.productId ?? undefined
  let created = false

  if (row.action === 'create') {
    if (data.creatorRow === row.rowNumber) {
      try {
        productId = await insertProduct(actor, { sku: data.sku, name: data.name, unit: data.unit, barcodes: [] }, options)
        created = true
      } catch (err) {
        // Önizlemeden sonra aynı kodla ürün açıldı: o ürüne yazmak başkasının
        // ürününün deposunu dosyaya göre değiştirmek olurdu. Çakışma.
        const conflict = err instanceof AppError && err.code === 'SKU_EXISTS'
        return { status: conflict ? 'CONFLICT' : 'FAILED', message: messageOf(err) }
      }
    } else {
      productId = await productCreatedBy(actor.tenantId, run.id, data.creatorRow!, options.db)
      if (!productId) {
        return {
          status: 'FAILED',
          message: `Ürün ${data.creatorRow}. satırda açılamadı; bu depo satırı yazılmadı. Dosyayı düzeltip yeniden yükleyin.`,
        }
      }
    }
  }

  // Yeni ürün, miktar 0: açılması yeterli, hareket yok (defterde delta <> 0).
  if (scaledFromNumber(data.targetQty) === scaledFromNumber(data.expectedQty)) {
    return { status: 'DONE', ...(productId ? { productId } : {}) }
  }

  try {
    await createMovement(
      actor,
      {
        idempotencyKey: inventoryKey(run.id, row.rowNumber),
        productId,
        depotId: data.depotId,
        expectedQty: data.expectedQty,
        targetQty: data.targetQty,
        note: `Envanter dosyası: ${run.fileName}`.slice(0, 500),
        clientCreatedAt: new Date().toISOString(),
      },
      { db: options.db, inventory: true, importRunId: run.id },
    )
    return { status: 'DONE', productId }
  } catch (err) {
    // Depo önizlemeden sonra değişti (STOCK_CHANGED): dosyadaki değer yazılmadı.
    const conflict = !created && err instanceof AppError && err.code === 'STOCK_CHANGED'
    return {
      status: conflict ? 'CONFLICT' : 'FAILED',
      productId,
      message: `${created ? 'Ürün eklendi, stok yazılamadı: ' : ''}${messageOf(err)}`,
    }
  }
}

/**
 * Yeni ürünü açan satırın ürünü, YALNIZ bu aktarım açtıysa. Kodla aramak
 * yetmez: açan satır çakıştıysa (aynı kodu başkası açtı) o ürün başkasının ve
 * bu depo satırı ona yazılmamalı. Açan satır ürünü açtı ama stoğunu
 * yazamadıysa (FAILED, ürün kimliği dolu) ürün yine bizim.
 */
async function productCreatedBy(tenantId: string, runId: string, creatorRow: number, db?: Db): Promise<string | undefined> {
  const [row] = await withTenant(
    tenantId,
    (tx) =>
      tx
        .select({ status: importRunRows.status, productId: importRunRows.productId })
        .from(importRunRows)
        .where(
          and(
            eq(importRunRows.tenantId, tenantId),
            eq(importRunRows.runId, runId),
            eq(importRunRows.rowNumber, creatorRow),
          ),
        ),
    db,
  )
  if (!row?.productId) return undefined
  return row.status === 'DONE' || row.status === 'FAILED' ? row.productId : undefined
}

/**
 * Kesintiye uğramış envanter satırının kararı (bkz. `resolveInterruptedRows`).
 * Hareket anahtarı satıra bağlı olduğu için kanıt çoğu zaman var:
 *
 *   hareket var                         → DONE (uygulandığı kanıtlandı)
 *   mevcut ürün ya da açılmış ürünün
 *   diğer depo satırı, hareket yok      → yeniden dene (kapı beklenen miktarı
 *                                         kilit altında yine sınıyor)
 *   ürünü açan satır, kod yok           → yeniden dene (ürün açılmamış)
 *   ürünü açan satır, kod var           → UNCERTAIN: ürünü bu aktarım mı açtı,
 *                                         başkası mı, kanıtlanamıyor
 */
export async function verifyInventoryRow(tx: Tx, tenantId: string, row: RunRow): Promise<RowVerdict> {
  const data = row.data as unknown as InventoryRowData
  const [movement] = await tx
    .select({ productId: stockMovements.productId })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.tenantId, tenantId),
        eq(stockMovements.idempotencyKey, inventoryKey(row.runId, row.rowNumber)),
      ),
    )
  if (movement) return { retry: false, status: 'DONE', productId: movement.productId }
  if (row.action !== 'create' || data.creatorRow !== row.rowNumber) return { retry: true }

  const [product] = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.sku, data.sku)))
  if (!product) return { retry: true }
  return {
    retry: false,
    productId: product.id,
    message:
      'Kesinti: bu kodla ürün kayıtlı, ama bu aktarımın mı açtığı doğrulanamadı; stoğu yazılmadı. Ürünü kontrol edin; dosyayı yeniden yüklemek güvenli.',
  }
}
