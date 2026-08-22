import { config } from 'dotenv'

// Kök .env. Testler hem DATABASE_URL (stok_app, RLS uygulanır) hem
// MIGRATION_DATABASE_URL (postgres, RLS atlanır) kullanır; ikisinin
// farkını test etmek zaten işin bir parçası.
config({ path: '../../.env' })

for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
  if (!process.env[key]) {
    throw new Error(
      `${key} tanımlı değil. Kök dizinde: cp .env.example .env\n` +
        'Veritabanı için: pnpm db:up',
    )
  }
}
