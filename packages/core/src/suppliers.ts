import {
  AppError,
  type Currency,
  SUPPLIER_MATCH_STATE_VALUES,
  type SupplierChangeKind,
  type SupplierMatchState,
  type SupplierPriceType,
  type TaxMode,
  createSupplierSchema,
} from '@stok/shared'
import {
  type Db,
  type Tx,
  isUniqueViolation,
  productBarcodes,
  products,
  supplierItems,
  suppliers,
  withTenant,
} from '@stok/db'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type Actor, requirePermission } from './authz'
import { formatScaled, scaledFromNumber } from './numeric'
import {
  type FeedRowIssue,
  type ParsedSupplierFile,
  type SupplierDefaults,
  normalizeSupplierRows,
} from './supplier-feed'
import { parseOrThrow } from './validate'

/**
 * ============================================================================
 * T200 — B2B V1: TEDARİKÇİ VERİSİ (PRD-14, ADR-006)
 *
 * STOK DEFTERİNE DOKUNMAZ. Bu dosya `stock_movements`, `current_stock` ve
 * ürün kartının alış/satış fiyatına hiçbir yoldan yazmaz (INV-3). Tedarikçinin
 * "elimde 500 var"ı bir bilgi; bizim stoğumuz defterin sonucu.
 *
 * YENİLEME TEK TRANSACTION:
 *
 *   1. tedarikçi satırı FOR UPDATE   eşzamanlı iki yenileme aynı eski fiyata
 *                                     bakıp aynı değişimi iki kez yazamasın
 *   2. satır doğrulaması             varsayılan koşullar tedarikçiden
 *   3. barkod çözümü                 yalnız aktif barkod, arşivlenmemiş ürün
 *   4. eşleşme ve fiyat miktarı      kararlar TS'te, tek seferde
 *   5. TEK SQL                       fark → supplier_price_changes,
 *                                     sonra supplier_items upsert
 *   6. last_refreshed_at             yalnız geçerli satır yazıldıysa
 *
 * Hata olursa hiçbir şey yazılmaz: kalemler, geçmiş ve son yenileme zamanı
 * olduğu gibi kalır. Dosyada olmayan kalem DEĞİŞMEZ ve işaretlenmez: kaynağın
 * tam mı kısmi mi liste gönderdiği bilinmiyor, yokluk bilgi sayılmıyor.
 *
 * ÖNİZLEME AYNI KODU ÇALIŞTIRIR ve transaction'ı geri alır. Ayrı bir
 * "tahmin" kodu yazılsaydı önizlemenin "12 fiyat değişecek" dediği dosya
 * kayıtta 15 değişim yazabilirdi.
 * ============================================================================
 */

export interface SupplierOptions {
  db?: Db
}

export interface SupplierRow {
  id: string
  name: string
  defaultCurrency: Currency
  defaultTaxMode: TaxMode
  defaultPriceType: SupplierPriceType
  /** Yönetici "fiyatlar 1 ürün birimi içindir" dedi mi. Varsayılan hayır (belirsiz). */
  unitPriceDeclared: boolean
  lastRefreshedAt: Date | null
  itemCount: number
  unmatchedCount: number
  createdAt: Date
}

const idSchema = z.string().uuid()

/**
 * Bozuk kimlik NOT_FOUND: PostgreSQL'e gitseydi 22P02 olarak patlar ve
 * kullanıcı 500 görürdü. Başka kiracının kimliği de NOT_FOUND (RLS).
 */
function idOrNotFound(id: string, what: 'supplier' | 'supplierItem' | 'product'): string {
  if (!idSchema.safeParse(id).success) {
    throw new AppError('NOT_FOUND', `${what} ${id} not found`, { [`${what}Id`]: id })
  }
  return id
}

// ---------------------------------------------------------------------------
// TEDARİKÇİ
// ---------------------------------------------------------------------------

async function selectSuppliers(tx: Tx, tenantId: string, supplierId?: string) {
  const rows = await tx
    .select({
      id: suppliers.id,
      name: suppliers.name,
      defaultCurrency: suppliers.defaultCurrency,
      defaultTaxMode: suppliers.defaultTaxMode,
      defaultPriceType: suppliers.defaultPriceType,
      unitPriceDeclared: suppliers.unitPriceDeclared,
      lastRefreshedAt: suppliers.lastRefreshedAt,
      createdAt: suppliers.createdAt,
      itemCount: sql<number>`count(${supplierItems.id})::int`,
      unmatchedCount: sql<number>`(count(${supplierItems.id}) FILTER (WHERE ${supplierItems.matchState} = 'UNMATCHED'))::int`,
    })
    .from(suppliers)
    .leftJoin(
      supplierItems,
      and(eq(supplierItems.tenantId, suppliers.tenantId), eq(supplierItems.supplierId, suppliers.id)),
    )
    .where(
      supplierId === undefined
        ? eq(suppliers.tenantId, tenantId)
        : and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, supplierId)),
    )
    .groupBy(suppliers.id)
    // Türkçe sıralama `tr_norm` üzerinden (DAT-11).
    .orderBy(suppliers.nameNorm)

  return rows.map(
    (r): SupplierRow => ({
      ...r,
      defaultCurrency: r.defaultCurrency as Currency,
      defaultTaxMode: r.defaultTaxMode as TaxMode,
      defaultPriceType: r.defaultPriceType as SupplierPriceType,
    }),
  )
}

export async function listSuppliers(
  actor: Actor,
  options: SupplierOptions = {},
): Promise<SupplierRow[]> {
  requirePermission(actor, 'supplier:read')
  return withTenant(actor.tenantId, (tx) => selectSuppliers(tx, actor.tenantId), options.db)
}

export async function getSupplier(
  actor: Actor,
  supplierId: string,
  options: SupplierOptions = {},
): Promise<SupplierRow> {
  requirePermission(actor, 'supplier:read')
  const id = idOrNotFound(supplierId, 'supplier')
  const [row] = await withTenant(
    actor.tenantId,
    (tx) => selectSuppliers(tx, actor.tenantId, id),
    options.db,
  )
  if (!row) throw new AppError('NOT_FOUND', `supplier ${id} not found`, { supplierId: id })
  return row
}

export async function createSupplier(
  actor: Actor,
  raw: unknown,
  options: SupplierOptions = {},
): Promise<SupplierRow> {
  requirePermission(actor, 'supplier:manage')
  const input = parseOrThrow(createSupplierSchema, raw)

  const id = await withTenant(
    actor.tenantId,
    async (tx) => {
      const [row] = await tx
        .insert(suppliers)
        .values({
          tenantId: actor.tenantId,
          name: input.name,
          defaultCurrency: input.defaultCurrency,
          defaultTaxMode: input.defaultTaxMode,
          defaultPriceType: input.defaultPriceType,
          unitPriceDeclared: input.unitPriceDeclared,
        })
        .returning({ id: suppliers.id })
        .catch((err: unknown) => {
          // Çakışma constraint ADINDAN okunuyor (products.ts'teki gerekçe).
          if (isUniqueViolation(err, 'suppliers_tenant_name_uq')) {
            throw new AppError('SUPPLIER_NAME_EXISTS', 'supplier name exists', { name: input.name })
          }
          throw err
        })
      return row!.id
    },
    options.db,
  )

  return getSupplier(actor, id, options)
}

// ---------------------------------------------------------------------------
// YENİLEME ("Verileri Getir")
// ---------------------------------------------------------------------------

export interface RefreshSummary {
  /** Dosyadaki satır sayısı. */
  received: number
  /** Doğrulamadan geçen ve yazılan (önizlemede: yazılacak) satırlar. */
  valid: number
  created: number
  /** Daha önce görülmüş ve bu dosyada da olan kalemler. */
  updated: number
  /** Güncellenip fiyatı ve koşulu değişmeyenler: geçmiş satırı YOK. */
  unchanged: number
  priceUp: number
  priceDown: number
  /** Para birimi, KDV, fiyat türü ya da fiyat miktarı değişti: yüzde yok. */
  conditionChanged: number
  /** Fiyat değişti ama miktar iki tarafta da belirsiz: yüzde yok. */
  qtyUnknownChanged: number
  /** Bu yenilemede barkodla yeni eşleşen kalemler. */
  autoMatched: number
  /** Dosyadaki kalemlerden eşleşme bekleyenler. */
  unmatched: number
  /** Fiyat miktarı belirsiz kalan kalemler; karşılaştırmaya girmez. */
  priceQtyUnknown: number
  errors: FeedRowIssue[]
  warnings: FeedRowIssue[]
}

interface LockedSupplier {
  defaults: SupplierDefaults
  unitPriceDeclared: boolean
}

/**
 * Tedarikçi satırını kilitler. Yenileme ve elle eşleştirme aynı kilidi
 * alıyor: yenileme kalemin `UNMATCHED` olduğunu okuduktan sonra araya giren
 * bir "Bağla" kararı ezilmesin.
 */
async function lockSupplier(tx: Tx, tenantId: string, supplierId: string): Promise<LockedSupplier> {
  const [row] = await tx
    .select({
      currency: suppliers.defaultCurrency,
      taxMode: suppliers.defaultTaxMode,
      priceType: suppliers.defaultPriceType,
      unitPriceDeclared: suppliers.unitPriceDeclared,
    })
    .from(suppliers)
    .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, supplierId)))
    .for('update')

  if (!row) throw new AppError('NOT_FOUND', `supplier ${supplierId} not found`, { supplierId })
  return {
    defaults: {
      currency: row.currency as Currency,
      taxMode: row.taxMode as TaxMode,
      priceType: row.priceType as SupplierPriceType,
    },
    unitPriceDeclared: row.unitPriceDeclared,
  }
}

/**
 * Değişim satırının türü. Karşılaştırılabilirlik veritabanında üretilen
 * sütundan okunuyor (schema.ts); burada yalnız "karşılaştırılamıyorsa neden"
 * ayrılıyor: koşul mu değişti, yoksa miktar iki tarafta da mı belirsiz.
 */
const CHANGE_KIND = sql.raw(`CASE
  WHEN is_comparable THEN 'PRICE'
  WHEN (old_currency, old_tax_mode, old_price_type, old_price_qty)
       IS NOT DISTINCT FROM (new_currency, new_tax_mode, new_price_type, new_price_qty)
    THEN 'QTY_UNKNOWN'
  ELSE 'CONDITION'
END`)

const ONE_UNIT = '1.000'

function addIssue(list: FeedRowIssue[], issue: Omit<FeedRowIssue, 'messages'>, message: string) {
  const existing = list.find((w) => w.rowNumber === issue.rowNumber)
  if (existing) existing.messages.push(message)
  else list.push({ ...issue, messages: [message] })
}

async function applyRefresh(
  tx: Tx,
  actor: Actor,
  supplierId: string,
  file: ParsedSupplierFile,
): Promise<RefreshSummary> {
  const tenantId = actor.tenantId
  const supplier = await lockSupplier(tx, tenantId, supplierId)
  const { items, errors, warnings } = normalizeSupplierRows(file, supplier.defaults)

  const summary: RefreshSummary = {
    received: file.rows.length,
    valid: items.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    priceUp: 0,
    priceDown: 0,
    conditionChanged: 0,
    qtyUnknownChanged: 0,
    autoMatched: 0,
    unmatched: 0,
    priceQtyUnknown: 0,
    errors,
    warnings,
  }
  if (items.length === 0) return summary

  const barcodes = [...new Set(items.flatMap((i) => (i.barcode ? [i.barcode] : [])))]
  const known =
    barcodes.length === 0
      ? []
      : await tx
          .select({
            barcode: productBarcodes.barcode,
            productId: productBarcodes.productId,
            kind: productBarcodes.kind,
          })
          .from(productBarcodes)
          .innerJoin(products, eq(products.id, productBarcodes.productId))
          .where(
            and(
              eq(productBarcodes.tenantId, tenantId),
              inArray(productBarcodes.barcode, barcodes),
              isNull(productBarcodes.archivedAt),
              isNull(products.archivedAt),
            ),
          )
  const byBarcode = new Map(known.map((k) => [k.barcode, k]))

  const existingRows = await tx
    .select({
      code: supplierItems.supplierCode,
      productId: supplierItems.productId,
      matchState: supplierItems.matchState,
    })
    .from(supplierItems)
    .where(
      and(
        eq(supplierItems.tenantId, tenantId),
        eq(supplierItems.supplierId, supplierId),
        inArray(
          supplierItems.supplierCode,
          items.map((i) => i.supplierCode),
        ),
      ),
    )
  const existing = new Map(existingRows.map((r) => [r.code, r]))

  const payload = items.map((item) => {
    const prev = existing.get(item.supplierCode)
    const hit = item.barcode ? byBarcode.get(item.barcode) : undefined
    const issue = { rowNumber: item.rowNumber, supplierCode: item.supplierCode, name: item.name }

    // EŞLEŞME: yalnız barkod. Elle verilen karar (MANUAL, IGNORED) ve önceki
    // otomatik eşleşme yenilemede korunur; tekrar denenen yalnız UNMATCHED.
    let productId: string | null = null
    let matchState: SupplierMatchState = 'UNMATCHED'
    if (prev && prev.matchState !== 'UNMATCHED') {
      productId = prev.productId
      matchState = prev.matchState as SupplierMatchState
    } else if (hit) {
      productId = hit.productId
      matchState = 'AUTO'
      summary.autoMatched += 1
    }
    if (matchState === 'UNMATCHED') summary.unmatched += 1

    // FİYAT MİKTARI eşleşmeden AYRI ve yalnız açık beyandan (T200, B2):
    // satırdaki "Fiyat Miktarı" > tedarikçinin birim beyanı > belirsiz.
    // Barkod çarpanı miktar ÜRETMEZ; koli barkodu yalnız beyanı askıya alır,
    // çünkü "fiyatlar birim başına" beyanı o satır için çelişkili olur.
    let priceQty: string | null = null
    if (item.priceQty !== undefined) {
      priceQty = formatScaled(scaledFromNumber(item.priceQty))
    } else if (supplier.unitPriceDeclared) {
      if (hit?.kind === 'CASE') {
        addIssue(warnings, issue, 'Koli barkoduyla eşleşti; fiyat miktarı belirsiz bırakıldı')
      } else {
        priceQty = ONE_UNIT
      }
    }
    if (priceQty === null) summary.priceQtyUnknown += 1

    if (prev) summary.updated += 1
    else summary.created += 1

    return {
      supplier_code: item.supplierCode,
      barcode: item.barcode ?? null,
      name: item.name,
      brand: item.brand ?? null,
      // Metin olarak gidiyor: şema 4 ondalığı ve üst sınırı zorladı,
      // `toFixed(4)` bu büyüklükte tam (INV-8).
      price: item.price.toFixed(4),
      currency: item.currency,
      tax_mode: item.taxMode,
      price_type: item.priceType,
      price_qty: priceQty,
      stock_qty: item.stockQty === undefined ? null : formatScaled(scaledFromNumber(item.stockQty)),
      source_updated_at: item.sourceUpdatedAt ?? null,
      product_id: productId,
      match_state: matchState,
    }
  })

  // TEK PARAMETRE, JSON: satır başına parametre 5.000 satırda PostgreSQL'in
  // 65.535 parametre sınırını aşardı. Fark PostgreSQL'de `numeric` ile
  // bulunuyor: 10.5 ile 10.5000 aynı fiyat, metin karşılaştırması sahte
  // değişim yazardı. Veri değiştiren iki CTE aynı anlık görüntüyü görüyor:
  // geçmiş satırı ESKİ fiyatı, upsert'ten önceki hâlden okuyor.
  const changes = await tx.execute<{ kind: SupplierChangeKind; direction: number }>(sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS x(
        supplier_code text, barcode text, name text, brand text,
        price numeric, currency text, tax_mode text, price_type text,
        price_qty numeric, stock_qty numeric, source_updated_at timestamptz,
        product_id uuid, match_state text)
    ),
    changed AS (
      INSERT INTO supplier_price_changes (
        tenant_id, supplier_item_id,
        old_price, old_currency, old_tax_mode, old_price_type, old_price_qty,
        new_price, new_currency, new_tax_mode, new_price_type, new_price_qty)
      SELECT s.tenant_id, s.id,
             s.price, s.currency, s.tax_mode, s.price_type, s.price_qty,
             i.price, i.currency, i.tax_mode, i.price_type, i.price_qty
        FROM incoming i
        JOIN supplier_items s
          ON s.tenant_id = ${tenantId}::uuid
         AND s.supplier_id = ${supplierId}::uuid
         AND s.supplier_code = i.supplier_code
       WHERE (s.price, s.currency, s.tax_mode, s.price_type, s.price_qty)
             IS DISTINCT FROM (i.price, i.currency, i.tax_mode, i.price_type, i.price_qty)
      RETURNING ${CHANGE_KIND} AS kind, sign(new_price - old_price)::int AS direction
    ),
    upserted AS (
      INSERT INTO supplier_items (
        tenant_id, supplier_id, supplier_code, barcode, name, brand,
        price, currency, tax_mode, price_type, price_qty, stock_qty,
        source_updated_at, fetched_at, product_id, match_state)
      SELECT ${tenantId}::uuid, ${supplierId}::uuid, i.supplier_code, i.barcode, i.name, i.brand,
             i.price, i.currency, i.tax_mode, i.price_type, i.price_qty, i.stock_qty,
             i.source_updated_at, now(), i.product_id, i.match_state
        FROM incoming i
      ON CONFLICT (tenant_id, supplier_id, supplier_code) DO UPDATE SET
        barcode = EXCLUDED.barcode,
        name = EXCLUDED.name,
        brand = EXCLUDED.brand,
        price = EXCLUDED.price,
        currency = EXCLUDED.currency,
        tax_mode = EXCLUDED.tax_mode,
        price_type = EXCLUDED.price_type,
        price_qty = EXCLUDED.price_qty,
        stock_qty = EXCLUDED.stock_qty,
        source_updated_at = EXCLUDED.source_updated_at,
        fetched_at = EXCLUDED.fetched_at,
        product_id = EXCLUDED.product_id,
        match_state = EXCLUDED.match_state
      RETURNING 1
    )
    SELECT kind, direction FROM changed
  `)

  for (const c of changes) {
    if (c.kind === 'PRICE') {
      if (c.direction > 0) summary.priceUp += 1
      else summary.priceDown += 1
    } else if (c.kind === 'CONDITION') summary.conditionChanged += 1
    else summary.qtyUnknownChanged += 1
  }
  summary.unchanged = summary.updated - [...changes].length

  await tx
    .update(suppliers)
    .set({ lastRefreshedAt: sql`now()` })
    .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, supplierId)))

  return summary
}

/** Önizlemeyi geri almak için fırlatılan, sonucu taşıyan işaret. Hata değil. */
class PreviewRollback extends Error {
  constructor(readonly summary: RefreshSummary) {
    super('supplier refresh preview: rollback')
    this.name = 'PreviewRollback'
  }
}

/**
 * Önizleme: yenilemenin AYNISI, sonra geri alma. Hiçbir şey kalıcı olmaz;
 * kullanıcı dosyanın nasıl okunduğunu görür (T200, B1). Fiyat değişimleri
 * tek tek onaylanmaz (PRD-14), onaylanan dosyanın okunuşudur.
 */
export async function previewSupplierRefresh(
  actor: Actor,
  supplierId: string,
  file: ParsedSupplierFile,
  options: SupplierOptions = {},
): Promise<RefreshSummary> {
  requirePermission(actor, 'supplier:manage')
  const id = idOrNotFound(supplierId, 'supplier')

  return withTenant(
    actor.tenantId,
    async (tx) => {
      throw new PreviewRollback(await applyRefresh(tx, actor, id, file))
    },
    options.db,
  ).catch((err: unknown) => {
    if (err instanceof PreviewRollback) return err.summary
    throw err
  })
}

/**
 * Kayıt. Önizlemedeki sınıflandırmaya güvenmez: dosya istemciden geri geliyor,
 * kilit altında yeniden hesaplanıyor. Geçerli satır yoksa hiçbir şey yazmaz,
 * son yenileme zamanı da ilerlemez.
 */
export async function refreshSupplier(
  actor: Actor,
  supplierId: string,
  file: ParsedSupplierFile,
  options: SupplierOptions = {},
): Promise<RefreshSummary> {
  requirePermission(actor, 'supplier:manage')
  const id = idOrNotFound(supplierId, 'supplier')

  return withTenant(
    actor.tenantId,
    async (tx) => {
      const summary = await applyRefresh(tx, actor, id, file)
      if (summary.valid === 0) {
        throw new AppError('SUPPLIER_FEED_NO_VALID_ROWS', 'no valid rows to save', {
          errorRows: summary.errors.length,
        })
      }
      return summary
    },
    options.db,
  )
}

// ---------------------------------------------------------------------------
// ELLE EŞLEŞTİRME
// ---------------------------------------------------------------------------

/** Kalemin tedarikçisini bulur ve kilitler; kalem yoksa (ya da başka kiracınınsa) NOT_FOUND. */
async function lockItemSupplier(tx: Tx, tenantId: string, itemId: string): Promise<void> {
  const [item] = await tx
    .select({ supplierId: supplierItems.supplierId })
    .from(supplierItems)
    .where(and(eq(supplierItems.tenantId, tenantId), eq(supplierItems.id, itemId)))
  if (!item) {
    throw new AppError('NOT_FOUND', `supplier item ${itemId} not found`, { supplierItemId: itemId })
  }
  await lockSupplier(tx, tenantId, item.supplierId)
}

/** Kalemi bir ürüne bağlar. Sonraki yenilemeler bu kararı değiştirmez. */
export async function bindSupplierItem(
  actor: Actor,
  supplierItemId: string,
  productId: string,
  options: SupplierOptions = {},
): Promise<void> {
  requirePermission(actor, 'supplier:manage')
  const itemId = idOrNotFound(supplierItemId, 'supplierItem')
  const target = idOrNotFound(productId, 'product')

  await withTenant(
    actor.tenantId,
    async (tx) => {
      await lockItemSupplier(tx, actor.tenantId, itemId)

      // FK kontrolü RLS'i atlar (PROJECT_BRAIN §8, T153): başka kiracının
      // ürün kimliği FK'dan geçerdi. Ürün kiracı içinde ayrıca aranıyor.
      const [product] = await tx
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.tenantId, actor.tenantId),
            eq(products.id, target),
            isNull(products.archivedAt),
          ),
        )
      if (!product) {
        throw new AppError('NOT_FOUND', `product ${target} not found`, { productId: target })
      }

      await tx
        .update(supplierItems)
        .set({ productId: target, matchState: 'MANUAL' })
        .where(and(eq(supplierItems.tenantId, actor.tenantId), eq(supplierItems.id, itemId)))
    },
    options.db,
  )
}

/**
 * Kalemi "bizim değil" olarak işaretler ya da yanlış bağlantıyı kaldırır.
 * `IGNORED` kalem otomatik eşleşmeye bir daha girmez; gerekirse elle bağlanır.
 */
export async function ignoreSupplierItem(
  actor: Actor,
  supplierItemId: string,
  options: SupplierOptions = {},
): Promise<void> {
  requirePermission(actor, 'supplier:manage')
  const itemId = idOrNotFound(supplierItemId, 'supplierItem')

  await withTenant(
    actor.tenantId,
    async (tx) => {
      await lockItemSupplier(tx, actor.tenantId, itemId)
      await tx
        .update(supplierItems)
        .set({ productId: null, matchState: 'IGNORED' })
        .where(and(eq(supplierItems.tenantId, actor.tenantId), eq(supplierItems.id, itemId)))
    },
    options.db,
  )
}

// ---------------------------------------------------------------------------
// OKUMA
//
// Fiyatlar METİN dönüyor ("12.5000"): 4 ondalıklı fiyat sayıya çevrilip
// ekranda 2 ondalığa yuvarlansaydı iki farklı fiyat aynı görünürdü.
// ---------------------------------------------------------------------------

const listItemsSchema = z.object({
  matchState: z
    .enum(SUPPLIER_MATCH_STATE_VALUES as [SupplierMatchState, ...SupplierMatchState[]])
    .optional(),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
})

export interface SupplierItemRow {
  id: string
  supplierCode: string
  barcode: string | null
  name: string
  brand: string | null
  price: string
  currency: Currency
  taxMode: TaxMode
  priceType: SupplierPriceType
  /** NULL = fiyat miktarı belirsiz. */
  priceQty: string | null
  stockQty: string | null
  sourceUpdatedAt: Date | null
  fetchedAt: Date
  matchState: SupplierMatchState
  productId: string | null
  productName: string | null
  productSku: string | null
}

export async function listSupplierItems(
  actor: Actor,
  supplierId: string,
  raw: unknown = {},
  options: SupplierOptions = {},
): Promise<{ rows: SupplierItemRow[]; total: number }> {
  requirePermission(actor, 'supplier:read')
  const id = idOrNotFound(supplierId, 'supplier')
  const q = parseOrThrow(listItemsSchema, raw)

  const where = and(
    eq(supplierItems.tenantId, actor.tenantId),
    eq(supplierItems.supplierId, id),
    q.matchState ? eq(supplierItems.matchState, q.matchState) : undefined,
  )

  const { rows, total } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const rows = await tx
        .select({
          id: supplierItems.id,
          supplierCode: supplierItems.supplierCode,
          barcode: supplierItems.barcode,
          name: supplierItems.name,
          brand: supplierItems.brand,
          price: supplierItems.price,
          currency: supplierItems.currency,
          taxMode: supplierItems.taxMode,
          priceType: supplierItems.priceType,
          priceQty: supplierItems.priceQty,
          stockQty: supplierItems.stockQty,
          sourceUpdatedAt: supplierItems.sourceUpdatedAt,
          fetchedAt: supplierItems.fetchedAt,
          matchState: supplierItems.matchState,
          productId: supplierItems.productId,
          productName: products.name,
          productSku: products.sku,
        })
        .from(supplierItems)
        .leftJoin(products, eq(products.id, supplierItems.productId))
        .where(where)
        .orderBy(sql`tr_norm(${supplierItems.name})`, supplierItems.supplierCode)
        .limit(q.limit)
        .offset(q.offset)
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(supplierItems)
        .where(where)
      return { rows, total: n }
    },
    options.db,
  )

  return {
    total,
    rows: rows.map((r) => ({
      ...r,
      currency: r.currency as Currency,
      taxMode: r.taxMode as TaxMode,
      priceType: r.priceType as SupplierPriceType,
      matchState: r.matchState as SupplierMatchState,
    })),
  }
}

export interface PriceChangeRow {
  id: string
  supplierItemId: string
  supplierCode: string
  itemName: string
  kind: SupplierChangeKind
  /** Yalnız `PRICE`'ta: 1 artış, -1 azalış. Diğer türlerde yön yok. */
  direction: 1 | -1 | null
  /** Yalnız `PRICE`'ta dolu, bir ondalık ("10.0"). */
  changePct: string | null
  oldPrice: string
  oldCurrency: Currency
  oldTaxMode: TaxMode
  oldPriceType: SupplierPriceType
  oldPriceQty: string | null
  newPrice: string
  newCurrency: Currency
  newTaxMode: TaxMode
  newPriceType: SupplierPriceType
  newPriceQty: string | null
  createdAt: Date
}

// `type`, `interface` değil: `execute<T>` satır tipinin indeks imzası istiyor.
type RawChange = {
  id: string
  supplier_item_id: string
  supplier_code: string
  item_name: string
  kind: SupplierChangeKind
  direction: number
  change_pct: string | null
  old_price: string
  old_currency: string
  old_tax_mode: string
  old_price_type: string
  old_price_qty: string | null
  new_price: string
  new_currency: string
  new_tax_mode: string
  new_price_type: string
  new_price_qty: string | null
  created_at: string
}

function mapChange(r: RawChange): PriceChangeRow {
  return {
    id: r.id,
    supplierItemId: r.supplier_item_id,
    supplierCode: r.supplier_code,
    itemName: r.item_name,
    kind: r.kind,
    direction: r.kind === 'PRICE' ? (r.direction > 0 ? 1 : -1) : null,
    changePct: r.change_pct,
    oldPrice: r.old_price,
    oldCurrency: r.old_currency as Currency,
    oldTaxMode: r.old_tax_mode as TaxMode,
    oldPriceType: r.old_price_type as SupplierPriceType,
    oldPriceQty: r.old_price_qty,
    newPrice: r.new_price,
    newCurrency: r.new_currency as Currency,
    newTaxMode: r.new_tax_mode as TaxMode,
    newPriceType: r.new_price_type as SupplierPriceType,
    newPriceQty: r.new_price_qty,
    createdAt: new Date(r.created_at),
  }
}

/** Bir tedarikçinin son fiyat değişimleri, yeniden eskiye. */
export async function listPriceChanges(
  actor: Actor,
  supplierId: string,
  limit = 50,
  options: SupplierOptions = {},
): Promise<PriceChangeRow[]> {
  requirePermission(actor, 'supplier:read')
  const id = idOrNotFound(supplierId, 'supplier')
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 200)

  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx.execute<RawChange>(sql`
        SELECT c.id, c.supplier_item_id, i.supplier_code, i.name AS item_name,
               ${CHANGE_KIND} AS kind, sign(c.new_price - c.old_price)::int AS direction,
               c.change_pct::text AS change_pct,
               c.old_price::text AS old_price, c.old_currency, c.old_tax_mode, c.old_price_type,
               c.old_price_qty::text AS old_price_qty,
               c.new_price::text AS new_price, c.new_currency, c.new_tax_mode, c.new_price_type,
               c.new_price_qty::text AS new_price_qty, c.created_at
          FROM supplier_price_changes c
          JOIN supplier_items i ON i.id = c.supplier_item_id AND i.tenant_id = c.tenant_id
         WHERE c.tenant_id = ${actor.tenantId}::uuid AND i.supplier_id = ${id}::uuid
         ORDER BY c.created_at DESC, c.id
         LIMIT ${capped}
      `),
    options.db,
  )
  return [...rows].map(mapChange)
}

// ---------------------------------------------------------------------------
// ÜRÜN SAYFASINDA KARŞILAŞTIRMA
// ---------------------------------------------------------------------------

export interface ProductOffer {
  supplierItemId: string
  supplierId: string
  supplierName: string
  supplierCode: string
  itemName: string
  price: string
  currency: Currency
  taxMode: TaxMode
  priceType: SupplierPriceType
  priceQty: string | null
  stockQty: string | null
  fetchedAt: Date
  sourceUpdatedAt: Date | null
  /** Grupta birden çok teklif varken en düşük fiyat. Tek teklifte hiçbir zaman. */
  isLowest: boolean
  lastChange: Pick<PriceChangeRow, 'kind' | 'direction' | 'changePct' | 'createdAt'> | null
}

export interface OfferGroup {
  currency: Currency
  taxMode: TaxMode
  priceType: SupplierPriceType
  priceQty: string
  offers: ProductOffer[]
}

export interface ProductOffers {
  /** Karşılaştırılabilir gruplar: dört koşul aynı, fiyat miktarı biliniyor. */
  groups: OfferGroup[]
  /** Fiyat miktarı belirsiz teklifler: sıralanmaz, "en düşük" işareti almaz. */
  uncertain: ProductOffer[]
}

type RawOffer = {
  supplier_item_id: string
  supplier_id: string
  supplier_name: string
  supplier_code: string
  item_name: string
  price: string
  currency: string
  tax_mode: string
  price_type: string
  price_qty: string | null
  stock_qty: string | null
  fetched_at: string
  source_updated_at: string | null
  is_lowest: boolean
  change_kind: SupplierChangeKind | null
  change_direction: number | null
  change_pct: string | null
  changed_at: string | null
}

/**
 * Bir ürünün bütün tedarikçi teklifleri, karşılaştırılabilir gruplara ayrılmış.
 *
 * "En düşük" kararı SQL'de, `numeric` üzerinde ve yalnız aynı grupta veriliyor:
 * TRY ile USD, KDV dahil ile hariç, koli ile adet aynı sıraya girmez. Sıralama
 * verinin yaşına bakmaz; her teklifin "son alındı" zamanı yanında döner.
 */
export async function listProductOffers(
  actor: Actor,
  productId: string,
  options: SupplierOptions = {},
): Promise<ProductOffers> {
  requirePermission(actor, 'supplier:read')
  const id = idOrNotFound(productId, 'product')

  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx.execute<RawOffer>(sql`
        SELECT i.id AS supplier_item_id, s.id AS supplier_id, s.name AS supplier_name,
               i.supplier_code, i.name AS item_name,
               i.price::text AS price, i.currency, i.tax_mode, i.price_type,
               i.price_qty::text AS price_qty, i.stock_qty::text AS stock_qty,
               i.fetched_at, i.source_updated_at,
               CASE WHEN i.price_qty IS NULL THEN false
                    ELSE count(*) OVER grp > 1 AND i.price = min(i.price) OVER grp
               END AS is_lowest,
               lc.kind AS change_kind, lc.direction AS change_direction,
               lc.change_pct, lc.created_at AS changed_at
          FROM supplier_items i
          JOIN suppliers s ON s.id = i.supplier_id AND s.tenant_id = i.tenant_id
          LEFT JOIN LATERAL (
            SELECT ${CHANGE_KIND} AS kind, sign(c.new_price - c.old_price)::int AS direction,
                   c.change_pct::text AS change_pct, c.created_at
              FROM supplier_price_changes c
             WHERE c.tenant_id = i.tenant_id AND c.supplier_item_id = i.id
             ORDER BY c.created_at DESC, c.id
             LIMIT 1
          ) lc ON true
         WHERE i.tenant_id = ${actor.tenantId}::uuid AND i.product_id = ${id}::uuid
        WINDOW grp AS (PARTITION BY i.currency, i.tax_mode, i.price_type, i.price_qty)
         ORDER BY i.currency, i.tax_mode, i.price_type, i.price_qty NULLS LAST, i.price, s.name
      `),
    options.db,
  )

  const result: ProductOffers = { groups: [], uncertain: [] }
  for (const r of rows) {
    const offer: ProductOffer = {
      supplierItemId: r.supplier_item_id,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      supplierCode: r.supplier_code,
      itemName: r.item_name,
      price: r.price,
      currency: r.currency as Currency,
      taxMode: r.tax_mode as TaxMode,
      priceType: r.price_type as SupplierPriceType,
      priceQty: r.price_qty,
      stockQty: r.stock_qty,
      fetchedAt: new Date(r.fetched_at),
      sourceUpdatedAt: r.source_updated_at === null ? null : new Date(r.source_updated_at),
      isLowest: r.is_lowest,
      lastChange:
        r.change_kind === null
          ? null
          : {
              kind: r.change_kind,
              direction:
                r.change_kind === 'PRICE' ? ((r.change_direction ?? 0) > 0 ? 1 : -1) : null,
              changePct: r.change_pct,
              createdAt: new Date(r.changed_at!),
            },
    }
    if (offer.priceQty === null) {
      result.uncertain.push(offer)
      continue
    }
    const last = result.groups.at(-1)
    // Satırlar grup anahtarına göre sıralı geliyor; ardışık aynı anahtar aynı grup.
    if (
      last &&
      last.currency === offer.currency &&
      last.taxMode === offer.taxMode &&
      last.priceType === offer.priceType &&
      last.priceQty === offer.priceQty
    ) {
      last.offers.push(offer)
    } else {
      result.groups.push({
        currency: offer.currency,
        taxMode: offer.taxMode,
        priceType: offer.priceType,
        priceQty: offer.priceQty,
        offers: [offer],
      })
    }
  }
  return result
}
