/**
 * ============================================================================
 * SUNUCU YAPILANDIRMA KONTROLÜ — TEK KAYNAK
 *
 * Bu dosya İKİ yerden çağrılıyor ve ikisi de gerekli:
 *
 *   next.config.ts       → `next dev` / `next start` açılışı (kendi makinen)
 *   src/instrumentation.ts → sunucu örneği başlarken (VERCEL DAHİL)
 *
 * NEDEN İKİNCİSİ VAR (T116). Kontrol eskiden yalnızca `next.config.ts`
 * içindeydi ve `phase !== PHASE_PRODUCTION_BUILD` koşuluna bağlıydı.
 * Vercel'de `next start` YOK: her istek serverless fonksiyonunu doğrudan
 * başlatıyor ve `next.config.ts` çalışma anında hiç yüklenmiyor. Yani
 * üretimde kontrol HİÇ KOŞMUYORDU.
 *
 * Sonuç, bu dosyanın önlemek için yazıldığı arızanın aynısı: eksik
 * `AUTH_SECRET` ile deploy yeşil geçiyor, ilk giriş denemesinde kullanıcı
 * "SERVER_ERROR" görüyor ve operatörün konsolunda hiçbir şey yazmıyor.
 * Kurulum hatası, çalışma hatası kılığında.
 *
 * MANTIK KOPYALANMADI, TAŞINDI. İki kopya olsaydı biri güncellenip diğeri
 * unutulurdu ve "hangisi doğru" sorusunun cevabı kalmazdı.
 * ============================================================================
 */

/**
 * ============================================================================
 * T118 — YÜKLEME BOYUTU SINIRI, TEK KAYNAK
 *
 * `bodySizeLimit` 5 MB'tı. VERCEL FONKSİYONLARININ İSTEK GÖVDESİ SINIRI
 * 4,5 MB ve platform seviyesinde uygulanıyor: istek uygulamaya hiç
 * ulaşmadan reddediliyor. Yani 5 MB'lık ayar ulaşılamaz bir sözdü.
 *
 * Sınırı 4,5'in altına çekmek TEK BAŞINA YETMEZDİ. Uygulama kodunda
 * boyut kontrolü yoktu; büyük bir dosya seçen depo çalışanı Türkçe bir
 * hata değil, platformun ham 413'ünü görürdü — ekranda "bir şeyler ters
 * gitti" bile yazmayan, sebebi söylemeyen bir arıza.
 *
 * Bu yüzden değer BURADA duruyor ve iki yer birden okuyor:
 *   next.config.ts                      → Next'in reddettiği sınır
 *   (panel)/urunler/aktar/actions.ts    → kullanıcıya söylenen sınır
 *
 * İkisi ayrı yazılsaydı biri değiştirilip diğeri unutulur ve kullanıcıya
 * yanlış sayı söylenirdi.
 *
 * 4 MB seçildi, 4,4 değil: platform sınırına yapışmak, çok parçalı form
 * kodlamasının eklediği ek yük yüzünden "bizim kontrolümüz geçirdi ama
 * Vercel reddetti" aralığı bırakırdı.
 * ============================================================================
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024
export const MAX_UPLOAD_LABEL = '4 MB'

/**
 * Eksik olan HER ŞEYİ birden listeliyor. Tek tek söylemek, kullanıcıyı
 * birini düzeltip diğerini keşfetme turuna sokardı.
 */
export function assertServerConfig(): void {
  const problems: string[] = []

  const url = process.env.DATABASE_URL
  if (!url) {
    problems.push('DATABASE_URL tanımlı değil.')
  } else {
    /**
     * ŞEMA DA KONTROL EDİLİYOR, sadece "çözümlenebiliyor mu" değil.
     *
     * `new URL()` TEK BAŞINA YETMİYOR ve bu ölçülerek bulundu: `new
     * URL('localhost:5433/stok')` fırlatmıyor, çünkü `localhost:` geçerli
     * bir şema sayılıyor. Aynı şekilde `merhaba:dunya` da geçiyordu. Yani
     * kontrol "geçerli bir bağlantı adresi değil" diyordu ama aslında
     * yalnızca iki nokta üst üste arıyordu.
     *
     * Gerçek hata biçimleri tam olarak bunlar: `postgresql://` öneki
     * unutulmuş bir `host:port/db`, ya da Supabase panelinden kopyalanmış
     * bir `https://` adresi. İkisi de eski kontrolden geçip uygulamayı
     * ilk sorguda düşürürdü.
     */
    let scheme = ''
    try {
      scheme = new URL(url).protocol
    } catch {
      scheme = ''
    }
    if (scheme !== 'postgres:' && scheme !== 'postgresql:') {
      problems.push('DATABASE_URL postgresql:// ile başlayan bir bağlantı adresi olmalı.')
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
}

/**
 * Bunlar HATA DEĞİL: ikisi de olmadan çalışan geçerli kurulumlar var.
 * Ama sessiz de kalmamalılar — ikisi de teşhisi en zor arıza sınıfını
 * üretiyor, yani "hiçbir şey olmuyor ve kimse sebebini bilmiyor".
 */
export function warnOptionalConfig(): void {
  // Çerez `secure` bayrağı APP_URL'den türüyor ve yoksa AÇIK kalıyor
  // (fail closed). LAN'da düz HTTP ile servis edilen bir kurulumda
  // tarayıcı o çerezi saklamıyor ve giriş ekranı hiçbir hata göstermeden
  // kendini tekrar ediyor. Bkz. src/server/session.ts.
  if (!process.env.APP_URL) {
    console.warn(
      'UYARI: APP_URL tanımlı değil. Oturum çerezi Secure olarak işaretlenecek,\n' +
        '       yani uygulamaya düz HTTP ile (örn. http://192.168.1.20:3000) erişilirse\n' +
        '       giriş sessizce başarısız olur. .env içinde APP_URL ayarlayın.',
    )
  }

  // CRON_SECRET yoksa uygulama çalışır ama gün sonu raporu ve kritik stok
  // taraması HİÇ ÇIKMAZ — kimse de fark etmez (G4'ün tam tanımı). Hata
  // değil çünkü zamanlayıcısı olmayan bir kurulum (tek depo, elle bakan
  // yönetici) geçerli.
  if (!process.env.CRON_SECRET) {
    console.warn(
      'UYARI: CRON_SECRET tanımlı değil. /api/cron kapalı kalacak,\n' +
        '       yani gün sonu raporu ve kritik stok taraması hiç çalışmaz.\n' +
        '       Üret: openssl rand -base64 32',
    )
  }
}
