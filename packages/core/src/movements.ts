import {
  AppError,
  type CreateMovementInput,
  type CreateMovementResponse,
  type Role,
  can,
  createMovementSchema,
  toDelta,
} from '@stok/shared'
import {
  type Db,
  type Tx,
  currentStock,
  isDeadlock,
  isUniqueViolation,
  locations,
  productBarcodes,
  products,
  stockMovements,
  withTenant,
} from '@stok/db'
import { and, eq, sql } from 'drizzle-orm'
import { formatScaled, multiplyScaled, parseScaled, scaledFromNumber, scaledToNumber } from './numeric.js'

/**
 * ============================================================================
 * TEK YAZMA KAPISI (T9)
 *
 * Stoğu değiştiren TEK fonksiyon. Web de mobil de aynı kapıdan geçer.
 * İki ayrı implementasyon iki ayrı hata kümesi demektir: biri idempotency'yi
 * unutur, diğeri koli çarpanını, ve ikisi de doğru görünür.
 *
 * Sıra önemli, her adım bir hata yolunu kapatıyor:
 *
 *   1. rol kontrolü          → FORBIDDEN        (arayüzde buton gizlemek yetki değildir)
 *   2. zod doğrulaması       → VALIDATION_FAILED / INVALID_QUANTITY
 *   3. idempotency okuması   → duplicate:true   (kullanıcı hiçbir şey görmez)
 *   4. barkod → ürün         → BARCODE_UNKNOWN  (depoda EN SIK yaşanan olay)
 *   5. arşiv kontrolü        → PRODUCT_ARCHIVED
 *   6. SATIR KİLİDİ + kontrol→ INSUFFICIENT_STOCK
 *   7. ledger insert         → trigger projeksiyonu günceller
 *
 * 6. adım neden kilitli (D-1.2): stok okuyup sonra yazmak klasik bir TOCTOU
 * yarışıdır. İki eşzamanlı çıkış isteği ikisi de "yeterli stok var"
 * kontrolünden geçer ve stok negatife düşer. Kilit ürün bazlı olduğu için
 * farklı ürünlere yazanlar birbirini beklemez.
 * ============================================================================
 */

export interface Actor {
  tenantId: string
  userId: string
  role: Role
}

interface CreateMovementOptions {
  /** Test ve cron için: varsayılan uygulama havuzu yerine başka bağlantı. */
  db?: Db
}

/** Deadlock ve serileştirme hatalarında kaç kez tekrar denenir. */
const MAX_ATTEMPTS = 3

export async function createMovement(
  actor: Actor,
  raw: unknown,
  options: CreateMovementOptions = {},
): Promise<CreateMovementResponse> {
  if (!can(actor.role, 'movement:create')) {
    throw new AppError('FORBIDDEN', `role ${actor.role} cannot create movements`, {
      permission: 'movement:create',
    })
  }

  const input = parseInput(raw)

  if (input.allowNegative && !can(actor.role, 'movement:allowNegative')) {
    // Reddetmek yerine sessizce yok saymak daha kötü olurdu: çalışan
    // "yine de yap" dediğini sanır, sistem başka bir şey yapar.
    throw new AppError('FORBIDDEN', `role ${actor.role} cannot override negative stock`, {
      permission: 'movement:allowNegative',
    })
  }

  for (let attempt = 1; ; attempt++) {
    try {
      return await withTenant(actor.tenantId, (tx) => writeMovement(tx, actor, input), options.db)
    } catch (err) {
      // Aynı idempotency_key ikinci kez geldi. 3. adımdaki okuma bunu
      // yakalayamadıysa iki istek aynı anda gelmiş demektir; yarışı
      // veritabanının UNIQUE index'i çözdü, cevabı biz veriyoruz.
      if (isUniqueViolation(err, 'movements_tenant_idem_uq')) {
        return readExistingMovement(actor, input, options)
      }
      // Deadlock: iki istek iki ürünü ters sırada kilitlemiş. Tekrar
      // denemek doğru davranış, kullanıcıya hata göstermek değil.
      if (isDeadlock(err) && attempt < MAX_ATTEMPTS) continue
      if (isDeadlock(err)) {
        throw new AppError('SERIALIZATION_FAILURE', `deadlock after ${attempt} attempts`, {
          attempts: attempt,
        })
      }
      throw err
    }
  }
}

// ---------------------------------------------------------------------------

function parseInput(raw: unknown): CreateMovementInput {
  const parsed = createMovementSchema.safeParse(raw)
  if (parsed.success) return parsed.data

  const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
  // Miktar hatası kendi koduna sahip: kullanıcıya "girilen bilgilerde hata
  // var" yerine "miktar sıfırdan büyük olmalı" gösterilebilsin.
  const code = issues.every((i) => i.path === 'qty') ? 'INVALID_QUANTITY' : 'VALIDATION_FAILED'
  throw new AppError(code, issues.map((i) => `${i.path}: ${i.message}`).join('; '), { issues })
}

async function writeMovement(
  tx: Tx,
  actor: Actor,
  input: CreateMovementInput,
): Promise<CreateMovementResponse> {
  const duplicate = await findByIdempotencyKey(tx, actor.tenantId, input.idempotencyKey)
  if (duplicate) return duplicate

  const target = await resolveBarcode(tx, actor.tenantId, input.barcode)

  if (target.archivedAt !== null) {
    throw new AppError('PRODUCT_ARCHIVED', `product ${target.productId} is archived`, {
      productId: target.productId,
      name: target.productName,
    })
  }

  if (input.locationId) await assertLocationExists(tx, actor.tenantId, input.locationId)

  const effectiveQty = multiplyScaled(
    scaledFromNumber(input.qty),
    parseScaled(target.qtyMultiplier),
  )
  const delta = toDelta(1, input.reason) === 1 ? effectiveQty : -effectiveQty

  const before = await lockStockRow(tx, actor.tenantId, target.productId)
  const expected = before + delta

  if (expected < 0n && !input.allowNegative) {
    throw new AppError(
      'INSUFFICIENT_STOCK',
      `requested ${formatScaled(-delta)} > available ${formatScaled(before)}`,
      {
        productId: target.productId,
        name: target.productName,
        available: scaledToNumber(before),
        requested: scaledToNumber(-delta),
      },
    )
  }

  const [inserted] = await tx
    .insert(stockMovements)
    .values({
      tenantId: actor.tenantId,
      productId: target.productId,
      userId: actor.userId,
      barcodeId: target.barcodeId,
      delta: formatScaled(delta),
      reason: input.reason,
      note: input.note ?? null,
      locationId: input.locationId ?? null,
      unitCost: input.unitCost === undefined ? null : input.unitCost.toFixed(2),
      idempotencyKey: input.idempotencyKey,
      clientCreatedAt: new Date(input.clientCreatedAt),
    })
    .returning({ id: stockMovements.id })

  if (!inserted) throw new AppError('SERVER_ERROR', 'ledger insert returned no row')

  // Projeksiyonu trigger yazdı. Hesabımızla karşılaştırıyoruz: eşit
  // değilse invariant kırıldı ve bunu kullanıcıya yanlış sayı göstererek
  // öğrenmektense burada patlamak iyidir (PLAN.md T37).
  const after = await readStockQty(tx, actor.tenantId, target.productId)
  if (after !== expected) {
    throw new AppError('SERVER_ERROR', 'projection diverged from ledger', {
      productId: target.productId,
      expected: formatScaled(expected),
      actual: formatScaled(after),
    })
  }

  return {
    movementId: inserted.id,
    productId: target.productId,
    productName: target.productName,
    effectiveQty: scaledToNumber(effectiveQty),
    delta: scaledToNumber(delta),
    newQty: scaledToNumber(after),
    duplicate: false,
  }
}

/**
 * Barkodu ürüne çevirir. `tenant_id` filtresi RLS'e EK olarak yazılıyor:
 * RLS zaten süzüyor ama açık filtre `barcodes_tenant_barcode_uq` index'ini
 * kullandırıyor ve niyeti okuyana gösteriyor.
 */
async function resolveBarcode(tx: Tx, tenantId: string, barcode: string) {
  const [row] = await tx
    .select({
      barcodeId: productBarcodes.id,
      qtyMultiplier: productBarcodes.qtyMultiplier,
      productId: products.id,
      productName: products.name,
      archivedAt: products.archivedAt,
    })
    .from(productBarcodes)
    .innerJoin(products, eq(products.id, productBarcodes.productId))
    .where(and(eq(productBarcodes.tenantId, tenantId), eq(productBarcodes.barcode, barcode)))
    .limit(1)

  if (!row) {
    throw new AppError('BARCODE_UNKNOWN', `barcode ${barcode} not found`, { barcode })
  }
  return row
}

/**
 * Konum bu tenant'a ait mi. Yabancı anahtar kontrolü BUNU YAPMAZ:
 * PostgreSQL'de referans bütünlüğü tetikleyicileri RLS'i atlar, yani
 * başka bir tenant'ın konum kimliği gönderilse FK'dan geçerdi.
 */
async function assertLocationExists(tx: Tx, tenantId: string, locationId: string) {
  const [row] = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.tenantId, tenantId), eq(locations.id, locationId)))
    .limit(1)

  if (!row) {
    throw new AppError('NOT_FOUND', `location ${locationId} not found`, { locationId })
  }
}

/**
 * Ürünün stok satırını kilitler ve mevcut miktarı döner.
 *
 * İlk hareket için satır henüz yoktur; `ON CONFLICT DO NOTHING` ile
 * atomik olarak sıfırdan oluşturulur. Satır silinemez (migration'da
 * `REVOKE DELETE`), bu yüzden araya giren `SELECT ... FOR UPDATE`
 * her zaman satırı bulur.
 */
async function lockStockRow(tx: Tx, tenantId: string, productId: string): Promise<bigint> {
  await tx
    .insert(currentStock)
    .values({ tenantId, productId, qty: '0' })
    .onConflictDoNothing({ target: [currentStock.tenantId, currentStock.productId] })

  const [row] = await tx
    .select({ qty: currentStock.qty })
    .from(currentStock)
    .where(and(eq(currentStock.tenantId, tenantId), eq(currentStock.productId, productId)))
    .for('update')

  if (!row) throw new AppError('SERVER_ERROR', 'current_stock row vanished after upsert')
  return parseScaled(row.qty)
}

async function readStockQty(tx: Tx, tenantId: string, productId: string): Promise<bigint> {
  const [row] = await tx
    .select({ qty: currentStock.qty })
    .from(currentStock)
    .where(and(eq(currentStock.tenantId, tenantId), eq(currentStock.productId, productId)))

  return row ? parseScaled(row.qty) : 0n
}

/**
 * Aynı anahtarla daha önce yazılmış hareketi bulur.
 *
 * Bulursa istek BAŞARILI sayılır ve `duplicate: true` döner. Hata
 * dönmek yanlış olurdu: mobil outbox 201 alamadığı için tekrar
 * gönderiyor, hareket zaten yazılmış, yapılacak bir şey yok.
 */
async function findByIdempotencyKey(
  tx: Tx,
  tenantId: string,
  idempotencyKey: string,
): Promise<CreateMovementResponse | undefined> {
  const [row] = await tx
    .select({
      movementId: stockMovements.id,
      productId: stockMovements.productId,
      productName: products.name,
      delta: stockMovements.delta,
      qty: currentStock.qty,
    })
    .from(stockMovements)
    .innerJoin(products, eq(products.id, stockMovements.productId))
    .leftJoin(
      currentStock,
      and(
        eq(currentStock.tenantId, stockMovements.tenantId),
        eq(currentStock.productId, stockMovements.productId),
      ),
    )
    .where(
      and(
        eq(stockMovements.tenantId, tenantId),
        eq(stockMovements.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1)

  if (!row) return undefined

  const delta = parseScaled(row.delta)
  return {
    movementId: row.movementId,
    productId: row.productId,
    productName: row.productName,
    effectiveQty: scaledToNumber(delta < 0n ? -delta : delta),
    delta: scaledToNumber(delta),
    newQty: scaledToNumber(row.qty ? parseScaled(row.qty) : 0n),
    duplicate: true,
  }
}

/** UNIQUE ihlali sonrası: kazanan isteğin yazdığı kaydı okuyup döner. */
async function readExistingMovement(
  actor: Actor,
  input: CreateMovementInput,
  options: CreateMovementOptions,
): Promise<CreateMovementResponse> {
  const found = await withTenant(
    actor.tenantId,
    (tx) => findByIdempotencyKey(tx, actor.tenantId, input.idempotencyKey),
    options.db,
  )
  if (found) return found
  // Buraya düşmek, UNIQUE ihlalinin başka bir index'ten geldiği anlamına
  // gelir. Sessizce yutmak yerine görünür olsun.
  throw new AppError('SERVER_ERROR', 'unique violation without a matching movement', {
    idempotencyKey: input.idempotencyKey,
  })
}

/** Test ve rapor kodu için: ürünün projeksiyondaki güncel miktarı. */
export async function getStockQty(
  actor: Pick<Actor, 'tenantId'>,
  productId: string,
  options: CreateMovementOptions = {},
): Promise<number> {
  const qty = await withTenant(
    actor.tenantId,
    (tx) => readStockQty(tx, actor.tenantId, productId),
    options.db,
  )
  return scaledToNumber(qty)
}

/**
 * Invariant kontrolü (T11 / T37): her ürün için
 * `SUM(stock_movements.delta) == current_stock.qty`.
 *
 * Uygulama kodunda duruyor çünkü sadece test değil, "Sistem Sağlığı"
 * kartı ve kırmızı alarm da bunu çağıracak.
 */
export interface InvariantBreach {
  productId: string
  ledgerSum: string
  projection: string
}

export async function checkStockInvariant(
  tenantId: string,
  options: CreateMovementOptions = {},
): Promise<InvariantBreach[]> {
  return withTenant(
    tenantId,
    async (tx) => {
      const rows = await tx.execute<{
        product_id: string
        ledger_sum: string
        projection: string
      }>(sql`
        SELECT COALESCE(m.product_id, s.product_id)     AS product_id,
               COALESCE(m.total, 0)::text               AS ledger_sum,
               COALESCE(s.qty, 0)::text                 AS projection
          FROM (SELECT product_id, SUM(delta) AS total
                  FROM stock_movements
                 GROUP BY product_id) m
          FULL OUTER JOIN current_stock s USING (product_id)
         WHERE COALESCE(m.total, 0) <> COALESCE(s.qty, 0)
      `)

      return [...rows].map((r) => ({
        productId: r.product_id,
        ledgerSum: r.ledger_sum,
        projection: r.projection,
      }))
    },
    options.db,
  )
}
