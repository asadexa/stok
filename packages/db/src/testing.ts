import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import type { Db } from './client.js'
import { hashSecret } from './password.js'
import {
  locations,
  productBarcodes,
  products,
  schema,
  tenants,
  users,
} from './schema.js'

/**
 * ============================================================================
 * ENTEGRASYON TESTİ ALTYAPISI
 *
 * Testler SAHTE veritabanına değil GERÇEK PostgreSQL'e koşar. Sebep:
 * bu projede doğruluğun büyük kısmı veritabanında duruyor — RLS politikaları,
 * append-only tetikleyici, projeksiyon tetikleyicisi, `FOR UPDATE` kilidi,
 * NUMERIC aritmetiği. Bunların hiçbiri sahte bir sürücüde test edilemez;
 * test edilmeyen bir güvenlik kontrolü, varlığı bilinmeyen bir kontroldür.
 *
 * Her paket KENDİ test veritabanını kullanır (`stok_test_db`, `stok_test_core`).
 * Paylaşılan tek veritabanı, iki paketin testleri aynı anda koştuğunda
 * birbirinin şemasını silerdi.
 *
 * Her test dosyası KENDİ tenant'ını oluşturur. Temizlik yok, çünkü
 * `stock_movements` üzerinde DELETE yasak (append-only defter) ve testin
 * bu kuralı test kolaylığı için gevşetmesi, test ettiği şeyi bozmak olurdu.
 * ============================================================================
 */


export interface TestDatabaseUrls {
  name: string
  /** stok_app rolü. RLS UYGULANIR. Testlerin çoğu bunu kullanır. */
  appUrl: string
  /** Sahip rolü. RLS ATLANIR. Sadece şema kurulumu ve fixture. */
  migrationUrl: string
}

function withDatabaseName(url: string, name: string): string {
  const u = new URL(url)
  u.pathname = `/${name}`
  return u.toString()
}

function required(name: 'DATABASE_URL' | 'MIGRATION_DATABASE_URL'): string {
  const value = process.env[name]
  // Varsayılana düşmek yerine patlıyoruz. `.env` yüklenmediğinde sessizce
  // sahip rolüne düşseydi, uygulama bağlantısı RLS'i atlar ve tenant
  // izolasyonu testlerinin TAMAMI yeşil yanarken hiçbir şey doğrulamazdı.
  if (!value) {
    throw new Error(
      `${name} tanımlı değil. Testler kök dizindeki .env dosyasını okur; ` +
        'komutu paket dizininden çalıştır (pnpm --filter @stok/db test).',
    )
  }
  return value
}

export function testDatabaseUrls(name: string): TestDatabaseUrls {
  const migrationBase = required('MIGRATION_DATABASE_URL')
  const appBase = required('DATABASE_URL')
  return {
    name,
    appUrl: withDatabaseName(appBase, name),
    migrationUrl: withDatabaseName(migrationBase, name),
  }
}

function connect(url: string, max = 5) {
  const client = postgres(url, { max, prepare: false, onnotice: () => {} })
  return { client, db: drizzle(client, { schema }) as Db }
}

/** Test veritabanına stok_app rolüyle bağlanır. RLS uygulanır. */
export function testAppDb(name: string, max = 5) {
  return connect(testDatabaseUrls(name).appUrl, max)
}

/** Test veritabanına sahip rolüyle bağlanır. RLS atlanır, sadece kurulum için. */
export function testAdminDb(name: string) {
  return connect(testDatabaseUrls(name).migrationUrl, 2)
}

/**
 * Test veritabanını sıfırdan kurar: düşür, oluştur, eklentiler, roller,
 * migration'lar. vitest `globalSetup`'ından çağrılır.
 *
 * Sıfırdan kurmak, artımlı temizlemekten yavaş ama dürüst: bir migration
 * bozuksa test paketi çalışmadan önce patlar, "bende çalışıyordu" olmaz.
 */
export async function resetTestDatabase(name: string): Promise<void> {
  const { migrationUrl } = testDatabaseUrls(name)
  const maintenance = postgres(withDatabaseName(migrationUrl, 'postgres'), {
    max: 1,
    prepare: false,
    onnotice: () => {},
  })

  try {
    // Açık bağlantı varsa DROP DATABASE başarısız olur. Önceki bir testin
    // sızdırdığı bağlantı yüzünden tüm paket çökmesin.
    await maintenance.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
    )
    await maintenance.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`)
    await maintenance.unsafe(`CREATE DATABASE ${quoteIdent(name)}`)
  } finally {
    await maintenance.end()
  }

  const initDir = new URL('../../../db/init/', import.meta.url)
  const setup = postgres(migrationUrl, { max: 1, prepare: false, onnotice: () => {} })
  try {
    for (const file of ['00-extensions.sql', '01-roles.sql']) {
      await setup.unsafe(await readFile(new URL(file, initDir), 'utf8'))
    }
  } finally {
    await setup.end()
  }

  const { client, db } = connect(migrationUrl, 1)
  try {
    await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname })
  } finally {
    await client.end()
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Geçersiz veritabanı adı: ${name}`)
  return `"${name}"`
}

// ---------------------------------------------------------------------------
// FIXTURE
// ---------------------------------------------------------------------------

/** Tohumdan türetilmiş kararlı UUID. Aynı isim hep aynı kimliği verir. */
export function detUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex')
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    ((parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-')
}

export interface TestProductSpec {
  sku: string
  name: string
  unit?: 'ADET' | 'KG' | 'METRE' | 'LITRE'
  minStock?: string
  archived?: boolean
  /** Koli barkodu çarpanı. Verilmezse koli barkodu oluşturulmaz. */
  caseMultiplier?: string
}

export interface TestProduct {
  id: string
  sku: string
  name: string
  /** UNIT barkodu, çarpan 1. */
  barcode: string
  /** CASE barkodu. `caseMultiplier` verilmediyse undefined. */
  caseBarcode?: string
}

export interface TestTenant {
  tenantId: string
  adminUserId: string
  staffUserId: string
  /** Giriş testleri için: fixture kullanıcılarının e-postası ve parolası. */
  adminEmail: string
  staffEmail: string
  password: string
  locationId: string
  products: Record<string, TestProduct>
}

/** Fixture kullanıcılarının parolası. Testlerde sabit, üretimde yok. */
export const TEST_PASSWORD = 'test1234'

const DEFAULT_PRODUCTS: TestProductSpec[] = [
  // Türkçe karakterli adlar bilerek: tr_norm() ve arama index'i gerçek
  // veriyle sınansın.
  { sku: 'KAL-001', name: 'Kırmızı Tükenmez Kalem', caseMultiplier: '12' },
  { sku: 'DEF-001', name: 'Çizgili Defter 80 Yaprak' },
  { sku: 'ISI-001', name: 'Isıtıcı Şerit', unit: 'METRE' },
  { sku: 'ARS-001', name: 'Arşivlenmiş Ürün', archived: true },
]

/**
 * İzole bir tenant kurar: iki kullanıcı (admin + çalışan), bir konum,
 * dört ürün. HİÇBİR HAREKET YAZMAZ; testler başlangıç stoğunu kendi
 * yazar, böylece her testin başlangıç durumu okunduğu yerde görünür.
 */
export async function seedTestTenant(
  db: Db,
  label: string,
  specs: TestProductSpec[] = DEFAULT_PRODUCTS,
): Promise<TestTenant> {
  const tenantId = detUuid(`tenant:${label}`)
  const adminUserId = detUuid(`user:${label}:admin`)
  const staffUserId = detUuid(`user:${label}:staff`)
  const locationId = detUuid(`location:${label}`)
  const adminEmail = `admin@${label}.test`
  const staffEmail = `staff@${label}.test`
  const passwordHash = await hashSecret(TEST_PASSWORD)

  await db.insert(tenants).values({ id: tenantId, name: `Test Tenant ${label}` })

  await db.insert(users).values([
    {
      id: adminUserId,
      tenantId,
      email: adminEmail,
      name: 'Test Yönetici',
      role: 'ADMIN',
      passwordHash,
    },
    {
      id: staffUserId,
      tenantId,
      email: staffEmail,
      name: 'Test Çalışan',
      role: 'STAFF',
      passwordHash,
    },
  ])

  await db.insert(locations).values({
    id: locationId,
    tenantId,
    code: 'A-01',
    name: 'A Rafı',
  })

  const result: Record<string, TestProduct> = {}

  for (const spec of specs) {
    const id = detUuid(`product:${label}:${spec.sku}`)
    await db.insert(products).values({
      id,
      tenantId,
      sku: spec.sku,
      name: spec.name,
      unit: spec.unit ?? 'ADET',
      minStock: spec.minStock ?? '0',
      locationId,
      archivedAt: spec.archived ? new Date() : null,
    })

    const barcode = `${label}-${spec.sku}-U`
    await db.insert(productBarcodes).values({
      id: detUuid(`barcode:${label}:${spec.sku}:U`),
      tenantId,
      productId: id,
      barcode,
      kind: 'UNIT',
      qtyMultiplier: '1',
    })

    let caseBarcode: string | undefined
    if (spec.caseMultiplier) {
      caseBarcode = `${label}-${spec.sku}-C`
      await db.insert(productBarcodes).values({
        id: detUuid(`barcode:${label}:${spec.sku}:C`),
        tenantId,
        productId: id,
        barcode: caseBarcode,
        kind: 'CASE',
        qtyMultiplier: spec.caseMultiplier,
      })
    }

    result[spec.sku] = { id, sku: spec.sku, name: spec.name, barcode, caseBarcode }
  }

  return {
    tenantId,
    adminUserId,
    staffUserId,
    adminEmail,
    staffEmail,
    password: TEST_PASSWORD,
    locationId,
    products: result,
  }
}

/**
 * Doğrudan ledger'a hareket yazar, `createMovement()` kapısını ATLAYARAK.
 * Sadece test başlangıç stoğu kurmak için: testin kurulumu, test ettiği
 * fonksiyonun doğru çalışmasına bağlı olmamalı.
 */
export async function seedOpeningStock(
  db: Db,
  tenant: TestTenant,
  productId: string,
  qty: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO stock_movements
      (tenant_id, product_id, user_id, delta, reason, idempotency_key)
    VALUES
      (${tenant.tenantId}, ${productId}, ${tenant.adminUserId}, ${qty}, 'OPENING',
       ${detUuid(`opening:${tenant.tenantId}:${productId}:${qty}`)})
  `)
}
