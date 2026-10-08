# TODOS — backlog

Gerçek iş listesi. **Güncel durum burada değil** (→ `CURRENT_STATE.md`),
**kararlar burada değil** (→ `DECISIONS.md`). Yol boyunca bulunan her yeni iş
`gorev-kaydet` skill'iyle buraya yazılır; o anki iş bölünmez.

**Kurallar**

- ID `T<n>`. Arşivdeki görevler numaralarını korur. Yeni görev en büyük
  numaradan devam eder — **sıradaki boş numara: T165**. Numara yeniden
  kullanılmaz.
- Biçim: `- [ ] **T<n> (P0–P3)** - <alan> - **Başlık**`. Altında kısa
  **Neden / Kanıt / Bağlı / Doğrula / Kaynak** satırları.
- Karar bekleyen iş `BLOKE: <DECISIONS ID>` taşır. Kararın kendisi
  `DECISIONS.md`'de durur, burada tekrarlanmaz.
- Öncelik: **P0** devralmayı ya da ürünü durduran · **P1** ilk deploy / ilk
  gerçek müşteriden önce · **P2** yakın vade · **P3** ilgili işe dokunulduğunda.
- Kapanan görev `[x]` + tek satır kanıtla (commit, test) "Kapananlar"a iner.
- Eski ayrıntı: T1–T119 → `docs/archive/PLAN-2026-09.md`, eski E-maddeleri →
  `docs/archive/TODOS-2026-08.md`.

---

## P0

- [ ] **T120 (P0)** - sahiplik - **Repo, IP ve hesap sahipliği netleşsin**
  - Neden: ticari ürün kişisel bir GitHub hesabında (`asadexa/stok`) **public** ve
    **LICENSE'sız**; master korumasız. Karar izlerinin bir kısmı önceki
    geliştiricinin hesabında: ≈47 commit'teki `claude.ai/code` oturum bağlantıları
    ve tasarım artifact'i (`claude.ai/code/artifact/5579f41a…`).
  - Yapılacak (insan): repo transferi + görünürlük kararı, LICENSE / tescilli ürün
    notu, yazılı IP devri, artifact ve oturum dökümlerinin dışa aktarılması,
    hesap/secret sahipliği listesi (GitHub; ileride Vercel, Supabase, SMTP, domain).
  - Bağlı: T140. Kaynak: devralma denetimi 2026-10-08.

## P1

- [ ] **T121 (P1)** - cron - **Gün sonu raporu, saatlik zamanlamada yanlış günü raporluyor**
  - Neden: `vercel.json` cron'u saatlik (`0 * * * *`). `runCron` "bugün"ü
    (`dayKey(now)`) DAILY_REPORT olarak planlayıp AYNI turda çalıştırıyor; dedupe
    gün içinde tekrarını engelliyor. Günün ilk turu (00:00) yeni başlamış günün
    boş verisini raporluyor → kasa açığı özeti (T88.1) yöneticiye hiç ulaşmıyor.
    Hata T34 tasarımı ile T42.1'deki saatlik kararın birleşiminden doğmuş.
  - Kanıt: `packages/core/src/cron.ts:500-507`, `apps/web/vercel.json`.
    `cron.test.ts:550-569` bu davranışı "doğru" diye kilitliyor.
  - Bağlı: T122, `DAT-16` (Open).
  - Doğrula: raporun TAMAMLANMIŞ bir günü kapsadığını saatlik tur senaryosuyla
    sınayan test; kilitleyen test düzeltilir; `dogrula`.

- [ ] **T122 (P1)** - zaman - **Saat dilimi politikası yok; gün sınırları üretimde kayar**
  - Neden: repoda hiçbir yerde `TZ` ayarı yok. `dayKey`, `todayIso` ve mesai saati
    (`getHours()`) sunucunun yerel saatine, rapor sorgusu (`created_at::date`) DB
    oturum saatine bakıyor. Vercel ve Supabase UTC → Türkiye için gün sınırı
    03:00'a, mesai alarm penceresi 3 saat kayar; 00–03 arasında bugünün fiyat
    tarihi "ileri tarih" sayılıp reddedilir.
  - Kanıt: `cron.ts:54,133,393`, `movements.ts:365`. Yerel Docker PG
    `SHOW timezone` = UTC (2026-10-08).
  - Bağlı: `DAT-16` (Open), T121.
  - Doğrula: TZ=UTC ve TZ=Europe/Istanbul altında 23:30 / 00:30 / 02:59 vakaları.

- [ ] **T123 (P1)** - auth - **Aynı e-posta birden fazla kiracıda: web'de çıkmaz + kiracılar arası kilitleme**
  - Neden: `login()` `TENANT_AMBIGUOUS` döndürüyor ve `tenantId` kabul ediyor, ama
    web `startSession` yalnız `{email, password}` gönderiyor; formda kiracı seçimi
    yok → kullanıcı giremiyor. E-posta tekilliği yalnız kiracı içinde ve
    `auth_lookup_user` pasif kullanıcıları da sayıyor: B kiracısının yöneticisi
    A'daki bir e-postayla kullanıcı açarak A'daki kişiyi web'den kilitleyebilir.
    Ayrıca belirsizlik parola doğrulanmadan ve hata sayılmadan dönüyor (sayım).
  - Kanıt: `packages/core/src/auth.ts:281-289`, `apps/web/src/server/session.ts:92-93`,
    `apps/web/src/app/giris/page.tsx:44`, `packages/core/src/users.ts` (`createUser`),
    `packages/db/migrations/0004_auth_lookup.sql:75`.
  - BLOKE: `SEC-14` (global tekillik mi, kiracı seçici mi).
  - Doğrula: iki kiracıda aynı e-postayla tarayıcı testi.

- [ ] **T124 (P1)** - güvenlik - **Supabase'te SECURITY DEFINER fonksiyon yetkileri doğrulanmalı**
  - Neden: migration'lar yetkiyi yalnız `PUBLIC`'ten geri alıyor. Supabase'in
    `public` şemasındaki fonksiyonlara `anon`/`authenticated` için varsayılan
    EXECUTE verdiği biliniyor (**doğrulanmadı**). Doğruysa anahtarı olan biri Data
    API RPC ile `auth_clear_attempts` (kaba kuvvet korumasını sıfırlar),
    `auth_record_failure` (hesap kilitler), `auth_lookup_user` / `cron_tenants`
    (sayım) çağırabilir. Runbook'ta Supavisor pooler kullanıcı adı biçimi
    (`stok_app.<proje-ref>`) da yok.
  - Kanıt: migration 0004 / 0005 / 0010 `REVOKE … FROM PUBLIC`.
    `packages/db/src/rls.test.ts:335` yalnız PUBLIC'e ve yalnız `auth_lookup_user`'a bakıyor.
  - Doğrula: Supabase'de her fonksiyon için
    `select has_function_privilege('anon', '<imza>', 'EXECUTE');`. Düzeltmeden
    sonra test, tüm SECURITY DEFINER fonksiyonlarının ACL'ini anon/authenticated
    dahil taramalı.
  - Bağlı: T42, `OPS-01`.

- [ ] **T125 (P1)** - veri - **Seed, ortam koruması olmadan defter dahil her şeyi TRUNCATE ediyor**
  - Neden: `seed.ts` host/ortam kontrolü yapmadan `stock_movements` dahil bütün
    tabloları TRUNCATE ediyor. Runbook operatörden üretim `MIGRATION_DATABASE_URL`'ini
    kendi makinesinde kullanmasını istiyor; yanlış kabukta `pnpm seed` ya da
    `pnpm demo --seed` üretimi siler. Append-only garantisi TRUNCATE'i kapsamıyor
    (trigger yalnız UPDATE/DELETE).
  - Kanıt: `packages/db/src/seed.ts:182`, migration 0002 (`BEFORE UPDATE OR DELETE`).
  - Doğrula: yerel olmayan hedefte seed'in reddettiğini sınayan test; `dogrula`.

- [ ] **T126 (P1)** - gözlem - **FAILED işler kalıcı; sağlık alarmı her saat tekrarlıyor**
  - Neden: `queueCheck` tüm zamanların FAILED işlerini sayıyor; onaylama ya da
    yeniden deneme yolu yok. HEALTH_ALARM `error` seviyesinde her saat e-posta
    atıyor → tek kalıcı hata = sonsuza kadar saatlik alarm. SMTP yoksa her saat
    yeni bir FAILED HEALTH_ALARM birikir ve cron 500 döner. `OPS-09`'a aykırı.
  - Kanıt: `packages/core/src/health.ts:129-140`, `cron.ts:426`, `jobs.ts` (onay yok).

- [ ] **T127 (P1)** - defter - **Düzeltme / ters hareket akışı yok**
  - Neden: `DAT-10` ve ADR-001 "düzeltme ters hareketle yapılır" diyor; ama
    `reverses_id` hiçbir kod yolunda yazılmıyor ve sayım düzeltme sebepleri elle
    seçilemiyor. Yanlış giriş, bağlantısız bir OTHER_IN/OUT ile düzeltiliyor;
    yanlış fiyatlı satış kasa açığı raporunda kalıcı kalıyor.
  - Kanıt: `reversesId` yalnız `schema.ts` ve `rls.test.ts`'te geçiyor.
  - Doğrula: ters hareket sonrası invariant ve kasa açığı raporu testleri.

- [ ] **T128 (P1)** - import - **Açılış stoğu toplu girilemiyor**
  - Neden: toplu içe aktarma yalnız ürün yaratıyor, miktar sütunu yok; OPENING her
    hareket için fiyat istiyor. 800 ürünlük bir müşteri 800 ayrı devir hareketi
    girmek zorunda. E1'in "bu olmadan ilk gün kurulamaz" gerekçesi yarım kalmış.
  - Kanıt: `packages/core/src/import.ts:148-161`.
  - Not: yazım `createMovement`'tan geçmeli (`DAT-02`); fiyat ve tarih `PRC-05`.

- [ ] **T129 (P1)** - operasyon - **Harici izleme ve yedek geri yükleme tatbikatı yok**
  - Neden: `/api/v1/health`'i yoklayan uptime izleyici yok; cron'un 500'ü yalnız
    platform loglarında; hata takibi (Sentry vb.) yok. HEALTH_ALARM SMTP'ye bağlı:
    SMTP bozuksa onu haber verecek alarm da gidemiyor. Geri yükleme tatbikatı hiç
    yapılmadı (runbook §7).
  - Bağlı: T42.

- [ ] **T42 (P1)** - deploy - **Vercel + Supabase üretim kurulumu**
  - Kod tarafı T114–T119 ile hazır. Hesap kurulumu, plan kararı (`OPS-02`) ve ilk
    migration insana ait; adımlar `docs/uretim-runbook.md`'de.
  - Önkoşul: T121–T126, T129. Zamanlayıcının canlıda kurulması (T112) bu işin parçası.

- [ ] **T110 (P1)** - arayüz - **JS kapalıyken formlar kullanılamıyor (streaming Suspense)**
  - BLOKE: `UX-08`. Depodaki tarayıcılar gerçekten JS'sizse P0'a çıkar.

- [ ] **T91 (P1)** - araştırma - **Fiyat senaryolarını gerçek kullanıcıda gözlemle**
  - Kalan iki soru: 5 yıllık ürünün faturası var mıydı (varsa T90'ın endeks yarısı
    gereksiz olabilir); enflasyon zararını satarken mi sonradan mı fark etti.
    T90'dan önce yapılmalı.

## P2

- [ ] **T130 (P2)** - doğrulama - **Birim hassasiyeti zorlanmıyor; çok küçük miktar 500 veriyor**
  - Neden: `UNITS.ADET.decimals = 0` hiçbir yerde kullanılmıyor, "0,5 adet" kabul
    ediliyor. `decimalsOf` `toString()` kullandığı için `0,0000001` (`1e-7`) zod'dan
    geçiyor, 0.000'a ölçekleniyor ve DB `delta <> 0` CHECK'i yakalıyor; kullanıcı
    500 görüyor (2026-10-08'de çalıştırılarak doğrulandı).
  - Kanıt: `packages/shared/src/schemas.ts:42`, `packages/shared/src/units.ts`.

- [ ] **T131 (P2)** - CI - **Migration drift adımı sessizce geçebiliyor**
  - Neden: `drizzle-kit generate` (0.31.10) çöktüğünde de 0 koduyla çıkıyor
    (2026-10-08'de bozuk config'le doğrulandı). CI adımı yalnız `git status`'a
    baktığı için drizzle-kit patlarsa "drift yok" der. Yan not: drizzle-kit
    Windows'ta mutlak `out` yolunu çalışma dizinine ekliyor.
  - Kanıt: `.github/workflows/ci.yml` → "Migration'lar şema ile senkron mu".

- [ ] **T132 (P2)** - defter - **`current_stock` uygulama rolünce yazılabilir**
  - Neden: `stok_app`'ten yalnız DELETE geri alınmış; INSERT/UPDATE serbest (trigger
    çağıranın yetkisiyle çalışıyor). Tek yazma kapısı (`DAT-02`) bir konvansiyon;
    ihlal ancak sonradan invariant'la görülür. Seçenek: SECURITY DEFINER trigger +
    REVOKE.
  - Kanıt: `packages/db/migrations/0002_ledger_projection_rls.sql:64`.

- [ ] **T133 (P2)** - güvenlik - **`.env.example`'daki `AUTH_SECRET` üretimde kabul ediliyor**
  - Neden: kontrol yalnız uzunluğa bakıyor. Bilinen sır + kiracı UUID'si = sahte
    admin token'ı.
  - Kanıt: `apps/web/src/server/config.ts:95`, `.env.example:50`.

- [ ] **T134 (P2)** - auth - **Çıkış refresh token'ı iptal etmiyor; rotasyon yok**
  - Neden: `endSession` yalnız çerezi siliyor; `tokenVersion` artmıyor. Refresh
    token 30 gün geçerli ve dönmüyor.
  - Kanıt: `apps/web/src/server/session.ts:102`.

- [ ] **T135 (P2)** - auth - **`x-forwarded-for`'un ilk değerine güveniliyor**
  - Neden: kendi sunucusunda / LAN kurulumunda IP sayacı sahtelenebilir ya da
    kurbanın IP'si kilitlenebilir. Vercel'de başlık platformca yazılır (doğrulanmalı).
  - Kanıt: `apps/web/src/app/giris/page.tsx:40`.

- [ ] **T136 (P2)** - ürün - **Ürün görseli modeli: http, üçüncü taraf istek, yükleme yok**
  - Neden: `http` kabul ediliyor (HTTPS sayfada otomatik yükseltilir, sunucu HTTPS
    desteklemiyorsa kırılır). Tarayıcı görseli doğrudan tedarikçi sunucusundan
    çekiyor: çalışanın IP'si, UA'sı ve origin referer'ı karşıya gidiyor (KVKK).
    `referrerPolicy` yok. Kırık/hotlink görsel yalnız tarayıcının kırık ikonu.
    T83'ün "yükleme + boyutlandırma" kısmı açık kalmış ama görevi yoktu.
  - Kanıt: `packages/shared/src/schemas.ts:237`, `apps/web/src/components/product-cell.tsx:59`,
    commit `f57fdcb`.
  - BLOKE (yükleme/depolama kısmı): `OPS-01`.

- [ ] **T137 (P2)** - güvenlik - **Güvenlik başlıkları yok (CSP, frame-ancestors)**
  - Neden: panel başka bir sitenin iframe'ine konabilir (clickjacking); CSP yok.

- [ ] **T138 (P2)** - export - **Büyük export bellekte üretilip cron içinde e-postayla gidiyor**
  - Neden: 20 bin satıra kadar bellekte xlsx. 200 bin satıra kadar iş, 60 sn'lik
    cron turunda üretilip e-posta EKİ olarak gönderiliyor; hem süre hem SMTP ek
    boyutu sınırı aşılabilir.
  - Kanıt: `packages/core/src/exports.ts:63,70`, `apps/web/vercel.json` (`maxDuration: 60`).

- [ ] **T139 (P2)** - cron - **Kiracılar tek çağrıda sırayla; bazı kiracılar sessizce atlanıyor**
  - Neden: bütün kiracılar tek 60 sn'lik çağrıda sırayla işleniyor (ölçek sınırı).
    `cron_tenants()` aktif yöneticisi olmayan kiracıyı hiç döndürmüyor (o kiracı
    için rapor, invariant kontrolü ve alarm yok). Raporun tek alıcısı en eski aktif
    yönetici.
  - Kanıt: `packages/db/migrations/0010_cron_tenants.sql`, `cron.ts` (`reportRecipient`).

- [ ] **T140 (P2)** - repo - **Repo yönetişimi: Dependabot birikimi, branch koruması, yayın**
  - Neden: 9 Dependabot PR açık; minor grup, zod 4 ve coverage-v8 5 CI'da kırmızı
    (2026-09-14'ten beri kimse bakmıyor). Master korumasız, zorunlu kontrol yok
    (CI atlanabilir). Tag/release/changelog, CODEOWNERS ve SECURITY.md yok.
  - Bağlı: T120.

- [ ] **T141 (P2)** - denetim - **Admin eylemleri için audit log yok**
  - Neden: ürün fiyatı, rol ve parola sıfırlama değişiklikleri kayıt altında değil.
    Kasa açığı kontrolünde (`PROJECT_BRAIN` §7, `SECURITY_MODEL` S13) bypass yolu:
    admin `sale_price`'ı düşürüp satıp geri yükseltirse fark kayda geçmez.

- [ ] **T142 (P2)** - CI - **Windows'ta DB testleri ve e2e koşmuyor**
  - Neden: geliştirme platformu Windows; Windows işi yalnız lint + typecheck + build.

- [ ] **T143 (P2)** - doküman - **Yaşayan MD dışındaki doküman/yorum drift'i**
  - 2026-10-08 göçünde kod ve config'e dokunulmadığı için bırakıldı:
    - ≈50 kod dosyasındaki 64 `PLAN.md …` yorum referansı. Kökteki `PLAN.md`
      yönlendirici bunları arşive götürüyor; kırık değil. Dokunulan dosyada
      doğrudan hedefe (PROJECT_BRAIN / SECURITY_MODEL / arşiv) çevrilebilir.
    - `.env.example`: `PLAN.md` referansları; çerezin `secure` bayrağını
      `NODE_ENV`'e bağlayan bayat yorum (gerçekte `APP_URL`'e bağlı).
    - `ci.yml`: webpack / `extensionAlias` / `./movements.js` / "@kararsiz dışarıda"
      yorumları bayat (T105, T109 sonrası).
    - `0010_cron_tenants.sql` yorumu "`requested_by` NOT NULL" diyor; sütun nullable.
    - ADR-005'in "mobil geri alınamaz" bağlamı ile `ARC-13` (EAS OTA) çelişiyor.
    - Runbook komutları POSIX `VAR=… komut` söz dizimiyle yazılmış; PowerShell/CMD'de çalışmaz.

- [ ] **T144 (P2)** - operasyon - **Staging ortamı yok**

- [ ] **T106 (P2)** - tasarım - **Dokunma hedefi kuralı ile kod ayrışık**
  - BLOKE: `UX-04`. Kodda 44 px (`h-11`) butonlar da var (kullanıcılar, boş durum,
    arama kutusu).

- [ ] **T108 (P2)** - hareket - **Fiyat alanı sebebe göre açılıp kapanmıyor**
  - BLOKE: `UX-09` (önce ölçüm: fire girişinde kullanıcı fiyat yazmaya kalkıyor mu).

- [ ] **T112 (P2)** - cron - **Zamanlayıcının kendisi canlıda kurulmadı** — T42'nin parçası.

- [ ] **T90 (P2)** - fiyat - **Yenileme maliyeti (son alış → Yİ-ÜFE endeksli → alış fiyatı)**
  - BLOKE: T91, `PRC-11`. Tasarım: `docs/designs/fiyat-defteri.md` Adım 3 (uyarı,
    engel değil; VUK 298/A uyarısı); mühendislik kararları `PRC-08`. T92'nin kalan
    kısmı (`replacementCost`'un dört kolu ve `price_index` RLS testleri) bu işe ait.

- [ ] **T16 (P2)** - baskı - **Yazıcı zaman aşımı + PDF'e düşme** — T156 (E5) ile birlikte yapılır, önce değil.

## P3

- [ ] **T145 (P3)** - güvenlik - scrypt N=2¹⁴ → 2¹⁷ (girişte yeniden özetleme ile). `packages/db/src/password.ts:31`
- [ ] **T146 (P3)** - migration - Additive kuralını (`DAT-13`) zorlayan otomatik kontrol yok; 0009 `RENAME COLUMN` ihlal etmiş.
- [ ] **T147 (P3)** - gizlilik - Hareket formunun hata yolunda girilen fiyatlar URL'de taşınıyor (tarayıcı geçmişi, erişim logları).
- [ ] **T148 (P3)** - test - `test:e2e:ci`'daki `--grep-invert @kararsiz` ölü filtre; artık hiçbir test etiketli değil.
- [ ] **T149 (P3)** - deploy - `apps/web/package.json`'da `engines` yok; Root Directory `apps/web` olunca Vercel'in Node sürümü sabit değil.
- [ ] **T150 (P3)** - test - E2E testleri demo veritabanını kalıcı değiştiriyor (2026-10-08 koşusu: +4 ürün, +4 hareket, +2 kullanıcı) ve seed verisine bağımlı.
- [ ] **T151 (P3)** - test - `pnpm test` `stok_test_*` veritabanlarını silmeden bırakıyor (zararsız).
- [ ] **T152 (P3)** - repo - `.claude/gstack-main/bin/gstack-global-discover.ts` lisanssız artık üçüncü taraf dosyası; 32 MB'lık vendor kopyası git geçmişinde.
- [ ] **T153 (P3)** - db - FK'lar kiracı-bileşik değil (RI kontrolü RLS'i atlıyor); bugün uygulama kontrolleriyle kapalı, savunma derinliği yok.
- [ ] **T154 (P3)** - bakım - Satır içi action'lı çok büyük sayfa dosyaları (ör. `hareket/page.tsx` 549 satır). Yalnız ilgili işe dokunulurken ele alınır.
- [ ] **T78 (P3)** - performans - Aylık stok değeri özet tablosu. BLOKE: `DAT-15`.

## Product / Future

**Mobil (Faz 5)** — kullanıcı kararıyla en sona bırakıldı (`PRD-03`). Ayrıntı arşivde.

- [ ] **T53 (P1)** - api - `/api/v1` REST uçları (mobilin önkoşulu). Sözleşmede "alanın YOKLUĞU yetki yokluğu, `null` girilmemiş" açıkça yazılmalı (`PROJECT_BRAIN` §7, `SECURITY_MODEL` S7); `MIN_CLIENT_VERSION` bugün hiçbir kodda okunmuyor.
- [ ] **T26 (P1)** - mobil - Expo iskeleti, auth, güvenli token saklama
- [ ] **T27 (P1)** - mobil - Barkod okutma ekranı: kamera hep açık, 800 ms debounce
- [ ] **T28 (P1)** - mobil - Offline outbox (`ARC-10`, ADR-003)
- [ ] **T29 (P1)** - mobil - Senkron sağlık rozeti (E3)
- [ ] **T30 (P1)** - mobil - Sesli + titreşimli geri bildirim (E4)
- [ ] **T31 (P1)** - mobil - Ürün arama + stok görüntüleme
- [ ] **T32 (P2)** - mobil - PIN ile hızlı kullanıcı geçişi + kilit (E10; `PIN` sayaç kapsamı ve `pin_hash` hazır)
- [ ] **T33 (P1)** - mobil - `X-Client-Version` + zorunlu güncelleme (`ARC-09`, ADR-005)
- [ ] **T43 (P1)** - deploy - EAS Update + EAS Build kanalları (`ARC-13`)
- [ ] **T48 (P1)** - test - Outbox saf mantık testleri (sahte transport, tüm durum geçişleri) + yazılı cihaz kontrol listesi (arka plan, OS'un öldürmesi, uçak modu, düşük pil). Cihaz otomasyonu yerine bilinçli seçim (eski D8); otomasyon T160.
- [ ] **T49 (P1)** - mobil - Offline ürün önbelleği + çevrimdışı tanınmayan barkod (`ARC-10`)

**Ürün**

- [ ] **T155** - Sayım (stocktake) akışı (eski E2, P1). Sayım tabloları o gün eklenir (`PROJECT_BRAIN` §12.10).
- [ ] **T156** - Barkod üretme + etiket basma (eski E5, P2); T16 bununla birlikte.
- [ ] **T157** - Maliyet takibi + kâr raporu (eski E8, P2). BLOKE: `DAT-15`. Geçmiş hareketlerde fiyat verisi yok.
- [ ] **T158** - Raf/konum yönetimi arayüzü (eski E9, P3). Şema hazır.
- [ ] **T159** - Mobilde tam katalog senkronu (P2). Tetikleyici: sahada "ürün adını göremiyorum" şikâyeti.
- [ ] **T160** - Mobil cihaz test otomasyonu, Maestro (P3). Tetikleyici: elle kontrol listesinin atlanması.
- [ ] **T161** - Çok katmanlı paketleme hiyerarşisi (P3). Tetikleyici: ikiden fazla paket seviyesi isteyen müşteri.

**Ürünleştirme**

- [ ] **T162** - Kiracı açma / onboarding aracı. Bugün yalnız seed ya da elle SQL (`SEC-03`).
- [ ] **T163** - Parola kurtarma. Son yönetici parolasını unutursa veritabanına elle müdahale gerekiyor.
- [ ] **T164** - KVKK: aydınlatma metni, saklama süresi, kiracı verisini dışa aktarma ve silme (tehdit S10).

**Yön (henüz madde değil):** çok depo / transfer, tedarikçi ve satın alma siparişi,
e-Fatura / e-Arşiv, Logo / Mikro / Paraşüt köprüsü, SaaS kayıt / abonelik / faturalama,
FIFO maliyet.

## Kapananlar

_(Bu dosyada açılıp kapanan görevler buraya iner. T1–T119'un kapanış kayıtları arşivde.)_
