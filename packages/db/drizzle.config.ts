import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Kök dizindeki tek .env. Her paket kendi kopyasını taşımasın.
config({ path: '../../.env' })

const url = process.env.MIGRATION_DATABASE_URL
if (!url) {
  throw new Error(
    'MIGRATION_DATABASE_URL tanımlı değil. .env.example dosyasını .env olarak kopyala.\n' +
      'DİKKAT: migration MIGRATION_DATABASE_URL kullanır (tablo sahibi),\n' +
      'uygulama DATABASE_URL kullanır (RLS uygulanan kısıtlı rol). Karıştırma.',
  )
}

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
