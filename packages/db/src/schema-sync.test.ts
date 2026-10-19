import {
  AUTH_ATTEMPT_SCOPE_VALUES,
  BARCODE_KINDS,
  BARCODE_KIND_VALUES,
  CURRENCY_VALUES,
  JOB_KIND_VALUES,
  JOB_STATUS_VALUES,
  MOVEMENT_REASON_VALUES,
  ROLE_VALUES,
  SUPPLIER_MATCH_STATE_VALUES,
  SUPPLIER_PRICE_TYPE_VALUES,
  TAX_MODE_VALUES,
  UNIT_VALUES,
  authScopesCheckConstraint,
  barcodeKindsCheckConstraint,
  jobKindsCheckConstraint,
  jobStatusesCheckConstraint,
  multiplierCheckConstraint,
  reasonsCheckConstraint,
  rolesCheckConstraint,
  unitsCheckConstraint,
} from '@stok/shared'
import { is, sql } from 'drizzle-orm'
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pgErrorCode } from './pg-errors'
import * as schema from './schema'
import { detUuid, testAdminDb } from './testing'
import { TEST_DB_NAME } from './test/db-name'
import { APP_TABLES } from './wipe-guard'

/**
 * ============================================================================
 * T44 — TEK KAYNAK GERÇEKTEN TEK Mİ
 *
 * Sebep kodları, roller ve birimler üç yerde yaşıyor:
 *
 *   packages/shared/src/reasons.ts   ← TEK KAYNAK
 *          │
 *          ├─▶ TypeScript tipleri ve zod enum'ları
 *          └─▶ DB CHECK constraint (schema.ts constraint metnini ÜRETİYOR)
 *
 * Üretim zinciri kodda kurulu ama migration BİR KEZ yazılıp dosyaya
 * donuyor. Yani listeye yeni bir sebep eklenip migration üretilmezse
 * kod ile veritabanı sessizce ayrışır: uygulama sebebi kabul eder,
 * INSERT 23514 ile patlar ve hata kullanıcıya 500 olarak görünür.
 *
 * Bu test o sessiz ayrışmayı derleme zamanında değil, test zamanında
 * yakalıyor. Drift'i yakalamanın başka yolu yok.
 * ============================================================================
 */

const admin = testAdminDb(TEST_DB_NAME)

afterAll(async () => {
  await admin.client.end()
})

/** Constraint'in veritabanındaki gerçek tanımını okur. */
async function constraintDefinition(name: string): Promise<string | undefined> {
  const rows = await admin.db.execute<{ def: string }>(sql`
    SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conname = ${name}
  `)
  return [...rows][0]?.def
}

/**
 * `pg_get_constraintdef` çıktısı `CHECK ((reason = ANY (ARRAY['SALE'::text, ...])))`
 * biçiminde; tırnak içindeki değerleri çıkarıyoruz. Metni birebir
 * karşılaştırmak PostgreSQL sürümüne bağımlı olurdu.
 */
function valuesIn(definition: string): string[] {
  return [...definition.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).sort()
}

describe('DB CHECK constraint kod ile senkron', () => {
  it('movements_reason_ck tam olarak MOVEMENT_REASONS listesini içeriyor', async () => {
    const def = await constraintDefinition('movements_reason_ck')
    expect(def, 'constraint veritabanında yok').toBeDefined()
    expect(valuesIn(def!)).toEqual([...MOVEMENT_REASON_VALUES].sort())
  })

  it('users_role_ck tam olarak ROLES listesini içeriyor', async () => {
    const def = await constraintDefinition('users_role_ck')
    expect(def).toBeDefined()
    expect(valuesIn(def!)).toEqual([...ROLE_VALUES].sort())
  })

  it('products_unit_ck tam olarak UNITS listesini içeriyor', async () => {
    const def = await constraintDefinition('products_unit_ck')
    expect(def).toBeDefined()
    expect(valuesIn(def!)).toEqual([...UNIT_VALUES].sort())
  })

  it('auth_attempts_scope_ck tam olarak AUTH_ATTEMPT_SCOPES listesini içeriyor', async () => {
    // Kapsam adındaki bir yazım hatası her zaman sıfırdan başlayan bir
    // sayaç yaratır, yani kaba kuvvet korumasını SESSİZCE kapatır (T51).
    const def = await constraintDefinition('auth_attempts_scope_ck')
    expect(def).toBeDefined()
    expect(valuesIn(def!)).toEqual([...AUTH_ATTEMPT_SCOPE_VALUES].sort())
  })

  it('jobs_kind_ck ve jobs_status_ck kod ile senkron', async () => {
    // Yeni bir iş türü eklenip migration üretilmezse, uygulama işi
    // kuyruğa almaya çalışır ve 23514 ile patlar — kullanıcı 500 görür.
    const kinds = await constraintDefinition('jobs_kind_ck')
    expect(kinds).toBeDefined()
    expect(valuesIn(kinds!)).toEqual([...JOB_KIND_VALUES].sort())

    const statuses = await constraintDefinition('jobs_status_ck')
    expect(statuses).toBeDefined()
    expect(valuesIn(statuses!)).toEqual([...JOB_STATUS_VALUES].sort())
  })

  it('tedarikçi sözlükleri (para birimi, KDV, fiyat türü, eşleşme) kod ile senkron (T200)', async () => {
    // Liste koda eklenip migration üretilmezse dosyadaki yeni para birimi
    // önizlemeden geçer, kayıtta 23514 ile patlar: kullanıcı 500 görür.
    const expected: [string, readonly string[]][] = [
      ['suppliers_currency_ck', CURRENCY_VALUES],
      ['suppliers_tax_mode_ck', TAX_MODE_VALUES],
      ['suppliers_price_type_ck', SUPPLIER_PRICE_TYPE_VALUES],
      ['supplier_items_currency_ck', CURRENCY_VALUES],
      ['supplier_items_tax_mode_ck', TAX_MODE_VALUES],
      ['supplier_items_price_type_ck', SUPPLIER_PRICE_TYPE_VALUES],
      ['supplier_items_match_state_ck', SUPPLIER_MATCH_STATE_VALUES],
      ['supplier_price_changes_old_currency_ck', CURRENCY_VALUES],
      ['supplier_price_changes_new_currency_ck', CURRENCY_VALUES],
      ['supplier_price_changes_old_tax_mode_ck', TAX_MODE_VALUES],
      ['supplier_price_changes_new_tax_mode_ck', TAX_MODE_VALUES],
      ['supplier_price_changes_old_price_type_ck', SUPPLIER_PRICE_TYPE_VALUES],
      ['supplier_price_changes_new_price_type_ck', SUPPLIER_PRICE_TYPE_VALUES],
    ]
    for (const [name, values] of expected) {
      const def = await constraintDefinition(name)
      expect(def, `${name} veritabanında yok`).toBeDefined()
      expect(valuesIn(def!), name).toEqual([...values].sort())
    }
  })

  it('barcodes_kind_ck tam olarak BARCODE_KINDS listesini içeriyor', async () => {
    // Yeni bir barkod türü eklenip migration üretilmezse, arayüz türü
    // seçtirir ve INSERT 23514 ile patlar — kullanıcı 500 görür.
    const def = await constraintDefinition('barcodes_kind_ck')
    expect(def).toBeDefined()
    expect(valuesIn(def!)).toEqual([...BARCODE_KIND_VALUES].sort())
  })

  it('barkod çarpan kuralı iki yönlü zorlanıyor (D7)', async () => {
    // Sadece "koli > 1" yönü olsaydı, çarpanı 12 olan bir TEKLİ barkod
    // veritabanına girer ve tek kalem okutulduğunda stoğu 12 artırırdı.
    const def = await constraintDefinition('barcodes_case_multiplier_ck')
    expect(def).toBeDefined()
    // PostgreSQL ifadeyi normalize ediyor: `1` → `(1)::numeric`, tek
    // elemanlı IN → `=`. Metni birebir beklemek yerine iki yönün de
    // orada olduğunu arıyoruz.
    const normalized = def!.replace(/\s+/g, ' ')
    expect(normalized).toMatch(/qty_multiplier > \(1\)::numeric/)
    expect(normalized).toMatch(/qty_multiplier = \(1\)::numeric/)
    // Çarpan alabilen tür listesi `BARCODE_KINDS` bayrağından türüyor.
    expect(valuesIn(def!)).toEqual(
      BARCODE_KIND_VALUES.filter((k) => BARCODE_KINDS[k].allowsMultiplier),
    )
  })

  it('barkod tekilliği KISMİ index: arşivli barkodu kapsamıyor', async () => {
    // Tam index olsaydı, yanlış ürüne bağlanmış bir barkod arşivlendikten
    // sonra doğru ürüne bir daha eklenemezdi (T21).
    const rows = await admin.db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'product_barcodes' AND indexname = 'barcodes_tenant_barcode_uq'
    `)
    const def = [...rows][0]?.indexdef
    expect(def, 'barkod tekillik index\'i yok').toBeDefined()
    expect(def).toContain('UNIQUE')
    expect(def).toContain('archived_at IS NULL')
  })

  it('constraint üreticileri beklenen SQL metnini yazıyor', () => {
    // Üreticinin kendisi de sınanmalı: schema.ts bunu sql.raw ile
    // gömüyor, bozuk bir metin migration üretimine kadar fark edilmezdi.
    expect(reasonsCheckConstraint('reason')).toContain("reason IN ('PURCHASE'")
    expect(rolesCheckConstraint('role')).toBe("role IN ('ADMIN', 'STAFF')")
    expect(unitsCheckConstraint('unit')).toBe("unit IN ('ADET', 'KG', 'METRE', 'LITRE')")
    expect(authScopesCheckConstraint('scope')).toBe(
      "scope IN ('LOGIN_EMAIL', 'LOGIN_IP', 'PIN')",
    )
    expect(jobStatusesCheckConstraint('status')).toBe(
      "status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')",
    )
    expect(jobKindsCheckConstraint('kind')).toContain("kind IN ('STOCK_EXPORT'")
    expect(barcodeKindsCheckConstraint('kind')).toBe(
      "kind IN ('UNIT', 'CASE', 'EAN', 'INTERNAL')",
    )
    expect(multiplierCheckConstraint('kind', 'qty_multiplier')).toBe(
      "CASE WHEN kind IN ('CASE') THEN qty_multiplier > 1 ELSE qty_multiplier = 1 END",
    )
  })
})

describe('şemanın taşıdığı diğer garantiler', () => {
  it('miktar NUMERIC(14,3), para NUMERIC(12,2), tedarikçi fiyatı NUMERIC(14,4)', async () => {
    // Bu tipleri INTEGER'a veya float'a çeviren bir migration, hatayı
    // aylar sonra "kuruş farkı" olarak gösterirdi.
    const rows = await admin.db.execute<{
      table_name: string
      column_name: string
      numeric_precision: number
      numeric_scale: number
    }>(sql`
      SELECT table_name, column_name, numeric_precision, numeric_scale
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type = 'numeric'
       ORDER BY table_name, column_name
    `)

    // Para sütunları TEK TEK sayılıyor, desenle değil. `%_price` gibi bir
    // desen yazmak yeni bir para sütununu sessizce kabul ederdi; bu test
    // tam olarak "yeni sütun yanlış ölçekle eklendi" durumunu yakalamak
    // için var. Liste büyüdükçe elle güncellenmesi maliyet değil, amaç.
    const MONEY_COLUMNS = new Set([
      'unit_price',
      'list_price',
      'client_list_price',
      'purchase_price',
      'sale_price',
    ])

    // Tedarikçi fiyatı ayrı ölçekte (T200, B3) ve tablo adıyla sayılıyor:
    // `price` adı tek başına bir ürün sütununu da kapsayabilirdi.
    const SUPPLIER_PRICE_COLUMNS = new Set([
      'supplier_items.price',
      'supplier_price_changes.old_price',
      'supplier_price_changes.new_price',
    ])
    // Yüzde bilerek hassasiyetsiz: sabit ölçek uç değişimlerde taşar ve
    // bütün yenilemeyi düşürürdü (schema.ts `change_pct`).
    const UNBOUNDED_COLUMNS = new Set(['supplier_price_changes.change_pct'])

    for (const c of rows) {
      const key = `${c.table_name}.${c.column_name}`
      const expected = UNBOUNDED_COLUMNS.has(key)
        ? { p: null, s: null }
        : SUPPLIER_PRICE_COLUMNS.has(key)
          ? { p: 14, s: 4 }
          : MONEY_COLUMNS.has(c.column_name)
            ? { p: 12, s: 2 }
            : { p: 14, s: 3 }
      expect(
        { p: c.numeric_precision, s: c.numeric_scale },
        `${c.table_name}.${c.column_name}`,
      ).toEqual(expected)
    }
  })

  it('idempotency anahtarı tenant başına UNIQUE', async () => {
    const rows = await admin.db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'stock_movements' AND indexname = 'movements_tenant_idem_uq'
    `)
    const def = [...rows][0]?.indexdef
    expect(def, 'idempotency index yok: çift kayıt koruması kapalı').toBeDefined()
    expect(def).toContain('UNIQUE')
    expect(def).toContain('tenant_id')
    expect(def).toContain('idempotency_key')
  })

  it('tr_norm() Türkçe harfleri collation bağımsız normalize ediyor', async () => {
    // unaccent + lower() burada yanlış sonuç verirdi: "ısıtıcı" arayan
    // "Isıtıcı" ürününü bulamazdı ve kullanıcı ürünün var olmadığını sanırdı.
    const rows = await admin.db.execute<{ a: string; b: string; c: string; d: string }>(sql`
      SELECT tr_norm('Isıtıcı') AS a,
             tr_norm('ısıtıcı') AS b,
             tr_norm('ŞERİT')   AS c,
             tr_norm('şerit')   AS d
    `)
    const r = [...rows][0]
    expect(r?.a).toBe(r?.b)
    expect(r?.c).toBe(r?.d)
  })
})

/**
 * T200 — FİYAT GEÇMİŞİNİN KURALLARI VERİTABANINDA (ADR-006).
 *
 * Karşılaştırılabilirlik ve yüzde üretilen sütunlar: uygulama hesaplamıyor,
 * yalnız okuyor. Satırlar burada SAHİP rolüyle doğrudan yazılıyor; kural
 * satırı kimin yazdığından bağımsız tutmalı.
 */
describe('fiyat geçmişi kuralları (T200, ADR-006)', () => {
  const tenantId = detUuid('schema-sync:supplier-tenant')
  const supplierId = detUuid('schema-sync:supplier')
  const itemId = detUuid('schema-sync:supplier-item')

  interface Side {
    price: string
    currency?: string
    taxMode?: string
    priceType?: string
    qty?: string | null
  }

  /** Bir değişim satırı yazar ve üretilen sütunları okur. */
  async function change(oldSide: Side, newSide: Side) {
    const rows = await admin.db.execute<{ is_comparable: boolean; change_pct: string | null }>(sql`
      INSERT INTO supplier_price_changes (
        tenant_id, supplier_item_id,
        old_price, old_currency, old_tax_mode, old_price_type, old_price_qty,
        new_price, new_currency, new_tax_mode, new_price_type, new_price_qty)
      VALUES (
        ${tenantId}, ${itemId},
        ${oldSide.price}, ${oldSide.currency ?? 'TRY'}, ${oldSide.taxMode ?? 'EXCLUDED'},
        ${oldSide.priceType ?? 'NET'}, ${oldSide.qty === undefined ? '1' : oldSide.qty},
        ${newSide.price}, ${newSide.currency ?? 'TRY'}, ${newSide.taxMode ?? 'EXCLUDED'},
        ${newSide.priceType ?? 'NET'}, ${newSide.qty === undefined ? '1' : newSide.qty})
      RETURNING is_comparable, change_pct::text AS change_pct
    `)
    return [...rows][0]!
  }

  async function rejected(oldSide: Side, newSide: Side): Promise<string | undefined> {
    const err = await change(oldSide, newSide).then(
      () => undefined,
      (e: unknown) => e,
    )
    return pgErrorCode(err)
  }

  beforeAll(async () => {
    await admin.db.execute(sql`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'Şema Tedarikçi')`)
    await admin.db.execute(sql`
      INSERT INTO suppliers (id, tenant_id, name, default_currency, default_tax_mode, default_price_type)
      VALUES (${supplierId}, ${tenantId}, 'Şema Toptan', 'TRY', 'EXCLUDED', 'NET')
    `)
    await admin.db.execute(sql`
      INSERT INTO supplier_items (id, tenant_id, supplier_id, supplier_code, name, price,
                                  currency, tax_mode, price_type, fetched_at)
      VALUES (${itemId}, ${tenantId}, ${supplierId}, 'K-1', 'Kalem', 10, 'TRY', 'EXCLUDED', 'NET', now())
    `)
  })

  it('koşullar aynı ve miktar biliniyorsa yüzde üretilir: 100 → 110 = %10,0', async () => {
    const r = await change({ price: '100' }, { price: '110' })
    expect(r.is_comparable).toBe(true)
    expect(r.change_pct).toBe('10.0')
  })

  it('azalış eksi yüzde: 3 → 2 = %-33,3', async () => {
    const r = await change({ price: '3' }, { price: '2' })
    expect(r.change_pct).toBe('-33.3')
  })

  it('para birimi değişirse karşılaştırılamaz, yüzde yok', async () => {
    const r = await change({ price: '100' }, { price: '3', currency: 'USD' })
    expect(r.is_comparable).toBe(false)
    expect(r.change_pct).toBeNull()
  })

  it('KDV durumu ya da fiyat türü değişirse yüzde yok', async () => {
    expect((await change({ price: '100' }, { price: '120', taxMode: 'INCLUDED' })).change_pct).toBeNull()
    expect((await change({ price: '100' }, { price: '90', priceType: 'LIST' })).change_pct).toBeNull()
  })

  it('miktar iki tarafta da belirsizse yüzde yok (T200, B2)', async () => {
    const r = await change({ price: '100', qty: null }, { price: '110', qty: null })
    expect(r.is_comparable).toBe(false)
    expect(r.change_pct).toBeNull()
  })

  it('miktar belirsizden 1 ürün birimine geçerse yüzde yok', async () => {
    const r = await change({ price: '100', qty: null }, { price: '110', qty: '1' })
    expect(r.is_comparable).toBe(false)
    expect(r.change_pct).toBeNull()
  })

  it('uç değişim yüzde sütununu taşırmaz: 0,0001 → 9999', async () => {
    const r = await change({ price: '0.0001' }, { price: '9999' })
    expect(r.change_pct).toBe('9998999900.0')
  })

  it('değişmeyen fiyat satırı reddedilir (PRD-14)', async () => {
    expect(await rejected({ price: '10' }, { price: '10' })).toBe('23514')
  })

  it('10.5 ile 10.50 aynı fiyat: sayısal eşitlik, metin değil', async () => {
    expect(await rejected({ price: '10.5' }, { price: '10.5000' })).toBe('23514')
  })

  it('iki taraf da belirsiz miktarla eşitse yine reddedilir', async () => {
    expect(await rejected({ price: '10', qty: null }, { price: '10', qty: null })).toBe('23514')
  })
})

/**
 * WS-1.2b — `db:reset`'in uygulama tablosu izin listesi. Reset, listede
 * olmayan bir `public` tablosu görünce volume'ü silmiyor; liste eskirse yeni
 * bir migration'dan sonra her reset reddedilir, liste fazlaysa yabancı bir
 * tablo uygulamanın sayılır. İki yöndeki ayrışmayı da burada yakalıyoruz:
 * taze migrate edilmiş veritabanıyla ve Drizzle şemasıyla.
 */
describe('db:reset uygulama tablosu listesi (WS-1.2b)', () => {
  it('APP_TABLES, migration sonrası public tablolarıyla birebir aynı', async () => {
    const rows = await admin.db.execute<{ name: string }>(sql`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1
    `)
    expect([...rows].map((r) => r.name)).toEqual([...APP_TABLES].sort())
  })

  it('APP_TABLES = schema.ts tabloları + yalnız SQL migration ile gelen auth_attempts', () => {
    const drizzleTables = Object.values(schema)
      .filter((v) => is(v, PgTable))
      .map((t) => getTableConfig(t as PgTable).name)
    expect([...APP_TABLES].sort()).toEqual([...drizzleTables, 'auth_attempts'].sort())
  })
})
