import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadRootEnv } from 'dotenv'
import { PHASE_PRODUCTION_BUILD } from 'next/constants.js'
import type { NextConfig } from 'next'
import { MAX_UPLOAD_BYTES, assertServerConfig, warnOptionalConfig } from './src/server/config'

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
    //
    // SINIR `src/server/config.ts`'ten geliyor (T118). Eskiden burada '5mb'
    // yazıyordu; Vercel fonksiyonlarının istek gövdesi sınırı 4,5 MB ve
    // platform seviyesinde uygulanıyor, yani o ayar ulaşılamaz bir sözdü.
    // Aynı sabiti içe aktarma eylemi de okuyor: kullanıcıya söylenen sayı
    // ile reddedilen sayı ayrı yazılsaydı biri unutulurdu.
    serverActions: { bodySizeLimit: MAX_UPLOAD_BYTES },
  },
  /**
   * Next 16'da Turbopack VARSAYILAN ve `webpack()` kancası artık
   * çalışmıyor. Boş nesne "Turbopack bilerek kullanılıyor" demek.
   *
   * ESKİDEN BURADA `extensionAlias` VARDI. Depo paketleri kendi içinde
   * `./movements.js` diye import ediyordu (Node'un ESM çözümlemesi uzantı
   * ister) ama diskteki dosya `movements.ts`; webpack'e bu eşleme elle
   * öğretiliyordu. Turbopack'te karşılığı YOK ve Next 16 derlemesi
   * "packages/core/src/index.ts'in hiç export'u yok" diye patlıyordu.
   *
   * ÇÖZÜM AYARA DEĞİL KAYNAĞA UYGULANDI: paketlerin içindeki 159 göreli
   * import uzantısız yazıldı (`moduleResolution: "Bundler"` bunu zaten
   * destekliyor; tsx ve vitest de öyle çözüyor). Böylece derleyiciye özel
   * bir kanca kalmadı — bir sonraki paketleyici değişikliğinde yeniden
   * yazılacak bir hack de yok.
   */
  turbopack: {
    rules: {
      /**
       * WS-SCAN: ZXing çözücüsünün WASM'ı modül olarak değil DOSYA olarak
       * derlemeye giriyor; import onun `/_next/static/media/...` adresini
       * veriyor (src/app/tara/scanner.tsx). Turbopack `.wasm`'ı varsayılan
       * olarak WebAssembly modülü sayıyor ve adres yerine dışa aktarımları
       * veriyor. Aynı ayarı tek import'a yazan öznitelik (`with {
       * turbopackModuleType: 'asset' }`) bu sürümde WASM'ta etkisiz kaldı:
       * derleme "export default yok" ile durdu (2026-10-09, Next 16.3.4).
       * Kalıp yalnız bu dosyanın adına uyuyor: başka bir `.wasm` modül olarak
       * kalsın.
       */
      'zxing_reader.wasm': { type: 'asset' },
    },
  },

  /**
   * Next 16 açılışta `apps/web/AGENTS.md` ve `apps/web/CLAUDE.md` ÜRETİYOR.
   * Kapatıldı: bu depoda kök `CLAUDE.md` elle yazılmış ve proje kararlarını
   * anlatıyor. `apps/web/` altında ikinci, otomatik üretilen bir dosya
   * bulunması, aynı soruya iki farklı cevap veren iki kaynak demek — ve
   * üretilen dosya her `next dev` çalıştırmasında geri gelip depoyu kirli
   * gösteriyor.
   */
  agentRules: false,
}

/**
 * Yapılandırma kontrolü DERLEMEDE koşmuyor: `next build` hiçbir yere
 * bağlanmıyor ve gizli anahtarları olmayan bir derleme ortamında (imaj
 * kurma adımı gibi) çalışabilmeli.
 *
 * BURASI TEK YER DEĞİL. Bu dosya yalnızca `next dev` / `next start`
 * açılışında yükleniyor; Vercel'de hiç yüklenmiyor. Üretimdeki karşılığı
 * `src/instrumentation.ts` (T116) ve ikisi de aynı `src/server/config.ts`
 * fonksiyonlarını çağırıyor — mantık tek yerde duruyor.
 *
 * Yerelde ikisi birden koşuyor, yani uyarılar iki kez yazılabiliyor. Bu
 * kabul edildi: alternatifi, hangi ortamda hangi kontrolün koştuğunu
 * bilen bir bayrak ve onun yanlış ayarlandığı gün kontrolün sessizce
 * kaybolması.
 */
export default function nextConfig(phase: string): NextConfig {
  if (phase !== PHASE_PRODUCTION_BUILD) {
    assertServerConfig()
    warnOptionalConfig()
  }
  return config
}
