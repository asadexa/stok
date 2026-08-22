import { AppError, type Unit, listStockSchema } from '@stok/shared'
import { type Db, currentStock, locations, products, withTenant } from '@stok/db'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import {
  type Actor,
  actorCan,
  canSeePrices,
  movementUserScope,
  requirePermission,
} from './authz.js'
import { parseScaled, scaledToNumber } from './numeric.js'
import { parseOrThrow } from './validate.js'

/**
 * ============================================================================
 * STOK TABLOSU (T19)
 *
 * TÜRKÇE ARAMA (D-4.1) bu dosyanın en önemli parçası. `lower()` +
 * `unaccent` Türkçe'de güvenilmez: `ı I i İ` dört ayrı harf ve `lower()`
 * davranışı collation'a bağlı. "ısıtıcı" arayan kullanıcı "Isıtıcı"
 * ürününü bulamayabilir — ve bulamayınca ürünün sistemde olmadığını sanıp
 * bir kopyasını daha ekler.
 *
 * Çözüm veritabanında sabitlenmiş: `tr_norm()` IMMUTABLE bir translate()
 * fonksiyonu, `products.name_norm` onun generated column'u, üstünde GIN
 * trgm index var. Sorgu da aynı fonksiyondan geçiyor, yani hangi collation
 * kurulu olursa olsun sonuç aynı ve index kullanılabilir kalıyor.
 *
 * SAYFALAMA SUNUCU TARAFINDA: 10 bin ürünü tarayıcıya gönderip orada
 * filtrelemek, depodaki zayıf bağlantıda dakikalar sürer.
 * ============================================================================
 */

export interface StockRow {
  productId: string
  sku: string
  name: string
  category: string | null
  brand: string | null
  unit: Unit
  qty: number
  minStock: number
  /** Miktar kritik eşiğin altında mı. Sunucu hesaplıyor: iki ayrı yerde
   *  hesaplanırsa tablo ile uyarı sayacı ayrışır. */
  critical: boolean
  locationCode: string | null
  lastMovementAt: Date | null
  purchasePrice?: number | null
  salePrice?: number | null
  archivedAt: Date | null
}

export interface StockPage {
  rows: StockRow[]
  /** Toplam eşleşen satır. Sayfalama arayüzü bunu gösteriyor. */
  total: number
  limit: number
  offset: number
}

export interface StockOptions {
  db?: Db
}

function whereClause(actor: Actor, q: ReturnType<typeof parseListStock>) {
  const search = q.search?.trim()
  return and(
    eq(products.tenantId, actor.tenantId),
    q.productId ? eq(products.id, q.productId) : undefined,
    q.includeArchived ? undefined : isNull(products.archivedAt),
    q.category ? eq(products.category, q.category) : undefined,
    q.onlyCritical ? sql`COALESCE(${currentStock.qty}, 0) <= ${products.minStock}` : undefined,
    // Arama HEM ada HEM stok koduna bakıyor: admin barkod okuyucuyu klavye
    // gibi kullanıyor ve okuttuğu şey çoğu zaman koddur.
    search
      ? or(
          sql`${products.nameNorm} LIKE '%' || tr_norm(${search}) || '%'`,
          sql`tr_norm(${products.sku}) LIKE '%' || tr_norm(${search}) || '%'`,
        )
      : undefined,
  )
}

function parseListStock(raw: unknown) {
  return parseOrThrow(listStockSchema, raw)
}

export async function listStock(
  actor: Actor,
  raw: unknown = {},
  options: StockOptions = {},
): Promise<StockPage> {
  requirePermission(actor, 'stock:read')
  const q = parseListStock(raw)

  return withTenant(
    actor.tenantId,
    async (tx) => {
      const stockJoin = and(
        eq(currentStock.tenantId, products.tenantId),
        eq(currentStock.productId, products.id),
      )

      const [countRow] = await tx
        .select({ n: sql<string>`count(*)::text` })
        .from(products)
        .leftJoin(currentStock, stockJoin)
        .where(whereClause(actor, q))

      const rows = await tx
        .select({
          productId: products.id,
          sku: products.sku,
          name: products.name,
          category: products.category,
          brand: products.brand,
          unit: products.unit,
          minStock: products.minStock,
          purchasePrice: products.purchasePrice,
          salePrice: products.salePrice,
          archivedAt: products.archivedAt,
          qty: currentStock.qty,
          lastMovementAt: currentStock.lastMovementAt,
          locationCode: locations.code,
        })
        .from(products)
        .leftJoin(currentStock, stockJoin)
        .leftJoin(locations, eq(locations.id, products.locationId))
        .where(whereClause(actor, q))
        // Kritik olanlar önce: patronun ekrana bakınca sorduğu ilk soru
        // "bir sorun var mı" (PLAN.md Bölüm 11).
        //
        // İkincil sıra `name` değil `name_norm`: veritabanı collation'ı
        // `C.UTF-8` (CI ve yerel container) ve orada sıralama BAYT
        // sırasına düşüyor — "Çelik" ve "Ürün", "Zeytin"den SONRA
        // geliyor. Türkçe adların çoğu böyle listenin dibine iniliyordu.
        // `name_norm` zaten `tr_norm(name)` ile üretilmiş stored generated
        // column, yani bedava ve collation'dan bağımsız.
        .orderBy(
          sql`(COALESCE(${currentStock.qty}, 0) <= ${products.minStock}) DESC`,
          asc(products.nameNorm),
        )
        .limit(q.limit)
        .offset(q.offset)

      const mapped: StockRow[] = rows.map((r) => {
        const qty = r.qty === null ? 0 : scaledToNumber(parseScaled(r.qty))
        const minStock = scaledToNumber(parseScaled(r.minStock))
        const row: StockRow = {
          productId: r.productId,
          sku: r.sku,
          name: r.name,
          category: r.category,
          brand: r.brand,
          unit: r.unit as Unit,
          qty,
          minStock,
          critical: qty <= minStock,
          locationCode: r.locationCode,
          lastMovementAt: r.lastMovementAt,
          archivedAt: r.archivedAt,
        }
        if (canSeePrices(actor.role)) {
          row.purchasePrice = r.purchasePrice === null ? null : Number(r.purchasePrice)
          row.salePrice = r.salePrice === null ? null : Number(r.salePrice)
        }
        return row
      })

      return { rows: mapped, total: Number(countRow?.n ?? 0), limit: q.limit, offset: q.offset }
    },
    options.db,
  )
}

/** Tablo başındaki kategori açılır listesi. */
export async function listCategories(
  actor: Actor,
  options: StockOptions = {},
): Promise<string[]> {
  requirePermission(actor, 'product:read')

  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .selectDistinct({ category: products.category })
        .from(products)
        .where(and(eq(products.tenantId, actor.tenantId), isNull(products.archivedAt))),
    options.db,
  )

  // Sıralama JavaScript'te, veritabanında değil. İki nedeni var:
  //
  //   1. `SELECT DISTINCT` ile `ORDER BY tr_norm(...)` yasak — sıralama
  //      ifadesi select listesinde olmalı.
  //   2. Bu liste sayfalanmıyor (açılır kutu, birkaç düzine değer), yani
  //      hepsi zaten elimizde ve `Intl` GERÇEK Türkçe sırayı biliyor:
  //      tr_norm'un ç→c indirgemesinden daha doğru (Türk alfabesinde ç,
  //      c'den sonra ayrı bir harf).
  //
  // Ürün ve kullanıcı listelerinde bu yol kapalı: onlar sayfalanıyor,
  // sıra veritabanında belirlenmek zorunda.
  const collator = new Intl.Collator('tr')
  return rows
    .map((r) => r.category)
    .filter((c): c is string => c !== null)
    .sort((a, b) => collator.compare(a, b))
}

// ---------------------------------------------------------------------------
// DASHBOARD ÖZETİ (T18)
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  /** Kritik seviyedeki ürün sayısı. Sıfırsa ekran "her şey yolunda" diyor. */
  criticalCount: number
  /**
   * Bugünün giriş/çıkış özeti. ÇALIŞAN İÇİN SADECE KENDİ HAREKETLERİ:
   * rol matrisinde "hareket geçmişi (tüm kullanıcılar)" admin yetkisi.
   * Toplamı herkese göstermek, listeyi kısıtlayıp özeti kısıtlamamak
   * olurdu — çalışan gün boyu kaç satış yapıldığını sayı üzerinden
   * yine öğrenirdi.
   */
  today: {
    inCount: number
    inQty: number
    outCount: number
    outQty: number
  }
  /**
   * Kalıcı olarak başarısız arka plan işi sayısı (G4 uyarısı).
   *
   * Yetkisi olmayan role alan HİÇ KONULMUYOR — fiyat alanlarındaki
   * kalıbın aynısı (bkz. redactPrices). `0` döndürmek "hata yok" demek
   * olurdu ve bu yanlış: doğrusu "bu kullanıcı bilmiyor".
   */
  failedJobCount?: number
}

/**
 * Dashboard'un üst iki şeridi. Tek sorguda değil üç sorguda: her biri farklı
 * index kullanıyor ve tek sorguya sıkıştırmak planı bozup üçünü de
 * yavaşlatırdı.
 *
 * `since` dışarıdan veriliyor çünkü "bugün" kullanıcının saat diliminde
 * başlıyor, sunucununkinde değil.
 */
export async function dashboardSummary(
  actor: Actor,
  since: Date,
  options: StockOptions = {},
): Promise<DashboardSummary> {
  requirePermission(actor, 'stock:read')
  // Hareket özeti hareket listesiyle AYNI kapsam fonksiyonundan geçiyor.
  // İkisi ayrı yazılsaydı biri kısıtlanır diğeri unutulurdu.
  const scopedUserId = movementUserScope(actor)
  // Arka plan işleri yönetim işi: kuyruğu görebilen, kullanıcıyı da yönetir.
  const seesJobs = actorCan(actor, 'user:manage')

  return withTenant(
    actor.tenantId,
    async (tx) => {
      const [critical] = await tx
        .select({ n: sql<string>`count(*)::text` })
        .from(products)
        .leftJoin(
          currentStock,
          and(
            eq(currentStock.tenantId, products.tenantId),
            eq(currentStock.productId, products.id),
          ),
        )
        .where(
          and(
            eq(products.tenantId, actor.tenantId),
            isNull(products.archivedAt),
            sql`COALESCE(${currentStock.qty}, 0) <= ${products.minStock}`,
          ),
        )

      const movementRows = await tx.execute<{
        direction: string
        n: string
        total: string
      }>(sql`
        SELECT CASE WHEN delta > 0 THEN 'IN' ELSE 'OUT' END AS direction,
               count(*)::text                               AS n,
               SUM(abs(delta))::text                        AS total
          FROM stock_movements
         WHERE created_at >= ${since.toISOString()}::timestamptz
           ${scopedUserId ? sql`AND user_id = ${scopedUserId}` : sql``}
         GROUP BY 1
      `)

      const byDirection = new Map(
        [...movementRows].map((r) => [r.direction, { n: Number(r.n), total: Number(r.total) }]),
      )

      const failedJobCount = seesJobs
        ? Number(
            (
              await tx.execute<{ n: string }>(sql`
                SELECT count(*)::text AS n FROM background_jobs WHERE status = 'FAILED'
              `)
            )[0]?.n ?? 0,
          )
        : undefined

      const summary: DashboardSummary = {
        criticalCount: Number(critical?.n ?? 0),
        today: {
          inCount: byDirection.get('IN')?.n ?? 0,
          inQty: byDirection.get('IN')?.total ?? 0,
          outCount: byDirection.get('OUT')?.n ?? 0,
          outQty: byDirection.get('OUT')?.total ?? 0,
        },
      }
      if (failedJobCount !== undefined) summary.failedJobCount = failedJobCount
      return summary
    },
    options.db,
  )
}

/** Ürünü kimliğiyle getirir. Detay ekranı ve hareket filtresi için. */
export async function getProduct(
  actor: Actor,
  productId: string,
  options: StockOptions = {},
): Promise<StockRow> {
  // Arşivli de dönüyor: ürün detayı "bu ürün arşivde" diyebilmeli,
  // "bulunamadı" dememeli — ikisi kullanıcı için farklı durumlar.
  const page = await listStock(
    actor,
    { productId, includeArchived: true, limit: 1 },
    options,
  )
  const row = page.rows[0]
  if (!row) throw new AppError('NOT_FOUND', `product ${productId} not found`, { productId })
  return row
}
