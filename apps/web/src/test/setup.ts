import { testDatabaseUrls } from '@stok/db/testing'
import { config } from 'dotenv'
import { vi } from 'vitest'
import { fakeCookieStore } from './cookie-jar.js'
import { TEST_DB_NAME } from './db-name.js'

// Kök .env. globalSetup ana süreçte yüklüyor ama test çalışanları ayrı
// süreç; burada da yüklenmezse bağlantı dizesi "bazen" bulunamaz.
config({ path: '../../.env' })

/**
 * BAĞLANTIYI TEST VERİTABANINA ÇEVİR.
 *
 * `appDb()` `DATABASE_URL`'i okuyor ve ilk çağrıda tek bir havuz açıp
 * saklıyor. Bu satırlar test dosyaları modülleri import etmeden ÖNCE
 * koşuyor (vitest setupFiles), yani havuz doğru veritabanına açılıyor.
 *
 * Yapılmasaydı testler GELİŞTİRME veritabanına yazardı: demo verisini
 * bozar ve `pnpm demo` sonrası "stok neden değişti" sorusunu doğururdu.
 */
const urls = testDatabaseUrls(TEST_DB_NAME)
process.env.DATABASE_URL = urls.appUrl
process.env.MIGRATION_DATABASE_URL = urls.migrationUrl

/**
 * `next/headers` taklidi. Sahtelenen tek sınır bu.
 *
 * `headers()` boş dönüyor: oran sınırı sayacı `x-forwarded-for` okuyor ve
 * testte istemci adresi yok. Sabit bir adres uydurmak, aynı adresten çok
 * sayıda giriş yapan testlerin kilitlenmeye takılmasına yol açardı.
 */
vi.mock('next/headers', () => ({
  cookies: async () => fakeCookieStore(),
  headers: async () => new Headers(),
}))

/**
 * `server-only` Next'in bundler'ında çözülüyor, Node'da çözülmüyor.
 * Boş modüle takma ad `vitest.config.ts` içinde; burada olmasının anlamı
 * yok, sadece nerede olduğunu söylüyoruz.
 */
