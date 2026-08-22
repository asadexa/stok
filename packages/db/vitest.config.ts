import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./src/test/global-setup.ts'],
    setupFiles: ['./src/test/setup-env.ts'],
    // Entegrasyon testleri gerçek bağlantı havuzu açıyor. Tek fork,
    // "too many connections" hatasını ve dosyalar arası sırayı belirsiz
    // bırakmayı önlüyor.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
