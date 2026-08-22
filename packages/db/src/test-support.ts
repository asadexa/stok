import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { schema } from './schema.js'

/**
 * ============================================================================
 * TEST DESTEĞİ
 *
 * İKİ BAĞLANTI, çünkü asıl test edilen şey ikisinin FARKI:
 *
 *   appSql / appDb      stok_app rolü  → RLS UYGULANIR   (uygulamanın gördüğü)
 *   adminSql / adminDb  postgres rolü  → RLS ATLANIR     (kurulum ve temizlik)
 *
 * Bir tenant izolasyonu testi yanlışlıkla admin bağlantısını kullanırsa
 * HER ŞEY GEÇER ve test hiçbir şey ispat etmez. Bu, RLS testlerinin en
 * sinsi yanlış pozitifi. İsimler bu yüzden bilerek ayrık.
 * ============================================================================
 */

export type TestDb = PostgresJsDatabase<typeof schema>

let _appSql: postgres.Sql | undefined
let _adminSql: postgres.Sql | undefined

/** RLS UYGULANAN bağlantı. Uygulamanın gerçekte kullandığı rol. */
export function appSql(): postgres.Sql {
  if (!_appSql) {
    _appSql = postgres(process.env.DATABASE_URL!, { max: 8, prepare: false, onnotice: () => {} })
  }
  return _appSql
}

export function appDb(): TestDb {
  return drizzle(appSql(), { schema })
}

/** RLS ATLAYAN bağlantı. Sadece fixture kurulumu ve temizlik. */
export function adminSql(): postgres.Sql {
  if (!_adminSql) {
    _adminSql = postgres(process.env.MIGRATION_DATABASE_URL!, {
      max: 4,
      prepare: false,
      onnotice: () => {},
    })
  }
  return _adminSql
}

export function adminDb(): TestDb {
  return drizzle(adminSql(), { schema })
}

export async function closeTestDbs(): Promise<void> {
  await _appSql?.end()
  await _adminSql?.end()
  _appSql = undefined
  _adminSql = undefined
}

export interface TenantFixture {
  tenantId: string
  adminUserId: string
  staffUserId: string
  productId: string
  /** Çarpanı 1 olan birim barkodu. */
  unitBarcode: string
  unitBarcodeId: string
  /** Çarpanı 12 olan koli barkodu (D7 testleri için). */
  caseBarcode: string
  caseBarcodeId: string
  locationId: string
}

/**
 * İzole bir tenant kurar. Her test kendi tenant'ını yaratmalı:
 * paylaşılan fixture kullanan testler birbirinin verisini bozar ve
 * hata mesajları "neden bu sayı 47" diye anlaşılmaz hale gelir.
 *
 * Admin bağlantısı kullanır (RLS atlanır) çünkü bu kurulum, test değil.
 */
export async function createTenantFixture(label = 'test'): Promise<TenantFixture> {
  const sql = adminSql()
  const tenantId = randomUUID()
  const adminUserId = randomUUID()
  const staffUserId = randomUUID()
  const productId = randomUUID()
  const unitBarcodeId = randomUUID()
  const caseBarcodeId = randomUUID()
  const locationId = randomUUID()
  const stamp = tenantId.slice(0, 8)
  const unitBarcode = `T${stamp}U`
  const caseBarcode = `T${stamp}C`

  await sql`INSERT INTO tenants (id, name) VALUES (${tenantId}, ${`${label}-${stamp}`})`
  await sql`
    INSERT INTO users (id, tenant_id, email, name, role)
    VALUES (${adminUserId}, ${tenantId}, ${`admin-${stamp}@test.example`}, 'Test Admin', 'ADMIN'),
           (${staffUserId}, ${tenantId}, ${`staff-${stamp}@test.example`}, 'Test Çalışan', 'STAFF')`
  await sql`
    INSERT INTO locations (id, tenant_id, code, name)
    VALUES (${locationId}, ${tenantId}, 'A-01', 'A-01 Rafı')`
  await sql`
    INSERT INTO products (id, tenant_id, sku, name, unit, min_stock, location_id)
    VALUES (${productId}, ${tenantId}, ${`SKU-${stamp}`}, ${`Test Ürünü ${stamp}`}, 'ADET', 10, ${locationId})`
  await sql`
    INSERT INTO product_barcodes (id, tenant_id, product_id, barcode, kind, qty_multiplier)
    VALUES (${unitBarcodeId}, ${tenantId}, ${productId}, ${unitBarcode}, 'UNIT', 1),
           (${caseBarcodeId}, ${tenantId}, ${productId}, ${caseBarcode}, 'CASE', 12)`

  return {
    tenantId,
    adminUserId,
    staffUserId,
    productId,
    unitBarcode,
    unitBarcodeId,
    caseBarcode,
    caseBarcodeId,
    locationId,
  }
}

/**
 * Fixture'ı siler.
 *
 * DİKKAT: stock_movements üzerinde DELETE, movements_no_mutate trigger'ı
 * tarafından engelleniyor ve bu SAHİP ROL İÇİN DE geçerli (trigger yetki
 * değil, davranış kontrolü). Temizlik için trigger geçici olarak devre dışı
 * bırakılıyor.
 *
 * Bu, ledger değiştirilemezliğinin ne kadar sıkı olduğunun kanıtı: test
 * temizliği bile onu atlamak için açıkça izin istemek zorunda. Üretimde
 * bu yol hiçbir uygulama koduna açık değil (stok_app'in ALTER TABLE
 * yetkisi yok).
 */
export async function dropTenantFixture(tenantId: string): Promise<void> {
  const sql = adminSql()
  await sql`ALTER TABLE stock_movements DISABLE TRIGGER movements_no_mutate`
  try {
    await sql`DELETE FROM stock_movements WHERE tenant_id = ${tenantId}`
    await sql`DELETE FROM current_stock WHERE tenant_id = ${tenantId}`
    await sql`DELETE FROM product_barcodes WHERE tenant_id = ${tenantId}`
    await sql`DELETE FROM products WHERE tenant_id = ${tenantId}`
    await sql`DELETE FROM locations WHERE tenant_id = ${tenantId}`
    await sql`DELETE FROM users WHERE tenant_id = ${tenantId}`
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`
  } finally {
    await sql`ALTER TABLE stock_movements ENABLE TRIGGER movements_no_mutate`
  }
}

/**
 * RLS bağlamı içinde sorgu çalıştırır. Uygulamadaki withTenant()'ın
 * test karşılığı; aynı SET LOCAL mekanizmasını kullanır.
 */
export async function asTenant<T>(
  tenantId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return appSql().begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return fn(tx)
  }) as Promise<T>
}

/** Tenant bağlamı KURMADAN sorgu. Politikalar hiçbir satır geçirmemeli. */
export async function withoutTenant<T>(
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return appSql().begin(async (tx) => fn(tx)) as Promise<T>
}

/** Ledger toplamı ile projeksiyonun uyuşmadığı satır sayısı. 0 olmalı. */
export async function invariantDrift(tenantId?: string): Promise<number> {
  const sql = adminSql()
  const rows = tenantId
    ? await sql`
        SELECT count(*)::int AS cnt FROM (
          SELECT m.product_id, SUM(m.delta) AS ledger, cs.qty
            FROM stock_movements m
            JOIN current_stock cs ON cs.tenant_id=m.tenant_id AND cs.product_id=m.product_id
           WHERE m.tenant_id = ${tenantId}
           GROUP BY m.product_id, cs.qty
          HAVING SUM(m.delta) <> cs.qty) d`
    : await sql`
        SELECT count(*)::int AS cnt FROM (
          SELECT m.tenant_id, m.product_id, SUM(m.delta) AS ledger, cs.qty
            FROM stock_movements m
            JOIN current_stock cs ON cs.tenant_id=m.tenant_id AND cs.product_id=m.product_id
           GROUP BY m.tenant_id, m.product_id, cs.qty
          HAVING SUM(m.delta) <> cs.qty) d`
  return Number(rows[0]?.cnt ?? 0)
}

/** Test hareketi ekler. Trigger projeksiyonu günceller. */
export async function insertMovement(
  tx: postgres.TransactionSql | postgres.Sql,
  f: Pick<TenantFixture, 'tenantId' | 'productId' | 'adminUserId'>,
  delta: number,
  reason = 'PURCHASE',
  idempotencyKey = randomUUID(),
): Promise<void> {
  await tx`
    INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, reason, idempotency_key)
    VALUES (${f.tenantId}, ${f.productId}, ${f.adminUserId}, ${delta}, ${reason}, ${idempotencyKey})`
}
