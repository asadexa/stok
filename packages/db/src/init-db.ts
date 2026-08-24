import { readFile } from 'node:fs/promises'
import { config } from 'dotenv'
import postgres from 'postgres'

/**
 * `db/init/*.sql` dosyalarını MEVCUT veritabanına uygular: `pg_trgm`
 * eklentisi ve `stok_app` rolü.
 *
 * NEDEN GEREKLİ. Bu iki dosya bugüne kadar yalnızca iki yerde koşuyordu:
 * Docker konteyneri İLK KEZ oluşturulurken (`docker-entrypoint-initdb.d`)
 * ve test veritabanı kurulurken (`testing.ts`). Yani Docker kullanmayan
 * biri — kendi makinesine PostgreSQL kurmuş biri — `pnpm demo`
 * çalıştırdığında migration `stok_app rolü yok` diyerek düşüyordu.
 *
 * Bu, Docker'ı gereksiz yere ZORUNLU kılıyordu. Oysa projenin Docker'a
 * ihtiyacı yok; ihtiyacı olan şey doğru yapılandırılmış bir Postgres.
 *
 * HER AÇILIŞTA KOŞMASI GÜVENLİ. Üç ifade de idempotent:
 * `CREATE EXTENSION IF NOT EXISTS`, rol bloğu `IF NOT EXISTS` ile korumalı,
 * `GRANT` ve `ALTER DEFAULT PRIVILEGES` tekrarlanabilir. Bu yüzden
 * "kuruldu mu" diye bir bayrak tutmuyoruz: tutulan her bayrak, gerçekle
 * ayrışabilecek ikinci bir kaynaktır.
 *
 * `testing.ts` AYNI DOSYALARI okuyor ama farklı iş yapıyor: o, test
 * veritabanını düşürüp sıfırdan yaratıyor. Buradaki ise var olan
 * veritabanına uyguluyor. Ortak olan SQL dosyalarının kendisi — kurulum
 * kodunun tek kopyası orada duruyor.
 *
 * SAHİP BAĞLANTISIYLA koşuyor (`MIGRATION_DATABASE_URL`): rol yaratmak ve
 * eklenti kurmak uygulama rolünün yetkisi değil, olmamalı da.
 */

config({ path: '../../.env' })

const url = process.env.MIGRATION_DATABASE_URL
if (!url) {
  throw new Error(
    'MIGRATION_DATABASE_URL tanımlı değil. Kök dizinde: .env.example dosyasını .env adıyla kopyalayın.',
  )
}

const initDir = new URL('../../../db/init/', import.meta.url)
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

try {
  for (const file of ['00-extensions.sql', '01-roles.sql']) {
    await sql.unsafe(await readFile(new URL(file, initDir), 'utf8'))
    console.log(`  uygulandı: ${file}`)
  }
} finally {
  await sql.end()
}
