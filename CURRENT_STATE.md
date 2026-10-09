# CURRENT_STATE

Yalnız BUGÜNÜN gerçeği. Her merge'te ya da durum değiştiğinde güncellenir; eski
satırlar silinir (tarihçe git'te). Ayrıntı yazılmaz: işler → `TODOS.md`,
kararlar → `DECISIONS.md`, model → `PROJECT_BRAIN.md`.

**Tarih:** 2026-10-10 · **Çalışma branch'i:** `development` · **Stabil referans:** `master`
(`master` = `dac05ff`, devralma öncesi son kod; geliştirme `development`'ta yapılır)

## Deploy

**Hiç yapılmadı.** Vercel/Supabase hesabı yok; GitHub'da deployment, environment
ya da release kaydı yok. Kod tarafı hazırlığı (vercel.json, `/api/v1/health`,
runbook) var; önkoşullar TODOS T42.

## Doğrulanmış baseline — 2026-10-10, WS-B (`e1dc9a1`), Windows 11, Node 24.20

| Kontrol | Sonuç |
|---|---|
| lint (Biome) | PASS — 195 dosya, 0 tanı |
| typecheck (4 paket) | PASS |
| test | PASS — **856/856** (shared 69, db 85, core 540, web 162), `TZ=UTC` ile |
| migration drift | PASS — "No schema changes", dosya üretilmedi |
| `next build` | PASS — 29 rota |
| Playwright | PASS — **24/24** |

Yerel saatle 00:00–03:00 arasında `cron.test.ts`'in üç testi kırmızı: T122'nin
yeniden üretimi (yerel UTC+3, DB UTC), WS-B'den bağımsız; `TZ=UTC` ile yeşil.

İçe aktarma, 2.000 satır (ayrı test veritabanı): devirli ilk koşu 47,1 sn, tekrar
32,5 sn (ikinci devir yazılmadı), önizleme 125–305 ms; devirsiz taban 23,5 sn (T171).

Gerçek cihaz kabulü (WS-SCAN, iPhone Safari, HTTPS tünel, laptop `next start`):
gerçek barkod telefon kamerasıyla okunuyor, ürün laptopta `/hareket`te açılıyor,
Kaydet ile stok güncelleniyor, aynı ürün yeniden okutulabiliyor, kirli form
koruması çalışıyor, "Bağlantıyı kes" telefon oturumunu kapatıyor. Android
denenmedi. Yerelde ayrıca Edge + sahte kamera aygıtı + sentetik EAN-13 ile
uçtan uca geçti (kamera yolu CI'da yok: T169).

GitHub CI: `development` `e1dc9a1` (WS-B) koşu #60 yeşil.
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
- **Saat dilimi**: tanımsız; UTC'de gün sınırları kayar (T122).
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

**WS-B — Birim hassasiyeti + içe aktarmada açılış stoğu** (`e1dc9a1`, CI #60):
adet tam sayı, efektif miktarda ve `createMovement`'ta (T130, `DAT-17`); `1e-7` artık
500 değil anlaşılır hata. İçe aktarmada "Açılış Stoğu" sütunu, devir `createMovement`
ile OPENING, yalnız ilk hareket olarak ve ürün başına tek (T128, `DAT-18`). Migration yok.

Öncesinde WS-SCAN (`2dd09cd`, CI #58): telefon kamerası → laptop `/hareket`
(`PRD-12`, `ARC-14`, S18); gerçek iPhone kabul testi geçti (baseline'a bak).

## Sıradaki workstream: WS-C-lite

Saha testinde görülebilecek export/Excel saat sorunu. Tam saat dilimi işi (T122,
`DAT-16`) bulut öncesi ayrıca.

## Production blocker düzeltmeleri

1. Önce kararlar: `DAT-16` (saat dilimi), `SEC-14` (e-posta tekilliği).
2. Sonra T121 + T122 → T126 → T124 → T123. Her biri minimum değişiklik
   + test + `dogrula`.

Paralelde, insan işi ve kod dışı: T120 (sahiplik), T140 (Dependabot triyajı +
branch koruması + zorunlu CI kontrolleri).

Ardından ürün hazırlığı (T127; kapsam kararıyla), en son staging deploy
(T42, T129, T144).
