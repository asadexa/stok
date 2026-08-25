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
// UYARI ÖZETİ (T80)
// ---------------------------------------------------------------------------

export interface AlertSummary {
  criticalCount: number
  /** `user:manage` yoksa alan HİÇ KONULMUYOR — kuyruk yönetim işi. */
  failedJobCount?: number
}

/**
 * Bildirim zilinin sayısı. HER SAYFADA çalışıyor, o yüzden mümkün olduğunca
 * ince tutuldu: iki sayım sorgusu, satır döndürmüyor.
 *
 * `dashboardSummary` ile ÇAKIŞIYOR gibi görünüyor ama ayrı olması gerekiyor:
 * o fonksiyon kategori dağılımı, 14 günlük hacim ve stok değeri de
 * hesaplıyor. Zil için onu çağırmak, her sayfa geçişinde panelin bütün
 * sorgularını koşturmak olurdu.
 *
 * Kritik sayımı `listStock(onlyCritical)` ve `dashboardSummary` ile AYNI
 * karşılaştırmayı kullanıyor (`COALESCE(qty,0) <= min_stock`). Üçü ayrı
 * yazılsaydı zil "3" derken tablo iki satır gösterebilirdi.
 */
export async function alertSummary(
  actor: Actor,
  options: StockOptions = {},
): Promise<AlertSummary> {
  requirePermission(actor, 'stock:read')
  const seesJobs = actorCan(actor, 'user:manage')

  return withTenant(
    actor.tenantId,
    async (tx) => {
      const [critical] = await tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n
          FROM products p
          LEFT JOIN current_stock cs
                 ON cs.tenant_id = p.tenant_id AND cs.product_id = p.id
         WHERE p.archived_at IS NULL
           AND COALESCE(cs.qty, 0) <= p.min_stock
      `)

      const summary: AlertSummary = { criticalCount: Number(critical?.n ?? 0) }

      if (seesJobs) {
        const [jobs] = await tx.execute<{ n: string }>(sql`
          SELECT count(*)::text AS n FROM background_jobs WHERE status = 'FAILED'
        `)
        summary.failedJobCount = Number(jobs?.n ?? 0)
      }

      return summary
    },
    options.db,
  )
}

// ---------------------------------------------------------------------------
// KATEGORİ ÖZETİ (T73)
// ---------------------------------------------------------------------------

export interface CategoryRow {
  /** Kategorisiz ürünler 'Kategorisiz' altında toplanıyor. */
  name: string
  /** Filtre bağlantısında kullanılan ham değer. Kategorisiz için null. */
  value: string | null
  productCount: number
  criticalCount: number
  totalQty: number
  /** `price:read` yoksa alan HİÇ KONULMUYOR (dashboardSummary ile aynı kalıp). */
  stockValue?: number
}

/**
 * Kategori kırılımı: ürün sayısı, kritik sayısı, toplam adet ve değer.
 *
 * KATEGORİ AYRI BİR TABLO DEĞİL, `products.category` serbest metin. Bu bir
 * eksiklik değil bilinçli: kategori bu üründe bir varlık değil bir etiket;
 * ayrı tablo kurmak her ürün eklemede ikinci bir kayıt ve yabancı anahtar
 * yönetimi getirirdi. Karşılığı şu: "Kalem" ile "kalem" iki ayrı kategori
 * görünür. Normalizasyon burada YAPILMIYOR çünkü kullanıcının yazdığı şeyi
 * sessizce değiştirmek, veriyi düzeltiyor gibi görünüp gizli bir eşleme
 * kuralı yaratır. Bunun yerine liste olduğu gibi gösteriliyor ve fark
 * gözle görülüyor.
 */
export async function categorySummary(
  actor: Actor,
  options: StockOptions = {},
): Promise<CategoryRow[]> {
  requirePermission(actor, 'stock:read')
  const seesPrices = actorCan(actor, 'price:read')

  return withTenant(
    actor.tenantId,
    async (tx) => {
      const rows = await tx.execute<{
        value: string | null
        products: string
        critical: string
        qty: string
        value_sum: string | null
      }>(sql`
        SELECT NULLIF(btrim(p.category), '')                          AS value,
               count(*)::text                                          AS products,
               count(*) FILTER (
                 WHERE COALESCE(cs.qty, 0) <= p.min_stock
               )::text                                                 AS critical,
               COALESCE(SUM(COALESCE(cs.qty, 0)), 0)::text             AS qty,
               COALESCE(SUM(COALESCE(cs.qty, 0) * COALESCE(p.purchase_price, 0)), 0)::text
                                                                       AS value_sum
          FROM products p
          LEFT JOIN current_stock cs
                 ON cs.tenant_id = p.tenant_id AND cs.product_id = p.id
         WHERE p.archived_at IS NULL
         GROUP BY 1
         ORDER BY count(*) DESC, 1 NULLS LAST
      `)

      return [...rows].map((r) => {
        const row: CategoryRow = {
          name: r.value ?? 'Kategorisiz',
          value: r.value,
          productCount: Number(r.products),
          criticalCount: Number(r.critical),
          totalQty: Number(r.qty),
        }
        if (seesPrices) row.stockValue = Number(r.value_sum ?? 0)
        return row
      })
    },
    options.db,
  )
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

  /** Arşivlenmemiş ürün sayısı. */
  productCount: number

  /** Stoğu sıfırdan büyük olan ürün sayısı. */
  inStockCount: number

  /**
   * Stoktaki toplam değer (adet × alış fiyatı).
   *
   * `price:read` yetkisi yoksa alan HİÇ KONULMUYOR — `failedJobCount` ve
   * `redactPrices` ile aynı kalıp. `0` döndürmek "stok değersiz" demek
   * olurdu ve bu yanlış: doğrusu "bu kullanıcı bilmiyor".
   *
   * BUGÜNÜN değeri, geçmişin değil. Geçmişe dönük stok değeri bir maliyet
   * yöntemi kararı gerektiriyor (PLAN.md ÇÖZÜLMEMİŞ KARAR U2: ağırlıklı
   * ortalama mı FIFO mu) ve o karar verilmeden hesaplanan her sayı yanlış
   * olur. Bu yüzden panelde değerin ZAMAN SERİSİ yok.
   */
  stockValue?: number

  /**
   * Kategori dağılımı, çoktan aza. Beşten fazlası "Diğer"de toplanıyor:
   * halkada altı dilimden sonrası okunmuyor ve lejant ekranı yiyor.
   */
  categories: { name: string; count: number }[]

  /**
   * Son 14 günün günlük hareket hacmi. Grafiğin veri kaynağı.
   *
   * NEDEN HACİM, NEDEN DEĞER DEĞİL: referans görselde aylık stok değeri
   * grafiği var ama o seri U2 kararına bağlı (yukarı bkz.). Hareket hacmi
   * bugün hesaplanabiliyor, `stock_movements.created_at` üstünde index
   * var ve pencere 14 günle sınırlı. Ayrıca gerçek bir soruya cevap
   * veriyor: "bugün olağandışı bir şey oldu mu?"
   *
   * Çalışan için SADECE KENDİ hareketleri — `today` ile aynı kapsam.
   */
  activity: { day: string; inQty: number; outQty: number }[]
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

      // Ürün sayacı ve stoktaki değer TEK sorguda: ikisi de aynı iki tabloyu
      // aynı şekilde birleştiriyor, ayırmak planı iki kez kurdururdu.
      //
      // Tenant süzmesi RLS'ten geliyor (withTenant `app.tenant_id` ayarını
      // kuruyor); movements sorgusundaki kalıbın aynısı.
      const [counts] = await tx.execute<{
        products: string
        in_stock: string
        value: string | null
      }>(sql`
        SELECT count(*)::text                                        AS products,
               count(*) FILTER (WHERE COALESCE(cs.qty, 0) > 0)::text AS in_stock,
               SUM(COALESCE(cs.qty, 0) * COALESCE(p.purchase_price, 0))::text AS value
          FROM products p
          LEFT JOIN current_stock cs
                 ON cs.tenant_id = p.tenant_id AND cs.product_id = p.id
         WHERE p.archived_at IS NULL
      `)

      const categoryRows = await tx.execute<{ name: string; n: string }>(sql`
        SELECT COALESCE(NULLIF(btrim(category), ''), 'Kategorisiz') AS name,
               count(*)::text                                       AS n
          FROM products
         WHERE archived_at IS NULL
         GROUP BY 1
         ORDER BY count(*) DESC, 1
      `)

      // İlk beş kategori ayrı, kalanı tek "Diğer" diliminde. Bölme
      // VERİTABANINDA değil burada: `LIMIT 5` kalanların toplamını
      // kaybettirirdi ve yüzdeler %100'e tamamlanmazdı.
      const allCategories = [...categoryRows].map((r) => ({
        name: r.name,
        count: Number(r.n),
      }))
      const categories = allCategories.slice(0, 5)
      const restTotal = allCategories.slice(5).reduce((sum, c) => sum + c.count, 0)
      if (restTotal > 0) categories.push({ name: 'Diğer', count: restTotal })

      // Son 14 gün. `generate_series` ile HAREKETSİZ GÜNLER DE geliyor:
      // eksik günü grafikte atlamak, iki gün arasındaki boşluğu düz bir
      // çizgi gibi gösterip "o gün de iş vardı" yalanını söylerdi.
      const activityRows = await tx.execute<{
        day: string
        in_qty: string
        out_qty: string
      }>(sql`
        WITH gunler AS (
          SELECT generate_series(
                   date_trunc('day', now()) - interval '13 days',
                   date_trunc('day', now()),
                   interval '1 day'
                 ) AS day
        )
        SELECT to_char(g.day, 'YYYY-MM-DD') AS day,
               COALESCE(SUM(m.delta) FILTER (WHERE m.delta > 0), 0)::text  AS in_qty,
               COALESCE(-SUM(m.delta) FILTER (WHERE m.delta < 0), 0)::text AS out_qty
          FROM gunler g
          LEFT JOIN stock_movements m
                 ON m.created_at >= g.day
                AND m.created_at <  g.day + interval '1 day'
                ${scopedUserId ? sql`AND m.user_id = ${scopedUserId}` : sql``}
         GROUP BY g.day
         ORDER BY g.day
      `)

      const summary: DashboardSummary = {
        criticalCount: Number(critical?.n ?? 0),
        today: {
          inCount: byDirection.get('IN')?.n ?? 0,
          inQty: byDirection.get('IN')?.total ?? 0,
          outCount: byDirection.get('OUT')?.n ?? 0,
          outQty: byDirection.get('OUT')?.total ?? 0,
        },
        productCount: Number(counts?.products ?? 0),
        inStockCount: Number(counts?.in_stock ?? 0),
        categories,
        activity: [...activityRows].map((r) => ({
          day: r.day,
          inQty: Number(r.in_qty),
          outQty: Number(r.out_qty),
        })),
      }
      if (failedJobCount !== undefined) summary.failedJobCount = failedJobCount
      // Fiyat yetkisi yoksa alan hiç konulmuyor (bkz. tip yorumu).
      if (actorCan(actor, 'price:read')) summary.stockValue = Number(counts?.value ?? 0)
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
