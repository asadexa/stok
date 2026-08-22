import { reasonsCheckConstraint, rolesCheckConstraint, unitsCheckConstraint } from '@stok/shared'
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * ============================================================================
 * VERİ MODELİ
 *
 * Temel ilke: STOK BİR SAYI DEĞİL, BİR SONUÇTUR.
 *
 *   stock_movements   append-only, GERÇEĞİN KAYNAĞI, UPDATE/DELETE yasak
 *          │
 *          │ AFTER INSERT trigger
 *          ▼
 *   current_stock     türetilmiş projeksiyon, sorgu hızı için var
 *
 * Bu ayrım üç şeyi birden çözüyor:
 *   1. Eşzamanlılık: iki çalışan aynı anda okutunca kayıp olmaz
 *   2. Düzeltilebilirlik: hata olunca geriye dönülür, ters hareket yazılır
 *   3. "Log Kayıtları" özelliği ayrıca yazılmaz, veri modelinin kendisidir
 *
 * Invariant (T11 testi bunu doğrular):
 *   SUM(stock_movements.delta) == current_stock.qty   her (tenant, ürün) için
 *
 * Bu invariant bozulursa sistem yalan söylüyor demektir ve kırmızı alarm.
 * ============================================================================
 */

const pk = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

/** Miktar: NUMERIC(14,3). INTEGER DEĞİL. kg/metre/litre satan müşteri geldiğinde
 *  migration yazmamak için. Bugün maliyeti sıfır. */
const qtyCol = (name: string) => numeric(name, { precision: 14, scale: 3 })

/** Para: NUMERIC(12,2). Asla float. */
const moneyCol = (name: string) => numeric(name, { precision: 12, scale: 2 })

// ---------------------------------------------------------------------------

export const tenants = pgTable('tenants', {
  id: pk(),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const users = pgTable(
  'users',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    passwordHash: text('password_hash'),
    /** PIN ile hızlı kullanıcı geçişi (E10). Paylaşılan telefonda
     *  "kim yaptı" bunsuz yalan söyler. */
    pinHash: text('pin_hash'),
    active: boolean('active').notNull().default(true),
    /**
     * Uzaktan oturum kapatma (tehdit S5). Bu sayı artınca kullanıcının
     * dağıtılmış TÜM refresh token'ları geçersiz olur: çalınan telefon,
     * işten ayrılan çalışan, parola değişikliği.
     *
     * Access token kısa ömürlü ve imzadan doğrulanıyor (her istekte
     * veritabanına gitmemek için); yani iptal en fazla access token
     * ömrü kadar (15 dk) gecikmeli etki eder. Bilinçli takas.
     */
    tokenVersion: integer('token_version').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_tenant_email_uq').on(t.tenantId, t.email),
    index('users_tenant_idx').on(t.tenantId),
    check('users_role_ck', sql.raw(rolesCheckConstraint('role'))),
  ],
)

export const locations = pgTable(
  'locations',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('locations_tenant_code_uq').on(t.tenantId, t.code)],
)

export const products = pgTable(
  'products',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    /**
     * Türkçe arama normalizasyonu (D-4.1).
     * unaccent + lower() Türkçe'de collation'a bağlı davranıyor:
     * "ısıtıcı" arayan "Isıtıcı" ürününü bulamayabiliyor. tr_norm()
     * translate() tabanlı, tamamen deterministik, IMMUTABLE.
     * GIN trgm index bu kolona kurulu.
     */
    nameNorm: text('name_norm').generatedAlwaysAs(sql`tr_norm(name)`),
    category: text('category'),
    brand: text('brand'),
    unit: text('unit').notNull().default('ADET'),
    purchasePrice: moneyCol('purchase_price'),
    salePrice: moneyCol('sale_price'),
    /** Kritik stok eşiği. Altına düşünce uyarı ve push bildirim. */
    minStock: qtyCol('min_stock').notNull().default('0'),
    locationId: uuid('location_id').references(() => locations.id),
    /**
     * Arşivleme. SİLME YOK: hareketi olan ürün silinirse log çöker ve
     * "kim ne yaptı" ekranı hiçbir şey ispat edemez. Arayüzde de
     * "Sil" değil "Arşivle" yazar; kullanıcıyı kandırmak da bir hatadır.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('products_tenant_sku_uq').on(t.tenantId, t.sku),
    index('products_tenant_idx').on(t.tenantId),
    check('products_unit_ck', sql.raw(unitsCheckConstraint('unit'))),
    check('products_min_stock_ck', sql`min_stock >= 0`),
  ],
)

export const productBarcodes = pgTable(
  'product_barcodes',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    barcode: text('barcode').notNull(),
    /** UNIT | CASE | EAN | INTERNAL */
    kind: text('kind').notNull().default('UNIT'),
    /**
     * D7: koli barkodu okutulunca stok kaç birim artıyor.
     * Bu sütun olmasaydı 12'li koliden 5 koli girildiğinde sistem 5 yazardı,
     * gerçekte 60 adet olurdu ve sayı makul göründüğü için kimse fark etmezdi.
     * CHECK: koli barkodunun çarpanı 1 olamaz.
     */
    qtyMultiplier: qtyCol('qty_multiplier').notNull().default('1'),
    createdAt: createdAt(),
  },
  (t) => [
    // Bir barkod tenant içinde tek bir ürüne ait olabilir.
    uniqueIndex('barcodes_tenant_barcode_uq').on(t.tenantId, t.barcode),
    index('barcodes_product_idx').on(t.productId),
    check('barcodes_kind_ck', sql`kind IN ('UNIT', 'CASE', 'EAN', 'INTERNAL')`),
    check('barcodes_multiplier_ck', sql`qty_multiplier > 0`),
    check('barcodes_case_multiplier_ck', sql`kind <> 'CASE' OR qty_multiplier > 1`),
  ],
)

/**
 * ============================================================================
 * LEDGER. Gerçeğin kaynağı.
 *
 * Bu tabloda UPDATE ve DELETE YASAKTIR. İki katmanlı zorlama (migration'da):
 *   1. REVOKE UPDATE, DELETE ... FROM stok_app
 *   2. BEFORE UPDATE OR DELETE trigger → exception
 *
 * Admin bile logu değiştiremez. Değiştirebilseydi "kim ne yaptı" ekranı
 * hiçbir şey ispat etmezdi ve ürünün ana değer önerisi çökerdi.
 *
 * Düzeltme = silme değil, TERS HAREKET yazma (reverses_id ile bağlı).
 * ============================================================================
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Hangi barkod okutuldu. Koli mi birim mi, geriye dönük denetlenebilsin. */
    barcodeId: uuid('barcode_id').references(() => productBarcodes.id),
    /**
     * İşaretli miktar. + giriş, - çıkış.
     * İşaret KULLANICIDAN DEĞİL, reason'dan türetilir (shared/reasons.ts).
     * Kullanıcı her zaman pozitif girer. Bu, "-5 girmek isterken 5 girdi"
     * hatasını yapısal olarak imkansız kılar.
     * Koli çarpanı UYGULANMIŞ haldedir.
     */
    delta: qtyCol('delta').notNull(),
    reason: text('reason').notNull(),
    note: text('note'),
    locationId: uuid('location_id').references(() => locations.id),
    /** Girişte alış fiyatı. Maliyet takibi (Faz 2) bu veriyi bugünden topluyor,
     *  böylece özellik açıldığında geçmiş veri hazır olur. */
    unitCost: moneyCol('unit_cost'),
    /**
     * Çift kayıt koruması. İstemcide BARKOD OKUTMA ANINDA üretilir,
     * gönderim anında değil (D-1.3): gönderimde üretilseydi uygulama
     * yeniden başladıktan sonraki tekrar denemede yeni anahtar oluşur ve
     * tam olarak önlenmek istenen çift kayıt meydana gelirdi.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    /** Sayım oturumu (TODOS E2). Tablo henüz yok (D4), bu yüzden FK yok.
     *  Sütun bugün duruyor ki özellik gelince geriye dönük bağlanabilsin. */
    countSessionId: uuid('count_session_id'),
    /** Bu hareket bir düzeltme ise, hangi hareketi ters çeviriyor. */
    reversesId: uuid('reverses_id').references((): AnyPgColumn => stockMovements.id),
    createdAt: createdAt(),
    /** Cihaz saati. Sunucu saatinden AYRI saklanır: telefon saati yanlış
     *  olabilir, sıralama her zaman created_at ile yapılır. */
    clientCreatedAt: timestamp('client_created_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('movements_tenant_idem_uq').on(t.tenantId, t.idempotencyKey),
    index('movements_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
    index('movements_tenant_product_created_idx').on(
      t.tenantId,
      t.productId,
      t.createdAt.desc(),
    ),
    index('movements_tenant_user_created_idx').on(t.tenantId, t.userId, t.createdAt.desc()),
    check('movements_reason_ck', sql.raw(reasonsCheckConstraint('reason'))),
    // Hiçbir şeyi değiştirmeyen hareket olmamalı: ya veri hatası ya da hata ayıklama artığı.
    check('movements_delta_nonzero_ck', sql`delta <> 0`),
  ],
)

/**
 * PROJEKSİYON. Türetilmiş veri, gerçeğin kaynağı DEĞİL.
 *
 * Gerçek tablo, materialized view değil: PostgreSQL'de materialized view
 * artımlı güncellenmez, her harekette tam REFRESH gerektirir ve bu iş
 * yükünde kabul edilemez.
 *
 * stock_movements üzerindeki AFTER INSERT trigger ile bakımlı. Trigger
 * tercih edildi çünkü invariant, hareketi KİMİN yazdığından bağımsız
 * korunmalı: psql'den elle atılan bir INSERT bile projeksiyonu günceller.
 */
export const currentStock = pgTable(
  'current_stock',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    qty: qtyCol('qty').notNull().default('0'),
    lastMovementAt: timestamp('last_movement_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.productId] }),
    // Kritik stok taraması: min_stock ile karşılaştırma için ürün join'i gerekiyor,
    // bu index tenant içi tam taramayı hızlandırıyor.
    index('current_stock_tenant_idx').on(t.tenantId),
  ],
)

export const schema = {
  tenants,
  users,
  locations,
  products,
  productBarcodes,
  stockMovements,
  currentStock,
}
