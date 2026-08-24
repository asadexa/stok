import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadRootEnv } from 'dotenv'
import type { NextConfig } from 'next'

/**
 * KÖK `.env` DOSYASINI BURADA YÜKLÜYORUZ.
 *
 * Next.js `.env` dosyalarını yalnızca KENDİ dizininde arıyor, yani
 * `apps/web/.env`. Bu monorepoda tek bir `.env` var ve o kökte duruyor —
 * veritabanı bağlantısı, JWT anahtarı, SMTP ayarları hepsi orada; ikinci
 * bir kopya çıkarmak iki kaynak demek olurdu.
 *
 * Yüklenmezse uygulama derleniyor, açılıyor ve İLK GİRİŞ DENEMESİNDE
 * "DATABASE_URL tanımlı değil" ile düşüyor — kurulum ekranından değil,
 * çalışma anından gelen bir hata.
 *
 * Eskiden bu gizliydi: demo scripti bir bash dosyasıydı ve `.env`'i kendi
 * kabuğuna export ediyordu, sunucu da onu miras alıyordu. Yani `pnpm demo`
 * çalışıyor, README'nin belgelediği `pnpm dev` çalışmıyordu. Ortamı
 * hazırlamak scriptin değil uygulamanın işi.
 *
 * Yol, dosyanın KENDİ konumundan türüyor (`import.meta.url`), çalışma
 * dizininden değil: sunucu depo kökünden de, `apps/web` içinden de
 * başlatılabiliyor.
 *
 * `dotenv` varsayılan olarak MEVCUT değişkenlerin üstüne yazmıyor: gerçek
 * ortam değişkeni (üretimde, CI'da, `DATABASE_URL=... pnpm dev` ile)
 * her zaman kazanıyor.
 */
loadRootEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env') })

const config: NextConfig = {
  // Monorepo paketleri TypeScript kaynağı olarak yayınlanıyor (derlenmiş
  // dist yok). Next'in bunları kendi derlemesine dahil etmesi gerekiyor.
  transpilePackages: ['@stok/shared', '@stok/db', '@stok/core'],
  experimental: {
    // postgres.js ve exceljs sunucu tarafı; istemci paketine sızmasınlar.
    serverActions: { bodySizeLimit: '5mb' },
  },
  webpack: (webpackConfig) => {
    // Paketler ESM ve içeride `./movements.js` diye import ediyorlar —
    // Node'un ESM çözümlemesi uzantı zorunlu kılıyor, ama diskteki dosya
    // `movements.ts`. tsc bu eşlemeyi kendisi yapıyor, webpack yapmıyor
    // ve "Module not found: './movements.js'" ile derleme patlıyor.
    //
    // Alternatif, paketleri derleyip dist yayınlamaktı: her değişiklikte
    // build adımı, kaynak haritası derdi ve hot reload kaybı demekti.
    webpackConfig.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    }
    return webpackConfig
  },
}

export default config
