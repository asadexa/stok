# CURRENT_STATE

Yalnız BUGÜNÜN gerçeği. Her merge'te ya da durum değiştiğinde güncellenir; eski
satırlar silinir (tarihçe git'te). Ayrıntı yazılmaz: işler → `TODOS.md`,
kararlar → `DECISIONS.md`, model → `PROJECT_BRAIN.md`.

**Tarih:** 2026-10-19 · **Çalışma branch'i:** `development` · **Stabil referans:** `master`
(`master` = `dac05ff`, devralma öncesi son kod; geliştirme `development`'ta yapılır)

## Deploy

**Hiç yapılmadı.** Vercel/Supabase hesabı yok; GitHub'da deployment, environment
ya da release kaydı yok. Kod tarafı hazırlığı (vercel.json, `/api/v1/health`,
runbook) var; önkoşullar TODOS T42.

## Doğrulanmış baseline — 2026-10-10, WS-C-lite (`dcf46d1`), Windows 11, Node 24.20

| Kontrol | Sonuç |
|---|---|
| lint (Biome) | PASS — 196 dosya, 0 tanı |
| typecheck (4 paket) | PASS |
| test | PASS — **872/872** (shared 69, db 85, core 550, web 168), yerel saat 14:3x, `TZ` zorlanmadan |
| migration drift | PASS — "No schema changes", dosya üretilmedi |
| `next build` | PASS — 29 rota |
| Playwright | PASS — **24/24** |

Yerel saatle 00:00–03:00 arasında `cron.test.ts`'in üç testi kırmızı: T122'nin
yeniden üretimi (yerel UTC+3, DB UTC); `TZ=UTC` ile yeşil.

Excel saatleri (WS-C-lite, gerçek tarayıcı, `next dev`): `/hareketler` bugünün
filtresiyle "Excel'e aktar 16 satır" → 16 satırlık dosya; her "Tarih" hücresi DB
`created_at`'in Europe/Istanbul duvar saati (UTC'de 9 Ekim 22:33 olan satır
`10.10.2026 01:33`), dosya adı `hareket-20261010-1439.xlsx`.

İçe aktarma, 2.000 satır (ayrı test veritabanı): devirli ilk koşu 47,1 sn, tekrar
32,5 sn (ikinci devir yazılmadı), önizleme 125–305 ms; devirsiz taban 23,5 sn (T171).

Gerçek cihaz kabulü (WS-SCAN, iPhone Safari, HTTPS tünel, laptop `next start`):
gerçek barkod telefon kamerasıyla okunuyor, ürün laptopta `/hareket`te açılıyor,
Kaydet ile stok güncelleniyor, aynı ürün yeniden okutulabiliyor, kirli form
koruması çalışıyor, "Bağlantıyı kes" telefon oturumunu kapatıyor. Android
denenmedi. Yerelde ayrıca Edge + sahte kamera aygıtı + sentetik EAN-13 ile
uçtan uca geçti (kamera yolu CI'da yok: T169).

T196 düzeltmesi (2026-10-16, yerel): lint 209 dosya 0 tanı, typecheck (4 paket), test **1096/1096**
(shared 69, db 309, core 550, web 168; Docker'lı `db-reset`, `db-reset-target` ve `backup`
testleri geçici compose projeleriyle), drift "No schema changes", `next build` PASS.
Playwright WS-1.1'den beri koşulmadı (arayüz değişmedi; e2e demo veritabanına yazıyor, T150);
son e2e sonucu yukarıdaki 24/24.

GitHub CI: son koşu #82 (`93b38f6`, 2026-10-18) yeşil (GitHub API'den okundu, iş ayrıntısı
görülmedi). Önceki ayrıntılı kayıt: `development` `8a96c74` (T196) koşu #75 yeşil; üç iş de geçti, demo işindeki "Yedek ve
durum" adımı artık başarı satırlarını da arıyor (test sayıları herkese açık API'de görünmüyor).
Öncesinde `1e47741` (WS-1.3a test düzeltmesi) koşu #73 yeşil; üç iş de geçti
(typecheck + test, Windows lint + typecheck + derleme, demo yolu). Test işinin günlüğünde
`backup.test.ts` 8/8, `backup-policy.test.ts` 78/78, `@stok/db` 294/294; demo işinde "Yedek ve
durum" adımı (`pnpm db:backup` ve `--status`) yeşil. Öncesinde `4fef58f` (#71) yeşil, `94c1151`
(#72) kırmızıydı: `backup.test.ts`'in hazırlığı migration'da `ECONNRESET` aldı, 8 test atlandı.
Neden test düzeneğiydi (geçici compose projesi bekleme betiğine aktarılmıyordu, Linux
`docker-proxy`'si portu PostgreSQL hazır olmadan kabul etti); `1e47741` ortamı aktarıp migration'dan
önce `SELECT 1` kapısı ekledi. Ortak `wait-for-db.mjs`'te kalan benzer pencere: T195.
`581f291` (#68) ilk denemede
Linux web derlemesinde Turbopack font çözümleme hatasıyla kırmızıydı, ikinci deneme yeşil; kök
neden bilinmiyor, tekrar ederse ayrı incelenecek. master'daki son koşu #44 (2026-09-14) yeşil.
9 Dependabot PR açık, 3'ü kırmızı (T140).

## Çalışan ana kapsam (web)

Giriş · panel · stok tablosu (Türkçe arama) · barkodla elle hareket girişi ve
fiyat defteri · hareket logu · ürün/barkod yönetimi · Excel/CSV ürün aktarma
(açılış stoğuyla, `DAT-18`) · birim hassasiyeti (`DAT-17`) ·
Excel export · kullanıcı yönetimi · ayarlar · kategoriler · raporlar · sistem
sağlığı · Ctrl+K · bildirim zili. RLS çok kiracılı veri katmanı, append-only
defter, kaba kuvvet kilidi, elle tetiklenen `/api/cron`, `/api/v1/health`,
`pnpm demo` (Windows/macOS/Linux). Pilot, varsayılan kapalı: telefon kamerasıyla
okutup `/hareket`te açma (`ENABLE_PHONE_SCANNER`, `PRD-12`, `ARC-14`).

## Kısmi / bozuk

- **Gün sonu raporu**: saatlik zamanlamada günün ilk turunda boş günü raporluyor (T121).
- **Saat dilimi**: tanımsız; UTC'de gün sınırları kayar (T122). Excel hücreleri ve
  dosya adı WS-C-lite'tan beri sabit Europe/Istanbul; ekran saati, tarih filtresinin
  gün sınırı ve cron hâlâ sunucu saatine bağlı.
- **Çok kiracıda aynı e-posta**: web'de giriş çıkmazı (T123).
- **Sağlık alarmı**: bir kez FAILED olan iş kalıcı, alarm her saat tekrar eder (T126).
- **Düzeltme / ters hareket**: akış yok (T127).
- **İçe aktarma**: büyük dosya tek istekte uzun sürüyor (2.000 devirli satır 47 sn; T171);
  devirde geçmiş tarihli fiyat yok (T172); birim değişimi sonrası eski veri denetlenmiyor (T170).
- **Ürün görseli**: yalnız URL; yükleme yok (T136).
- **Kritik stok**: yalnız e-posta, push yok.
- **Konum yönetimi**: arayüz yok.
- **Mobil ve `/api/v1` REST**: yok (Faz 5, en sona bırakıldı).
- **Telefonla okutma pilotu**: oturum süreç belleğinde (yeniden başlatmada düşer,
  yalnız tek süreçli `next start`, `ARC-14`); tünel açıkken bütün uygulama dışarıda
  (T167); UPC-A 12/13 hane ölçülmedi (T168).
- **Ağ açıklığı**: veritabanı portu yalnız `127.0.0.1` (WS-1.1, S19), ama parolalar repodaki
  varsayılanlar; uygulama sunucusu (`next start`) yerel ağda HTTP ile açık (T183).
- **Yedek / geri yükleme**: yerel yedek var (`pnpm db:backup`, WS-1.3a, `OPS-10`): içindekiler +
  tam okuma + SHA-256 ile doğrulanmış döküm, son 14 tanesi saklanıyor, `--status` durumu
  gösteriyor. Geri yükleme tatbikatı (WS-1.4) ve zamanlama (WS-1.3b) yok; dökümün geri
  yüklenebilirliği henüz kanıtsız. Döküm şifresiz (S20). Paketli bir uygulamanın (Claude
  masaüstü) terminalinden varsayılan dizin uygulamanın özel klasörüne yönleniyor (komut
  uyarıyor); normal terminalde varsayılan dizin doğrulandı (T192, 2026-10-16).

## P0 / P1 blocker'lar

| ID | Konu |
|---|---|
| T120 (P0) | Repo / IP / hesap sahipliği; repo public ve lisanssız |
| T121 | Cron gün sonu raporu semantiği |
| T122 | Saat dilimi politikası (`DAT-16` Open) |
| T123 | `TENANT_AMBIGUOUS` çıkmazı + kiracılar arası kilitleme (`SEC-14` Open) |
| T124 | Supabase SECURITY DEFINER yetkileri — deploy öncesi doğrulama |
| T126 | Kalıcı FAILED işler / alarm tekrarı |
| T127 | Düzeltme (ters hareket) akışı |
| T129 | Harici izleme + yedek geri yükleme tatbikatı |
| T167 | Telefon pilotunun tüneli bütün uygulamayı internete açıyor |

Kullanıcı kararı bekleyen `Open` kararlar: `DECISIONS.md`'de `Open` olarak
işaretli (öne çıkanlar `DAT-15`, `DAT-16`, `SEC-14`, `OPS-01`, `OPS-02`, `UX-04`, `UX-08`).

## Son tamamlanan workstream

**WS-1.3a — Doğrulanmış yerel yedek** (2026-10-16, `OPS-10`): `pnpm db:backup` compose `db`'deki
`stok`'u `pg_dump` ile akışla `.partial`'a alıyor; içindekiler (`dbname`, beş temel tablonun TABLE ve
TABLE DATA girdileri) ve baştan sona okuma geçmeden döküm son adını ve `.sha256`'sını almıyor.
`pg_restore --list` tek başına yetmiyor: kesik ve baytı bozulmuş arşivi geçirdi (M1 ölçümü). Kaynak
yalnız yerel Docker ve uygulamanın `DATABASE_URL`'inin gösterdiği veritabanı; dizin kuralı repo içi,
OneDrive, göreli ve ağ yollarını reddediyor; saklama yalnız başarılı koşudan sonra, son 14.
`--status` "kayıtlı" ile "şimdi doğrulanan"ı (yalnız en yeni, SHA-256) ayırıyor. Commit'ler:
`4fef58f` hazırlık (Docker katmanı `db-reset.ts`'ten `docker.ts`'e taşındı, `db:reset` çıktısı
bayt bayt aynı), `94c1151` yedek, `1e47741` test hazırlığı düzeltmesi; CI #73 yeşil. Ayrıntı:
`SECURITY_MODEL` S20, README. Bağımsız REVIEW: PASS WITH RISKS; bulgusu T196 (CLI'ın bağlantılı ya
da uzantısız yoldan sessizce 0 dönmesi) düzeltildi. Açık: T190 (1.3b'den önce), T191, T193–T195,
T197–T199.

Öncesinde **WS-1.2b — Güvenli `db:reset`** (`b12f5b3`, CI #70): volume adıyla onay, ağsız
geçici kapsayıcıda izole inceleme, yalnız tanınan kümede silme. Geliştirme volume'ünde ön kontrol
`stok_test_*` veritabanları yüzünden reddediyor (beklenen). Ayrıntı: `SECURITY_MODEL` S12.

## Sıradaki workstream

**Yol haritasının üstü** (ekip kararı, 2026-10-17), bu sırayla:
1. **T200 B2B V1 PLAN** (`PRD-14`): ✓ kullanıcı onaylı (2026-10-19; `PRD-15`, `DAT-19`, ADR-006).
2. **T200 ilk BUILD dilimi**: 1a çekirdek (shared, db migration 0012, core, testler) yerelde bitti,
   commit bekliyor; arayüz yok. 1b ekranlar ve e2e sırada. Ayrıntı F-12.
3. **HTTPS test ortamı** (T144, `OPS-12`): yakın adım, B2B'yi geciktirmez. Barındırma `OPS-01`
   (Open); üretim ayrı iş (T42).
4. **T201 harici API kaynağı**: V1'in devamı. Gerçek sağlayıcı seçilmeden genel entegrasyon
   iddia edilmez.
Özellik kayıtları `docs/TEKNIK_SARTNAME.md` F-12, F-13. Diğer P1 işler ve güvenlik/veri koruma
gereklilikleri olduğu gibi geçerli.

**WS-1 — Güvenlik ve Veri Koruma** (kullanıcı onaylı R-1 planı, 2026-10-13; kalan dilimler ve
öncelikleri korunuyor): sıra
1.1 ✓ → 1.2a ✓ → 1.2b ✓ → 1.3a ✓ (yedek) → **1.4 (geri yükleme tatbikatı)** → 1.3b (zamanlama);
ayrı şerit 1.5a/1.5b (tünel kapısı, T167). Her dilim ayrı onayla başlar. R-1'in 1.5b'si de var
olmayan `scripts/pilot.mjs`'e dayanıyor; kendi planında yeniden değerlendirilecek.
**Pilot ortamı** (`OPS-11`): doğrulanmış yedek ve geri yükleme tatbikatı pilot laptopunda yeşil
geçmeden oraya hiçbir WS-1 değişikliği uygulanmaz; tatbikat henüz yok. Tam saat dilimi işi (T122,
`DAT-16`) bulut öncesi ayrıca.

## Production blocker düzeltmeleri

1. Önce kararlar: `DAT-16` (saat dilimi), `SEC-14` (e-posta tekilliği).
2. Sonra T121 + T122 → T126 → T124 → T123. Her biri minimum değişiklik
   + test + `dogrula`.

Paralelde, insan işi ve kod dışı: T120 (sahiplik), T140 (Dependabot triyajı +
branch koruması + zorunlu CI kontrolleri).

Ardından ürün hazırlığı (T127; kapsam kararıyla), en son üretim deploy'u (T42, T129). Çevrim
içi test ortamı (T144) P1'e çıktı; önkoşulu (T124) ve bilinen sınırları T144 kaydında.
