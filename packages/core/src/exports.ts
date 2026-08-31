import {
  AppError,
  type ExportMovementsInput,
  type ExportStockInput,
  type JobKind,
  type MovementReason,
  type PriceOverrideReason,
  type Role,
  type Unit,
  exportMovementsSchema,
  exportStockSchema,
} from '@stok/shared'
import {
  type Db,
  type Tx,
  currentStock,
  products,
  stockMovements,
  users,
  withTenant,
} from '@stok/db'
import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm'
import { type Actor, canSeePrices, movementUserScope, requirePermission } from './authz.js'
import {
  type MovementExportRow,
  type StockExportRow,
  buildWorkbook,
  exportFileName,
  movementColumns,
  stockColumns,
} from './excel.js'
import { type JobRecord, enqueueJob, requesterEmail } from './jobs.js'
import { type MailTransport, XLSX_CONTENT_TYPE } from './mail.js'
import { parseScaled, scaledToNumber } from './numeric.js'
import { parseOrThrow } from './validate.js'

/**
 * ============================================================================
 * EXPORT — KRİTİK AÇIK G1
 *
 * Kapatılan hata: 50 bin satırlık rapor isteği serverless zaman sınırına
 * takılıyor, kullanıcı yarım inen bir dosya ya da sessiz 500 alıyor.
 *
 * ÜÇ YOL (D-4.2):
 *
 *   satır < 20.000        ──▶ senkron: dosya anında iniyor
 *   20.000 ≤ satır ≤ 200k ──▶ kuyruğa: "hazırlanınca e-posta ile gelecek"
 *   satır > 200.000       ──▶ RED: "tarih aralığını daraltın"
 *
 * Neden üçüncü yol da var: arka plan işinin de bir sınırı olmalı. Sınırsız
 * bırakılsaydı bir kullanıcı tüm geçmişi isteyip işçiyi saatlerce meşgul
 * eder, kuyruktaki gün sonu raporları gecikirdi. Reddetmek dürüst: rapor
 * gerçekten çok büyük ve kullanıcının yapabileceği somut bir şey var.
 *
 * SAYIM ÖNCE YAPILIYOR: satırları çekip sonra "çok fazlaymış" demek,
 * tam olarak kaçınmak istediğimiz belleği ve süreyi harcamak olurdu.
 * `COUNT(*)` aynı index'i kullanıyor ve ucuz.
 * ============================================================================
 */

/** Bu satır sayısının altında dosya istek içinde üretilir. */
export const INLINE_ROW_LIMIT = 20_000

/**
 * Arka plan işinin de üst sınırı. Üstünde istek reddediliyor.
 * Kullanıcı tarih aralığını daraltarak somut bir şey yapabilir; sınırsız
 * bir iş ise kuyruğu tıkar ve gün sonu raporunu geciktirir.
 */
export const QUEUED_ROW_LIMIT = 200_000

export type ExportKind = Extract<JobKind, 'STOCK_EXPORT' | 'MOVEMENT_EXPORT'>

export type ExportResult =
  | {
      mode: 'inline'
      fileName: string
      buffer: Buffer
      rowCount: number
    }
  | {
      mode: 'queued'
      jobId: string
      rowCount: number
      /** Dosyanın gideceği adres. Ekranda gösteriliyor: kullanıcı nereye bakacağını bilsin. */
      notifyEmail: string
    }

export interface ExportOptions {
  db?: Db
  now?: () => number
  /**
   * Eşikler yapılandırılabilir çünkü doğru değer DAĞITIMA bağlı:
   * serverless fonksiyonun süre sınırı plana göre 10-300 sn arasında
   * değişiyor (D-4.2). Varsayılanlar plandaki değerler.
   */
  inlineRowLimit?: number
  queuedRowLimit?: number
}

function limitsOf(options: ExportOptions) {
  return {
    inline: options.inlineRowLimit ?? INLINE_ROW_LIMIT,
    queued: options.queuedRowLimit ?? QUEUED_ROW_LIMIT,
  }
}

// ---------------------------------------------------------------------------
// SORGULAR
// ---------------------------------------------------------------------------

function stockWhere(actor: Actor, q: ExportStockInput) {
  const search = q.search?.trim()
  return and(
    eq(products.tenantId, actor.tenantId),
    q.includeArchived ? undefined : isNull(products.archivedAt),
    q.category ? eq(products.category, q.category) : undefined,
    q.onlyCritical ? sql`COALESCE(${currentStock.qty}, 0) <= ${products.minStock}` : undefined,
    // `listStock` ile BİREBİR aynı koşul (tr_norm, hem ad hem stok kodu).
    // İki yerde farklı yazılsaydı ekranda 12 satır görüp Excel'de 13 satır
    // almak mümkün olurdu ve hangisinin doğru olduğu belli olmazdı.
    search
      ? or(
          sql`${products.nameNorm} LIKE '%' || tr_norm(${search}) || '%'`,
          sql`tr_norm(${products.sku}) LIKE '%' || tr_norm(${search}) || '%'`,
        )
      : undefined,
  )
}

async function countStock(tx: Tx, actor: Actor, q: ExportStockInput): Promise<number> {
  const [row] = await tx
    .select({ n: sql<string>`count(*)::text` })
    .from(products)
    .leftJoin(
      currentStock,
      and(
        eq(currentStock.tenantId, products.tenantId),
        eq(currentStock.productId, products.id),
      ),
    )
    .where(stockWhere(actor, q))
  return Number(row?.n ?? 0)
}

async function loadStock(tx: Tx, actor: Actor, q: ExportStockInput): Promise<StockExportRow[]> {
  const rows = await tx
    .select({
      sku: products.sku,
      name: products.name,
      category: products.category,
      brand: products.brand,
      unit: products.unit,
      minStock: products.minStock,
      purchasePrice: products.purchasePrice,
      salePrice: products.salePrice,
      qty: currentStock.qty,
      lastMovementAt: currentStock.lastMovementAt,
    })
    .from(products)
    .leftJoin(
      currentStock,
      and(
        eq(currentStock.tenantId, products.tenantId),
        eq(currentStock.productId, products.id),
      ),
    )
    .where(stockWhere(actor, q))
    .orderBy(asc(products.sku))

  return rows.map((r) => ({
    sku: r.sku,
    name: r.name,
    category: r.category,
    brand: r.brand,
    unit: r.unit as Unit,
    // Hiç hareketi olmayan ürün projeksiyonda yok; raporda 0 görünmeli,
    // boş değil. Boş hücre "veri yok" demek, oysa cevap "sıfır adet".
    qty: r.qty === null ? 0 : scaledToNumber(parseScaled(r.qty)),
    minStock: scaledToNumber(parseScaled(r.minStock)),
    purchasePrice: r.purchasePrice === null ? null : Number(r.purchasePrice),
    salePrice: r.salePrice === null ? null : Number(r.salePrice),
    lastMovementAt: r.lastMovementAt,
  }))
}

function movementWhere(actor: Actor, q: ExportMovementsInput, scopedUserId: string | undefined) {
  return and(
    eq(stockMovements.tenantId, actor.tenantId),
    scopedUserId ? eq(stockMovements.userId, scopedUserId) : undefined,
    q.productId ? eq(stockMovements.productId, q.productId) : undefined,
    q.reason ? eq(stockMovements.reason, q.reason) : undefined,
    q.from ? gte(stockMovements.createdAt, new Date(q.from)) : undefined,
    q.to ? lte(stockMovements.createdAt, new Date(q.to)) : undefined,
  )
}

async function countMovements(
  tx: Tx,
  actor: Actor,
  q: ExportMovementsInput,
  scopedUserId: string | undefined,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<string>`count(*)::text` })
    .from(stockMovements)
    .where(movementWhere(actor, q, scopedUserId))
  return Number(row?.n ?? 0)
}

async function loadMovements(
  tx: Tx,
  actor: Actor,
  q: ExportMovementsInput,
  scopedUserId: string | undefined,
): Promise<MovementExportRow[]> {
  const rows = await tx
    .select({
      createdAt: stockMovements.createdAt,
      sku: products.sku,
      productName: products.name,
      unit: products.unit,
      userName: users.name,
      userRole: users.role,
      reason: stockMovements.reason,
      delta: stockMovements.delta,
      note: stockMovements.note,
      unitPrice: stockMovements.unitPrice,
      listPrice: stockMovements.listPrice,
      priceOverrideReason: stockMovements.priceOverrideReason,
    })
    .from(stockMovements)
    .innerJoin(products, eq(products.id, stockMovements.productId))
    .innerJoin(users, eq(users.id, stockMovements.userId))
    .where(movementWhere(actor, q, scopedUserId))
    .orderBy(asc(stockMovements.createdAt))

  return rows.map((r) => ({
    createdAt: r.createdAt,
    sku: r.sku,
    productName: r.productName,
    unit: r.unit as Unit,
    userName: r.userName,
    userRole: r.userRole as Role,
    reason: r.reason as MovementReason,
    delta: scaledToNumber(parseScaled(r.delta)),
    note: r.note,
    unitPrice: r.unitPrice === null ? null : Number(r.unitPrice),
    listPrice: r.listPrice === null ? null : Number(r.listPrice),
    priceOverrideReason: r.priceOverrideReason as PriceOverrideReason | null,
  }))
}

// ---------------------------------------------------------------------------
// KAMU ARAYÜZÜ
// ---------------------------------------------------------------------------

function tooLarge(rowCount: number, kind: ExportKind, limit: number): AppError {
  return new AppError(
    'EXPORT_TOO_LARGE',
    `${kind} would produce ${rowCount} rows, above the ${limit} hard limit`,
    { rowCount, limit },
  )
}

async function resolveNotifyEmail(actor: Actor, options: ExportOptions): Promise<string> {
  const [row] = await withTenant(
    actor.tenantId,
    (tx) => tx.select({ email: users.email }).from(users).where(eq(users.id, actor.userId)).limit(1),
    options.db,
  )
  if (!row?.email) {
    // Adressiz kuyruğa almak, dosyayı hiçbir yere göndermemek demek.
    // Sessizce kuyruğa alıp kullanıcıyı beklettirmektense burada durmak doğru.
    throw new AppError('NOT_FOUND', `user ${actor.userId} has no email for report delivery`, {
      userId: actor.userId,
    })
  }
  return row.email
}

/**
 * ============================================================================
 * PLANLAMA — indirme bağlantısının mutasyon içermemesi için
 *
 * `exportStock`/`exportMovements` üç yoldan birini seçiyor ve ikisi yan
 * etkili: kuyruğa alma bir iş yaratıyor. Bu yüzden indirme düğmesi
 * doğrudan bir `GET` bağlantısı OLAMAZ — kullanıcının sayfayı yenilemesi
 * her seferinde yeni bir arka plan işi kuyruğa alırdı.
 *
 * Akış ikiye bölündü:
 *
 *   POST (form)  ─▶ planExport(): SADECE sayar, hiçbir şey yazmaz
 *                     ├─ inline  ─▶ GET /api/rapor/... adresine yönlendir
 *                     └─ queued  ─▶ exportStock() çağır, işi kuyruğa al
 *
 * Böylece indirme adresi salt okunur kalıyor: yenilenebilir, yer imine
 * eklenebilir, tarayıcı önceden çekse bile zarar yok.
 *
 * `inline` yolunda sayım iki kez çalışıyor (bir planlamada, bir de indirme
 * isteğinde). `COUNT(*)` aynı index'i kullanıyor ve 20 bin satırlık dosyayı
 * üretmenin yanında ölçülemeyecek kadar ucuz — buna karşılık kazanılan şey,
 * yan etkisiz bir indirme adresi.
 * ============================================================================
 */
export interface ExportPlan {
  mode: 'inline' | 'queued'
  rowCount: number
}

export async function planExport(
  actor: Actor,
  kind: ExportKind,
  raw: unknown = {},
  options: ExportOptions = {},
): Promise<ExportPlan> {
  requirePermission(actor, 'export:excel')
  const limits = limitsOf(options)

  const rowCount = await (kind === 'STOCK_EXPORT'
    ? (async () => {
        const q = parseOrThrow(exportStockSchema, raw)
        return withTenant(actor.tenantId, (tx) => countStock(tx, actor, q), options.db)
      })()
    : (async () => {
        const q = parseOrThrow(exportMovementsSchema, raw)
        const scopedUserId = movementUserScope(actor, q.userId)
        return withTenant(
          actor.tenantId,
          (tx) => countMovements(tx, actor, q, scopedUserId),
          options.db,
        )
      })())

  if (rowCount > limits.queued) throw tooLarge(rowCount, kind, limits.queued)
  return { mode: rowCount >= limits.inline ? 'queued' : 'inline', rowCount }
}

export async function exportStock(
  actor: Actor,
  raw: unknown = {},
  options: ExportOptions = {},
): Promise<ExportResult> {
  requirePermission(actor, 'export:excel')
  const q = parseOrThrow(exportStockSchema, raw)
  const now = new Date(options.now?.() ?? Date.now())

  const limits = limitsOf(options)
  const rowCount = await withTenant(actor.tenantId, (tx) => countStock(tx, actor, q), options.db)
  if (rowCount > limits.queued) throw tooLarge(rowCount, 'STOCK_EXPORT', limits.queued)

  if (rowCount >= limits.inline) {
    return queue(actor, 'STOCK_EXPORT', q, rowCount, options)
  }

  const rows = await withTenant(actor.tenantId, (tx) => loadStock(tx, actor, q), options.db)
  const buffer = await buildWorkbook({
    name: 'Stok',
    columns: stockColumns(canSeePrices(actor.role)),
    rows,
  })
  return { mode: 'inline', fileName: exportFileName('stok', now), buffer, rowCount: rows.length }
}

export async function exportMovements(
  actor: Actor,
  raw: unknown = {},
  options: ExportOptions = {},
): Promise<ExportResult> {
  requirePermission(actor, 'export:excel')
  const q = parseOrThrow(exportMovementsSchema, raw)
  const now = new Date(options.now?.() ?? Date.now())
  // Kapsam kısıtı export'ta da geçerli: Excel'e dökmek, rol matrisini
  // atlamanın yolu olamaz.
  const scopedUserId = movementUserScope(actor, q.userId)

  const limits = limitsOf(options)
  const rowCount = await withTenant(
    actor.tenantId,
    (tx) => countMovements(tx, actor, q, scopedUserId),
    options.db,
  )
  if (rowCount > limits.queued) throw tooLarge(rowCount, 'MOVEMENT_EXPORT', limits.queued)

  if (rowCount >= limits.inline) {
    return queue(actor, 'MOVEMENT_EXPORT', { ...q, userId: scopedUserId }, rowCount, options)
  }

  const rows = await withTenant(
    actor.tenantId,
    (tx) => loadMovements(tx, actor, q, scopedUserId),
    options.db,
  )
  const buffer = await buildWorkbook({
    name: 'Hareketler',
    columns: movementColumns(canSeePrices(actor.role)),
    rows,
  })
  return { mode: 'inline', fileName: exportFileName('hareket', now), buffer, rowCount: rows.length }
}

async function queue(
  actor: Actor,
  kind: ExportKind,
  params: Record<string, unknown>,
  rowCount: number,
  options: ExportOptions,
): Promise<ExportResult> {
  const notifyEmail = await resolveNotifyEmail(actor, options)
  const { job } = await enqueueJob(
    actor,
    {
      kind,
      // Rolü de saklıyoruz: iş çalıştığında fiyat sütunlarının görünüp
      // görünmeyeceğini isteyen kişinin rolü belirliyor, işçinin değil.
      params: { ...params, role: actor.role, rowCount },
      notifyEmail,
    },
    options,
  )
  return { mode: 'queued', jobId: job.id, rowCount, notifyEmail }
}

// ---------------------------------------------------------------------------
// ARKA PLAN İŞLEYİCİSİ
// ---------------------------------------------------------------------------

/**
 * Kuyruğa alınmış export işini çalıştırır: dosyayı üretir ve e-postayla
 * gönderir.
 *
 * Gönderim BAŞARISIZ olursa fırlatıyor; `runQueuedJobs` bunu yakalayıp
 * bir kez daha deniyor, o da olmazsa iş FAILED olarak duruyor ve admin
 * panelinde görünüyor (G4). Burada yakalayıp "dosya hazır ama mail
 * gitmedi" diye başarılı saymak, tam olarak kapatmaya çalıştığımız
 * sessiz hatayı üretirdi.
 */
export function createExportJobHandler(mail: MailTransport, options: ExportOptions = {}) {
  return async (job: JobRecord): Promise<Record<string, unknown>> => {
    const params = job.params as Record<string, unknown>
    const role = (params.role as Role | undefined) ?? 'ADMIN'
    const actor: Actor = {
      tenantId: job.tenantId,
      userId: job.requestedBy ?? '',
      role,
    }
    const now = new Date(options.now?.() ?? Date.now())

    const { buffer, fileName, rowCount, subject } =
      job.kind === 'STOCK_EXPORT'
        ? await buildStockAttachment(actor, params, now, options)
        : await buildMovementAttachment(actor, params, now, options)

    const to = job.notifyEmail ?? (await requesterEmail(job, options))
    if (!to) throw new AppError('NOT_FOUND', `job ${job.id} has no delivery address`)

    await mail.send({
      to,
      subject,
      text: `İstediğiniz rapor hazır. ${rowCount} satır içeriyor ve ekte.`,
      attachments: [{ filename: fileName, content: buffer, contentType: XLSX_CONTENT_TYPE }],
    })

    return { rowCount, fileName, deliveredTo: to }
  }
}

async function buildStockAttachment(
  actor: Actor,
  params: Record<string, unknown>,
  now: Date,
  options: ExportOptions,
) {
  const q = exportStockSchema.parse(params)
  const rows = await withTenant(actor.tenantId, (tx) => loadStock(tx, actor, q), options.db)
  return {
    buffer: await buildWorkbook({
      name: 'Stok',
      columns: stockColumns(canSeePrices(actor.role)),
      rows,
    }),
    fileName: exportFileName('stok', now),
    rowCount: rows.length,
    subject: 'Stok raporunuz hazır',
  }
}

async function buildMovementAttachment(
  actor: Actor,
  params: Record<string, unknown>,
  now: Date,
  options: ExportOptions,
) {
  const q = exportMovementsSchema.parse(params)
  const scopedUserId = movementUserScope(actor, q.userId)
  const rows = await withTenant(
    actor.tenantId,
    (tx) => loadMovements(tx, actor, q, scopedUserId),
    options.db,
  )
  return {
    buffer: await buildWorkbook({
      name: 'Hareketler',
      columns: movementColumns(canSeePrices(actor.role)),
      rows,
    }),
    fileName: exportFileName('hareket', now),
    rowCount: rows.length,
    subject: 'Hareket raporunuz hazır',
  }
}
