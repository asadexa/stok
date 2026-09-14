import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = fileURLToPath(new URL('./src', import.meta.url))

/**
 * ============================================================================
 * T94 — apps/web sunucu testleri
 *
 * NE SAHTE, NE GERÇEK:
 *   sahte  → `next/headers` (çerez kavanozu), `server-only`
 *   gerçek → veritabanı, @stok/core yetki mantığı, rota kodunun kendisi
 *
 * Core sahtelenirse test "sahtenin sahteyi çağırdığını" doğrular; oysa
 * sınamak istediğimiz şey tam olarak ROTANIN CORE'U DOĞRU ÇAĞIRDIĞI.
 *
 * `e2e/` HARİÇ: orası Playwright'ın (T93), vitest onu toplarsa iki koşucu
 * aynı dosyayı çalıştırmaya çalışır.
 * ============================================================================
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': src,
      // Next'in bundler'ında çözülüyor, Node'da çözülmüyor.
      'server-only': fileURLToPath(new URL('./src/test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
    globalSetup: ['./src/test/global-setup.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // Gerçek bağlantı havuzu açılıyor ve testler ortak çerez kavanozunu
    // paylaşıyor. Tek fork: "too many connections" ve kavanoz yarışları
    // yerine sıralı ve okunabilir hata mesajları.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
