# CURRENT_STATE

Yalnız BUGÜNÜN gerçeği. Her merge'te ya da durum değiştiğinde güncellenir; eski
satırlar silinir (tarihçe git'te). Ayrıntı yazılmaz: işler → `TODOS.md`,
kararlar → `DECISIONS.md`, model → `PROJECT_BRAIN.md`.

**Tarih:** 2026-10-13 · **Çalışma branch'i:** `development` · **Stabil referans:** `master`
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

WS-1.2b (2026-10-14, yerel): lint 201 dosya 0 tanı, typecheck, test **991/991** (shared 69,
db 204, core 550, web 168; `db-reset.test.ts` gerçek Docker'da geçici projeyle ~115 sn), drift
"No schema changes", `next build` PASS. Playwright WS-1.1'den beri koşulmadı (arayüz değişmedi;
e2e demo veritabanına yazıyor, T150); son e2e sonucu yukarıdaki 24/24. GitHub CI sonucu
commit'ten sonra yazılır.

GitHub CI: `development` `aab203b` (PRD-13) koşu #69 yeşil; üç iş de geçti (typecheck + test,
Windows lint + typecheck + derleme, demo yolu). `581f291` (T187/T186) koşu #68 ilk denemede Linux
web derlemesinde Turbopack font çözümleme hatasıyla kırmızı, aynı commit'in ikinci denemesi yeşil;
kök neden bilinmiyor, tekrar ederse ayrı incelenecek. Doğrulama: GitHub API, 2026-10-14.
master'daki son koşu #44 (2026-09-14) yeşil.
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
- **Yedek / geri yükleme**: yerel yedek aracı ve tatbikat yok (WS-1.3a, WS-1.4); `pnpm db:reset`
  artık doğrulanmış ve onaylı (WS-1.2b), ama yedek gelene kadar volume silme geri alınamaz.

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

**WS-1.2b — Güvenli `db:reset`** (2026-10-14): `docker compose down -v` kaldırıldı.
Onaysız çağrı yalnız kullanım yazar; `--dry-run` canlı ve salt okunur ön kontrol yapar; gerçek
sıfırlama volume adıyla onay ister, kapsayıcıyı durdurup volume'ü ağsız geçici kapsayıcıda inceler,
ancak küme tanınırsa (yalnız `stok`/`postgres`/şablonlar, bilinen rol ve uygulama tabloları) ve
hedef değişmediyse siler; aksi halde kapsayıcıyı geri açar. Geliştirme volume'ünde ön kontrol
`stok_test_*` veritabanları yüzünden reddediyor (beklenen). Ayrıntı: `SECURITY_MODEL` S12, README.

Öncesinde **T187 + T186 — Silme hedefinin doğrulanması** (2026-10-13): hedef adresten
kesin okunamıyorsa (sorgu parametresi, `%` kodlu ad, eksik port) yerel sayılmıyor; seed silmeden
önce bağlanılan veritabanını yazılan adla ve tablolarının `public`'e çözüldüğünü karşılaştırıyor;
`tenant:create` gösterilen ile bağlanılan veritabanı ayrışınca duruyor. Uzak hedef testi artık
gerçekten erişilebilir bir adresle ve bağlantı sayacıyla sınıyor. Ayrıntı: TODOS T187, T186,
`SECURITY_MODEL` S12. Açık kalan: T188 (P2, gerçek pilotta yeni kiracıdan önce).

Öncesinde **WS-1.2a — Ortak silme kuralı** (`59e4d9f`, CI #67): seed'in silme kapısı yan etkisiz
`packages/db/src/wipe-guard.ts`'e taşındı (demo kiracı kimlikleri ve saf karar); seed sorguyu
kendisi yapıyor ve mesajları birebir aynı. Bilinçli tek sıkılaştırma: adreste veritabanı adı
yoksa ve onay boşsa silme reddediliyor (T185). `db:reset` henüz bu kuralı kullanmıyor (WS-1.2b).
Ayrıntı: TODOS T185, `SECURITY_MODEL` S12. WS-1.1'den (`42486cc`) açık doğrulama: başka bir
cihazdan 5433 denemesi yapılmadı (T184).

## Sıradaki workstream

**WS-1 — Güvenlik ve Veri Koruma** (kullanıcı onaylı R-1 planı, 2026-10-13): sıra
1.1 ✓ → 1.2a ✓ (ortak silme kuralı) → 1.2b ✓ (güvenli `db:reset`) → 1.3a (yedek) →
1.4 (tatbikat) → 1.3b (zamanlama); ayrı şerit 1.5a/1.5b (tünel kapısı, T167). Her dilim ayrı onayla başlar.
**Pilot ortamı:** WS-1.3a yedeği ve WS-1.4 tatbikatı geliştirilip o makinede yeşil geçmeden
gerçek pilot laptopuna hiçbir WS-1 değişikliği uygulanmaz (ikisi de henüz yok). Tam saat dilimi
işi (T122, `DAT-16`) bulut öncesi ayrıca.

## Production blocker düzeltmeleri

1. Önce kararlar: `DAT-16` (saat dilimi), `SEC-14` (e-posta tekilliği).
2. Sonra T121 + T122 → T126 → T124 → T123. Her biri minimum değişiklik
   + test + `dogrula`.

Paralelde, insan işi ve kod dışı: T120 (sahiplik), T140 (Dependabot triyajı +
branch koruması + zorunlu CI kontrolleri).

Ardından ürün hazırlığı (T127; kapsam kararıyla), en son staging deploy
(T42, T129, T144).
