import {
  AppError,
  type AddBarcodeInput,
  type BarcodeKind,
  addBarcodeSchema,
  createProductSchema,
  updateProductSchema,
} from '@stok/shared'
import {
  type Db,
  type Tx,
  isUniqueViolation,
  locations,
  pgConstraint,
  productBarcodes,
  products,
  withTenant,
} from '@stok/db'
import { and, asc, eq, sql } from 'drizzle-orm'
import { type Actor, requirePermission } from './authz'
import { formatScaled, parseScaled, scaledFromNumber, scaledToNumber } from './numeric'
import { getProduct, type StockRow } from './stock'
import { parseOrThrow } from './validate'

/**
 * ============================================================================
 * T21 — ÜRÜN TANIMI VE ÇOKLU BARKOD
 *
 * SİLME YOK, ARŞİVLEME VAR. Hem ürün hem barkod için ve iki ayrı sebeple:
 *
 *   ürün   → hareketi olan bir ürün silinirse denetim logu "kim ne yaptı"
 *            sorusuna cevap veremez; ekran boş satırlar gösterir.
 *   barkod → stock_movements.barcode_id bu satıra FK ile bağlı, gerçek
 *            DELETE 23503 ile patlar (bkz. migration 0007).
 *
 * ÇAKIŞMA HATALARI SQLSTATE'DEN OKUNUYOR, önden SELECT ile değil. Önden
 * kontrol yarış durumunu kapatmaz: iki admin aynı anda aynı stok koduyla
 * kaydederse ikisi de "boşta" görür, ikisi de INSERT eder, biri 500 alır.
 * Unique index zaten atomik; tek doğru yer o.
 *
 * FİYAT ALANLARI BU DOSYADA GİZLENMİYOR. Ürün yazma yetkisi (`product:*`)
 * zaten sadece admin'de ve fiyat da sadece admin'de; ikisi aynı role
 * bağlı olduğu için ayrıca `redactPrices` çağırmak ölü kod olurdu.
 * Okuma yolu (listStock/getProduct) gizlemeyi kendisi yapıyor.
 * ============================================================================
 */

export interface ProductOptions {
  db?: Db
}

export interface BarcodeRow {
  id: string
  barcode: string
  kind: BarcodeKind
  /** Okutulunca miktarın çarpılacağı sayı. Koli dışında her zaman 1 (D7). */
  qtyMultiplier: number
  archivedAt: Date | null
  createdAt: Date
}

export interface ProductDetail extends StockRow {
  barcodes: BarcodeRow[]
}

// ---------------------------------------------------------------------------
// OKUMA
// ---------------------------------------------------------------------------

/**
 * Ürünün barkodları.
 *
 * Arşivlenmişler de dönüyor: düzenleme ekranı "bu barkod kaldırıldı"
 * diyebilmeli. Sadece aktifleri döndürseydik, kullanıcı arşivlediği bir
 * barkodu yeniden eklemeye çalışıp anlamsız bir çakışma hatası alırdı.
 */
export async function listBarcodes(
  actor: Actor,
  productId: string,
  options: ProductOptions = {},
): Promise<BarcodeRow[]> {
  requirePermission(actor, 'product:read')

  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .select({
          id: productBarcodes.id,
          barcode: productBarcodes.barcode,
          kind: productBarcodes.kind,
          qtyMultiplier: productBarcodes.qtyMultiplier,
          archivedAt: productBarcodes.archivedAt,
          createdAt: productBarcodes.createdAt,
        })
        .from(productBarcodes)
        .where(
          and(
            eq(productBarcodes.tenantId, actor.tenantId),
            eq(productBarcodes.productId, productId),
          ),
        )
        // Aktifler önce, sonra eskiden yeniye.
        .orderBy(
          sql`(${productBarcodes.archivedAt} IS NOT NULL)`,
          asc(productBarcodes.createdAt),
        ),
    options.db,
  )

  return rows.map((r) => ({
    id: r.id,
    barcode: r.barcode,
    kind: r.kind as BarcodeKind,
    qtyMultiplier: scaledToNumber(parseScaled(r.qtyMultiplier)),
    archivedAt: r.archivedAt,
    createdAt: r.createdAt,
  }))
}

/** Düzenleme ekranının tek sorgusu: ürün + stok + barkodlar. */
export async function getProductDetail(
  actor: Actor,
  productId: string,
  options: ProductOptions = {},
): Promise<ProductDetail> {
  const [row, barcodes] = await Promise.all([
    getProduct(actor, productId, options),
    listBarcodes(actor, productId, options),
  ])
  return { ...row, barcodes }
}

export interface LocationRow {
  id: string
  code: string
  name: string
}

/** Ürün formundaki konum açılır listesi. */
export async function listLocations(
  actor: Actor,
  options: ProductOptions = {},
): Promise<LocationRow[]> {
  requirePermission(actor, 'product:read')

  return withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .select({ id: locations.id, code: locations.code, name: locations.name })
        .from(locations)
        .where(eq(locations.tenantId, actor.tenantId))
        // Raf kodu Türkçe harf içerebiliyor ("Çelik Raf"); sıralama
        // `tr_norm` üzerinden, veritabanı collation'ı C.UTF-8 olduğu için
        // ham ORDER BY listeyi bozardı.
        .orderBy(sql`tr_norm(${locations.code})`),
    options.db,
  )
}

// ---------------------------------------------------------------------------
// YAZMA
// ---------------------------------------------------------------------------

export async function createProduct(
  actor: Actor,
  raw: unknown,
  options: ProductOptions = {},
): Promise<ProductDetail> {
  requirePermission(actor, 'product:create')
  // Barkodsuz ürün okutulamaz, yani şema en az bir barkod istiyor. O da
  // ayrı bir yetki: ikisini de arıyoruz, yoksa `product:create` verilmiş
  // ama `barcode:create` verilmemiş bir rol yarım ürün yaratırdı.
  requirePermission(actor, 'barcode:create')

  const input = parseOrThrow(createProductSchema, raw)

  const productId = await withTenant(
    actor.tenantId,
    async (tx) => {
      if (input.locationId) await assertLocation(tx, actor.tenantId, input.locationId)

      const [inserted] = await tx
        .insert(products)
        .values({
          tenantId: actor.tenantId,
          sku: input.sku,
          name: input.name,
          unit: input.unit,
          category: input.category ?? null,
          brand: input.brand ?? null,
          imageUrl: input.imageUrl ?? null,
          purchasePrice: money(input.purchasePrice),
          salePrice: money(input.salePrice),
          minStock: qty(input.minStock),
          locationId: input.locationId ?? null,
        })
        .returning({ id: products.id })
        .catch((err: unknown) => {
          throw translateProductConflict(err, { sku: input.sku })
        })

      const id = inserted!.id

      await tx
        .insert(productBarcodes)
        .values(
          input.barcodes.map((b) => ({
            tenantId: actor.tenantId,
            productId: id,
            barcode: b.barcode,
            kind: b.kind,
            qtyMultiplier: qty(b.qtyMultiplier),
          })),
        )
        .catch((err: unknown) => {
          // Tek INSERT: barkodlardan biri çakışırsa ÜRÜN DE yazılmıyor.
          // Ayrı transaction'larda olsaydı barkodsuz bir ürün kalırdı ve
          // o ürün depoda hiçbir zaman okutulamazdı.
          throw translateBarcodeConflict(err, input.barcodes.map((b) => b.barcode))
        })

      return id
    },
    options.db,
  )

  return getProductDetail(actor, productId, options)
}

export async function updateProduct(
  actor: Actor,
  productId: string,
  raw: unknown,
  options: ProductOptions = {},
): Promise<ProductDetail> {
  requirePermission(actor, 'product:update')
  const input = parseOrThrow(updateProductSchema, raw)

  // `undefined` = dokunma, `null` = temizle. Şema ikisini ayırıyor, burada
  // da ayrı kalmalı: `input.category ?? null` yazsaydık gönderilmeyen bir
  // alan sessizce silinirdi.
  const patch: Record<string, unknown> = {}
  if ('sku' in input) patch.sku = input.sku
  if ('name' in input) patch.name = input.name
  if ('unit' in input) patch.unit = input.unit
  if ('category' in input) patch.category = input.category
  if ('brand' in input) patch.brand = input.brand
  if ('imageUrl' in input) patch.imageUrl = input.imageUrl
  if ('purchasePrice' in input) patch.purchasePrice = money(input.purchasePrice)
  if ('salePrice' in input) patch.salePrice = money(input.salePrice)
  if ('minStock' in input) patch.minStock = qty(input.minStock)
  if ('locationId' in input) patch.locationId = input.locationId

  if (Object.keys(patch).length === 0) return getProductDetail(actor, productId, options)

  await withTenant(
    actor.tenantId,
    async (tx) => {
      if (typeof patch.locationId === 'string') {
        await assertLocation(tx, actor.tenantId, patch.locationId)
      }

      const updated = await tx
        .update(products)
        .set(patch)
        .where(and(eq(products.tenantId, actor.tenantId), eq(products.id, productId)))
        .returning({ id: products.id })
        .catch((err: unknown) => {
          throw translateProductConflict(err, { sku: String(patch.sku ?? '') })
        })

      if (updated.length === 0) {
        throw new AppError('NOT_FOUND', `product ${productId} not found`, { productId })
      }
    },
    options.db,
  )

  return getProductDetail(actor, productId, options)
}

/**
 * Arşivleme. Stoğu olan ürün de arşivlenebiliyor.
 *
 * Engellenseydi "artık satmıyoruz ama depoda 3 tane kaldı" durumundaki
 * ürünü listeden çıkarmanın tek yolu sahte bir çıkış hareketi yazmak
 * olurdu — yani defteri kirletmek. Arşivli ürün stok tablosunda "arşiv
 * dahil" filtresiyle görünmeye devam ediyor, sayısı kaybolmuyor.
 */
export async function archiveProduct(
  actor: Actor,
  productId: string,
  options: ProductOptions = {},
): Promise<ProductDetail> {
  return setArchived(actor, productId, new Date(), options)
}

/** Arşivden çıkarma. Yanlışlıkla arşivlemek geri alınabilir olmalı. */
export async function restoreProduct(
  actor: Actor,
  productId: string,
  options: ProductOptions = {},
): Promise<ProductDetail> {
  return setArchived(actor, productId, null, options)
}

async function setArchived(
  actor: Actor,
  productId: string,
  at: Date | null,
  options: ProductOptions,
): Promise<ProductDetail> {
  requirePermission(actor, 'product:archive')

  await withTenant(
    actor.tenantId,
    async (tx) => {
      const rows = await tx
        .update(products)
        .set({ archivedAt: at })
        .where(and(eq(products.tenantId, actor.tenantId), eq(products.id, productId)))
        .returning({ id: products.id })

      if (rows.length === 0) {
        throw new AppError('NOT_FOUND', `product ${productId} not found`, { productId })
      }
    },
    options.db,
  )

  return getProductDetail(actor, productId, options)
}

// ---------------------------------------------------------------------------
// BARKOD YÖNETİMİ
// ---------------------------------------------------------------------------

/**
 * Ürüne barkod ekler.
 *
 * Yetki `barcode:create`: yanlış barkod eşlemesi SESSİZ bir stok hatası
 * üretir — okutan kişi doğru ürünü okuttuğunu sanır, sayı başka üründen
 * düşer ve fark ancak sayımda ortaya çıkar. Bu yüzden çalışanda yok.
 */
export async function addBarcode(
  actor: Actor,
  productId: string,
  raw: unknown,
  options: ProductOptions = {},
): Promise<BarcodeRow[]> {
  requirePermission(actor, 'barcode:create')
  const input: AddBarcodeInput = parseOrThrow(addBarcodeSchema, raw)

  await withTenant(
    actor.tenantId,
    async (tx) => {
      await assertProductExists(tx, actor.tenantId, productId)

      await tx
        .insert(productBarcodes)
        .values({
          tenantId: actor.tenantId,
          productId,
          barcode: input.barcode,
          kind: input.kind,
          qtyMultiplier: qty(input.qtyMultiplier),
        })
        .catch((err: unknown) => {
          throw translateBarcodeConflict(err, [input.barcode])
        })
    },
    options.db,
  )

  return listBarcodes(actor, productId, options)
}

/**
 * Barkodu kaldırır — arşivleyerek.
 *
 * SON AKTİF BARKOD KALDIRILAMAZ. Barkodsuz ürün depoda okutulamaz, yani
 * pratikte yok olur; kullanıcı bunu ancak eline terminali alıp raf başında
 * fark eder. Önce yenisini eklemek zorunda.
 *
 * Geçmiş etkilenmiyor: hareketler `barcode_id` ile bu satıra bağlı kalıyor
 * ve "koli mu birim mi okutuldu" bilgisi denetimde okunabilir durumda.
 */
export async function archiveBarcode(
  actor: Actor,
  barcodeId: string,
  options: ProductOptions = {},
): Promise<BarcodeRow[]> {
  requirePermission(actor, 'barcode:create')

  const productId = await withTenant(
    actor.tenantId,
    async (tx) => {
      const [target] = await tx
        .select({ productId: productBarcodes.productId, archivedAt: productBarcodes.archivedAt })
        .from(productBarcodes)
        .where(
          and(eq(productBarcodes.tenantId, actor.tenantId), eq(productBarcodes.id, barcodeId)),
        )
        .limit(1)

      if (!target) {
        throw new AppError('NOT_FOUND', `barcode ${barcodeId} not found`, { barcodeId })
      }
      // Zaten arşivliyse sessizce başarılı: kullanıcı çift tıkladıysa
      // ikinci tıklamanın hata göstermesi için bir sebep yok.
      if (target.archivedAt !== null) return target.productId

      const [active] = await tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n
          FROM product_barcodes
         WHERE product_id = ${target.productId}
           AND archived_at IS NULL
      `)

      if (Number(active?.n ?? 0) <= 1) {
        throw new AppError('LAST_BARCODE', `barcode ${barcodeId} is the last active one`, {
          productId: target.productId,
        })
      }

      await tx
        .update(productBarcodes)
        .set({ archivedAt: new Date() })
        .where(
          and(eq(productBarcodes.tenantId, actor.tenantId), eq(productBarcodes.id, barcodeId)),
        )

      return target.productId
    },
    options.db,
  )

  return listBarcodes(actor, productId, options)
}

// ---------------------------------------------------------------------------
// YARDIMCILAR
// ---------------------------------------------------------------------------

/** NUMERIC(14,3) sütunu için metin. Float doğrudan yazılırsa 0.1+0.2 sorunu. */
function qty(value: number | undefined): string | undefined {
  return value === undefined ? undefined : formatScaled(scaledFromNumber(value))
}

/** NUMERIC(12,2) sütunu. `null` ile `undefined` ayrımı korunuyor. */
function money(value: number | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return value.toFixed(2)
}

async function assertLocation(tx: Tx, tenantId: string, locationId: string): Promise<void> {
  const [row] = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.tenantId, tenantId), eq(locations.id, locationId)))
    .limit(1)

  if (!row) {
    throw new AppError('NOT_FOUND', `location ${locationId} not found`, { locationId })
  }
}

async function assertProductExists(tx: Tx, tenantId: string, productId: string): Promise<void> {
  const [row] = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.id, productId)))
    .limit(1)

  if (!row) {
    throw new AppError('NOT_FOUND', `product ${productId} not found`, { productId })
  }
}

/**
 * 23505'i iş hatasına çevirir.
 *
 * Constraint ADINA bakıyor, mesaj metnine değil: mesaj PostgreSQL sürümüne
 * ve diline göre değişir, index adı şemadan gelir ve sabittir.
 */
function translateProductConflict(err: unknown, ctx: { sku: string }): unknown {
  if (isUniqueViolation(err) && pgConstraint(err) === 'products_tenant_sku_uq') {
    return new AppError('SKU_EXISTS', `sku ${ctx.sku} already exists`, { sku: ctx.sku })
  }
  return err
}

function translateBarcodeConflict(err: unknown, barcodes: string[]): unknown {
  if (isUniqueViolation(err) && pgConstraint(err) === 'barcodes_tenant_barcode_uq') {
    // Toplu eklemede hangi barkodun çakıştığını sürücü söylemiyor; hepsini
    // veriyoruz ki arayüz "şunlardan biri" diyebilsin. Tek barkod eklerken
    // liste zaten tek elemanlı ve mesaj kesin.
    return new AppError('BARCODE_EXISTS', `barcode conflict: ${barcodes.join(', ')}`, {
      barcode: barcodes.join(', '),
    })
  }
  return err
}
