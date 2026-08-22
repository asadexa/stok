import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Kök .env'i her test dosyasından önce yükle. Aksi halde her test
    // kendi dotenv çağrısını yapmak zorunda kalır ve biri unutunca
    // hata mesajı anlaşılmaz olur.
    setupFiles: ['./src/test-setup.ts'],
    // Veritabanına vuran testler aynı anda koşarsa birbirinin verisini
    // görebilir. Her test kendi tenant'ını yaratıyor ama eşzamanlılık
    // testleri kasten yarış üretiyor; dosya bazında sıralı koşmak
    // yanlış alarmları önlüyor.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
