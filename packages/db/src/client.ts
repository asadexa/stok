import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { schema } from './schema.js'

/**
 * ============================================================================
 * BAĞLANTI KATMANI
 *
 * İKİ AYRI BAĞLANTI VAR ve karıştırmak D5 kararını geçersiz kılar:
 *
 *   DATABASE_URL            stok_app rolü. RLS UYGULANIR. Uygulama bunu kullanır.
 *   MIGRATION_DATABASE_URL  postgres (sahip). RLS ATLANIR. Sadece migration/seed.
 *
 * Uygulama kodundan yanlışlıkla migration bağlantısı kullanılırsa tenant
 * izolasyonu sessizce kapanır ve bunu tek tenant'la test ederken asla fark
 * etmezsin. Bu yüzden ikisi ayrı fonksiyonda ve adminDb() adı bilerek rahatsız
 * edici.
 * ============================================================================
 */

export type Db = PostgresJsDatabase<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

interface ClientOptions {
  url: string
  max?: number
}

function createClient({ url, max = 10 }: ClientOptions) {
  const client = postgres(url, {
    max,
    // pgbouncer transaction modunda (Supabase pooler, port 6543) prepared
    // statement desteklenmiyor ve açık bırakılırsa çalışma zamanında
    // "prepared statement already exists" hatası veriyor (PLAN.md D-1.4).
    // Yerelde de kapalı tutuyoruz ki üretimde sürpriz olmasın: geliştirme
    // ve üretim davranışının aynı olması, mikro performanstan önemli.
    prepare: false,
    // Türkçe karakterler ve zaman damgaları için açık ayar.
    types: {},
    onnotice: () => {},
  })
  return { client, db: drizzle(client, { schema }) }
}

let appSingleton: { client: postgres.Sql; db: Db } | undefined

/**
 * Uygulamanın veritabanı bağlantısı. RLS UYGULANIR.
 *
 * Next.js geliştirme modunda hot reload her seferinde modülü yeniden
 * yüklüyor; singleton olmazsa bağlantı havuzu sızdırır ve birkaç dakikada
 * "too many connections" alırsın.
 */
export function appDb(): Db {
  if (!appSingleton) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL tanımlı değil')
    appSingleton = createClient({ url })
  }
  return appSingleton.db
}

/**
 * Sahip rolüyle bağlantı. RLS ATLANIR.
 * SADECE migration, seed ve test kurulumu. Uygulama kodundan ASLA.
 */
export function adminDbUnsafe(): { client: postgres.Sql; db: Db } {
  const url = process.env.MIGRATION_DATABASE_URL
  if (!url) throw new Error('MIGRATION_DATABASE_URL tanımlı değil')
  return createClient({ url, max: 2 })
}

/**
 * TEK BOĞAZ. Veri erişen her kod yolu buradan geçer.
 *
 *   ┌──────────────┐
 *   │ route handler│
 *   └──────┬───────┘
 *          │ withTenant(tenantId, tx => ...)
 *          ▼
 *   ┌──────────────────────────────────┐
 *   │ BEGIN                            │
 *   │   set_config('app.tenant_id', …) │  ← LOCAL: sadece bu transaction
 *   │   <senin sorguların>             │  ← RLS politikaları burada devreye girer
 *   │ COMMIT                           │
 *   └──────────────────────────────────┘
 *
 * set_config'in üçüncü parametresi `true` = LOCAL. Transaction bitince
 * ayar düşer. `false` olsaydı bağlantı havuza geri döndüğünde ayar üstünde
 * kalır ve bir sonraki isteğe SIZAR: başka bir müşterinin verisini görürdü.
 * Bu, havuzlanmış bağlantılarda RLS'in en klasik hatasıdır.
 *
 * current_tenant_id() ayarlanmamışsa NULL döner ve hiçbir politika satır
 * geçirmez. Yani withTenant dışından yapılan sorgu veri SIZDIRMAZ, boş döner.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  db: Db = appDb(),
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`)
    return fn(tx)
  })
}

export async function closeAppDb(): Promise<void> {
  if (appSingleton) {
    await appSingleton.client.end()
    appSingleton = undefined
  }
}
