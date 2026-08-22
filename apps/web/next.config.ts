import type { NextConfig } from 'next'

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
