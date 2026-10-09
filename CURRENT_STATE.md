# CURRENT_STATE

Yalnız BUGÜNÜN gerçeği. Her merge'te ya da durum değiştiğinde güncellenir; eski
satırlar silinir (tarihçe git'te). Ayrıntı yazılmaz: işler → `TODOS.md`,
kararlar → `DECISIONS.md`, model → `PROJECT_BRAIN.md`.

**Tarih:** 2026-10-09 · **Çalışma branch'i:** `development` · **Stabil referans:** `master`
(`master` = `dac05ff`, devralma öncesi son kod; geliştirme `development`'ta yapılır)

## Deploy

**Hiç yapılmadı.** Vercel/Supabase hesabı yok; GitHub'da deployment, environment
ya da release kaydı yok. Kod tarafı hazırlığı (vercel.json, `/api/v1/health`,
runbook) var; önkoşullar TODOS T42.

## Doğrulanmış baseline — 2026-10-09, WS-A (`a230c18` üzerine), Windows 11, Node 24.20

| Kontrol | Sonuç |
|---|---|
| lint (Biome) | PASS — 174 dosya, 0 tanı |
| typecheck (4 paket) | PASS |
| test | PASS — **719/719** (shared 56, db 85, core 493, web 85), atlanan yok |
| migration drift | PASS — "No schema changes", dosya üretilmedi |
| `next build` | PASS — 24 rota |
| Playwright | PASS — **21/21** |

Ek duman testi: `pnpm tenant:create` ile ayrı test veritabanında açılan iki
sentetik işletmenin yöneticileri üretim derlemesinde (`next start`, rastgele
`AUTH_SECRET`) giriyor, ürün izolasyonu korunuyor; örnek sırlarla `next start`
açılmıyor; `pnpm demo --seed` ayrı veritabanında temizken geçiyor, pilot işletme
varken duruyor.

GitHub CI: `development` `a230c18` yeşil; master'daki son koşu #44 (2026-09-14)
yeşil. 9 Dependabot PR açık, 3'ü kırmızı (T140).

## Çalışan ana kapsam (web)

Giriş · panel · stok tablosu (Türkçe arama) · barkodla elle hareket girişi ve
fiyat defteri · hareket logu · ürün/barkod yönetimi · Excel/CSV ürün aktarma ·
Excel export · kullanıcı yönetimi · ayarlar · kategoriler · raporlar · sistem
sağlığı · Ctrl+K · bildirim zili. RLS çok kiracılı veri katmanı, append-only
defter, kaba kuvvet kilidi, elle tetiklenen `/api/cron`, `/api/v1/health`,
`pnpm demo` (Windows/macOS/Linux).

## Kısmi / bozuk

- **Gün sonu raporu**: saatlik zamanlamada günün ilk turunda boş günü raporluyor (T121).
- **Saat dilimi**: tanımsız; UTC'de gün sınırları kayar (T122).
- **Çok kiracıda aynı e-posta**: web'de giriş çıkmazı (T123).
- **Sağlık alarmı**: bir kez FAILED olan iş kalıcı, alarm her saat tekrar eder (T126).
- **Düzeltme / ters hareket**: akış yok (T127).
- **Açılış stoğu**: toplu girilemiyor (T128).
- **Birim hassasiyeti**: zorlanmıyor; çok küçük miktar 500 veriyor (T130).
- **Ürün görseli**: yalnız URL; yükleme yok (T136).
- **Kritik stok**: yalnız e-posta, push yok.
- **Konum yönetimi**: arayüz yok.
- **Mobil ve `/api/v1` REST**: yok (Faz 5, en sona bırakıldı).

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
| T128 | Açılış stoğu toplu girişi |
| T129 | Harici izleme + yedek geri yükleme tatbikatı |

Kullanıcı kararı bekleyen `Open` kararlar: `DECISIONS.md`'de `Open` olarak
işaretli (öne çıkanlar `DAT-15`, `DAT-16`, `SEC-14`, `OPS-01`, `OPS-02`, `UX-04`, `UX-08`).

## Son tamamlanan workstream

**WS-A — Güvenli kurulum**: `pnpm tenant:create` ile işletme + ilk yönetici
(T162), seed hedef koruması (T125), üretimde örnek `AUTH_SECRET` reddi ve
`pnpm demo`'nun rastgele anahtar üretmesi (T133). Parola kurtarma kapsam dışı (T163).
Öncesinde PRE (`a230c18`): CI `development`'ta da koşuyor, drift adımı fail closed (T131).

## Sıradaki workstream: WS-SCAN

Telefon kamerasıyla okutup dizüstündeki ekrana aktarma. Kapsamı henüz yazılı değil.

## Production blocker düzeltmeleri

1. Önce kararlar: `DAT-16` (saat dilimi), `SEC-14` (e-posta tekilliği).
2. Sonra T121 + T122 → T126 → T124 → T123. Her biri minimum değişiklik
   + test + `dogrula`.

Paralelde, insan işi ve kod dışı: T120 (sahiplik), T140 (Dependabot triyajı +
branch koruması + zorunlu CI kontrolleri).

Ardından ürün hazırlığı (T127, T128, T130; kapsam kararıyla), en son staging deploy
(T42, T129, T144).
