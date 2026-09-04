import {
  AppError,
  type CreateMovementInput,
  type CreateMovementResponse,
  type MovementReason,
  type PriceSource,
  type Unit,
  createMovementSchema,
  listMovementsSchema,
  priceOverrideRequiresReason,
  reasonLabel,
  reasonPriceBasis,
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
  users,
  withTenant,
} from '@stok/db'
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { type LogFields, logged } from './observability'
import {
  type Actor,
  canSeePrices,
  movementUserScope,
  redactMovementPricesAll,
  requirePermission,
} from './authz'
import { issuesOf, parseOrThrow, validationError } from './validate'
import { formatScaled, multiplyScaled, parseScaled, scaledFromNumber, scaledToNumber } from './numeric'

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

interface CreateMovementOptions {
  /** Test ve cron için: varsayılan uygulama havuzu yerine başka bağlantı. */
  db?: Db
  /**
   * Log'a yazılan kanal (T36). Varsayılan 'web'; `/api/v1` mobil isteklerde
   * 'mobile' geçirecek. Ayrı bir alan çünkü "mobilde reddedilme oranı web'in
   * iki katı" sorusu ancak kanal ayrıysa sorulabilir.
   */
  source?: 'web' | 'mobile'
}

/** Deadlock ve serileştirme hatalarında kaç kez tekrar denenir. */
const MAX_ATTEMPTS = 3

export async function createMovement(
  actor: Actor,
  raw: unknown,
  options: CreateMovementOptions = {},
): Promise<CreateMovementResponse> {
  /**
   * YAPISAL LOG BURADA, DAHA İÇERİDE DEĞİL (T36).
   *
   * Sarmalayıcı `parseInput`'tan ÖNCE başlıyor: doğrulama hataları da
   * ölçülmek zorunda. PLAN Bölüm 8'in iki metriği ("reddedilen hareket
   * oranı", "`BARCODE_UNKNOWN` oranı") YALNIZCA buradan çıkabiliyor —
   * reddedilen hareket hiçbir tabloya yazılmıyor, defterde izi yok.
   * `writeMovement` içine konsaydı reddedilenlerin çoğu oraya hiç
   * ulaşmadığı için sayılmazdı ve oran her zaman %0 görünürdü.
   *
   * `barcode` LOG'A YAZILMIYOR: ürün kimliği zaten sonuçta var, barkod
   * ise fişten okunan bir müşteri verisi olabilir.
   */
  /**
   * ALANLAR ÇAĞRI BOYUNCA DOLUYOR, başta değil. `logged` bu nesneyi log
   * yazarken açıyor, yani `createMovementInner` içinde eklenen alanlar
   * BAŞARISIZLIK satırında da görünüyor. Girdi baştan çözümlenip alanlar
   * doldurulsaydı, doğrulamayı iki kez yapmak gerekirdi.
   */
  const alanlar: LogFields = {
    tenantId: actor.tenantId,
    userId: actor.userId,
    source: options.source ?? 'web',
  }

  return logged(
    'hareket',
    alanlar,
    () => createMovementInner(actor, raw, options, alanlar),
    (result) => ({
      productId: result.productId,
      delta: result.delta.toString(),
      duplicate: result.duplicate,
    }),
  )
}

async function createMovementInner(
  actor: Actor,
  raw: unknown,
  options: CreateMovementOptions,
  alanlar: LogFields,
): Promise<CreateMovementResponse> {
  requirePermission(actor, 'movement:create')

  const input = parseInput(raw)
  alanlar.reason = input.reason
  alanlar.idempotencyKey = input.idempotencyKey

  // Reddetmek yerine bayrağı sessizce yok saymak daha kötü olurdu:
  // çalışan "yine de yap" dediğini sanır, sistem başka bir şey yapar.
  if (input.allowNegative) requirePermission(actor, 'movement:allowNegative')

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

  const issues = issuesOf(parsed.error)
  // Miktar hatası kendi koduna sahip: kullanıcıya "girilen bilgilerde hata
  // var" yerine "miktar sıfırdan büyük olmalı" gösterilebilsin.
  const onlyQty = issues.every((i) => i.path === 'qty')
  throw validationError(issues, onlyQty ? 'INVALID_QUANTITY' : 'VALIDATION_FAILED')
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

  // Kontrol SADECE çıkışlara uygulanıyor. `expected < 0` tek başına
  // yetmez: stok zaten -5 iken +3'lük bir MAL KABULÜ de -2'de kalır ve
  // reddedilirdi. O zaman negatife düşmüş bir ürünü mal girişiyle
  // düzeltmek imkansız olur, tek çare admin'in her seferinde
  // `allowNegative` ile giriş yapması olurdu. Giriş her zaman serbest:
  // stoğu gerçeğe yaklaştırıyor.
  if (delta < 0n && expected < 0n && !input.allowNegative) {
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

  // Liste fiyatı hata metnine YALNIZCA görmeye yetkili role konuyor
  // (tehdit S7). Bkz. `resolvePrice`.
  //
  // "Bugün" SUNUCU saatinden: istemciden gelseydi ileri tarihli fiyat
  // kontrolü (T89) istemcinin saatini geri alarak atlanırdı.
  const price = resolvePrice(input, target, canSeePrices(actor.role), todayIso())

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
      unitPrice: price.unitPrice,
      listPrice: price.listPrice,
      clientListPrice: price.clientListPrice,
      priceSource: price.priceSource,
      priceOverrideReason: price.priceOverrideReason,
      priceDate: price.priceDate,
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
 * ============================================================================
 * KASA AÇIĞI KONTROLÜ — FİYATIN SUNUCUDA KARARA BAĞLANMASI (T88)
 *
 * Senaryo: fiş liste fiyatından 110 ₺ yazıyor, müşteri tanıdık diye 100 ₺
 * ödüyor, kasada 10 ₺ açık kalıyor. Amaç açığı ENGELLEMEK DEĞİL, GİZLENEMEZ
 * yapmak.
 *
 *   list_price         110  sunucunun üründen OKUDUĞU, harekete dondurulan
 *   client_list_price  110  istemcinin gördüğünü İDDİA ETTİĞİ
 *   unit_price         100  gerçekte ne olduğu
 *   fark                10  ürün sonradan düzenlense de değişmez
 *
 * OTORİTE SUNUCUDA. İstemcinin gönderdiği liste fiyatı karşılaştırmaya HİÇ
 * girmiyor; girseydi kontrolün tamamı kağıt üzerinde kalırdı: fiyatı elle
 * yazan bir istemci `listPrice: 100` gönderip sapmayı sıfırlar, sebep hiç
 * sorulmaz, açık da hiç görünmezdi.
 *
 * LİSTE FİYATI HAREKETE DONDURULUYOR. `products.sale_price` sonradan
 * 110 → 120 olursa geçmişteki 10 ₺'lik açık geriye dönük 20 ₺'ye dönüşürdü.
 * Defter tam da bunun için append-only; o günkü liste fiyatı da hareketle
 * birlikte donmalı.
 * ============================================================================
 */
interface ResolvedPrice {
  unitPrice: string | null
  listPrice: string | null
  clientListPrice: string | null
  priceSource: PriceSource | null
  priceOverrideReason: string | null
  priceDate: string | null
}

/**
 * ============================================================================
 * AÇILIŞ DEĞERLEMESİ — FİYATIN EKONOMİK TARİHİ (T89)
 *
 * 5 yıldır rafta duran mal bugün sisteme giriliyor. Hareketin tarihi bugün,
 * fiyatın tarihi 5 yıl önce. Bu iki tarih AYRI olmak zorunda: aynı sayılsaydı
 * enflasyon düzeltmesi (T90) o fiyatı bugünün parası sanar ve yenileme
 * maliyetini olduğundan düşük hesaplardı.
 *
 * GEÇMİŞ TARİHLİ FİYAT LİSTE FİYATIYLA KARŞILAŞTIRILMIYOR. 5 yıl önceki
 * 45 ₺'yi bugünkü 80 ₺'lik listeyle kıyaslamak kategori hatası: aradaki
 * fark bir indirim değil, enflasyon. Sapma sebebi sormak kullanıcıyı her
 * devir satırında anlamsız bir seçime zorlardı.
 *
 * AMA BU BİR KAÇAK OLAMAZ. Satışta geçmiş tarih serbest bırakılsaydı kasa
 * açığı kontrolü (T88) tek alanla atlanırdı: çalışan fiyat tarihine dünü
 * yazar, karşılaştırma düşer, 10 ₺'lik açık sebepsiz kaydedilir. Bu yüzden
 * geçmiş tarih YALNIZCA satış dayanağı OLMAYAN sebeplerde kabul ediliyor —
 * satış ve müşteri iadesinde fiyatın anı, işlemin anıdır.
 * ============================================================================
 */
function resolvePriceDate(input: CreateMovementInput, today: string): string | null {
  if (input.priceDate === undefined) return null
  if (input.priceDate > today) {
    throw new AppError('PRICE_DATE_INVALID', `price date ${input.priceDate} is in the future`, {
      reason: 'FUTURE',
      priceDate: input.priceDate,
    })
  }
  if (input.priceDate < today && reasonPriceBasis(input.reason) === 'SALE') {
    throw new AppError(
      'PRICE_DATE_INVALID',
      `past price date ${input.priceDate} not allowed for sale-based ${input.reason}`,
      { reason: 'PAST_ON_SALE', priceDate: input.priceDate },
    )
  }
  // Bugünse yazmaya değmez: sütunun sözleşmesi "boş = hareket tarihi".
  return input.priceDate === today ? null : input.priceDate
}

interface PriceContext {
  purchasePrice: string | null
  salePrice: string | null
}

/** `numeric(12,2)` metnini sayıya çevirir. Kuruş sınırlı, güvenli. */
function money(value: string | null): number | null {
  return value === null ? null : Number(value)
}

/**
 * Bugünün tarihi `YYYY-MM-DD`, YEREL saat diliminde.
 *
 * `toISOString()` UTC'ye çeviriyor ve Türkiye'de (UTC+3) gece yarısından
 * 03:00'e kadar DÜNÜ döndürürdü. O aralıkta girilen "bugün" tarihli bir
 * fiyat geçmiş sayılır, liste karşılaştırması sessizce düşer ve kasa
 * açığı kontrolü her gece üç saat kapalı kalırdı.
 */
function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

function resolvePrice(
  input: CreateMovementInput,
  product: PriceContext,
  canSeeAllPrices: boolean,
  today: string,
): ResolvedPrice {
  const basis = reasonPriceBasis(input.reason)
  const priceDate = resolvePriceDate(input, today)

  // Para el değiştirmeyen sebepler (fire, kullanım, sayım düzeltmesi).
  // Fiyat SESSİZCE YUTULMUYOR: kullanıcı yazdığı tutarın kaydedildiğini
  // sanır, oysa raporda hiç görünmezdi.
  if (basis === null) {
    if (input.unitPrice !== undefined) {
      throw new AppError('PRICE_NOT_APPLICABLE', `reason ${input.reason} carries no price`, {
        reason: input.reason,
        reasonLabel: reasonLabel(input.reason as MovementReason),
      })
    }
    return {
      unitPrice: null,
      listPrice: null,
      clientListPrice: null,
      priceSource: null,
      priceOverrideReason: null,
      priceDate: null,
    }
  }

  const listPrice = money(basis === 'SALE' ? product.salePrice : product.purchasePrice)

  if (input.unitPrice === undefined) {
    // DEVİRDE FİYAT ZORUNLU (T89). Defter append-only: fiyatsız yazılan
    // bir devir satırının değeri sonradan EKLENEMEZ, yani o stok sonsuza
    // kadar değersiz görünür. Tek şansı bu ekran.
    //
    // Diğer sebeplerde zorunlu DEĞİL: bugünün akışını kıran bir
    // zorunluluk, veri toplanmaya başlamadan kullanıcıyı formdan
    // kaçırırdı (T88).
    if (input.reason === 'OPENING') {
      throw new AppError('PRICE_REQUIRED', 'OPENING movements must carry a unit price', {
        reason: input.reason,
        reasonLabel: reasonLabel(input.reason as MovementReason),
      })
    }
    return {
      unitPrice: null,
      // Fiyat yoksa liste fiyatı da yazılmıyor: tek başına bir liste
      // fiyatı "bu fiyattan işlem gördü" gibi okunur, oysa hiçbir fiyat
      // kaydedilmedi.
      listPrice: null,
      clientListPrice: null,
      priceSource: null,
      priceOverrideReason: null,
      priceDate: null,
    }
  }

  /**
   * Fiyat BAŞKA BİR ANA ait mi. İki durumda liste fiyatı dondurulmuyor ve
   * sapma sebebi sorulmuyor, çünkü kıyaslanacak bir "olması gereken" yok:
   *
   *   geçmiş tarihli  → aradaki fark indirim değil ENFLASYON
   *   tahmini         → kullanıcı zaten "bilmiyorum, tahminim bu" diyor
   *
   * `list_price` NULL kaldığı için DB CHECK de sessiz kalıyor; kural ile
   * veri aynı şeyi söylüyor.
   */
  const detached = priceDate !== null || input.priceEstimated

  if (detached) {
    return {
      unitPrice: input.unitPrice.toFixed(2),
      listPrice: null,
      clientListPrice:
        input.clientListPrice === undefined ? null : input.clientListPrice.toFixed(2),
      priceSource: input.priceEstimated ? 'ESTIMATED' : (input.priceSource ?? 'MANUAL'),
      priceOverrideReason: null,
      priceDate,
    }
  }

  if (priceOverrideRequiresReason(input.unitPrice, listPrice) && !input.priceOverrideReason) {
    /**
     * LİSTE FİYATI HATA DETAYINA HER ZAMAN KONMUYOR (tehdit S7).
     *
     * Detaylar Türkçe hata metnine giriyor ve o metin kullanıcıya, adres
     * çubuğuna ve ağ sekmesine düşüyor. Alış fiyatından sapan bir GİRİŞ
     * yazan çalışan, "Liste fiyatı 168,34 ₺" uyarısından ürünün alış
     * fiyatını öğrenirdi — listeden gizlediğimiz sayıyı forma yanlış
     * fiyat yazarak sorgulamak mümkün olurdu. Satış fiyatı için kısıt
     * yok: raf etiketinde zaten yazıyor.
     *
     * `message` (İngilizce, yalnızca log) tam sayıyı taşımaya devam
     * ediyor: hata ayıklarken gereken bilgi orada.
     */
    const mayReveal = canSeeAllPrices || basis === 'SALE'
    throw new AppError(
      'PRICE_OVERRIDE_REASON_REQUIRED',
      `unit price ${input.unitPrice} deviates from list ${listPrice} without a reason`,
      mayReveal
        ? { unitPrice: input.unitPrice, listPrice, reason: input.reason }
        : { reason: input.reason },
    )
  }

  return {
    unitPrice: input.unitPrice.toFixed(2),
    listPrice: listPrice === null ? null : listPrice.toFixed(2),
    clientListPrice:
      input.clientListPrice === undefined ? null : input.clientListPrice.toFixed(2),
    // İstemci yalnızca sunucunun gözlemleyemeyeceğini iddia edebiliyor
    // (fiş / tahmin); gerisini burada türetiyoruz. Şema da bunu zorluyor.
    priceSource: input.priceSource ?? (input.unitPrice === listPrice ? 'LIST' : 'MANUAL'),
    // Sapma yokken gelen sebep DÜŞÜRÜLÜYOR: "110'a sattım ama tanıdık
    // indirimi yaptım" diye bir satır rapora girer ve indirim toplamını
    // şişirirdi. DB CHECK bunu yakalamaz — sebep fazlalık olduğunda da
    // geçerli sayılıyor.
    priceOverrideReason: priceOverrideRequiresReason(input.unitPrice, listPrice)
      ? (input.priceOverrideReason ?? null)
      : null,
    priceDate,
  }
}

/**
 * Barkodu ürüne çevirir. `tenant_id` filtresi RLS'e EK olarak yazılıyor:
 * RLS zaten süzüyor ama açık filtre `barcodes_tenant_barcode_uq` index'ini
 * kullandırıyor ve niyeti okuyana gösteriyor.
 */
/**
 * ============================================================================
 * BARKOD ÖNİZLEME (T52)
 *
 * Hareket yazmadan ÖNCE "hangi ürün, elde kaç tane" sorusunu cevaplıyor.
 * PLAN.md D9: "çalışan barkodu okuttuğunda ekranda ürün adı ve mevcut stok
 * görmeli, yoksa doğru ürüne yazdığını doğrulayamaz."
 *
 * Bu, yazma yolundan AYRI ve salt okunur. Aynı fonksiyonu kullanmak cazip
 * ama yanlış olurdu: yazma yolu satırı kilitliyor (`FOR UPDATE`) ve sadece
 * bakmak için kilit almak, gerçekten yazan istekleri bekletirdi.
 * ============================================================================
 */
export interface BarcodeLookup {
  barcode: string
  productId: string
  productName: string
  sku: string
  unit: Unit
  /** Barkodun çarpanı. Koli barkodunda > 1 (D7). */
  qtyMultiplier: number
  /** Şu anki stok. Kilit ALINMADAN okundu, yani yazma anında değişebilir. */
  qty: number
  /**
   * Ürünün liste satış fiyatı. HERKESE AÇIK: raf etiketinde yazıyor,
   * müşteri zaten görüyor. Gizlenseydi çalışan sapmayı hesaplayamaz,
   * "kaça satıyorum" sorusunu ekranda cevaplayamazdı (T88).
   */
  salePrice: number | null
  /** Alış fiyatı — ticari sır (tehdit S7). Yetkisiz rolde ALAN HİÇ YOK. */
  purchasePrice?: number | null
  archivedAt: Date | null
}

export async function lookupBarcode(
  actor: Actor,
  barcode: string,
  options: CreateMovementOptions = {},
): Promise<BarcodeLookup> {
  requirePermission(actor, 'stock:read')
  const trimmed = barcode.trim()
  if (trimmed === '') {
    throw new AppError('BARCODE_UNKNOWN', 'empty barcode', { barcode: trimmed })
  }

  return withTenant(
    actor.tenantId,
    async (tx) => {
      const [row] = await tx
        .select({
          productId: products.id,
          productName: products.name,
          sku: products.sku,
          unit: products.unit,
          archivedAt: products.archivedAt,
          purchasePrice: products.purchasePrice,
          salePrice: products.salePrice,
          qtyMultiplier: productBarcodes.qtyMultiplier,
          qty: currentStock.qty,
        })
        .from(productBarcodes)
        .innerJoin(products, eq(products.id, productBarcodes.productId))
        .leftJoin(
          currentStock,
          and(
            eq(currentStock.tenantId, products.tenantId),
            eq(currentStock.productId, products.id),
          ),
        )
        .where(
          and(
            eq(productBarcodes.tenantId, actor.tenantId),
            eq(productBarcodes.barcode, trimmed),
            isNull(productBarcodes.archivedAt),
          ),
        )
        .limit(1)

      if (!row) {
        throw new AppError('BARCODE_UNKNOWN', `barcode ${trimmed} not found`, { barcode: trimmed })
      }

      const lookup: BarcodeLookup = {
        barcode: trimmed,
        productId: row.productId,
        productName: row.productName,
        sku: row.sku,
        unit: row.unit as Unit,
        qtyMultiplier: scaledToNumber(parseScaled(row.qtyMultiplier)),
        // Hiç hareketi olmayan ürünün projeksiyon satırı yok; 0 göstermeli,
        // boş değil. Boş hücre "bilinmiyor" der, oysa cevap "sıfır".
        qty: row.qty === null ? 0 : scaledToNumber(parseScaled(row.qty)),
        salePrice: money(row.salePrice),
        archivedAt: row.archivedAt,
      }
      // Alan YALNIZCA yetkiliye ekleniyor; `null` atayıp geçmek "alış
      // fiyatı girilmemiş" gibi okunur ve ekran ikisini ayıramaz.
      if (canSeePrices(actor.role)) lookup.purchasePrice = money(row.purchasePrice)
      return lookup
    },
    options.db,
  )
}

async function resolveBarcode(tx: Tx, tenantId: string, barcode: string) {
  const [row] = await tx
    .select({
      barcodeId: productBarcodes.id,
      qtyMultiplier: productBarcodes.qtyMultiplier,
      productId: products.id,
      productName: products.name,
      archivedAt: products.archivedAt,
      // Liste fiyatları SUNUCUDA okunuyor, istemciden gelmiyor (T88).
      purchasePrice: products.purchasePrice,
      salePrice: products.salePrice,
    })
    .from(productBarcodes)
    .innerJoin(products, eq(products.id, productBarcodes.productId))
    .where(
      and(
        eq(productBarcodes.tenantId, tenantId),
        eq(productBarcodes.barcode, barcode),
        // ARŞİVLENMİŞ BARKOD ÇÖZÜLMÜYOR (T21). Yanlış ürüne bağlandığı
        // için kaldırılmış bir barkod hâlâ çözülseydi, kaldırma işlemi
        // hiçbir şey yapmamış olurdu: etiket rafta duruyor, okutan kişi
        // yine yanlış üründen düşürüyor. "Bu barkod tanımlı değil" demek
        // doğru cevap — kullanıcı yeniden tanımlamaya gider.
        isNull(productBarcodes.archivedAt),
      ),
    )
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

/**
 * ============================================================================
 * HAREKET LİSTESİ
 *
 * Rol matrisi (PLAN.md Bölüm 4): "Hareket geçmişi (tüm kullanıcılar) →
 * admin ✓, çalışan SADECE KENDİ".
 *
 * Kapsam kısıtı `movementUserScope()` ile uygulanıyor ve istemcinin
 * gönderdiği `userId` filtresi çalışan için YOK SAYILIYOR. Filtreyi
 * doğrudan sorguya koysaydık `?userId=<patron>` yazan çalışan patronun
 * hareketlerini okurdu — arayüzde o kutuyu göstermemek bunu engellemez.
 *
 * Fiyat alanları çalışan cevabından SATIR BAZINDA çıkarılıyor (T88 / D7):
 * satış fiyatı kalıyor, alış fiyatı gidiyor (tehdit S7). Gerekçe
 * `authz.ts` → `redactMovementPricesAll`.
 * ============================================================================
 */

export interface MovementRow {
  id: string
  productId: string
  productName: string
  productSku: string
  userId: string
  userName: string
  delta: number
  reason: string
  note: string | null
  /** Gerçekleşen birim fiyat. ALAN YOKSA yetki yok, `null` ise girilmemiş. */
  unitPrice?: number | null
  /** O günkü liste fiyatı, harekete dondurulmuş (T88). */
  listPrice?: number | null
  /** İstemcinin gördüğünü iddia ettiği liste fiyatı; uyuşmazlık kanıtı. */
  clientListPrice?: number | null
  /** Sapma sebebi. Yalnızca `unitPrice !== listPrice` olan satırlarda dolu. */
  priceOverrideReason?: string | null
  /** Fiyatın ekonomik tarihi (T89). Boş = hareket tarihi. */
  priceDate?: string | null
  /** Fiyat nereden geldi: liste / elle / tahmini … (T89). */
  priceSource?: string | null
  createdAt: Date
}

export async function listMovements(
  actor: Actor,
  raw: unknown = {},
  options: CreateMovementOptions = {},
): Promise<MovementRow[]> {
  const q = parseOrThrow(listMovementsSchema, raw)
  // Yetki kontrolü burada: movementUserScope, read:all olmayan role
  // read:own arar ve ikisi de yoksa 403 fırlatır.
  const scopedUserId = movementUserScope(actor, q.userId)

  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .select({
          id: stockMovements.id,
          productId: stockMovements.productId,
          productName: products.name,
          productSku: products.sku,
          userId: stockMovements.userId,
          userName: users.name,
          delta: stockMovements.delta,
          reason: stockMovements.reason,
          note: stockMovements.note,
          unitPrice: stockMovements.unitPrice,
          listPrice: stockMovements.listPrice,
          clientListPrice: stockMovements.clientListPrice,
          priceOverrideReason: stockMovements.priceOverrideReason,
          priceDate: stockMovements.priceDate,
          priceSource: stockMovements.priceSource,
          createdAt: stockMovements.createdAt,
        })
        .from(stockMovements)
        .innerJoin(products, eq(products.id, stockMovements.productId))
        .innerJoin(users, eq(users.id, stockMovements.userId))
        .where(
          and(
            eq(stockMovements.tenantId, actor.tenantId),
            scopedUserId ? eq(stockMovements.userId, scopedUserId) : undefined,
            q.productId ? eq(stockMovements.productId, q.productId) : undefined,
            q.reason ? eq(stockMovements.reason, q.reason) : undefined,
            q.from ? gte(stockMovements.createdAt, new Date(q.from)) : undefined,
            q.to ? lte(stockMovements.createdAt, new Date(q.to)) : undefined,
          ),
        )
        // Sıralama HER ZAMAN sunucu saatiyle: telefon saati yanlış olabilir
        // ve cihaz saatine göre sıralanan bir log denetimde işe yaramaz.
        .orderBy(desc(stockMovements.createdAt))
        .limit(q.limit)
        .offset(q.offset),
    options.db,
  )

  return redactMovementPricesAll(
    actor,
    rows.map((r) => ({
      ...r,
      delta: scaledToNumber(parseScaled(r.delta)),
      unitPrice: money(r.unitPrice),
      listPrice: money(r.listPrice),
      clientListPrice: money(r.clientListPrice),
    })),
  )
}
