import {
  AppError,
  IMPORT_ROW_STATUSES,
  type ImportOpeningOutcome,
  type ImportRowStatus,
  type ImportRunKind,
  type ImportRunStatus,
} from '@stok/shared'
import { randomUUID } from 'node:crypto'
import {
  type Db,
  type Tx,
  importRunRows,
  importRuns,
  isUniqueViolation,
  products,
  stockMovements,
  withTenant,
} from '@stok/db'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, not, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type Actor, requirePermission } from './authz'
import type { SheetColumn } from './excel'
import {
  type OpeningPlan,
  type PreviewRow,
  type RowAction,
  type RowOutcome,
  type RowVerdict,
  applyRow,
  importNotices,
  openingKey,
  previewImport,
  rawRowSchema,
} from './import'
import {
  INVENTORY_FIELDS,
  INVENTORY_HEADER_LIMIT,
  INVENTORY_REQUIRED_FIELDS,
  INVENTORY_UNREAD_COLUMNS_LIMIT,
  type InventoryField,
  type RawInventoryRow,
} from './inventory-file'
import {
  applyInventoryRow,
  previewInventory,
  rawInventoryRowSchema,
  resolveRunDepots,
  verifyInventoryRow,
} from './inventory-import'
import {
  COLUMN_LABELS,
  IMPORT_FIELDS,
  IMPORT_FILE_BYTES_LIMIT,
  IMPORT_ROW_LIMIT,
  type ImportField,
  type ParsedRow,
  type RawRow,
} from './product-file'
import { PRODUCT_VERSION } from './products'
import { parseOrThrow } from './validate'

/**
 * ============================================================================
 * T171 — TOPLU ÜRÜN AKTARIMI KAYDI: yükle → önizle → aktar (ilerleme, iptal) → sonuç
 *
 * Neden bir kayıt var: 20.000 satır ne tek isteğe sığıyor (gövde ve süre
 * sınırları) ne de istemcide güvenle tutulabiliyor (önizleme yanıtı on MB'larca).
 * Satırlar tarayıcıdan küçük parçalarla geliyor, önizleme bütün dosya üzerinden
 * bir kez hesaplanıyor ve aktarım kısa, süre bütçeli parçalarla ilerliyor.
 * Arka plan işçisi YOK: parçaları kullanıcının tarayıcısı sürüyor; sekme
 * kapanırsa aktarım durur, yapılanlar kalır (ürün kapsamı: duraklat/devam yok).
 *
 *   startImportRun        UPLOADING   kayıt açılır, eski kayıtlar temizlenir
 *   appendImportRows      UPLOADING   ham satırlar parça parça
 *   finalizeImportPreview PREVIEWED   önizleme: ürün ve stok DEĞİŞMEZ
 *   beginImportRun        RUNNING     kullanıcı onayladı
 *   processImportChunk    RUNNING     birkaç saniyelik satır grubu
 *   cancelImportRun       CANCELLED   yeni satır başlamaz, yapılanlar korunur
 *
 * GÜVENCELER
 *
 *   Satır sınırı   İptal ve kesinti yalnız satırlar ARASINDA etki ediyor. Bir
 *                  satırın işi: ürün (kendi transaction'ı) → açılış stoğu
 *                  (`createMovement`, kendi transaction'ı) → sonuç. Üçünü tek
 *                  transaction'a almak, defterin tek yazma kapısına (INV-3/5/6)
 *                  dışarıdan transaction sokmak demekti.
 *   Mükerrer devir Açılış stoğunun idempotency anahtarı ürün başına sabit
 *                  (DAT-18); aynı satır iki kez işlense de ikinci devir yazılmaz.
 *   Çakışma (K3)   Güncelleme önizleme anındaki ürün sürümünü şart koşuyor.
 *   Kesinti        Sonucu yazılamamış satır `IN_PROGRESS` kalıyor; sonraki
 *                  parça onu veritabanına bakarak çözüyor: uygulanmadığı
 *                  kanıtlanırsa yeniden dener, kanıtlanamazsa `UNCERTAIN` der.
 *                  Yanlış "başarılı" ya da "başarısız" yazılmıyor (güvence 5).
 *   Kira (T5)      Uzun süre tutulan kilit yok; iptal hiçbir şeyi beklemiyor.
 *                  Kirayı bir kimlik (`lease_token`) tutuyor: aynı aktarımı iki
 *                  işleyici aynı anda işlemiyor, kirası elinden alınan işleyici
 *                  bir sonraki satırda duruyor.
 * ============================================================================
 */

/** Geçici aktarım kayıtlarının saklanma süresi (K4). Sonra bütün satırlarıyla siliniyor. */
export const IMPORT_RUN_RETENTION_DAYS = 30
/** Yüklemesi yarıda kalmış (UPLOADING) kayıt bu kadar sonra siliniyor; önizlenmemiş ham veri bekletilmiyor. */
export const IMPORT_UPLOAD_ABANDON_HOURS = 24
/** Parça işleyicinin kirası. Düşen işleyicinin kirası bu süre sonunda kendiliğinden bitiyor. */
export const IMPORT_LEASE_SECONDS = 30
/**
 * `IN_PROGRESS` bir satır ancak bu kadar eskiyse "kesintiye uğradı" sayılıyor.
 * Kiradan uzun: kirası bitmiş ama veritabanında takılı kalmış bir işleyici o
 * satırı hâlâ yazıyor olabilir; doğrulama erken yapılsaydı henüz yazılmamış
 * ürünü "yazılmadı" sayıp satırı ikinci kez işletirdi.
 */
export const IMPORT_STALE_CLAIM_SECONDS = 120
/**
 * Bir parça isteğinin satır işleme süresi. Barındırmanın istek süre sınırının
 * çok altında. Kısa tutuldu: aynı sekmenin sunucu eylemleri sırayla gidiyor,
 * yani iptal en kötü bu kadar bekliyor ve ilerleme çubuğu bu aralıkla
 * güncelleniyor. Parça başına sabit maliyet (kira, sayım) birkaç ms.
 */
export const IMPORT_CHUNK_BUDGET_MS = 2_000
/** Tek çağrıda eklenebilecek en fazla ham satır; tarayıcı ≈2 MiB'lık parçalar gönderiyor. */
export const IMPORT_APPEND_MAX_ROWS = 5_000
/** Önizleme ve sonuç ekranında gösterilen sorunlu satır sayısı; tamamı raporda. */
export const IMPORT_SAMPLE_SIZE = 50

export interface ImportRunOptions {
  db?: Db
}

export interface ImportChunkOptions extends ImportRunOptions {
  budgetMs?: number
  /**
   * Bu parçada en fazla kaç satır. Ölçüm ve testler için: süre bütçesine bağlı
   * bir test makinenin hızına göre farklı sonuç verirdi (T109 dersi).
   */
  maxRows?: number
}

function requireImport(actor: Actor): void {
  requirePermission(actor, 'product:create')
  requirePermission(actor, 'barcode:create')
}

const runIdSchema = z.string().uuid()

function runIdOf(raw: string): string {
  const parsed = runIdSchema.safeParse(raw)
  // Bozuk kimlik NOT_FOUND: PostgreSQL'e gitseydi 22P02 olarak patlardı.
  if (!parsed.success) throw new AppError('NOT_FOUND', 'import run not found', { runId: raw })
  return parsed.data
}

const notFound = (runId: string) => new AppError('NOT_FOUND', `import run ${runId} not found`, { runId })
const wrongState = (runId: string, status: string) =>
  new AppError('IMPORT_RUN_STATE', `import run ${runId} is ${status}`, { runId, status })

// ---------------------------------------------------------------------------
// TEMİZLİK (K4)
// ---------------------------------------------------------------------------

/**
 * Kiracının süresi dolmuş aktarım kayıtlarını siler; satırlar `ON DELETE CASCADE`.
 *
 * Yalnız `import_runs`'a dokunuyor: silme yapı gereği gerçek veriye (ürün,
 * barkod, hareket, `current_stock`) ulaşamaz. Kiracı kapsamı RLS'ten de geliyor
 * (çağıran `withTenant` içinde).
 *
 * DEFTERE BAĞLI AKTARIM SİLİNMİYOR. Envanter hareketleri `import_run_id` ile
 * kendi aktarımını gösteriyor ("bu sayım hangi dosyadan geldi"). O kayıt
 * silinseydi kaynak bilgisi kaybolurdu; yabancı anahtar da silmeyi reddeder ve
 * bütün temizlik o kiracı için patlardı. Bu yüzden bağlı kayıtlar baştan
 * atlanıyor.
 *
 * BAŞLAMIŞ ENVANTER AKTARIMININ BAŞLIĞI DA SİLİNMİYOR (T218, K3), hiç hareket
 * yazmamış olsa bile: aynı içerik uyarısı ve son dosya bilgisi onu okuyor.
 * Silinseydi aylar önceki dosya yeniden yüklendiğinde uyarı çıkmaz, arada
 * girilen satışlar sessizce geri alınırdı. Ham satırları 30 gün sonra
 * siliniyor: başlık küçük, satırlar binlerce.
 */
export async function pruneImportRuns(tx: Tx, tenantId: string): Promise<number> {
  const expired = lt(importRuns.createdAt, sql`now() - make_interval(days => ${IMPORT_RUN_RETENTION_DAYS})`)
  const keptInventory = and(eq(importRuns.kind, 'INVENTORY'), isNotNull(importRuns.startedAt))
  const deleted = await tx
    .delete(importRuns)
    .where(
      and(
        eq(importRuns.tenantId, tenantId),
        sql`NOT EXISTS (
              SELECT 1 FROM ${stockMovements}
               WHERE ${stockMovements.tenantId} = ${importRuns.tenantId}
                 AND ${stockMovements.importRunId} = ${importRuns.id}
            )`,
        not(keptInventory!),
        or(
          expired,
          and(
            eq(importRuns.status, 'UPLOADING'),
            lt(importRuns.createdAt, sql`now() - make_interval(hours => ${IMPORT_UPLOAD_ABANDON_HOURS})`),
          ),
        ),
      ),
    )
    .returning({ id: importRuns.id })
  await tx.delete(importRunRows).where(
    and(
      eq(importRunRows.tenantId, tenantId),
      inArray(
        importRunRows.runId,
        tx
          .select({ id: importRuns.id })
          .from(importRuns)
          .where(and(eq(importRuns.tenantId, tenantId), keptInventory, expired)),
      ),
    ),
  )
  return deleted.length
}

/** Cron'un bakım adımı için: kiracı bağlamını kendisi kuruyor. */
export async function pruneTenantImportRuns(tenantId: string, options: ImportRunOptions = {}): Promise<number> {
  return withTenant(tenantId, (tx) => pruneImportRuns(tx, tenantId), options.db)
}

// ---------------------------------------------------------------------------
// YÜKLEME
// ---------------------------------------------------------------------------

const startSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    fileBytes: z.number().int().nonnegative().max(IMPORT_FILE_BYTES_LIMIT),
    totalRows: z.number().int().min(1).max(IMPORT_ROW_LIMIT),
    columns: z.array(z.enum(IMPORT_FIELDS as [ImportField, ...ImportField[]])).max(IMPORT_FIELDS.length),
    ignoredQtyColumns: z.array(z.string().max(200)).max(50).default([]),
  })
  .refine((v) => v.columns.includes('sku') && v.columns.includes('name'), {
    message: 'Stok Kodu ve Ürün Adı sütunları gerekli',
    path: ['columns'],
  })

/**
 * Yeni aktarım kaydı açar. Önce aynı kiracının süresi dolmuş kayıtlarını siler:
 * cron kapalıyken de (yerel kurulum) temizlik çalışsın (K4).
 */
export async function startImportRun(
  actor: Actor,
  raw: unknown,
  options: ImportRunOptions = {},
): Promise<{ runId: string }> {
  requireImport(actor)
  const input = parseOrThrow(startSchema, raw)

  const runId = await withTenant(
    actor.tenantId,
    async (tx) => {
      await pruneImportRuns(tx, actor.tenantId)
      const [row] = await tx
        .insert(importRuns)
        .values({
          tenantId: actor.tenantId,
          createdBy: actor.userId,
          fileName: input.fileName,
          fileBytes: input.fileBytes,
          totalRows: input.totalRows,
          columns: input.columns,
          notices: importNotices(input.ignoredQtyColumns),
        })
        .returning({ id: importRuns.id })
      return row!.id
    },
    options.db,
  )
  return { runId }
}

const appendSchema = z.object({ rows: z.array(rawRowSchema).min(1).max(IMPORT_APPEND_MAX_ROWS) })

/**
 * Ham satırları ekler. Satırlar tarayıcıda ayrıştırılmış KULLANICI VERİSİ:
 * şema yalnız tanınan alanları ve sınırlı uzunlukta metni kabul ediyor, toplam
 * satır sayısı başta beyan edilen sayıyı aşamıyor. İçerik önizlemede sınanıyor.
 */
export async function appendImportRows(
  actor: Actor,
  runIdRaw: string,
  raw: unknown,
  options: ImportRunOptions = {},
): Promise<{ received: number; total: number }> {
  requireImport(actor)
  const runId = runIdOf(runIdRaw)
  const input = parseOrThrow(appendSchema, raw)
  return appendRows(actor, runId, 'PRODUCT', input.rows, options)
}

/**
 * Ham satırları türüne uyan kayda ekler. Tür şartı: envanter kaydına ürün
 * satırı (fiyat hücreleriyle) ya da ürün kaydına envanter satırı giremesin.
 */
async function appendRows(
  actor: Actor,
  runId: string,
  kind: ImportRunKind,
  rows: { rowNumber: number; cells: Record<string, string | undefined> }[],
  options: ImportRunOptions,
): Promise<{ received: number; total: number }> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      // FOR UPDATE: iki sekmeden aynı anda gelen eklemeler sırayla sayılsın;
      // yoksa ikisi de "yer var" görüp beyan edilen sayıyı aşabilirdi.
      const [run] = await tx
        .select({ status: importRuns.status, totalRows: importRuns.totalRows })
        .from(importRuns)
        .where(and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId), eq(importRuns.kind, kind)))
        .for('update')
      if (!run) throw notFound(runId)
      if (run.status !== 'UPLOADING') throw wrongState(runId, run.status)

      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(importRunRows)
        .where(and(eq(importRunRows.tenantId, actor.tenantId), eq(importRunRows.runId, runId)))) as [
        { n: number },
      ]
      if (n + rows.length > run.totalRows) throw wrongState(runId, 'TOO_MANY_ROWS')

      await tx
        .insert(importRunRows)
        .values(
          rows.map((r) => ({
            tenantId: actor.tenantId,
            runId,
            rowNumber: r.rowNumber,
            cells: r.cells as Record<string, string>,
          })),
        )
        .catch((err: unknown) => {
          // Aynı satır numarası ikinci kez: istemci aynı parçayı iki kez gönderdi.
          if (isUniqueViolation(err, 'import_run_rows_run_id_row_number_pk')) {
            throw wrongState(runId, 'DUPLICATE_ROW')
          }
          throw err
        })
      return { received: n + rows.length, total: run.totalRows }
    },
    options.db,
  )
}

// ---------------------------------------------------------------------------
// ÖNİZLEME
// ---------------------------------------------------------------------------

export interface ImportRunPreview {
  runId: string
  counts: { create: number; update: number; error: number }
  /** Yazılacak açılış stoğu sayısı (devir atlanacak satırlar hariç). */
  openings: number
  /** Devri atlanacak satır sayısı (üründe hareket var); `warnings` yalnız ilk satırlar. */
  skippedOpenings: number
  notices: string[]
  /** İlk `IMPORT_SAMPLE_SIZE` hatalı satır; tamamı raporda. */
  errors: { rowNumber: number; sku: string; name: string; issues: { column: string; message: string }[] }[]
  /** Hata olmayan ama söylenmesi gereken satırlar ("devir atlanacak"). */
  warnings: { rowNumber: number; sku: string; name: string; message: string }[]
}

/**
 * Bütün satırlar geldikten sonra önizlemeyi BİR KEZ, bütün dosya üzerinden
 * hesaplar ve satır kararlarını kayda yazar. Dosya içi mükerrer stok kodu ancak
 * bütün dosyaya bakınca görülüyor; parçalara bölünseydi ikinci satır ilkini
 * sessizce ezerdi.
 *
 * Ürün ve stok verisine HİÇBİR ŞEY YAZILMIYOR. Güncellenecek ürünlerin sürümü
 * (`xmin`) bu anda alınıyor; yazım onunla karşılaştırılacak (K3).
 */
export async function finalizeImportPreview(
  actor: Actor,
  runIdRaw: string,
  options: ImportRunOptions = {},
): Promise<ImportRunPreview> {
  requireImport(actor)
  const runId = runIdOf(runIdRaw)
  const db = options.db

  const { run, rows } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const [run] = await tx
        .select({ status: importRuns.status, totalRows: importRuns.totalRows, columns: importRuns.columns, notices: importRuns.notices })
        .from(importRuns)
        .where(and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId), eq(importRuns.kind, 'PRODUCT')))
      if (!run) throw notFound(runId)
      if (run.status !== 'UPLOADING') throw wrongState(runId, run.status)
      const rows = await tx
        .select({ rowNumber: importRunRows.rowNumber, cells: importRunRows.cells })
        .from(importRunRows)
        .where(and(eq(importRunRows.tenantId, actor.tenantId), eq(importRunRows.runId, runId)))
        .orderBy(asc(importRunRows.rowNumber))
      return { run, rows }
    },
    db,
  )
  if (rows.length !== run.totalRows) throw wrongState(runId, 'INCOMPLETE')

  const preview = await previewImport(
    actor,
    { rows: rows as unknown as RawRow[], columns: run.columns as ImportField[], ignoredQtyColumns: [] },
    { db },
  )

  await withTenant(
    actor.tenantId,
    async (tx) => {
      // Önizleme hesaplanırken başka bir istek bu kaydı ilerletmiş olabilir.
      const [locked] = await tx
        .select({ status: importRuns.status })
        .from(importRuns)
        .where(and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId)))
        .for('update')
      if (locked?.status !== 'UPLOADING') throw wrongState(runId, locked?.status ?? 'GONE')

      for (let i = 0; i < preview.rows.length; i += 1_000) {
        const batch = preview.rows.slice(i, i + 1_000).map((r) => ({
          row_number: r.rowNumber,
          action: r.action,
          sku: r.sku,
          name: r.name,
          issues: r.issues,
          warnings: r.warnings ?? null,
          data: r.data ?? null,
          product_id: r.productId ?? null,
          product_version: r.productVersion ?? null,
          opening: r.opening ?? null,
        }))
        await tx.execute(sql`
          UPDATE import_run_rows AS r
             SET action = x.action, sku = x.sku, name = x.name, issues = x.issues,
                 warnings = x.warnings, data = x.data, product_id = x.product_id,
                 product_version = x.product_version, opening = x.opening,
                 status = CASE WHEN x.action = 'error' THEN 'INVALID' ELSE 'PENDING' END
            FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS x(
                 row_number int, action text, sku text, name text, issues jsonb, warnings jsonb,
                 data jsonb, product_id uuid, product_version text, opening jsonb)
           WHERE r.tenant_id = ${actor.tenantId}::uuid AND r.run_id = ${runId}::uuid
             AND r.row_number = x.row_number
        `)
      }
      await tx
        .update(importRuns)
        .set({ status: 'PREVIEWED', previewedAt: sql`now()` })
        .where(and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId)))
    },
    db,
  )

  const errorRows = preview.rows.filter((r) => r.action === 'error')
  const warned = preview.rows.filter((r) => r.warnings?.length)
  return {
    runId,
    counts: preview.counts,
    openings: preview.rows.filter((r) => r.opening && !r.warnings?.length).length,
    skippedOpenings: warned.length,
    notices: run.notices,
    errors: errorRows.slice(0, IMPORT_SAMPLE_SIZE).map((r) => ({
      rowNumber: r.rowNumber,
      sku: r.sku,
      name: r.name,
      issues: r.issues,
    })),
    warnings: warned
      .slice(0, IMPORT_SAMPLE_SIZE)
      .map((r) => ({ rowNumber: r.rowNumber, sku: r.sku, name: r.name, message: r.warnings!.join('; ') })),
  }
}

// ---------------------------------------------------------------------------
// AKTARIM
// ---------------------------------------------------------------------------

/**
 * Kullanıcı önizlemeyi onayladı. Çalışan aktarımda tekrar onay hata değil,
 * ilerlemeyi döndürüyor: ilk yanıt istemciye ulaşmadıysa kullanıcı düğmeye
 * yeniden basabilmeli. Bitmiş ya da iptal edilmiş aktarım yeniden başlamıyor.
 */
export async function beginImportRun(
  actor: Actor,
  runIdRaw: string,
  options: ImportRunOptions = {},
): Promise<ImportRunProgress> {
  requireImport(actor)
  const runId = runIdOf(runIdRaw)
  const begun = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .update(importRuns)
        .set({ status: 'RUNNING', startedAt: sql`now()` })
        .where(
          and(
            eq(importRuns.tenantId, actor.tenantId),
            eq(importRuns.id, runId),
            eq(importRuns.kind, 'PRODUCT'),
            eq(importRuns.status, 'PREVIEWED'),
          ),
        )
        .returning({ id: importRuns.id }),
    options.db,
  )
  const progress = await getImportRunProgress(actor, runId, options)
  if (begun.length === 0 && progress.status !== 'RUNNING') throw wrongState(runId, progress.status)
  return progress
}

export interface ImportRunProgress {
  runId: string
  status: ImportRunStatus
  fileName: string
  totalRows: number
  /** İşlenecek satır (önizlemede hatalı olanlar hariç). İlerleme çubuğunun paydası. */
  toProcess: number
  /** İşlenmiş satır (sonucu yazılmış). İlerleme çubuğunun payı. */
  processed: number
  rows: {
    created: number
    updated: number
    invalid: number
    failed: number
    conflict: number
    uncertain: number
    pending: number
    /** Envanter: önizlemede işlenmeyeceği belli satırlar (değişiklik yok, depoya atama bekliyor). */
    skipped: number
  }
  openings: Record<'written' | 'skipped' | 'failed', number>
  cancelRequested: boolean
}

/** Aktarımın durumu ve sayıları; sayılar satır durumlarından SAYILIYOR, ayrı sayaç yok. */
export async function getImportRunProgress(
  actor: Actor,
  runIdRaw: string,
  options: ImportRunOptions = {},
): Promise<ImportRunProgress> {
  requireImport(actor)
  const runId = runIdOf(runIdRaw)
  return progressIn(actor, runId, 'PRODUCT', options.db)
}

function progressIn(actor: Actor, runId: string, kind: ImportRunKind, db?: Db): Promise<ImportRunProgress> {
  return withTenant(actor.tenantId, (tx) => progressOf(tx, actor.tenantId, runId, kind), db)
}

async function progressOf(tx: Tx, tenantId: string, runId: string, kind: ImportRunKind): Promise<ImportRunProgress> {
  const [run] = await tx
    .select({
      status: importRuns.status,
      fileName: importRuns.fileName,
      totalRows: importRuns.totalRows,
      cancelRequestedAt: importRuns.cancelRequestedAt,
    })
    .from(importRuns)
    .where(and(eq(importRuns.tenantId, tenantId), eq(importRuns.id, runId), eq(importRuns.kind, kind)))
  if (!run) throw notFound(runId)

  const groups = await tx
    .select({
      status: importRunRows.status,
      action: importRunRows.action,
      opening: importRunRows.openingOutcome,
      n: sql<number>`count(*)::int`,
    })
    .from(importRunRows)
    .where(and(eq(importRunRows.tenantId, tenantId), eq(importRunRows.runId, runId)))
    .groupBy(importRunRows.status, importRunRows.action, importRunRows.openingOutcome)

  const rows = { created: 0, updated: 0, invalid: 0, failed: 0, conflict: 0, uncertain: 0, pending: 0, skipped: 0 }
  const openings = { written: 0, skipped: 0, failed: 0 }
  for (const g of groups) {
    const status = g.status as ImportRowStatus
    if (status === 'DONE') rows[g.action === 'create' ? 'created' : 'updated'] += g.n
    else if (status === 'INVALID') rows.invalid += g.n
    else if (status === 'FAILED') rows.failed += g.n
    else if (status === 'CONFLICT') rows.conflict += g.n
    else if (status === 'UNCERTAIN') rows.uncertain += g.n
    else if (status === 'SKIPPED') rows.skipped += g.n
    else rows.pending += g.n // PENDING ve IN_PROGRESS: henüz sonucu yok
    const opening = g.opening as ImportOpeningOutcome | null
    if (opening) openings[opening === 'WRITTEN' ? 'written' : opening === 'SKIPPED' ? 'skipped' : 'failed'] += g.n
  }
  const toProcess = run.totalRows - rows.invalid - rows.skipped
  return {
    runId,
    status: run.status as ImportRunStatus,
    fileName: run.fileName,
    totalRows: run.totalRows,
    toProcess,
    processed: toProcess - rows.pending,
    rows,
    openings,
    cancelRequested: run.cancelRequestedAt !== null,
  }
}

/**
 * Bir sonraki satır grubunu işler; süre bütçesi dolunca durur ve ilerlemeyi
 * döndürür. Tarayıcı bunu aktarım bitene ya da iptal edilene kadar çağırıyor.
 *
 * Kira alınamazsa aynı aktarım başka bir istekte işleniyor: `IMPORT_RUN_BUSY`,
 * istemci biraz bekleyip tekrar deniyor. Kira her satırdan önce yenileniyor ve
 * iptal bayrağı AYNI sorguda okunuyor: iptal ile kira yenileme arasında yarış yok.
 *
 * Bir parça hiç satır işlemeden dönebilir: başka bir işleyicinin yarım kalmış
 * satırı henüz eskimediyse (`IMPORT_STALE_CLAIM_SECONDS`) aktarım onu bekliyor.
 * İstemci bu durumda bekleyip tekrar çağırıyor.
 */
export async function processImportChunk(
  actor: Actor,
  runIdRaw: string,
  options: ImportChunkOptions = {},
): Promise<ImportRunProgress> {
  requireImport(actor)
  const runId = runIdOf(runIdRaw)
  return runChunk(
    actor,
    runId,
    'PRODUCT',
    {
      apply: (row) => applyRow(actor, previewRowOf(row), { db: options.db, checkVersion: true }),
      verify: verifyRow,
    },
    options,
  )
}

type RunRow = typeof importRunRows.$inferSelect

/** Bir aktarım türünün satır işi: uygula ve kesintide doğrula. Kira, iptal ve sonuç yazımı ortak. */
interface RowEngine {
  apply(row: RunRow): Promise<RowOutcome>
  verify(tx: Tx, tenantId: string, row: RunRow): Promise<RowVerdict>
}

async function runChunk(
  actor: Actor,
  runId: string,
  kind: ImportRunKind,
  engine: RowEngine,
  options: ImportChunkOptions,
): Promise<ImportRunProgress> {
  const db = options.db
  const budgetMs = options.budgetMs ?? IMPORT_CHUNK_BUDGET_MS
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY
  const started = Date.now()
  const token = randomUUID()
  // İşlenmiş ama sonucu henüz yazılmamış satır: sonraki transaction'la birlikte yazılıyor.
  let unwritten: { rowNumber: number; outcome: RowOutcome } | null = null

  const lease = await withTenant(actor.tenantId, (tx) => acquireLease(tx, actor.tenantId, runId, kind, token), db)
  if (!lease) {
    const progress = await progressIn(actor, runId, kind, db)
    if (progress.status === 'RUNNING') {
      throw new AppError('IMPORT_RUN_BUSY', `import run ${runId} is leased`, { runId })
    }
    // Bitmiş aktarım için tekrar çağrı hata değil: son yanıt istemciye ulaşmamış olabilir.
    if (progress.status === 'DONE' || progress.status === 'CANCELLED') return progress
    throw wrongState(runId, progress.status)
  }

  try {
    // Önceki bir işleyici satırın ortasında düştüyse o satır IN_PROGRESS kaldı.
    await resolveInterruptedRows(actor, runId, engine.verify, db)

    if (lease.cancelRequested) {
      await withTenant(actor.tenantId, (tx) => finishRun(tx, actor.tenantId, runId, token, 'CANCELLED'), db)
      return await progressIn(actor, runId, kind, db)
    }

    let done = 0
    outer: while (done < maxRows && Date.now() - started < budgetMs) {
      const batch = await withTenant(
        actor.tenantId,
        (tx) =>
          tx
            .select()
            .from(importRunRows)
            .where(
              and(
                eq(importRunRows.tenantId, actor.tenantId),
                eq(importRunRows.runId, runId),
                eq(importRunRows.status, 'PENDING'),
              ),
            )
            .orderBy(asc(importRunRows.rowNumber))
            .limit(Math.min(100, maxRows - done)),
        db,
      )
      if (batch.length === 0) {
        await withTenant(
          actor.tenantId,
          async (tx) => {
            await flushOutcome(tx)
            await finishIfSettled(tx, actor.tenantId, runId, token)
          },
          db,
        )
        unwritten = null
        break
      }

      for (const row of batch) {
        if (done >= maxRows || Date.now() - started >= budgetMs) break outer

        // Önceki satırın sonucu + kira yenileme + iptal kontrolü + satırı alma:
        // tek transaction. Sonucu ayrı yazmak satır başına bir transaction
        // daha demekti (ölçüm: ~10 ms, küçük dosyada fark ediliyor).
        const claim = await withTenant(
          actor.tenantId,
          async (tx) => {
            await flushOutcome(tx)
            const renewed = await renewLease(tx, actor.tenantId, runId, token)
            if (!renewed) return 'lost' as const
            if (renewed.cancelRequested) return 'cancel' as const
            const taken = await tx
              .update(importRunRows)
              .set({ status: 'IN_PROGRESS', claimedAt: sql`now()`, claimToken: token })
              .where(
                and(
                  eq(importRunRows.tenantId, actor.tenantId),
                  eq(importRunRows.runId, runId),
                  eq(importRunRows.rowNumber, row.rowNumber),
                  eq(importRunRows.status, 'PENDING'),
                ),
              )
              .returning({ rowNumber: importRunRows.rowNumber })
            return taken.length > 0 ? ('taken' as const) : ('skip' as const)
          },
          db,
        )
        unwritten = null
        // Kira elimizden alındı ya da aktarım kapandı: başka satır başlatılmıyor.
        if (claim === 'lost') break outer
        if (claim === 'cancel') {
          await withTenant(actor.tenantId, (tx) => finishRun(tx, actor.tenantId, runId, token, 'CANCELLED'), db)
          break outer
        }
        if (claim === 'skip') continue

        unwritten = { rowNumber: row.rowNumber, outcome: await engine.apply(row) }
        done += 1
      }
    }
  } finally {
    // Son satırın sonucu ve kira: sıradaki parça 30 sn beklemesin. Yalnız
    // kendi kiramız; kiramız başkasına geçtiyse onunkini silmek iki işleyiciyi
    // birlikte çalıştırırdı. Bu da yazılamazsa satır IN_PROGRESS kalıyor ve
    // kesinti doğrulaması onu çözüyor (güvence 5).
    await withTenant(
      actor.tenantId,
      async (tx) => {
        await flushOutcome(tx)
        await tx
          .update(importRuns)
          .set({ leaseUntil: null, leaseToken: null })
          .where(
            and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId), eq(importRuns.leaseToken, token)),
          )
      },
      db,
    )
  }

  return progressIn(actor, runId, kind, db)

  /**
   * Henüz yazılmamış satır sonucunu verilen transaction'da yazar. Çağıran,
   * `unwritten`'ı yalnız o transaction commit olduktan sonra boşaltıyor: geri
   * dönerse sonuç kaybolmuyor, sıradaki fırsatta (ya da `finally`'de) yazılıyor.
   */
  async function flushOutcome(tx: Tx): Promise<void> {
    if (!unwritten) return
    const { rowNumber, outcome } = unwritten
    await tx
      .update(importRunRows)
      .set({
        status: outcome.status,
        openingOutcome: outcome.opening?.outcome ?? null,
        message: outcome.status === 'DONE' ? (outcome.opening?.message ?? null) : (outcome.message ?? null),
        ...(outcome.productId ? { productId: outcome.productId } : {}),
        processedAt: sql`now()`,
      })
      .where(
        and(
          eq(importRunRows.tenantId, actor.tenantId),
          eq(importRunRows.runId, runId),
          eq(importRunRows.rowNumber, rowNumber),
          eq(importRunRows.status, 'IN_PROGRESS'),
          // Satır hâlâ bizim mi: kesinti doğrulaması onu başka bir
          // işleyiciye verdiyse geç kalan sonuç yenisini ezmiyor.
          eq(importRunRows.claimToken, token),
        ),
      )
  }
}

/**
 * Kirayı alır: yalnız RUNNING kayıtta ve kira boşsa ya da süresi bittiyse.
 * Aynı anda gelen iki istekten biri alıyor: ikinci UPDATE satır kilidinden
 * sonra koşulu yeniden değerlendiriyor ve kirayı dolu buluyor.
 */
async function acquireLease(
  tx: Tx,
  tenantId: string,
  runId: string,
  kind: ImportRunKind,
  token: string,
): Promise<{ cancelRequested: boolean } | null> {
  const [row] = await tx
    .update(importRuns)
    .set({ leaseToken: token, leaseUntil: sql`now() + make_interval(secs => ${IMPORT_LEASE_SECONDS})` })
    .where(
      and(
        eq(importRuns.tenantId, tenantId),
        eq(importRuns.id, runId),
        // Tür şartı: ürün işleyicisi envanter satırını ürün diye uygulayamasın.
        eq(importRuns.kind, kind),
        eq(importRuns.status, 'RUNNING'),
        or(isNull(importRuns.leaseUntil), lt(importRuns.leaseUntil, sql`now()`)),
      ),
    )
    .returning({ cancelRequestedAt: importRuns.cancelRequestedAt })
  return row ? { cancelRequested: row.cancelRequestedAt !== null } : null
}

/**
 * Kirayı uzatır; yalnız kira hâlâ bizdeyse ve aktarım açıksa. Süresi bitmiş
 * kira da uzatılabiliyor: başkası almadıysa çalışan tek işleyici hâlâ biziz.
 */
async function renewLease(
  tx: Tx,
  tenantId: string,
  runId: string,
  token: string,
): Promise<{ cancelRequested: boolean } | null> {
  const [row] = await tx
    .update(importRuns)
    .set({ leaseUntil: sql`now() + make_interval(secs => ${IMPORT_LEASE_SECONDS})` })
    .where(
      and(
        eq(importRuns.tenantId, tenantId),
        eq(importRuns.id, runId),
        eq(importRuns.status, 'RUNNING'),
        eq(importRuns.leaseToken, token),
      ),
    )
    .returning({ cancelRequestedAt: importRuns.cancelRequestedAt })
  return row ? { cancelRequested: row.cancelRequestedAt !== null } : null
}

async function finishRun(
  tx: Tx,
  tenantId: string,
  runId: string,
  token: string,
  status: 'DONE' | 'CANCELLED',
): Promise<void> {
  await tx
    .update(importRuns)
    .set({ status, finishedAt: sql`now()`, leaseUntil: null, leaseToken: null })
    .where(
      and(
        eq(importRuns.tenantId, tenantId),
        eq(importRuns.id, runId),
        eq(importRuns.status, 'RUNNING'),
        eq(importRuns.leaseToken, token),
      ),
    )
}

/**
 * Bekleyen satır kalmadıysa aktarımı bitirir. Henüz eskimemiş bir IN_PROGRESS
 * satır varsa bitirmiyor: o satırın sonucu hâlâ yazılabilir; "bitti" deyip
 * sonucu belirsiz bir satırla raporu kapatmak yanlış olurdu.
 */
async function finishIfSettled(tx: Tx, tenantId: string, runId: string, token: string): Promise<void> {
  const [open] = await tx
    .select({ rowNumber: importRunRows.rowNumber })
    .from(importRunRows)
    .where(
      and(
        eq(importRunRows.tenantId, tenantId),
        eq(importRunRows.runId, runId),
        inArray(importRunRows.status, ['PENDING', 'IN_PROGRESS']),
      ),
    )
    .limit(1)
  if (!open) await finishRun(tx, tenantId, runId, token, 'DONE')
}

function previewRowOf(row: RunRow): PreviewRow {
  return {
    rowNumber: row.rowNumber,
    // Ürün kaydında karar yalnız create/update/error (tür şartı `acquireLease`'te).
    action: row.action as RowAction,
    sku: row.sku ?? '',
    name: row.name ?? '',
    issues: [],
    data: row.data as unknown as ParsedRow,
    ...(row.productId ? { productId: row.productId } : {}),
    ...(row.productVersion ? { productVersion: row.productVersion } : {}),
    ...(row.opening ? { opening: row.opening as unknown as OpeningPlan } : {}),
  }
}

/**
 * Sonucu yazılamamış (IN_PROGRESS) satırları veritabanına bakarak çözer.
 *
 * Bu satırların ürünü yazılmış OLABİLİR. "Başarılı" demek yanlış olabilir,
 * "başarısız" deyip yeniden yazmak da bir değişikliği ezebilir. Yalnız kanıt
 * varsa karar veriliyor:
 *
 *   yeni ürün, stok kodu yok        → ürün yazılmamış: yeniden denenir
 *   güncelleme, sürüm hâlâ aynı     → güncelleme yazılmamış: yeniden denenir
 *   diğer her durum                 → UNCERTAIN, bulunan gerçek mesajda
 *
 * Yeniden denemek güvenli: devir anahtarı ürün başına sabit (DAT-18).
 *
 * Yalnız `IMPORT_STALE_CLAIM_SECONDS`'tan eski satırlar: daha yeni bir satırın
 * işleyicisi hâlâ çalışıyor olabilir (bkz. sabit).
 *
 * Kararı türün doğrulayıcısı veriyor (`verify`); envanterde hareket anahtarı
 * satıra bağlı olduğu için uygulandığı KANITLANAN satır DONE olabiliyor.
 */
async function resolveInterruptedRows(
  actor: Actor,
  runId: string,
  verify: RowEngine['verify'],
  db?: Db,
): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const stuck = await tx
        .select()
        .from(importRunRows)
        .where(
          and(
            eq(importRunRows.tenantId, actor.tenantId),
            eq(importRunRows.runId, runId),
            eq(importRunRows.status, 'IN_PROGRESS'),
            lt(importRunRows.claimedAt, sql`now() - make_interval(secs => ${IMPORT_STALE_CLAIM_SECONDS})`),
          ),
        )
      for (const row of stuck) {
        const verdict = await verify(tx, actor.tenantId, row)
        await tx
          .update(importRunRows)
          .set(
            verdict.retry
              ? { status: 'PENDING', claimedAt: null, claimToken: null }
              : {
                  status: verdict.status ?? 'UNCERTAIN',
                  message: verdict.message ?? null,
                  ...(verdict.productId ? { productId: verdict.productId } : {}),
                  processedAt: sql`now()`,
                },
          )
          .where(
            and(
              eq(importRunRows.tenantId, actor.tenantId),
              eq(importRunRows.runId, runId),
              eq(importRunRows.rowNumber, row.rowNumber),
              eq(importRunRows.status, 'IN_PROGRESS'),
            ),
          )
      }
    },
    db,
  )
}

async function verifyRow(tx: Tx, tenantId: string, row: RunRow): Promise<RowVerdict> {
  const [product] = await tx
    .select({ id: products.id, version: PRODUCT_VERSION })
    .from(products)
    .where(
      and(
        eq(products.tenantId, tenantId),
        row.action === 'create' ? eq(products.sku, row.sku ?? '') : eq(products.id, row.productId!),
      ),
    )

  if (row.action === 'create' && !product) return { retry: true }
  if (row.action === 'update' && product && product.version === row.productVersion) return { retry: true }
  if (!product) {
    return { retry: false, message: 'Kesinti: ürün bulunamadı; sonucu doğrulanamadı. Ürünü kontrol edin.' }
  }

  let opening = ''
  if (row.opening) {
    const [movement] = await tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.tenantId, tenantId),
          eq(stockMovements.idempotencyKey, openingKey(tenantId, product.id)),
        ),
      )
    opening = movement ? ' Açılış stoğu kayıtlı.' : ' Açılış stoğu yazılmamış.'
  }
  return {
    retry: false,
    productId: product.id,
    message:
      row.action === 'create'
        ? `Kesinti: bu stok koduyla ürün kayıtlı, ama bu aktarımın mı eklediği doğrulanamadı.${opening} Ürünü kontrol edin; aynı dosyayı yeniden yüklemek güvenli.`
        : `Kesinti: ürün değişmiş, ama değişikliğin bu aktarımdan mı geldiği doğrulanamadı.${opening} Ürünü kontrol edin; aynı dosyayı yeniden yüklemek güvenli.`,
  }
}

/**
 * İptal. Yeni satır başlamaz; başlamış satır tamamlanır; yapılanlar korunur,
 * geri alınmaz. Hiçbir kilidi beklemiyor (T5).
 *
 * İşleyici çalışıyorsa (kira geçerli) yalnız bayrak yazılıyor; işleyici bir
 * sonraki satırdan ÖNCE görüp aktarımı kapatıyor. Çalışmıyorsa aktarım burada
 * kapanıyor: kira alma koşulu RUNNING olduğundan, kapandıktan sonra yeni bir
 * parça başlayamaz.
 */
export async function cancelImportRun(
  actor: Actor,
  runIdRaw: string,
  options: ImportRunOptions = {},
): Promise<ImportRunProgress> {
  requireImport(actor)
  return cancelRun(actor, runIdOf(runIdRaw), 'PRODUCT', verifyRow, options.db)
}

async function cancelRun(
  actor: Actor,
  runId: string,
  kind: ImportRunKind,
  verify: RowEngine['verify'],
  db?: Db,
): Promise<ImportRunProgress> {
  // İşleyici yok: aktarım çalışmıyor ya da kira boş/süresi bitmiş.
  const idle = sql`(${importRuns.status} <> 'RUNNING' OR ${importRuns.leaseUntil} IS NULL OR ${importRuns.leaseUntil} < now())`
  const closed = await withTenant(
    actor.tenantId,
    async (tx) => {
      const [row] = await tx
        .update(importRuns)
        .set({
          cancelRequestedAt: sql`coalesce(${importRuns.cancelRequestedAt}, now())`,
          status: sql`CASE WHEN ${idle} THEN 'CANCELLED' ELSE ${importRuns.status} END`,
          finishedAt: sql`CASE WHEN ${idle} THEN now() ELSE ${importRuns.finishedAt} END`,
          leaseUntil: sql`CASE WHEN ${idle} THEN NULL ELSE ${importRuns.leaseUntil} END`,
          leaseToken: sql`CASE WHEN ${idle} THEN NULL ELSE ${importRuns.leaseToken} END`,
        })
        .where(
          and(
            eq(importRuns.tenantId, actor.tenantId),
            eq(importRuns.id, runId),
            eq(importRuns.kind, kind),
            inArray(importRuns.status, ['UPLOADING', 'PREVIEWED', 'RUNNING']),
          ),
        )
        .returning({ status: importRuns.status })
      return row?.status === 'CANCELLED'
    },
    db,
  )
  // Kapanan aktarımda düşmüş bir işleyiciden kalan satır olabilir.
  if (closed) await resolveInterruptedRows(actor, runId, verify, db)
  return progressIn(actor, runId, kind, db)
}

// ---------------------------------------------------------------------------
// SONUÇ VE RAPOR
// ---------------------------------------------------------------------------

export interface ImportRunReportRow {
  rowNumber: number
  sku: string
  name: string
  status: string
  column: string
  message: string
}

/**
 * Rapor dosyasının sütunları. Satır numarası ve sütun adı birlikte: 60
 * sorunlu satırı ekrandan okuyup düzeltmek mümkün değil, kullanıcı iki
 * dosyayı yan yana açıp düzeltiyor.
 */
export function importRunReportColumns(): SheetColumn<ImportRunReportRow>[] {
  return [
    { header: 'Satır', width: 8, value: (r) => r.rowNumber },
    { header: 'Stok Kodu', width: 16, value: (r) => r.sku },
    { header: 'Ürün Adı', width: 32, value: (r) => r.name },
    { header: 'Durum', width: 12, value: (r) => r.status },
    { header: 'Sütun', width: 16, value: (r) => r.column },
    { header: 'Açıklama', width: 60, value: (r) => r.message },
  ]
}

/**
 * Kullanıcının düzeltmesi ya da bilmesi gereken bütün satırlar: hatalı,
 * yazılamayan, çakışan, belirsiz, işlenmeyen ve açılış stoğu notu olanlar
 * (T172'nin rapor kısmı). Sorunsuz aktarılan satır raporda yok.
 *
 * `limit`: ekran için ilk satırlar; rapor dosyası için verilmez.
 */
export async function importRunReport(
  actor: Actor,
  runIdRaw: string,
  options: ImportRunOptions & { limit?: number } = {},
): Promise<ImportRunReportRow[]> {
  requireImport(actor)
  return reportOf(actor, runIdOf(runIdRaw), 'PRODUCT', options)
}

/**
 * İki türün raporu aynı sorgu: envanterde ek olarak "depoya atama bekliyor"
 * satırları (SKIPPED, `unassigned`) çıkıyor; "değişiklik yok" satırı
 * düzeltilecek ya da bilinecek bir şey taşımadığı için raporda yok.
 */
async function reportOf(
  actor: Actor,
  runId: string,
  kind: ImportRunKind,
  options: ImportRunOptions & { limit?: number },
): Promise<ImportRunReportRow[]> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const [run] = await tx
        .select({ status: importRuns.status })
        .from(importRuns)
        .where(and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId), eq(importRuns.kind, kind)))
      if (!run) throw notFound(runId)
      // Aktarım sürerken bekleyen satır "işlenmedi" değil; yalnız kapanmış aktarımda.
      const closed = run.status === 'DONE' || run.status === 'CANCELLED'

      const rows = await tx
        .select({
          rowNumber: importRunRows.rowNumber,
          sku: importRunRows.sku,
          name: importRunRows.name,
          status: importRunRows.status,
          issues: importRunRows.issues,
          message: importRunRows.message,
          openingOutcome: importRunRows.openingOutcome,
          cells: importRunRows.cells,
        })
        .from(importRunRows)
        .where(
          and(
            eq(importRunRows.tenantId, actor.tenantId),
            eq(importRunRows.runId, runId),
            or(
              inArray(importRunRows.status, ['INVALID', 'FAILED', 'CONFLICT', 'UNCERTAIN', 'IN_PROGRESS']),
              closed ? eq(importRunRows.status, 'PENDING') : undefined,
              inArray(importRunRows.openingOutcome, ['SKIPPED', 'FAILED']),
              and(eq(importRunRows.status, 'SKIPPED'), eq(importRunRows.action, 'unassigned')),
            ),
          ),
        )
        .orderBy(asc(importRunRows.rowNumber))
        .limit(options.limit ?? IMPORT_ROW_LIMIT)

      return rows.flatMap((r) => {
        const status = r.status as ImportRowStatus
        const sku = r.sku ?? r.cells.sku ?? ''
        const name = r.name ?? r.cells.name ?? ''
        const base = { rowNumber: r.rowNumber, sku, name, status: IMPORT_ROW_STATUSES[status].tr }
        if (status === 'INVALID') {
          return (r.issues ?? []).map((i) => ({ ...base, column: i.column, message: i.message }))
        }
        if (status === 'PENDING') {
          return [{ ...base, column: '', message: 'İptal edildiği için işlenmedi' }]
        }
        if (status === 'IN_PROGRESS') {
          return [{ ...base, status: IMPORT_ROW_STATUSES.UNCERTAIN.tr, column: '', message: 'Kesinti: sonucu doğrulanamadı. Ürünü kontrol edin.' }]
        }
        return [{ ...base, column: status === 'DONE' ? COLUMN_LABELS.openingQty : '', message: r.message ?? '' }]
      })
    },
    options.db,
  )
}

// ---------------------------------------------------------------------------
// ENVANTER DOSYASI (T218, PRD-18)
//
// Aynı kayıt ve parça işleyici; satır işi `inventory-import.ts`'te. Akış:
//   startInventoryRun → appendInventoryRows → finalizeInventoryPreview
//   → beginInventoryRun (depolar burada açılıyor) → processInventoryChunk …
// ---------------------------------------------------------------------------

/**
 * Envanter aktarımının yetkisi: stoğu dosyadaki sayıya çeken sayım onayı
 * (yalnız yönetici). Dosyada yeni ürün varsa onayda ayrıca `product:create`.
 */
function requireInventory(actor: Actor): void {
  requirePermission(actor, 'count:approve')
}

const inventoryStartSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    fileBytes: z.number().int().nonnegative().max(IMPORT_FILE_BYTES_LIMIT),
    totalRows: z.number().int().min(1).max(IMPORT_ROW_LIMIT),
    columns: z
      .array(z.enum(INVENTORY_FIELDS as [InventoryField, ...InventoryField[]]))
      .max(INVENTORY_FIELDS.length),
    unreadColumns: z
      .array(z.string().trim().max(INVENTORY_HEADER_LIMIT))
      .max(INVENTORY_UNREAD_COLUMNS_LIMIT)
      .default([]),
  })
  .refine((v) => INVENTORY_REQUIRED_FIELDS.every((f) => v.columns.includes(f)), {
    message: 'Malzeme Kodu, Envanter Miktarı ve Ambar sütunları gerekli',
    path: ['columns'],
  })

/**
 * Dosya düzeyi bilgiler. Dosyada olmayan ürünün değişmediği AÇIKÇA
 * söyleniyor (CEO-7): kullanıcı "dosyada yoksa sıfırlanır" sanıp stoğu sıfır
 * olan ürünleri dosyadan çıkarmış olabilir.
 */
function inventoryNotices(unreadColumns: string[]): string[] {
  const notices = ['Dosyada olmayan ürünlerin ve depoların stoğu değişmez.']
  if (unreadColumns.length > 0) {
    notices.push(
      `Okunmayan sütunlar: ${unreadColumns.join(', ')}. Fiyat ve tutar sütunları envanter güncellemesinde kullanılmaz.`,
    )
  }
  return notices
}

export async function startInventoryRun(
  actor: Actor,
  raw: unknown,
  options: ImportRunOptions = {},
): Promise<{ runId: string }> {
  requireInventory(actor)
  const input = parseOrThrow(inventoryStartSchema, raw)
  const runId = await withTenant(
    actor.tenantId,
    async (tx) => {
      await pruneImportRuns(tx, actor.tenantId)
      const [row] = await tx
        .insert(importRuns)
        .values({
          tenantId: actor.tenantId,
          createdBy: actor.userId,
          kind: 'INVENTORY',
          fileName: input.fileName,
          fileBytes: input.fileBytes,
          totalRows: input.totalRows,
          columns: input.columns,
          notices: inventoryNotices(input.unreadColumns),
        })
        .returning({ id: importRuns.id })
      return row!.id
    },
    options.db,
  )
  return { runId }
}

const inventoryAppendSchema = z.object({
  rows: z.array(rawInventoryRowSchema).min(1).max(IMPORT_APPEND_MAX_ROWS),
})

export async function appendInventoryRows(
  actor: Actor,
  runIdRaw: string,
  raw: unknown,
  options: ImportRunOptions = {},
): Promise<{ received: number; total: number }> {
  requireInventory(actor)
  const runId = runIdOf(runIdRaw)
  const input = parseOrThrow(inventoryAppendSchema, raw)
  return appendRows(actor, runId, 'INVENTORY', input.rows, options)
}

/** Son uygulanan (başlamış) envanter dosyası (K3, CEO-5): ad ve tarih. */
export interface LastInventoryFile {
  fileName: string
  startedAt: Date
  finishedAt: Date | null
  status: ImportRunStatus
}

export interface InventoryRunPreview {
  runId: string
  counts: {
    create: number
    newProducts: number
    update: number
    unchanged: number
    unassigned: number
    error: number
    ambiguous: number
  }
  /** Geçerli satırların depoları; `isNew` onayda açılacak. */
  depots: { name: string; isNew: boolean }[]
  notices: string[]
  /** İlk `IMPORT_SAMPLE_SIZE` hatalı satır; tamamı raporda. */
  errors: { rowNumber: number; sku: string; name: string; issues: { column: string; message: string }[] }[]
  /** Depoya atama bekleyen satırlar (ilk `IMPORT_SAMPLE_SIZE`). */
  unassigned: { rowNumber: number; sku: string; name: string; message: string }[]
  /** Aynı içerik daha önce uygulandıysa o dosya: onay "yeni sayım" onayı ister. */
  repeatOf: { fileName: string; startedAt: Date } | null
  lastFile: LastInventoryFile | null
}

/**
 * Bütün satırlar geldikten sonra önizlemeyi BİR KEZ hesaplar, satır
 * kararlarını ve içerik parmak izini kayda yazar. Ürün, depo ve stok
 * verisine HİÇBİR ŞEY yazılmıyor.
 */
export async function finalizeInventoryPreview(
  actor: Actor,
  runIdRaw: string,
  options: ImportRunOptions = {},
): Promise<InventoryRunPreview> {
  requireInventory(actor)
  const runId = runIdOf(runIdRaw)
  const db = options.db

  const { run, rows } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const [run] = await tx
        .select({ status: importRuns.status, totalRows: importRuns.totalRows, notices: importRuns.notices })
        .from(importRuns)
        .where(and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId), eq(importRuns.kind, 'INVENTORY')))
      if (!run) throw notFound(runId)
      if (run.status !== 'UPLOADING') throw wrongState(runId, run.status)
      const rows = await tx
        .select({ rowNumber: importRunRows.rowNumber, cells: importRunRows.cells })
        .from(importRunRows)
        .where(and(eq(importRunRows.tenantId, actor.tenantId), eq(importRunRows.runId, runId)))
        .orderBy(asc(importRunRows.rowNumber))
      return { run, rows }
    },
    db,
  )
  if (rows.length !== run.totalRows) throw wrongState(runId, 'INCOMPLETE')

  const preview = await previewInventory(actor, rows as RawInventoryRow[], { db })

  const { repeatOf, lastFile } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const [locked] = await tx
        .select({ status: importRuns.status })
        .from(importRuns)
        .where(and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId)))
        .for('update')
      if (locked?.status !== 'UPLOADING') throw wrongState(runId, locked?.status ?? 'GONE')

      for (let i = 0; i < preview.rows.length; i += 1_000) {
        const batch = preview.rows.slice(i, i + 1_000).map((r) => ({
          row_number: r.rowNumber,
          action: r.action,
          sku: r.sku,
          name: r.name,
          issues: r.issues,
          data: r.data ?? null,
          product_id: r.productId ?? null,
          message: r.message ?? null,
        }))
        await tx.execute(sql`
          UPDATE import_run_rows AS r
             SET action = x.action, sku = x.sku, name = x.name, issues = x.issues, data = x.data,
                 product_id = x.product_id, message = x.message,
                 status = CASE WHEN x.action = 'error' THEN 'INVALID'
                               WHEN x.action IN ('unchanged', 'unassigned') THEN 'SKIPPED'
                               ELSE 'PENDING' END
            FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS x(
                 row_number int, action text, sku text, name text, issues jsonb, data jsonb,
                 product_id uuid, message text)
           WHERE r.tenant_id = ${actor.tenantId}::uuid AND r.run_id = ${runId}::uuid
             AND r.row_number = x.row_number
        `)
      }
      await tx
        .update(importRuns)
        .set({ status: 'PREVIEWED', previewedAt: sql`now()`, contentHash: preview.contentHash })
        .where(and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId)))
      return {
        repeatOf: await repeatOfRun(tx, actor.tenantId, runId, preview.contentHash),
        lastFile: await lastInventoryFileIn(tx, actor.tenantId),
      }
    },
    db,
  )

  const errorRows = preview.rows.filter((r) => r.action === 'error')
  const unassignedRows = preview.rows.filter((r) => r.action === 'unassigned')
  return {
    runId,
    counts: preview.counts,
    depots: preview.depots,
    notices: run.notices,
    errors: errorRows
      .slice(0, IMPORT_SAMPLE_SIZE)
      .map((r) => ({ rowNumber: r.rowNumber, sku: r.sku, name: r.name, issues: r.issues })),
    unassigned: unassignedRows
      .slice(0, IMPORT_SAMPLE_SIZE)
      .map((r) => ({ rowNumber: r.rowNumber, sku: r.sku, name: r.name, message: r.message ?? '' })),
    repeatOf,
    lastFile,
  }
}

/**
 * Aynı içerikle başlamış önceki envanter aktarımı (K3). Başlamamış (yalnız
 * önizlenmiş) dosya sayılmıyor: stoğa hiç dokunmadı.
 */
async function repeatOfRun(
  tx: Tx,
  tenantId: string,
  runId: string,
  contentHash: string | null,
): Promise<{ fileName: string; startedAt: Date } | null> {
  if (!contentHash) return null
  const [prev] = await tx
    .select({ fileName: importRuns.fileName, startedAt: importRuns.startedAt })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.tenantId, tenantId),
        eq(importRuns.kind, 'INVENTORY'),
        eq(importRuns.contentHash, contentHash),
        ne(importRuns.id, runId),
        isNotNull(importRuns.startedAt),
      ),
    )
    .orderBy(desc(importRuns.startedAt))
    .limit(1)
  return prev ? { fileName: prev.fileName, startedAt: prev.startedAt! } : null
}

async function lastInventoryFileIn(tx: Tx, tenantId: string): Promise<LastInventoryFile | null> {
  const [last] = await tx
    .select({
      fileName: importRuns.fileName,
      startedAt: importRuns.startedAt,
      finishedAt: importRuns.finishedAt,
      status: importRuns.status,
    })
    .from(importRuns)
    .where(and(eq(importRuns.tenantId, tenantId), eq(importRuns.kind, 'INVENTORY'), isNotNull(importRuns.startedAt)))
    .orderBy(desc(importRuns.startedAt))
    .limit(1)
  return last
    ? { fileName: last.fileName, startedAt: last.startedAt!, finishedAt: last.finishedAt, status: last.status as ImportRunStatus }
    : null
}

/** Son uygulanan envanter dosyasının adı ve tarihi; ekranın üstünde gösteriliyor. */
export async function getLastInventoryFile(
  actor: Actor,
  options: ImportRunOptions = {},
): Promise<LastInventoryFile | null> {
  requireInventory(actor)
  return withTenant(actor.tenantId, (tx) => lastInventoryFileIn(tx, actor.tenantId), options.db)
}

const beginInventorySchema = z.object({ confirmNewCount: z.boolean().default(false) })

/**
 * Kullanıcı önizlemeyi onayladı. Tek transaction'da: aynı içerik kontrolü,
 * yeni depoların açılması ve aktarımın başlaması. Depo ancak burada açılıyor:
 * önizleme ya da onaylanmamış dosya hiçbir depo bırakmıyor.
 *
 * AYNI İÇERİK (K3): daha önce uygulanmış içerik `confirmNewCount` olmadan
 * başlamıyor. Kontrol SUNUCUDA: yalnız ekranda olsaydı istek doğrudan
 * gönderilerek atlanabilirdi. Aynı aktarımın yeniden onayı (ilk yanıt
 * kaybolduysa) hata değil, ilerlemeyi döndürüyor.
 */
export async function beginInventoryRun(
  actor: Actor,
  runIdRaw: string,
  raw: unknown = {},
  options: ImportRunOptions = {},
): Promise<ImportRunProgress> {
  requireInventory(actor)
  const runId = runIdOf(runIdRaw)
  const input = parseOrThrow(beginInventorySchema, raw)
  const db = options.db

  const begun = await withTenant(
    actor.tenantId,
    async (tx) => {
      const [run] = await tx
        .select({ status: importRuns.status, contentHash: importRuns.contentHash })
        .from(importRuns)
        .where(and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId), eq(importRuns.kind, 'INVENTORY')))
        .for('update')
      if (!run) throw notFound(runId)
      if (run.status !== 'PREVIEWED') return false

      const [creates] = await tx
        .select({ rowNumber: importRunRows.rowNumber })
        .from(importRunRows)
        .where(
          and(
            eq(importRunRows.tenantId, actor.tenantId),
            eq(importRunRows.runId, runId),
            eq(importRunRows.action, 'create'),
            eq(importRunRows.status, 'PENDING'),
          ),
        )
        .limit(1)
      if (creates) requirePermission(actor, 'product:create')

      if (!input.confirmNewCount) {
        const repeat = await repeatOfRun(tx, actor.tenantId, runId, run.contentHash)
        if (repeat) {
          throw new AppError('IMPORT_REPEAT_UNCONFIRMED', `content already applied by ${repeat.fileName}`, {
            fileName: repeat.fileName,
            startedAt: repeat.startedAt.toISOString(),
          })
        }
      }

      await resolveRunDepots(tx, actor.tenantId, runId)
      await tx
        .update(importRuns)
        .set({ status: 'RUNNING', startedAt: sql`now()` })
        .where(and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId)))
      return true
    },
    db,
  )
  const progress = await progressIn(actor, runId, 'INVENTORY', db)
  if (!begun && progress.status !== 'RUNNING') throw wrongState(runId, progress.status)
  return progress
}

/** Bir sonraki envanter satır grubunu işler (bkz. `processImportChunk`). */
export async function processInventoryChunk(
  actor: Actor,
  runIdRaw: string,
  options: ImportChunkOptions = {},
): Promise<ImportRunProgress> {
  requireInventory(actor)
  const runId = runIdOf(runIdRaw)
  const [run] = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .select({ fileName: importRuns.fileName })
        .from(importRuns)
        .where(and(eq(importRuns.tenantId, actor.tenantId), eq(importRuns.id, runId), eq(importRuns.kind, 'INVENTORY'))),
    options.db,
  )
  if (!run) throw notFound(runId)
  return runChunk(
    actor,
    runId,
    'INVENTORY',
    {
      apply: (row) => applyInventoryRow(actor, { id: runId, fileName: run.fileName }, row, { db: options.db }),
      verify: verifyInventoryRow,
    },
    options,
  )
}

export async function getInventoryRunProgress(
  actor: Actor,
  runIdRaw: string,
  options: ImportRunOptions = {},
): Promise<ImportRunProgress> {
  requireInventory(actor)
  return progressIn(actor, runIdOf(runIdRaw), 'INVENTORY', options.db)
}

export async function cancelInventoryRun(
  actor: Actor,
  runIdRaw: string,
  options: ImportRunOptions = {},
): Promise<ImportRunProgress> {
  requireInventory(actor)
  return cancelRun(actor, runIdOf(runIdRaw), 'INVENTORY', verifyInventoryRow, options.db)
}

export async function inventoryRunReport(
  actor: Actor,
  runIdRaw: string,
  options: ImportRunOptions & { limit?: number } = {},
): Promise<ImportRunReportRow[]> {
  requireInventory(actor)
  return reportOf(actor, runIdOf(runIdRaw), 'INVENTORY', options)
}
