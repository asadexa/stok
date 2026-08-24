import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Test veritabanını ana süreçte sıfırdan kuruyor: db/init/*.sql +
    // bütün migration'lar. Kurulumu YAML'a veya her test dosyasına
    // kopyalamak ikinci bir kaynak olurdu.
    globalSetup: ['./src/test/global-setup.ts'],
    // Kök .env'i test ÇALIŞANLARINDA da yükle: globalSetup ana süreçte
    // koşuyor, çalışanlar ayrı süreç.
    setupFiles: ['./src/test/setup-env.ts'],
    // Entegrasyon testleri gerçek bağlantı havuzu açıyor. Tek fork,
    // "too many connections" hatasını ve dosyalar arası sırayı belirsiz
    // bırakmayı önlüyor. Eşzamanlılık testleri (T12) kasten yarış
    // üretiyor; dosya bazında paralellik yanlış alarm verirdi.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
