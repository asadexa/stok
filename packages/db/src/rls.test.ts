import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from './client'
import { pgErrorCode } from './pg-errors'
import { TEST_DB_NAME } from './test/db-name'
import {
  type TestTenant,
  detUuid,
  seedOpeningStock,
  seedTestTenant,
  testAdminDb,
  testAppDb,
} from './testing'
import { currentStock, productBarcodes, products, stockMovements, tenants, users } from './schema'

/**
 * ============================================================================
 * T46 — TENANT İZOLASYONU VE DEĞİŞTİRİLEMEZ DEFTER
 *
 * Bu dosya iki güvenlik iddiasını sınıyor:
 *
 *   1. A müşterisi B'nin verisini NE OKUYABİLİR NE YAZABİLİR (D5)
 *   2. stock_movements append-only, ADMİN BİLE değiştiremez
 *
 * Neden ayrı bir dosya: ikisi de uygulama kodunda değil VERİTABANINDA
 * duruyor. Uygulama testleri bunları asla göremez çünkü uygulama kodu
 * zaten doğru olanı yapıyor. Buradaki testler "kod yanlış olsaydı ne
 * olurdu" sorusunu soruyor.
 *
 * Test edilmeyen bir güvenlik kontrolü, varlığı bilinmeyen bir kontroldür.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

let alpha: TestTenant
let beta: TestTenant

beforeAll(async () => {
  alpha = await seedTestTenant(admin.db, 'rls-a', [{ sku: 'A-1', name: 'Alfa Ürünü' }])
  beta = await seedTestTenant(admin.db, 'rls-b', [{ sku: 'B-1', name: 'Beta Ürünü' }])
  await seedOpeningStock(admin.db, alpha, alpha.products['A-1']!.id, '50')
  await seedOpeningStock(admin.db, beta, beta.products['B-1']!.id, '70')
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

/**
 * SQLSTATE kodunu döner; sorgu başarılı olursa testi anlamlı bir mesajla
 * düşürür. `pgErrorCode` kullanıyor çünkü Drizzle sürücü hatasını kendi
 * hatasının `cause`'una sarıyor ve `err.code` her zaman undefined.
 */
async function expectPgError(fn: () => Promise<unknown>): Promise<string> {
  const err = await fn().then(
    () => undefined,
    (e: unknown) => e,
  )
  if (err === undefined) throw new Error('sorgu başarılı oldu, oysa engellenmeliydi')
  const code = pgErrorCode(err)
  expect(code, `SQLSTATE taşımayan hata: ${String(err)}`).toBeDefined()
  return code as string
}

describe('T46.1 - A tenantı B tenantını OKUYAMAZ', () => {
  it('ürünler: A bağlamında sadece A görünür', async () => {
    const rows = await withTenant(alpha.tenantId, (tx) => tx.select().from(products), app.db)
    expect(rows.map((r) => r.sku)).toEqual(['A-1'])
  })

  it('B ürününü kimliğiyle istemek de boş döner', async () => {
    const rows = await withTenant(
      alpha.tenantId,
      (tx) => tx.select().from(products).where(eq(products.id, beta.products['B-1']!.id)),
      app.db,
    )
    expect(rows).toEqual([])
  })

  it('barkod aramasında B barkodu bulunmaz', async () => {
    // BARCODE_UNKNOWN'ın gerçek sebebi burası: uygulama filtresi değil RLS.
    const rows = await withTenant(
      alpha.tenantId,
      (tx) =>
        tx
          .select()
          .from(productBarcodes)
          .where(eq(productBarcodes.barcode, beta.products['B-1']!.barcode)),
      app.db,
    )
    expect(rows).toEqual([])
  })

  it('hareket logu ve stok projeksiyonu da sızmaz', async () => {
    const { movements, stock } = await withTenant(
      alpha.tenantId,
      async (tx) => ({
        movements: await tx.select().from(stockMovements),
        stock: await tx.select().from(currentStock),
      }),
      app.db,
    )
    expect(movements.every((m) => m.tenantId === alpha.tenantId)).toBe(true)
    expect(stock.every((s) => s.tenantId === alpha.tenantId)).toBe(true)
    expect(stock).toHaveLength(1)
  })

  it('tenants tablosunda kendinden başkası görünmez', async () => {
    const rows = await withTenant(alpha.tenantId, (tx) => tx.select().from(tenants), app.db)
    expect(rows.map((r) => r.id)).toEqual([alpha.tenantId])
  })

  it('toplam sorgusu da B verisini saymaz', async () => {
    // COUNT(*) sızıntısı en sinsi olanı: satır görünmez ama sayı doğruyu
    // söylerse rakibin kaç ürünü olduğu öğrenilir.
    const rows = await withTenant(
      alpha.tenantId,
      (tx) => tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM products`),
      app.db,
    )
    expect([...rows][0]?.n).toBe('1')
  })
})

describe('T46.2 - A tenantı B tenantına YAZAMAZ', () => {
  it('B kimliğiyle ürün eklenemez', async () => {
    const code = await expectPgError(() =>
      withTenant(
        alpha.tenantId,
        (tx) =>
          tx.insert(products).values({
            tenantId: beta.tenantId,
            sku: 'SIZINTI-1',
            name: 'Sızmaya Çalışan Ürün',
          }),
        app.db,
      ),
    )
    // 42501: new row violates row-level security policy
    expect(code).toBe('42501')
  })

  it('B ürününe hareket yazılamaz', async () => {
    const code = await expectPgError(() =>
      withTenant(
        alpha.tenantId,
        (tx) =>
          tx.insert(stockMovements).values({
            tenantId: beta.tenantId,
            productId: beta.products['B-1']!.id,
            userId: beta.adminUserId,
            delta: '-70',
            reason: 'SALE',
            idempotencyKey: detUuid('rls:cross-write'),
          }),
        app.db,
      ),
    )
    expect(code).toBe('42501')
  })

  it('B ürününün adı değiştirilemez (UPDATE hiçbir satır bulamaz)', async () => {
    await withTenant(
      alpha.tenantId,
      (tx) =>
        tx
          .update(products)
          .set({ name: 'Ele Geçirildi' })
          .where(eq(products.id, beta.products['B-1']!.id)),
      app.db,
    )

    const [row] = await admin.db
      .select({ name: products.name })
      .from(products)
      .where(eq(products.id, beta.products['B-1']!.id))
    expect(row?.name).toBe('Beta Ürünü')
  })

  it('B stoğu silinemez', async () => {
    const code = await expectPgError(() =>
      withTenant(
        alpha.tenantId,
        (tx) => tx.delete(currentStock).where(eq(currentStock.tenantId, beta.tenantId)),
        app.db,
      ),
    )
    // current_stock üzerinde DELETE zaten REVOKE edilmiş: yetki hatası.
    expect(code).toBe('42501')
  })
})

describe('T46.3 - SET LOCAL yapılmadan hiçbir satır görünmez', () => {
  it('withTenant dışından yapılan sorgu boş döner, sızdırmaz', async () => {
    // Güvenli varsayılan yönü: yanlış yapılandırmada sistem veri
    // sızdırmaz, BOŞ döner. Ters olsaydı hatayı üretimde öğrenirdik.
    const rows = await app.db.select().from(products)
    expect(rows).toEqual([])
  })

  it('current_tenant_id() ayarsızken NULL', async () => {
    const rows = await app.db.execute<{ t: string | null }>(
      sql`SELECT current_tenant_id()::text AS t`,
    )
    expect([...rows][0]?.t).toBeNull()
  })

  it('transaction bitince ayar DÜŞER, havuzdaki sonraki isteğe sızmaz', async () => {
    // SET LOCAL yerine SET kullanılsaydı bu test kırılırdı ve havuzlanmış
    // bağlantılarda başka müşterinin verisi görünürdü. RLS'in en klasik
    // hatası tam olarak budur.
    await withTenant(alpha.tenantId, (tx) => tx.select().from(products), app.db)

    const after = await app.db.execute<{ t: string | null }>(
      sql`SELECT current_tenant_id()::text AS t`,
    )
    expect([...after][0]?.t).toBeNull()
  })
})

describe('T46.4 - uygulama rolü RLS atlayamaz', () => {
  it('stok_app: BYPASSRLS yok, superuser değil, tablo sahibi değil', async () => {
    const rows = await app.db.execute<{
      rolsuper: boolean
      rolbypassrls: boolean
      rolcreatedb: boolean
    }>(sql`SELECT rolsuper, rolbypassrls, rolcreatedb FROM pg_roles WHERE rolname = 'stok_app'`)
    const role = [...rows][0]

    expect(role).toBeDefined()
    expect(role?.rolsuper).toBe(false)
    expect(role?.rolbypassrls).toBe(false)
    expect(role?.rolcreatedb).toBe(false)
  })

  it('uygulama gerçekten stok_app olarak bağlanıyor', async () => {
    // .env yanlış doldurulup uygulama sahip rolüyle bağlanırsa yukarıdaki
    // testlerin hepsi geçer ama izolasyon kapalı olur. Bu test o sessiz
    // yanlış yapılandırmayı yakalıyor.
    const rows = await app.db.execute<{ u: string }>(sql`SELECT current_user AS u`)
    expect([...rows][0]?.u).toBe('stok_app')
  })

  it('tenant tablolarının hepsinde RLS açık VE zorlanıyor', async () => {
    const rows = await admin.db.execute<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relkind = 'r'
         AND relname <> '__drizzle_migrations'
       ORDER BY relname
    `)

    const tables = [...rows]
    expect(tables.length).toBeGreaterThanOrEqual(7)
    for (const t of tables) {
      // FORCE olmadan sahip rol politikaları atlar; Supabase'de sahip
      // superuser olmayabilir ama yine de kendi tablosunda RLS'i atlar.
      expect(t.relrowsecurity, `${t.relname}: RLS kapalı`).toBe(true)
      expect(t.relforcerowsecurity, `${t.relname}: FORCE RLS kapalı`).toBe(true)
    }
  })

  it('politikalar her tenant tablosunda gerçekten TANIMLI', async () => {
    // FORCE RLS açık ama politika yazılmamış bir tablo, "her şeyi reddet"
    // olarak davranır ve hatayı üretimde 500 olarak görürüz. Açık RLS ile
    // tanımlı politikayı ayrı ayrı doğrulamak gerekiyor.
    const rows = await admin.db.execute<{ tablename: string; policyname: string }>(sql`
      SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'
    `)
    const withPolicy = new Set([...rows].map((r) => r.tablename))
    for (const t of [
      'tenants',
      'users',
      'locations',
      'products',
      'product_barcodes',
      'stock_movements',
      'current_stock',
      'background_jobs',
      // Tenant'a bağlı değil ama politikası var: sadece sahip role açık,
      // uygulama rolüne hiçbir satır geçmiyor (T51).
      'auth_attempts',
    ]) {
      expect(withPolicy.has(t), `${t}: RLS politikası yok`).toBe(true)
    }
  })
})

describe('T46.5 - giriş istisnası (auth_lookup) daraltılmış', () => {
  it('fonksiyon tenant bağlamı olmadan çalışır ve SADECE iki alan döner', async () => {
    // Giriş anında tenant bilinmiyor; bu fonksiyon RLS'in tek istisnası.
    const rows = await app.db.execute<{ user_id: string; tenant_id: string }>(
      sql`SELECT * FROM auth_lookup_user(${alpha.adminEmail})`,
    )
    const list = [...rows]

    expect(list).toHaveLength(1)
    expect(list[0]?.tenant_id).toBe(alpha.tenantId)
    expect(list[0]?.user_id).toBe(alpha.adminUserId)
    // Parola özeti, ad, rol BU YOLDAN ÇIKMIYOR.
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(['tenant_id', 'user_id'])
  })

  it('uygulama rolü app.auth_lookup ayarını KENDİ kurarak satır göremez', async () => {
    // İstisnanın tamamı buna dayanıyor: politika `TO <sahip rol>` ile
    // role bağlı. Bağlı olmasaydı uygulama rolü bu ayarı kendi kurup
    // BÜTÜN tenantların kullanıcı tablosunu okurdu.
    const rows = await app.db.execute<{ n: string }>(sql`
      SELECT set_config('app.auth_lookup', 'on', false) AS ignored,
             (SELECT count(*)::text FROM users) AS n
    `)
    expect([...rows][0]?.n).toBe('0')
  })

  it('tenant bağlamı kuruluyken bile ayar başka tenantı açmıyor', async () => {
    const rows = await withTenant(
      alpha.tenantId,
      async (tx) => {
        await tx.execute(sql`SELECT set_config('app.auth_lookup', 'on', true)`)
        return tx.select().from(users)
      },
      app.db,
    )
    expect(rows.every((u) => u.tenantId === alpha.tenantId)).toBe(true)
  })

  it('fonksiyonu PUBLIC çalıştıramaz, sadece stok_app', async () => {
    const rows = await admin.db.execute<{ acl: string | null }>(sql`
      SELECT array_to_string(proacl, ',') AS acl
        FROM pg_proc WHERE proname = 'auth_lookup_user'
    `)
    const acl = [...rows][0]?.acl ?? ''

    expect(acl).toContain('stok_app=X')
    // "=X/..." (rol adı olmadan) PUBLIC yetkisi demektir.
    expect(acl.split(',').some((entry) => entry.startsWith('=X'))).toBe(false)
  })

  it('bilinmeyen e-posta boş döner', async () => {
    const rows = await app.db.execute(sql`SELECT * FROM auth_lookup_user('yok@yok.test')`)
    expect([...rows]).toEqual([])
  })
})

describe('T5 - defter değiştirilemez', () => {
  it('uygulama rolü UPDATE edemez (yetki katmanı)', async () => {
    const code = await expectPgError(() =>
      withTenant(
        alpha.tenantId,
        (tx) =>
          tx
            .update(stockMovements)
            .set({ note: 'sonradan eklendi' })
            .where(eq(stockMovements.tenantId, alpha.tenantId)),
        app.db,
      ),
    )
    expect(code).toBe('42501')
  })

  it('uygulama rolü DELETE edemez (yetki katmanı)', async () => {
    const code = await expectPgError(() =>
      withTenant(
        alpha.tenantId,
        (tx) => tx.delete(stockMovements).where(eq(stockMovements.tenantId, alpha.tenantId)),
        app.db,
      ),
    )
    expect(code).toBe('42501')
  })

  it('SAHİP rolü bile UPDATE edemez (tetikleyici katmanı)', async () => {
    // Yetki bir şekilde geri verilse bile ikinci katman duruyor.
    // Admin logu değiştirebilseydi "kim ne yaptı" ekranı hiçbir şey
    // ispat etmezdi ve ürünün ana değer önerisi çökerdi.
    const code = await expectPgError(() =>
      admin.db
        .update(stockMovements)
        .set({ note: 'sahip bile yapamaz' })
        .where(eq(stockMovements.tenantId, alpha.tenantId)),
    )
    expect(code).toBe('23001') // restrict_violation
  })

  it('SAHİP rolü bile DELETE edemez (tetikleyici katmanı)', async () => {
    const code = await expectPgError(() =>
      admin.db.delete(stockMovements).where(eq(stockMovements.tenantId, alpha.tenantId)),
    )
    expect(code).toBe('23001')
  })

  it('düzeltme yolu açık: ters hareket yazılabilir', async () => {
    const [original] = await admin.db
      .select({ id: stockMovements.id, productId: stockMovements.productId })
      .from(stockMovements)
      .where(eq(stockMovements.tenantId, alpha.tenantId))
      .limit(1)

    await withTenant(
      alpha.tenantId,
      (tx) =>
        tx.insert(stockMovements).values({
          tenantId: alpha.tenantId,
          productId: original!.productId,
          userId: alpha.adminUserId,
          delta: '-50',
          reason: 'OTHER_OUT',
          note: 'Hatalı giriş düzeltmesi',
          reversesId: original!.id,
          idempotencyKey: detUuid('rls:reversal'),
        }),
      app.db,
    )

    const [stock] = await withTenant(
      alpha.tenantId,
      (tx) =>
        tx
          .select({ qty: currentStock.qty })
          .from(currentStock)
          .where(
            and(
              eq(currentStock.tenantId, alpha.tenantId),
              eq(currentStock.productId, original!.productId),
            ),
          ),
      app.db,
    )
    expect(stock?.qty).toBe('0.000')
  })

  it('tenants tablosuna uygulama rolü yazamaz (provisioning işi)', async () => {
    const code = await expectPgError(() =>
      withTenant(
        alpha.tenantId,
        (tx) => tx.insert(tenants).values({ name: 'Kendi Kendine Kayıt' }),
        app.db,
      ),
    )
    expect(code).toBe('42501')
  })
})
