# Stok Takip

Küçük ve orta ölçekli depolar ve perakende işletmeler için barkod tabanlı stok
takip sistemi. Türkçe arayüz, çok kiracılı (multi-tenant), değiştirilemez
(append-only) stok defteri: stok bir sayı olarak tutulmaz, hareketlerin toplamıdır.

## Hızlı başlangıç (Windows)

Yerel geliştirme ve demo içindir; gerçek işletme verisi olan bir bilgisayarda kullanmayın.

1. **Gerekenler:** [Node.js](https://nodejs.org) 22, 23 ya da 24 ve
   [Docker Desktop](https://www.docker.com/products/docker-desktop/) (açık olmalı). pnpm'i
   başlatıcı kendisi kurar. İlk çalıştırmada internet bağlantısı gerekir.
2. **Projeyi indirin:** GitHub'da **Code → Download ZIP** ile indirip bir klasöre açın ya da
   `git clone` ile kopyalayın. Ağ klasörü değil, bu bilgisayardaki bir klasör kullanın.
3. **Başlatın:** proje klasöründeki `BASLAT.bat` dosyasına çift tıklayın.
4. **İlk çalıştırmada kendiliğinden hazırlananlar** (`pnpm demo` yapar, birkaç dakika
   sürebilir): gerekirse pnpm (yönetici izni istemeden, kullanıcı hesabınıza), `.env` ayar
   dosyası (rastgele `AUTH_SECRET` ile), paketler, Docker'da PostgreSQL veritabanı ve şema,
   veritabanı boşsa örnek veri.
5. **Açın:** pencerede "Sunucu başlatılıyor" yazınca tarayıcıda **http://localhost:3000**
   adresine gidin ve aşağıdaki hesaplardan biriyle girin.
6. **Kapatma ve yeniden başlatma:** pencerede **Ctrl+C**'ye basın ("Terminate batch job
   (Y/N)?" sorulursa `Y`) ya da pencereyi kapatın. Tekrar başlatmak için aynı dosyaya çift
   tıklayın. Veriler korunur: veritabanı Docker volume'ünde durur, örnek veri yalnız
   veritabanında hiç ürün yoksa yüklenir.

| Rol | E-posta | Parola |
|---|---|---|
| Yönetici | `admin@yilmaz.example` | `admin123` |
| Çalışan | `ahmet@yilmazkirtasiye.example` | `calisan123` |
| Başka işletme | `admin@demir.example` | `admin123` |

Veri silen işlemler normal başlatmanın parçası değildir, yalnız elle çalıştırılır: örnek
veriyi baştan yüklemek için `pnpm demo --seed`, Docker veritabanını tamamen sıfırlamak için
`pnpm db:reset` (ikisi de "Kurulum ayrıntıları" bölümünde). macOS ve Linux'ta aynı akış
proje klasöründe `pnpm demo` komutudur.

## Telefon kamerasıyla barkod okutma (pilot)

Telefonun kamerasıyla okunan barkod, bilgisayardaki giriş/çıkış ekranında (`/hareket`)
açılır. Telefon yalnız barkodu iletir; stok hareketini bilgisayarda **Kaydet**'e basan
kullanıcı kaydeder. Özellik varsayılan olarak kapalıdır.

**Bilmeniz gerekenler:**

- Bu akış `BASLAT.bat`'ın açtığı geliştirme sunucusuyla (`next dev`) değil, üretim derlemesi
  ve tek süreçli `next start` ile çalışır. İkisi aynı anda açık olamaz, ikisi de 3000
  portunu kullanır: önce BASLAT penceresini Ctrl+C ile kapatın.
- Telefon kamerası yalnız HTTPS adreste açılır. Bilgisayardaki sunucuya HTTPS adresini
  Cloudflare'in geçici tüneli verir (hesap gerekmez).
- **Tünel açıkken uygulamanın tamamı, giriş sayfası dahil, internetten erişilebilir.** Demo
  parolaları bu dosyada açıkça yazıyor: tüneli yalnız deneme süresince açık tutun (T167).
  Sunucu ayrıca yerel ağdan HTTP ile erişilebilir (T183).
- Eşleşmeler sunucunun belleğinde tutulur: sunucu yeniden başlarsa düşer. Çok örnekli bulut
  dağıtımında (ör. Vercel) bu köprü doğru çalışmaz, orada kapalı kalmalıdır (`ARC-14`).
- iPhone Safari'de sınandı; Android henüz denenmedi.

**Bir kez:** Cloudflare Tunnel'ı kurun, sonra yeni bir PowerShell penceresi açın. Proje bir
kez `BASLAT.bat` ile kurulmuş olmalı (paketler, `.env`, veritabanı); Docker Desktop açık olmalı.

```powershell
winget install --id Cloudflare.cloudflared -e
```

**1. PowerShell penceresi, sunucu** (proje klasöründe):

```powershell
$env:ENABLE_PHONE_SCANNER = 'true'
pnpm --filter @stok/web run build
pnpm --filter @stok/web run start
```

Bayrak yalnız bu pencere için geçerlidir. Derleme ilk seferde ve kod değiştikten sonra
gerekir. Veritabanı kapalıysa önce `pnpm db:up`. Sunucu "AUTH_SECRET depoda açıkça yazan
örnek bir değer" diye açılmazsa `.env`'deki `AUTH_SECRET`'i yenileyin (üretme komutu
`.env.example`'da); `BASLAT.bat` yeni bir `.env`'e zaten rastgele değer yazar.

**2. PowerShell penceresi, tünel:**

```powershell
cloudflared tunnel --url http://localhost:3000
```

Çıktıdaki `https://…trycloudflare.com` adresini kopyalayın.

**3. Bilgisayarda:** `http://localhost:3000/hareket` (giriş yapın) → **Telefon adresi (tünel)**
alanına tünel adresini yapıştırın → **Telefonla Barkod Okut**. Ekranda bir QR kodu çıkar;
2 dakika geçerlidir, süresi dolarsa **Yeni QR oluştur**.

**4. Telefonda:** kamera uygulamasıyla QR'ı okutun, açılan sayfada kameraya izin verin. QR
okunmazsa paneldeki adresi telefonda elle açın. Bilgisayarda "Telefon bağlı ✓" görünür.

**5. Okutma ve kayıt:** barkodu telefon kamerasına tutun. Ürün bilgisayardaki giriş/çıkış
formunda açılır; miktarı ve sebebi bilgisayarda girip **Kaydet**'e basın, stok ancak o zaman
değişir. Sonraki ürün için telefonda **Sonraki Ürünü Tara**. Bilgisayardaki formu
değiştirdiyseniz yeni okuma formu ezmez, panelde bildirilir.

**Bitirince:** bilgisayarda **Bağlantıyı kes**, tünel penceresini ve ardından sunucuyu
Ctrl+C ile kapatın.

## Sık karşılaşılan sorunlar

| Sorun | Ne yapın |
|---|---|
| "Node.js bulunamadı" ya da "Node.js vXX uygun değil" | [nodejs.org](https://nodejs.org)'dan 22, 23 ya da 24 kurun, sonra `BASLAT.bat`'ı yeniden çalıştırın |
| "Ne çalışan bir Postgres ne de Docker bulundu" | Docker Desktop'ı açın, çalışır duruma gelmesini bekleyip tekrar çift tıklayın. 5433'te kendi PostgreSQL'iniz varsa `.env`'deki `DATABASE_URL` ve `MIGRATION_DATABASE_URL`'i ona göre düzenleyin |
| Port 3000 kullanımda (`EADDRINUSE`) | Başka bir `BASLAT.bat`, `pnpm demo` ya da `next start` penceresi açık olabilir; onu Ctrl+C ile kapatın. Hangi işlemin kullandığını görmek için PowerShell'de `netstat -ano \| findstr :3000` |
| "pnpm kurulamadı" | Başlatıcının hata mesajındaki `npm install -g pnpm@…` komutunu elle çalıştırın, sonra yeni bir pencerede tekrar deneyin |
| Telefonda kamera açılmıyor | Adres `https://` ile başlamalı (tünel adresi). "Kamera izni verilmedi" yazıyorsa tarayıcının site ayarlarından kamera izni verin; "başka bir uygulama kullanıyor" yazıyorsa o uygulamayı kapatın |
| QR bağlantısı çalışmıyor | Sunucu `ENABLE_PHONE_SCANNER = 'true'` ile `next start` olarak açık olmalı (bayraksız `/tara` 404 verir); tünel penceresi açık olmalı; "Telefon adresi" alanı `https://` ile başlamalı. QR 2 dakika ve tek kullanımlıktır: **Yeni QR oluştur**. Sunucu yeniden başladıysa eşleşme düşmüştür, yeni QR oluşturun |

## Temel özellikler

- **Giriş / çıkış**: barkod (USB okuyucu ya da elle) → ürün ve mevcut stok →
  miktar + sebep; koli barkodunda çarpan uygulanır
- **Telefonla okutma (pilot, varsayılan kapalı)**: telefon kamerasıyla okunan barkod
  laptopta aynı giriş/çıkış ekranında açılır; stok yalnız laptopta Kaydet'le değişir
- **Kasa açığı kontrolü**: liste fiyatından sapan satışta sebep zorunlu; fark gün
  sonu raporunda kullanıcı bazında
- **Stok tablosu**: Türkçe arama (`ısıtıcı` → `Isıtıcı Şerit`), kategori / kritik / arşiv filtreleri
- **Hareket logu**: kim, ne zaman, neden; çalışan yalnız kendi kayıtlarını görür
- **Ürün yönetimi**: çoklu barkod, arşivleme, Excel/CSV toplu aktarma (önizleme + hata raporu; "Açılış Stoğu" sütunuyla devir)
- **Raporlar**: stok ve hareket Excel'i; büyük raporlar e-postayla
- **Kullanıcılar ve roller**: yönetici / çalışan; alış fiyatı çalışana gösterilmez
- **Sistem sağlığı**: defter tutarlılığı, iş kuyruğu, hareketsizlik
- **Kiracı izolasyonu**: PostgreSQL Row Level Security ile veritabanı seviyesinde

Mobil uygulama ve dış REST API henüz yok.

## Teknoloji

pnpm monorepo · TypeScript · Next.js 16 (App Router, Turbopack) · React 19 ·
Tailwind 4 · PostgreSQL 17 + RLS · Drizzle ORM · zod · jose (JWT) · exceljs ·
nodemailer · Vitest (gerçek PostgreSQL ile) · Playwright · Biome.

```
packages/shared   sözleşme: zod şemaları, sebep/rol/birim/fiyat sözlükleri, hata kodları
packages/db       şema, migration'lar, RLS, bağlantılar, seed, test altyapısı
packages/core     iş mantığı: tek yazma kapısı, auth, yetki, import/export, cron
apps/web          Next.js arayüzü
```

## Kurulum ayrıntıları ve yönetici komutları

Windows'ta en kolay yol yukarıdaki "Hızlı başlangıç". Gerekenler: Node 22 (`.nvmrc`;
22–24 desteklenir), pnpm 11, PostgreSQL 17. Docker zorunlu değil.

**Tek komut (demo):**

```bash
pnpm demo
```

`BASLAT.bat`'ın da çalıştırdığı komut. Veritabanını hazırlar (Docker varsa kaldırır;
5433'te kendi PostgreSQL'iniz varsa onu kullanır), şemayı uygular, veritabanında hiç ürün
yoksa örnek veriyi yükler ve sunucuyu `http://localhost:3000`'de açar. Windows
(CMD/PowerShell), macOS ve Linux'ta aynı komut. Veriyi sıfırlayıp yeniden yüklemek için
`pnpm demo --seed`. Seed yalnız yerel veritabanında çalışır ve kendi demo verisi dışında bir
işletme bulursa hiçbir şey silmeden durur. `.env` uzak bir veritabanını gösteriyorsa
`pnpm demo` hiçbir adımı uygulamadan durur.

**Adım adım:**

```bash
pnpm install
docker compose up -d                # veya 5433 portunda kendi PostgreSQL'iniz
pnpm --filter @stok/db run init     # pg_trgm eklentisi + stok_app rolü (idempotent)
pnpm --filter @stok/db run migrate
pnpm --filter @stok/db run seed     # DİKKAT: bütün veriyi siler; uzak hedefte ve başka işletme varken çalışmaz
pnpm --filter @stok/web run dev
```

`.env` yoksa `.env.example` dosyasını `.env` adıyla kopyalayın (`pnpm demo` bunu
kendisi yapar, `AUTH_SECRET`'e rastgele bir anahtar yazar ve var olan `.env`'e
dokunmaz). Sunucu, `DATABASE_URL` veya `AUTH_SECRET` eksik ya da geçersizse
açılmaz ve neyin eksik olduğunu konsola yazar. Örnek `AUTH_SECRET` yerel
geliştirmede çalışır, üretim modunda (`next start`) reddedilir.

Docker veritabanı yalnız bu makineden erişilebilir (`127.0.0.1:5433`); yerel ağdaki
başka bir cihaz bağlanamaz. `.env.example` bu yüzden `127.0.0.1` kullanır. Eski bir
`.env`'de `localhost:5433` yazıyorsa uygulama yine bağlanır (Node `::1` reddedilince
IPv4'e geçer), ama başka veritabanı araçları için adresi `127.0.0.1` yapın.

**Yeni işletme ve ilk yöneticisi:**

```bash
pnpm tenant:create
```

İşletme adı, yönetici adı ve e-postası sorulur; parola üretilir ve yalnız bir kez
gösterilir. Yazmadan önce hedef veritabanı (YEREL/UZAK) ve içindeki işletme sayısı
gösterilir, "evet" yazılmadan hiçbir şey yazılmaz. `MIGRATION_DATABASE_URL`'deki
veritabanına yazar.

**Docker veritabanını tamamen sıfırlamak** (volume'ü ve içindeki bütün
veritabanlarını siler; örnek veriyi yenilemek için `pnpm demo --seed` yeterli):

```bash
pnpm db:reset --dry-run                                  # salt okunur ön kontrol, kesinti yok
pnpm db:reset --confirm-volume=<volume-adı>              # volume adı ön kontrol çıktısında yazar
```

Onaysız `pnpm db:reset` yalnız kullanımı yazar. Gerçek sıfırlama kapsayıcıyı
durdurur, volume'ü ağı olmayan geçici bir kapsayıcıda yeniden inceler ve ancak
küme tanınırsa siler: yalnız `stok`, `postgres` ve şablonlar; bilinen roller ve
uygulama tabloları. Başka bir veritabanı (`pnpm test`'in bıraktığı `stok_test_*`
dahil), rol, şema ya da tablo varsa hiçbir şey silmeden durur ve kapsayıcıyı
yeniden açar; gözden çıkarılabilirse onları önce kendiniz silin. `stok`'ta demo
dışı işletme varsa ayrıca `--wipe-non-demo-data=stok` gerekir.

**Yerel yedek** (Docker kurulumu):

```bash
pnpm db:backup             # doğrulanmış döküm alır
pnpm db:backup --status    # dizini okur; Docker'a gitmez, hiçbir şey yazmaz
```

Döküm compose `db` kapsayıcısındaki `stok` veritabanından alınır; uygulamanın
`DATABASE_URL`'i başka bir veritabanını gösteriyorsa komut reddeder. Varsayılan dizin
Windows'ta `%LOCALAPPDATA%\stok\yedek`; değiştirmek için tam yolla `STOK_BACKUP_DIR`
(PowerShell: `$env:STOK_BACKUP_DIR = 'D:\yedek\stok'`). Repo içi, OneDrive altı, göreli
ve ağ yolları reddedilir. Döküm ancak içindekiler tablosu ve baştan sona okuma geçince
son adını (`stok-<UTC damga>Z.dump`) ve `.sha256`'sını alır; en yeni 14 tanesi tutulur,
silme yalnız başarılı yedekten sonra yapılır. `--status` yalnız en yeni dökümün
SHA-256'sını yeniden hesaplar. Bu komut geri yükleme denemez; geri yüklenebilirlik ayrı
tatbikatla kanıtlanır.

Döküm şifresizdir ve bütün işletmelerin verisini (parola özetleri ve alış fiyatları dahil)
içerir: dizini yalnız sizin hesabınız okuyabilmeli. Claude masaüstü uygulaması gibi
paketli bir uygulamanın terminalinden çalıştırılırsa varsayılan dizin uygulamanın özel
klasörüne yönlenebilir (uygulama kaldırılınca silinir); komut bunu yazar. Kalıcı yedek
için normal bir terminal kullanın.

`--filter` ile çağırırken **`run` kelimesi zorunlu**: onsuz pnpm, Windows'ta
`'migrate' is not recognized` hatası verir.

**Gün sonu turunu elle tetiklemek** (`.env`'de `CRON_SECRET` tanımlı olmalı):

```bash
curl -X POST -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron
```

## Test ve kalite kapıları

| Komut | Ne yapar |
|---|---|
| `pnpm lint` | Biome |
| `pnpm typecheck` | Dört paketin tip kontrolü |
| `pnpm test` | Birim + entegrasyon. Gerçek PostgreSQL gerekir; her paket kendi `stok_test_*` veritabanını sıfırdan kurar. `db:reset` ve `db:backup` testleri Docker ister ve kendi geçici compose projelerini açıp siler |
| `pnpm --filter @stok/db exec drizzle-kit generate` | Şema ile migration'lar senkron mu ("No schema changes" beklenir) |
| `pnpm --filter @stok/web run build` | Üretim derlemesi |
| `pnpm --filter @stok/web run test:e2e` | Playwright; önce build gerekir, port 3000 boş olmalı, demo veritabanını kullanır |
| `pnpm db:up` | Docker veritabanını aç ve hazır olana kadar bekle |
| `pnpm db:reset --dry-run` / `--confirm-volume=<ad>` | Volume'ü sıfırlamadan önce salt okunur kontrol / doğrulanmış sıfırlama (yukarıda) |
| `pnpm db:backup` / `--status` | Doğrulanmış yerel yedek / yedek dizininin durumu (yukarıda) |

CI (GitHub Actions): lint, typecheck, gerçek PostgreSQL ile testler, migration
drift, derleme, temiz checkout'tan `pnpm demo` + `pnpm db:backup` + Playwright, ve
Windows'ta lint/typecheck/derleme.

## Ortam değişkenleri

Tam liste ve açıklamalar `.env.example`'da.

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `DATABASE_URL` | evet | Uygulama bağlantısı, `stok_app` rolü (RLS uygulanır) |
| `MIGRATION_DATABASE_URL` | migration, seed, `tenant:create` için | Tablo sahibi (RLS'i atlar). **Uygulama çalışma ortamına konmaz** |
| `AUTH_SECRET` | evet | JWT imza anahtarı, en az 32 karakter; üretme komutu `.env.example`'da. Depodaki örnek değerlerle üretim modu açılmaz |
| `APP_URL` | önerilir | Oturum çerezinin `Secure` bayrağı bu adresin şemasından türer; üretimde `https://` |
| `CRON_SECRET` | cron için | En az 32 karakter; tanımsızsa `/api/cron` kapalı |
| `SMTP_URL`, `REPORT_FROM_EMAIL` | e-posta için | Rapor ve alarm e-postaları |
| `DB_POOL_MAX`, `DB_IDLE_TIMEOUT` | serverless'ta | Havuz boyutu ve boşta kapanma süresi |
| `ENABLE_PHONE_SCANNER` | pilot | `true` iken telefonla okutma açık (`/tara`, `/api/tara/*`, `/hareket` paneli); yalnız `true`/`false`. Varsayılan kapalı |
| `STOK_BACKUP_DIR` | yedek için | `pnpm db:backup` dizini, tam yol. Windows'ta varsayılan `%LOCALAPPDATA%\stok\yedek`; başka platformda zorunlu. Boş değer reddedilir |

`NODE_ENV` bilerek tanımlanmaz: Next kendisi ayarlar.

## Dokümantasyon

- [`PROJECT_BRAIN.md`](PROJECT_BRAIN.md): amaç, mimari, veri modeli, invariant'lar
- [`CURRENT_STATE.md`](CURRENT_STATE.md): güncel durum
- [`DECISIONS.md`](DECISIONS.md): geçerli kararlar · [`docs/ADR/`](docs/ADR/): karar gerekçeleri
- [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md): tehdit modeli ve korumalar
- [`docs/designs/`](docs/designs/): henüz uygulanmamış özelliklerin aktif tasarımları
- [`TODOS.md`](TODOS.md): backlog
- [`docs/uretim-runbook.md`](docs/uretim-runbook.md): üretime alma (Vercel + Supabase)
- [`docs/archive/`](docs/archive/): tarihsel plan ve inceleme kayıtları
