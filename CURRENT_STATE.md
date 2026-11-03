# CURRENT_STATE

Yalnız BUGÜNÜN gerçeği. Her merge'te ya da durum değiştiğinde güncellenir; eski
satırlar silinir (tarihçe git'te). Ayrıntı yazılmaz: işler → `TODOS.md`,
kararlar → `DECISIONS.md`, model → `PROJECT_BRAIN.md`.

**Tarih:** 2026-11-03 · **Depo:** `KeremGerede/stok` (eski adres `asadexa/stok` GitHub'da
yönlendiriliyor) · **Çalışma branch'i:** `development` · **Kararlı dal:** `main` (varsayılan dal).
İkisi de `c2f9805`. Dal modeli `OPS-13`: `master` fast-forward ile ilerletilip `main` olarak yeniden
adlandırıldı. Ruleset'ler: `main` PR, üç zorunlu CI işi, silme ve force-push yasağı; `development`
silme ve force-push yasağı; `backup/*` silme ve force-push yasağı. Yedek dallar
`backup/master-pre-migration` (`dac05ff`) ve `backup/development-pre-migration` (`5199069`).

## Deploy

**AWS Lightsail staging/demo (kullanıcı bildirimi, 2026-11-03; `OPS-14`):** uygulama Lightsail'de
çalışıyor; müşteri üretim ortamı değil. Sunucuda Git HEAD `f64e716`, yerel `development` dalında,
`origin/development`'ı izliyor; detached değil (kullanıcının sunucu terminalinden doğrulaması).
Çalışan Docker imajının kaynak commit'i **kanıtlanmadı** (imajda commit etiketi yok); sunucuda
otomatik çekme ya da dağıtım olmadığı **kanıtlanmadı**. Kalan sunucu doğrulamaları GitHub
geçişinden sonra. Bu repoda dağıtım kaydı, sürüm etiketi ya da deploy iş akışı yok. Otomatik şifreli S3 yedeği üzerinde çalışma sürüyor, tamamlanmadı. Üretim (gerçek
müşteri verisi) yok; önkoşullar TODOS T42. Vercel/Supabase hesabı yok.

**Docker staging hazırlığı (S1, 2026-10-28):** AWS Lightsail staging
(T144) için `Dockerfile`, `compose.production.yml` ve `.env.production.example` hazır.
Komutlar runbook "L" bölümünde. Doğrulama yerelde, Docker 29.9 linux/amd64 üzerinde,
boş bir test volume'üyle yapıldı:
- 16 migration uygulandı; 15 tablonun 15'inde RLS ve FORCE açık.
- `stok_app` rolünün superuser ve BYPASSRLS bayrakları false. Geliştirme parolası ağdan reddedildi.
- `/api/v1/health` 200 döndü.
- Gerçek tarayıcıda giriş, ürün, alış 10 ve satış 3 çalıştı: defter toplamı 7, projeksiyon 7.
- Kiracı bağlamı olmadan 0 satır görünüyor. Defterde UPDATE ve DELETE reddedildi.
- `APP_URL` https iken çerezler Secure. Örnek `AUTH_SECRET` ile açılış reddedildi.
- Portlar yayınlanmıyor. Veritabanının internete çıkışı yok.
- Bu doğrulama yereldi; sunucudaki kurulumun aynı adımlarla yapıldığı repodan doğrulanamıyor.

Barındırma kararı `OPS-01` hâlâ Open. Derleme Google Fonts'a bağımlı (T230).
S1 `4472fa5` olarak commit edildi; CI #94 yeşil (üç iş). Log döndürme `f64e716`, CI #95 yeşil.

**Caddy/HTTPS hazırlığı (S4.0 + S4.1, 2026-10-28, yerel):**
- S4.0: production compose'a log döndürme eklendi (servis başına 3 × 10 MB).
- S4.1: ortak Caddy yapılandırması bu reponun dışında, `citech-infra` dizininde (sürüm
  denetimi altında değil). Caddy
  arkasında Stok girişi ve hareketi çalıştı. X-Forwarded-For koruması koruma
  kaldırılarak sınandı; ayrıntı runbook L.4'te.
- 2026-10-28 itibarıyla sunucuya kurulmamıştı; bugünkü sunucu yapılandırması repodan
  doğrulanamıyor (yukarıda). Genel DNS delegasyonu doğrulanmadı.

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

İçe aktarma, 2.000 satır (ayrı test veritabanı, 2026-10-10, eski tek istekli yol): devirli ilk
koşu 47,1 sn, tekrar 32,5 sn (ikinci devir yazılmadı), önizleme 125–305 ms; devirsiz taban 23,5 sn.

T171 kapıları (2026-10-23, commit öncesi yerel koşu; `TZ=UTC`, saat T122 penceresinde): lint (proje
klasörleri, T206) 235 dosya 0 tanı, typecheck (4 paket), test **1254/1254** (shared 82, db 326,
core 659, web 187; T207 bu koşuda geçti), drift "No schema changes", `next build` PASS, Playwright
**30/30** (izole `stok_test_e2e_t171` veritabanı ve 3100 portu; demo veritabanına yazılmadı).

Çok depo Dilim 1 kapıları (2026-10-27, `50b6dd9`, commit öncesi yerel koşu): lint temiz, typecheck
(4 paket), test **1284/1284** (shared 83, db 326, core 688, web 187; gerçek PostgreSQL), drift "No
schema changes", `next build` PASS; arayüz değişmediği için Playwright koşulmadı. Yerel
`apps/web/.next/dev` önbelleği T171'de silinen bir rotaya işaret ettiği için typecheck'i kırıyordu;
silinmedi, proje dışına taşındı (`next dev` yeniden üretir).

T171 ölçümü (2026-10-23, izole `stok_test_perf`, core doğrudan, yarı yeni yarı güncelleme). Bu
makine bugün 2026-10-10'dan ~2,5–3 kat yavaş: tek sorgu 1,9 ms, boş `withTenant` transaction'ı
9,8 ms; kontrol olarak eski yol (`commitImport`) 2.000 satırda devirsiz 20 ms/satır, devirli
59,5 ms/satır. Yeni yol, satır başına işlem süresi:

| Satır | Devirsiz | Devirli | Önizleme | Gönderim |
|---|---|---|---|---|
| 300 | 12,4 sn (41 ms/satır) | 23,9 sn (80) | 0,1 sn | 0,2 sn |
| 2.000 | 85,6 sn (43) | 160 sn (80) | 0,3 sn | 0,4 sn |
| 5.000 | 186 sn (37) | 355 sn (71) | 0,5 sn | 1,0 sn |
| 10.000 | 357 sn (36) | 701 sn (70) | 1,0–1,2 sn | 1,7 sn |
| 20.000 | 692 sn (35) | 1.353 sn (68) | 2,1–2,2 sn | 3,4 sn |

Hepsi `DONE`, defter = projeksiyon, mükerrer devir yok; en uzun parça 2,18 sn; ölçüm sürecinin
en yüksek belleği 417 MiB (20.000 devirli). Tarayıcı (yerel `next start`): 97,6 MiB'lık, 20.000
satırlı, görselli xlsx okuma 2,0 sn, okuma + gönderim + önizleme 8,2 sn, ana iş parçacığında en uzun
blok 94 ms; 101 MiB'lık dosya okunmadan reddedildi. Yeni yolun eski yola ek maliyeti satır başına
alma transaction'ı (devirsizde ~15 ms, devirlide ~10–20 ms).

Gerçek cihaz kabulü (WS-SCAN, iPhone Safari, HTTPS tünel, laptop `next start`):
gerçek barkod telefon kamerasıyla okunuyor, ürün laptopta `/hareket`te açılıyor,
Kaydet ile stok güncelleniyor, aynı ürün yeniden okutulabiliyor, kirli form
koruması çalışıyor, "Bağlantıyı kes" telefon oturumunu kapatıyor. Android
denenmedi. Yerelde ayrıca Edge + sahte kamera aygıtı + sentetik EAN-13 ile
uçtan uca geçti (kamera yolu CI'da yok: T169).

T200 1b kapıları (2026-10-20, yerel; saat T122 penceresinde olduğu için `TZ=UTC`): lint (proje
klasörleri; kökteki `~/` yüzünden, T206) 228 dosya 0 tanı, typecheck (4 paket), test **1211/1212**
(shared 82, db 325, core 622/623, web 182; tek kırmızı T207: `invariant.test.ts` 30 sn sınırını
aşıyor, tek başına 31,8 sn'de geçiyor), drift "No schema changes", `next build` PASS, Playwright
**28/28** (24 + 4 tedarikçi). REVIEW B1 (önizleme/kayıt uzunluk uyumu) ve B2 (uzun adda ürün
arama) düzeltmeleri dahil. Yerel geliştirme veritabanına 0012 uygulandı (öncesi/sonrası stok
parmak izi aynı). E2E ve ölçüm demo kiracısına tedarikçi yazdı (T150); ölçümün 2 tedarikçisinde
5.000'er eşleşmemiş kalem var.

Tedarikçi dosyası, 5.000 satır (T200 1b, 2026-10-20). Tipik satır (kod 10, ad 60 karakter): xlsx
208 KB, kayıtta geri gönderilen blob 1,11 MB. Uzun satır (kod 100, ad 300, marka 100; doğrulama
sınırları): xlsx 213 KB, blob 3,63 MB. Core (`stok_test_core`, tipik/uzun): önizleme 0,83/0,91 sn,
ilk kayıt 0,76/0,87 sn, değişmeyen kayıt 0,59/0,78 sn, 5.000 fiyatı değişen kayıt 1,05/1,20 sn.
Tarayıcı (yerel `next start`, tıklamadan sonuca): önizleme 1,5/2,0–2,3 sn, kayıt 1,6/2,1–2,3 sn.
Gerçek istek: önizleme = dosya + ~0,5–0,9 KB; kayıt = blob + ~0,5 KB (uzun: 3.626.825 B, 4 MiB
sınırından geçti). Önizleme yanıtı blob'u tarayıcıya taşıyor (uzun: 3,63 MB). Blob'u
`SUPPLIER_SAVE_BLOB_LIMIT`'i (3.670.016 B) aşan dosyada (3,71 MB) kayıt düğmesi kapalı, uyarı
görünüyor. 4 MiB − 2 KB dosya eyleme ulaştı; tam 4 MiB dosya istemci denetimini geçip Next'in
gövde sınırına çarptı (500, genel hata ekranı; T208); 4 MiB + 1 B istemcide durdu.

GitHub CI: son koşu #101 (`c2f9805`, `main` push, 2026-11-03) yeşil; #98 (`c2f9805`,
`development`) yeşil, #99 (`c2f9805`, `master`) ikinci denemede yeşil. #97 (`311c39d`, CI
tetikleyicisi ve Dependabot hedefi, OPS-13, 2026-11-02) yeşil. #95 (`f64e716`, log döndürme, 2026-10-28) yeşil. #90–#94 de yeşil: #90
`a09157d` (Dilim 2, ikinci denemede), #91 `f9a8bef` (Dilim 3), #92 `7fe8770` (T221), #93 `1b759a6`
(Dilim 4), #94 `4472fa5` (S1 Docker; CI Docker imajını derlemiyor). Öncesinde #88 (`50b6dd9`, çok depo Dilim 1, 2026-10-27) yeşil, üç iş de geçti; öncesinde
#87 (`3db7d81`, T171, 2026-10-23) yeşil. #84 (`667512a`, T200 1b, 2026-10-20) yeşil; üç iş de adım adım geçti (Linux
test işinde lint, drift, testler ve derleme; demo işinde temiz kurulum ve Playwright duman testi;
Windows'ta temiz checkout'ta lint, typecheck ve derleme). Öncesinde #83 (`9d4bc8c`, T200 1a,
2026-10-19) ve #82 (`93b38f6`) yeşil. Önceki
ayrıntılı kayıt: `development` `8a96c74` (T196) koşu #75 yeşil; üç iş de geçti, demo işindeki "Yedek ve
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
neden bilinmiyor. `c2f9805`'te aynı tür hata tekrar etti: `master` push'unun CI #99'unda ilk
denemede yalnız demo işinin "Web derlemesi" adımı düştü, ikinci deneme yeşil (T230). `main`'deki
son koşu #101 (`c2f9805`, push) yeşil. Açık Dependabot PR'ları: #15 (`minor-ve-yama`, 14
güncelleme) `development`'ı hedefliyor, CI #100 yeşil; eski tabandaki 8 büyük sürüm PR'ı (#2, #3,
#7–#10, #13, #14) adlandırmayla `main`'e geçti ve ayrı karar bekliyor (T140).

## Çalışan ana kapsam (web)

Giriş · panel · stok tablosu (Türkçe arama) · barkodla elle hareket girişi ve
fiyat defteri · hareket logu · ürün/barkod yönetimi · Excel/CSV ürün aktarma
(açılış stoğuyla, `DAT-18`) · birim hassasiyeti (`DAT-17`) ·
Excel export · kullanıcı yönetimi · ayarlar · kategoriler · raporlar · sistem
sağlığı · Ctrl+K · bildirim zili. RLS çok kiracılı veri katmanı, append-only
defter, kaba kuvvet kilidi, elle tetiklenen `/api/cron`, `/api/v1/health`,
`pnpm demo` (Windows/macOS/Linux). Tedarikçi fiyat ve stok verisi, yalnız yönetici (F-12;
Dilim 1, kullanıcı kabul testinde kabul edildi 2026-10-22; Dilim 2 ve gerçek API T201 açık). Pilot, varsayılan kapalı: telefon kamerasıyla
okutup `/hareket`te açma (`ENABLE_PHONE_SCANNER`, `PRD-12`, `ARC-14`). Kodda, kabul testi
bekleyen yok. Çok depo ve Envanteri Güncelle (F-15) manuel kabul testinde kabul edildi
(2026-11-03); eksikleri aşağıda "Kısmi / bozuk".

## Kısmi / bozuk

- **Gün sonu raporu**: saatlik zamanlamada günün ilk turunda boş günü raporluyor (T121).
- **Saat dilimi**: tanımsız; UTC'de gün sınırları kayar (T122). Excel hücreleri ve
  dosya adı WS-C-lite'tan beri sabit Europe/Istanbul; ekran saati, tarih filtresinin
  gün sınırı ve cron hâlâ sunucu saatine bağlı.
- **Çok kiracıda aynı e-posta**: web'de giriş çıkmazı (T123).
- **Sağlık alarmı**: bir kez FAILED olan iş kalıcı, alarm her saat tekrar eder (T126).
- **Düzeltme / ters hareket**: akış yok (T127).
- **İçe aktarma**: T171 (20.000 satır, 100 MB, ilerleme, iptal) manuel kabul testinde geçti
  (kullanıcı bildirimi, 2026-11-03, yerel `stok_uat`): 2.000 satırda iptal ve yeniden yükleme
  mükerrer devirsiz tamamlandı; 20.000 devirli satır ~25 dk, hatasız (çekirdekte ölçüm ~23 dk).
  Sekme açık kalmalı; süre T235. Lightsail'de bellek ölçümü yok (T171 açık). Çok depolu işletmede
  önizleme yazılamayacak devri yazılacak gibi gösteriyor (T234). T171 çalışmasında
  yerel demo veritabanına migration uygulanmadı; ekran için 0013 gerekir (`pnpm demo` uygular). Devirde geçmiş tarihli fiyat yok (T172); birim değişimi sonrası eski veri denetlenmiyor (T170).
- **Kuyruğa alınan büyük dışa aktarma**: cron'da işleyicisi yok, çalışmıyor (T216, kod okumasıyla).
- **Çok depo ve Envanteri Güncelle** (`PRD-17`, `PRD-18`, F-15): Dilim 1–4 ve değer dürüstlüğü
  kodda; manuel kabul testi U0–U12 geçti (T218–T220 kapandı; T222'de kalan test notu). UAT
  bulguları: girişte görünen Atanmamış Stok seçeneği (T236, sunucu reddediyor), eski depo uyarısı
  (T237). Var: envanter dosyası (depo açan tek
  yol), Envanteri Güncelle ekranı, ürün sayfasında depo dağılımı, harekette depo seçimi, Atanmamış
  Stok'tan çıkış, barkodsuz ürün formu ve ürün kimliğiyle hareket; panel ve kategori değeri fiyatı
  bilinmeyen ürünü 0 saymıyor, sayısını gösteriyor. Yok: deposu bilinmeyen eski stoğun depoya
  atanması (T223; envanter dosyası da böyle bir ürünün satırını atlıyor), tek ürün sayım
  düzeltmesi (T232), depolar arası transfer (T233), "Depoya atama bekliyor" rozeti (T221), elle
  depo açma/arşivleme (T226), ürün aktarımında barkodsuz satır (T228), fiyat geçmişi ve toplu
  satış fiyatı (T224), toplu mal kabulü (T225).
- **Ürün görseli**: yalnız URL; yükleme yok (T136).
- **Kritik stok**: yalnız e-posta, push yok.
- **Konum yönetimi**: arayüz yok.
- **Mobil ve `/api/v1` REST**: yok (Faz 5, en sona bırakıldı).
- **Telefonla okutma pilotu**: oturum süreç belleğinde (yeniden başlatmada düşer,
  yalnız tek süreçli `next start`, `ARC-14`); tünel açıkken bütün uygulama dışarıda
  (T167); UPC-A 12/13 hane ölçülmedi (T168).
- **Ağ açıklığı**: geliştirme compose'unda veritabanı portu yalnız `127.0.0.1` (WS-1.1, S19), ama
  parolalar repodaki varsayılanlar; uygulama sunucusu (`next start`) yerel ağda HTTP ile açık
  (T183). Production compose port yayınlamıyor ve geliştirme parolasını reddediyor (S1).
- **Excel dışa aktarma**: rapor istek içinde üretiliyor; sürerken diğer istekler 1,5–5 sn
  bekliyor (T231, ölçüm 2026-10-27).
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

**Kararlı sürüm öncesi kabul testi** (2026-11-03; T222, T171): U0–U12, 13/13 geçti. Kanıt
kullanıcının kendi testi ve ekran görüntüleri; testleri kullanıcı yaptı, Claude koşmadı. Ortam: yerel,
izole `stok_uat` veritabanı, taze sentetik kiracı; demo ve geliştirme verisine yazılmadı. 2.000
satırda 193 satırdan sonra iptal, yeniden yüklemede kalan 1.807 satır, 193 devir ikinci kez
yazılmadı; 20.000 satırda 20.000 ürün ve devir, hatasız, ~25 dk; UAT sonunda 22.006 üründe hareket
toplamı = projeksiyon, 0 tutarsızlık. Bulgular T234–T237. Test edilen kod `f64e716` ile `311c39d`
arasında aynı.

Öncesinde **Çok depo Dilim 2–4 ve değer dürüstlüğü** (2026-10-27…28; kabul 2026-11-03):
Dilim 2 envanter dosyası çekirdeği `a09157d` (T218, migration 0015, CI #90); Dilim 3 Envanteri
Güncelle ekranı ve depo dağılımı `f9a8bef` (T219, CI #91); değer dürüstlüğü `7fe8770` (T221'in
değer kısmı, CI #92); Dilim 4 harekette depo seçimi, Atanmamış Stok ve barkodsuz ürün `1b759a6`
(T220, CI #93). Commit mesajlarına göre son yerel kapı 1.323 test ve izole Playwright 38/38; her
dilimde korumalar `dogrula` ile kırmızıya düşürüldü. Ardından AWS staging hazırlığı `4472fa5` (S1)
ve `f64e716` (log döndürme), CI #94–#95.

Öncesinde **Çok depo Dilim 1 — depo modeli ve hareket kapısı** (T217, 2026-10-27; `DAT-21`–`DAT-25`, ADR-008):
`50b6dd9`, CI #88 yeşil; 1.284 yerel test, `dogrula` ile sekiz koruma kırmızıya düşürüldü (T217
kaydı). Uygulananlar: ayrı `depots` tablosu (FORCE RLS; `locations` raf olarak kaldı); defterde
`depot_id` ve `import_run_id` (`count_session_id` sayıma ayrıldı); depo miktarı defterden türetiliyor,
toplam `current_stock` değişmedi; depo kuralı ve depo bazlı yetersiz stok; barkod ya da ürün
kimliğiyle hareket; barkodsuz ürün çekirdekte; sunucu kontrollü `COUNT_ADJUST`; deposu bilinmeyen
eski stok olduğu gibi korunuyor. Migration yalnız ekleme yapıyor. Arayüz değişmedi.

Öncesinde **T200 Dilim 1 — B2B V1 tedarikçi verisi** (kabul 2026-10-22, F-12, `PRD-14`): 1a `9d4bc8c` (CI #83),
1b `667512a` (CI #84). Kullanıcı kabul testi 2026-10-20…22, yerel `next dev`, demo kiracısı Yılmaz;
işlemleri kullanıcı arayüzden yaptı, her adım salt okunur DB parmak iziyle doğrulandı: **10/10 senaryo
geçti, kanıtlanmış yeni teknik hata yok.** Doğrulananlar: tedarikçi oluşturma ve ayarlar; CSV/XLSX
okuma, önizleme (yazmıyor) ve kayıt; hatalı satır ve dosya düzeyi redler; barkodla otomatik, elle
bağlama ve yok sayma (yenilemede korunuyor); değişen fiyatta geçmiş, aynı dosyanın ikinci kaydında 0
yeni geçmiş satırı; iki tedarikçinin karşılaştırması, KDV koşulu farklı teklifler ayrı grupta; çalışan
tedarikçi fiyatını görmüyor (INV-10); başka kiracının tedarikçi adresi 404. UAT boyunca ve sonda hareket,
`current_stock`, ürün kartı ve barkod özetleri başlangıçla aynı. Kanıt ayrımı: 9.1–9.3'ü kullanıcı yaptı
(ekran görüntüleri kullanıcının kendi incelemesinde; DB ile doğrulandı); Demir'in boş tedarikçi listesi
ekranda görülmedi, veri katmanında doğrulandı (`stok_app` + Demir kiracı ayarı: 0 tedarikçi, 0 kalem,
0 geçmiş); JSON kaynağı, ayar değişiminin "koşul değişimi" üretmesi (`PRD-16`) ve 390 px mobil UAT'de
elle denenmedi, kanıtları otomatik testler (F-12). Demo kiracısında kalıcı UAT kayıtları (V1'de silme
yok): UAT-A (5 kalem: 3 AUTO, 1 MANUAL, 1 IGNORED), UAT-B (3 kalem, AUTO), 2 fiyat geçmişi satırı,
kullanıcının açtığı "Burik Teknoloji A.Ş" (0 kalem). Bulgular: T212–T215, T210 genişletildi; bağlananlar
T171, T201, T211.

Öncesinde **WS-1.3a — Doğrulanmış yerel yedek** (2026-10-16, `OPS-10`): `pnpm db:backup` compose `db`'deki
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

**Faz 0.3 `master` → `main` geçişinin dal kısmı tamamlandı (`OPS-13`)**; sonra onaylanacak ilk
ürün workstream'i gelir. Geçişten kalan işler:
- Eski 8 Dependabot PR'ı için karar: `development`'a yönlendirme ya da kapatma (T140).
- Bilinen sınırlar listesinin kullanıcı tarafından kabulü (kayıtlı değil): T221 rozeti, T223, T226, T227, T232, T233, T216, T208,
  T234–T237.
- Lightsail sunucu doğrulamaları (`OPS-14`, T171 bellek ölçümü), T222 test notu.
Kullanıcı testinde bulunan eksikler T232 (tek ürün sayım düzeltmesi), T223 (eski stoğun depoya
atanması) ve T233 (depolar arası transfer).

**Yol haritası sırası** (kullanıcı kararı 2026-10-27; 2026-10-22 sırasının üstüne):
1. **Çok depo ve Envanteri Güncelle**: Dilim 1–4 ve T221'in değer kısmı kodda ve kabul testinde
   geçti (2026-11-03). T171 (20.000 satır; `ARC-15`, ADR-007, `DAT-20`, S21, F-02) kabul testinde
   geçti; kalan Lightsail ölçümü. Sıradaki çok depo işleri T232, T223, T233 ve T221 rozeti.
2. **T201 gerçek tedarikçi API'si**: ilk hedef, erişimi sağlanabilen bir sağlayıcıyla uçtan uca.
   Sağlayıcı, kimlik doğrulama ve yaklaşım PLAN'da kanıtla seçilir; gerçek sağlayıcı seçilmeden genel
   entegrasyon iddia edilmez. Çok depo kritik yolunun dışında.
3. **T200 Dilim 2**: genel karşılaştırma ekranı, kod eşitliğinden onaylı eşleşme önerisi, şablon
   indirme değerlendirmesi. İptal değil; önceliği değişti.
4. **UX iyileştirmeleri** uygun ürün dilimlerinde, tek bir yeniden tasarım olarak değil: T212–T215,
   T210, T211.
Tamamlanan: T200 PLAN (2026-10-19; `PRD-15`, `DAT-19`, ADR-006) ve Dilim 1 (kabul 2026-10-22,
yukarıda). HTTPS test ortamı (T144, `OPS-12`) ayrı operasyon hattında; bu ürün sırası onu değiştirmez.
Barındırma `OPS-01` (Open); üretim ayrı iş (T42). Sıra ürün önceliğidir: kritik veri bütünlüğü ve
güvenlik işlerini ertelemenin gerekçesi değildir. Özellik kayıtları `docs/TEKNIK_SARTNAME.md` F-12,
F-13. Diğer P1 işler ve güvenlik/veri koruma gereklilikleri olduğu gibi geçerli.

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

Paralelde, insan işi ve kod dışı: T120 (sahiplik), T140 (Dependabot triyajı, yayın; dal
koruması ve zorunlu CI kontrolleri 2026-11-03'te kuruldu).

Ardından ürün hazırlığı (T127; kapsam kararıyla), en son üretim deploy'u (T42, T129). Çevrim
içi test ortamı (T144) P1'e çıktı; önkoşulu (T124) ve bilinen sınırları T144 kaydında.
