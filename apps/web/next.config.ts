import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadRootEnv } from 'dotenv'
import { PHASE_PRODUCTION_BUILD } from 'next/constants.js'
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

/**
 * SUNUCU EKSİK YAPILANDIRMAYLA AÇILMIYOR.
 *
 * Bunlar olmadan uygulama derleniyor, açılıyor ve İLK GİRİŞ DENEMESİNDE
 * düşüyor. Kullanıcı ekranda "SERVER_ERROR" görüyor: ne eksik olduğunu
 * söylemeyen, kurulum hatasını çalışma hatası gibi gösteren bir mesaj.
 * Kullanıcı testinde bu iki kez oldu — önce DATABASE_URL, sonra
 * AUTH_SECRET.
 *
 * Doğru an bu: sorun kurulumda çıktı, kurulumda söylenmeli. Ve operatörün
 * konsolunda söylenmeli, giriş ekranında değil — kimliği doğrulanmamış bir
 * sayfaya sunucunun neyi eksik olduğunu yazmak gereksiz bilgi verir.
 *
 * HEPSİ BİRDEN listeleniyor. Tek tek söylemek, kullanıcıyı birini düzeltip
 * diğerini keşfetme turuna sokardı.
 */
function assertServerConfig(): void {
  const problems: string[] = []

  const url = process.env.DATABASE_URL
  if (!url) {
    problems.push('DATABASE_URL tanımlı değil.')
  } else {
    try {
      new URL(url)
    } catch {
      problems.push('DATABASE_URL geçerli bir bağlantı adresi değil.')
    }
  }

  // 32 karakter sınırı auth.ts'teki `signingKey()` ile aynı; orası da
  // varsayılana düşmüyor. İki yerde kontrol var çünkü mobil/cron yolları
  // bu dosyadan geçmiyor.
  const secret = process.env.AUTH_SECRET
  if (!secret) problems.push('AUTH_SECRET tanımlı değil.')
  else if (secret.length < 32) {
    problems.push(`AUTH_SECRET ${secret.length} karakter, en az 32 olmalı.`)
  }

  if (problems.length > 0) {
    throw new Error(
      [
        '',
        'Stok Takip açılamadı — yapılandırma eksik:',
        '',
        ...problems.map((p) => `  • ${p}`),
        '',
        '  Kök dizinde .env dosyası olmalı. Yoksa:',
        '      .env.example dosyasını .env adıyla kopyalayın',
        '  Örnek dosyadaki değerler yerel geliştirme için hazır gelir.',
        '  Kendi anahtarınızı üretmek için: openssl rand -base64 32',
        '',
      ].join('\n'),
    )
  }

  // APP_URL bir hata değil ama sessiz kalırsa teşhisi en zor arızayı
  // üretiyor: çerez `secure` bayrağı buradan türüyor ve APP_URL yoksa
  // AÇIK kalıyor (fail closed). LAN'da düz HTTP ile servis edilen bir
  // kurulumda tarayıcı o çerezi saklamıyor ve giriş ekranı hiçbir hata
  // göstermeden kendini tekrar ediyor. Bkz. src/server/session.ts.
  // CRON_SECRET yoksa uygulama çalışır ama gün sonu raporu ve kritik stok
  // taraması HİÇ ÇIKMAZ — kimse de fark etmez (G4'ün tam tanımı). Hata
  // değil çünkü zamanlayıcısı olmayan bir kurulum (tek depo, elle bakan
  // yönetici) geçerli; ama sessiz de kalmamalı.
  if (!process.env.CRON_SECRET) {
    console.warn(
      'UYARI: CRON_SECRET tanımlı değil. POST /api/cron kapalı kalacak,\n' +
        '       yani gün sonu raporu ve kritik stok taraması hiç çalışmaz.\n' +
        '       Üret: openssl rand -base64 32',
    )
  }

  if (!process.env.APP_URL) {
    console.warn(
      'UYARI: APP_URL tanımlı değil. Oturum çerezi Secure olarak işaretlenecek,\n' +
        '       yani uygulamaya düz HTTP ile (örn. http://192.168.1.20:3000) erişilirse\n' +
        '       giriş sessizce başarısız olur. .env içinde APP_URL ayarlayın.',
    )
  }
}

const config: NextConfig = {
  // Monorepo paketleri TypeScript kaynağı olarak yayınlanıyor (derlenmiş
  // dist yok). Next'in bunları kendi derlemesine dahil etmesi gerekiyor.
  transpilePackages: ['@stok/shared', '@stok/db', '@stok/core'],
  experimental: {
    // postgres.js ve exceljs sunucu tarafı; istemci paketine sızmasınlar.
    serverActions: { bodySizeLimit: '5mb' },
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
  turbopack: {},

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
 * kurma adımı gibi) çalışabilmeli. Kontrol sunucunun açıldığı anda,
 * yani `next dev` ve `next start` fazlarında yapılıyor.
 */
export default function nextConfig(phase: string): NextConfig {
  if (phase !== PHASE_PRODUCTION_BUILD) assertServerConfig()
  return config
}
