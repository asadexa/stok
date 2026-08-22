import {
  AUTH_ATTEMPT_SCOPE_VALUES,
  JOB_KIND_VALUES,
  JOB_STATUS_VALUES,
  MOVEMENT_REASON_VALUES,
  ROLE_VALUES,
  UNIT_VALUES,
  authScopesCheckConstraint,
  jobKindsCheckConstraint,
  jobStatusesCheckConstraint,
  reasonsCheckConstraint,
  rolesCheckConstraint,
  unitsCheckConstraint,
} from '@stok/shared'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { testAdminDb } from './testing.js'
import { TEST_DB_NAME } from './test/db-name.js'

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
  })
})

describe('şemanın taşıdığı diğer garantiler', () => {
  it('miktar NUMERIC(14,3), para NUMERIC(12,2)', async () => {
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

    for (const c of rows) {
      const expected =
        c.column_name === 'unit_cost' ||
        c.column_name === 'purchase_price' ||
        c.column_name === 'sale_price'
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
