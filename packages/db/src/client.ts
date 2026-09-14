import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { schema } from './schema'

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
  idleTimeout?: number
}

/**
 * Sayı okuyan ortam değişkeni yardımcısı.
 *
 * GEÇERSİZ DEĞER SESSİZCE YOK SAYILMIYOR. `DB_POOL_MAX=bir` yazılıp
 * varsayılana düşülseydi üretim on bağlantıyla koşar, operatör ayarı
 * yaptığını sanır ve "neden hâlâ too many connections alıyorum" sorusunun
 * cevabı hiçbir yerde olmazdı. Yapılandırma hatası kurulumda söylenmeli.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} negatif olmayan bir tam sayı olmalı, "${raw}" verildi.`)
  }
  return n
}

/**
 * ============================================================================
 * T117 — HAVUZ AYARLARI ORTAMDAN OKUNUYOR
 *
 * Bugünkü değerler TEK UZUN ÖMÜRLÜ SUNUCU varsayıyor ve orada doğrular.
 * Vercel'de uygulama N tane eşzamanlı fonksiyon örneğine dağılıyor, her
 * biri KENDİ havuzunu açıyor: 20 örnek × 10 = 200 bağlantı. Supabase
 * pooler'ın istemci sınırı bu civarda ve aşıldığında hata "too many
 * connections" olarak KULLANICIYA düşüyor.
 *
 * `idle_timeout` yokluğu ayrı bir sorun: fonksiyon örneği donduruluyor ama
 * bağlantı sunucu tarafında açık kalıyor ve kimse kapatmıyor.
 *
 * VARSAYILANLAR BUGÜNKÜYLE AYNI BIRAKILDI (max 10, idle_timeout 0 = hiç
 * kapatma). Sabit küçük bir `max` yazmak yerelde tek süreçli demo yolunu
 * yavaşlatırdı; üretim değerleri `docs/uretim-runbook.md` içinde.
 *
 * SADECE UYGULAMA HAVUZUNA uygulanıyor. Migration bağlantısı (`max: 2`)
 * kısa ömürlü ve elle kapatılıyor; onu ortamdan ayarlanabilir yapmak,
 * yanlışlıkla büyütülebilen bir sahip-rolü havuzu demek olurdu.
 * ============================================================================
 */
export function appPoolOptions(): { max: number; idleTimeout: number } {
  return {
    max: envInt('DB_POOL_MAX', 10),
    idleTimeout: envInt('DB_IDLE_TIMEOUT', 0),
  }
}

function createClient({ url, max = 10, idleTimeout = 0 }: ClientOptions) {
  const client = postgres(url, {
    max,
    // 0 = bağlantıyı hiç kapatma (postgres.js varsayılanı). Serverless'ta
    // sıfırdan büyük bir değer gerekiyor: donan fonksiyon örneğinin
    // bağlantısı aksi halde sunucu tarafında sonsuza kadar açık kalıyor.
    idle_timeout: idleTimeout,
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
    appSingleton = createClient({ url, ...appPoolOptions() })
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

/**
 * Bağlantının GERÇEKTEN ayakta olup olmadığını sorar. T114 sağlık ucu bunu
 * kullanıyor.
 *
 * NEDEN BURADA, ROTADA DEĞİL. `apps/web` drizzle-orm'a bağımlı değil ve
 * `sql` şablonu oradan geliyor. Sırf tek bir `SELECT 1` için web paketine
 * drizzle eklemek, onu veritabanı katmanına doğrudan bağlardı; bugün
 * `@stok/db` arkasında duran bağlantı ayrıntısı arayüz koduna sızardı.
 *
 * `SELECT 1` BİLEREK EN UCUZ SORGU: sağlık ucu dakikada bir vurulabilir ve
 * bir tabloya bakan kontrol, izleme trafiğini gerçek yükün üstüne eklerdi.
 * Sorulan soru "şema doğru mu" değil, "bu sürüm veritabanına ulaşabiliyor
 * mu" — üretimde en sık görülen arıza tam olarak bu: uygulama ayakta,
 * veritabanı erişilemez.
 */
export async function pingDb(db: Db = appDb()): Promise<void> {
  await db.execute(sql`SELECT 1`)
}

export async function closeAppDb(): Promise<void> {
  if (appSingleton) {
    await appSingleton.client.end()
    appSingleton = undefined
  }
}
