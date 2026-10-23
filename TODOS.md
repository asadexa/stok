# TODOS — backlog

Gerçek iş listesi. **Güncel durum burada değil** (→ `CURRENT_STATE.md`),
**kararlar burada değil** (→ `DECISIONS.md`). Yol boyunca bulunan her yeni iş
`gorev-kaydet` skill'iyle buraya yazılır; o anki iş bölünmez.

**Kurallar**

- ID `T<n>`. Arşivdeki görevler numaralarını korur. Yeni görev en büyük
  numaradan devam eder — **sıradaki boş numara: T217**. Numara yeniden
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

Yol haritasının üstü (kullanıcı kararı 2026-10-22; 2026-10-17 sırasının yerine), bu sırayla:
(1) T171, toplu ürün aktarımını 20.000 satıra ölçeklendirme (geliştirme tamamlandı, manuel UAT bekleniyor);
(2) T201, gerçek tedarikçi API entegrasyonu; (3) T200 Dilim 2; (4) UX iyileştirmeleri uygun ürün
dilimlerinde (T212–T215, T210, T211), tek bir yeniden tasarım olarak değil. T200 PLAN ve Dilim 1
tamam; Dilim 1 kullanıcı kabul testinde kabul edildi (2026-10-22). HTTPS test ortamı (T144; üretim
T42 ayrı) ayrı operasyon hattında yürüyor; bu ürün sırası onu değiştirmez. Sıra ürün önceliğidir:
kritik veri bütünlüğü ve güvenlik işlerini ertelemenin gerekçesi değildir. Diğer P1 işler ve
güvenlik/veri koruma gereklilikleri olduğu gibi geçerli.

- [ ] **T171 (P1)** - import - **Büyük içe aktarma tek istekte uzun sürüyor (2.000 satır devirli 47 sn); kullanıcı hedefi 20.000 satır**
  - Neden: satırlar tek tek, her devir kendi `createMovement` transaction'ında yazılıyor
    (bilinçli: tek yazma kapısı ve satır bazlı hata). Yerel `next start`'ta sorun değil;
    Vercel'de sunucu eylemi fonksiyon süre sınırına takılabilir, kullanıcı yarım
    aktarım görür (tekrar çalıştırma eksik devirleri tamamlıyor, ikinci kez yazmıyor).
  - Kanıt: WS-B ölçümü 2026-10-10, ayrı test veritabanı: devirsiz ilk koşu 23,5 sn,
    devirli ilk koşu 47,1 sn, tekrar 32,5 sn; önizleme 125–305 ms.
  - Kullanıcı talebi (T200 UAT, 2026-10-21): `Stok → Toplu aktarma` 20.000 satıra kadar dosya
    almalı. Bugün sınır `IMPORT_ROW_LIMIT = 2_000` (`packages/core/src/import.ts:61`; ekran metni
    `urunler/aktar/page.tsx:56` aynı sabitten). Amaç: büyük işletmelerin dosyalarının güvenilir
    işlenmesi; 20.000 satır ürün gereksinimi, uygulanacak mimari henüz kararlaştırılmadı.
  - Sıra: yol haritasının ilk işi (kullanıcı kararı 2026-10-22; önceki P2).
  - Durum (2026-10-23): geliştirme tamamlandı, manuel UAT bekleniyor. PLAN ve Engineering Review
    onaylı; kod ve belgeler `development`'a gönderildi. Kabul testinden önce kapatılmaz. Mimari `ARC-15` (ADR-007), sayı kuralı `DAT-20`, özellik
    F-02, koruma S21, ölçümler `CURRENT_STATE`.
  - YAPILMAYACAK: yalnız `IMPORT_ROW_LIMIT`'i 20.000'e çıkarmak. Doğrusal tahminle (ölçülmedi)
    devirli 20.000 satır tek istekte ~8 dk sürer; süre sınırına takılan istek yarım aktarım bırakır.
  - PLAN'da değerlendirilecek: dosya boyutu (`MAX_UPLOAD_BYTES` 4 MiB, Vercel 4,5 MB gövde
    sınırı; T208, arşiv T118); önizleme süresi ve bellek; işlem süresi; parçalama ya da iş kuyruğu
    (emsal: dışa aktarmada `planExport` inline/queued + `enqueueJob`, `exports.ts:292-315`,
    `jobs.ts:115`; T138'deki cron turu sınırı); büyük dosyada satır bazlı hatalar ve raporu (T172);
    idempotency (`DAT-18`: devir anahtarı UUID v5, tekrar koşu eksik devirleri tamamlar); kiracı
    izolasyonu (INV-4); stok defteri bütünlüğü (her devir `createMovement` tek kapısından,
    INV-1/2/3); CSV sayı biçimi riski (T205).
  - Bağlı: T42, T138 (aynı sınıf: uzun iş tek istekte), T205, T208, T172, `OPS-01`, `DAT-18`.
  - Doğrula: üretim platformunda 2.000 satırlık devirli dosya; gerekirse iş kuyruğuna
    alma ya da parçalama (tek kapıdan geçme kuralı korunarak). 20.000 satır hedefi için: süre,
    bellek ve istek boyutu ölçümü; yarıda kesilen aktarımın tekrarında mükerrer devir yok;
    defter = projeksiyon (invariant testi).
- [ ] **T200 (P1)** - entegrasyon - **B2B V1: tedarikçi ürün, fiyat ve stok verisini çekme ve karşılaştırma**
  - Neden: tedarikçinin ürün, barkod, fiyat ve stok bilgisi bugün elle yeniden yazılıyor ya da
    hiç görünmüyor; aynı ürün için tedarikçiler karşılaştırılamıyor.
  - Ürün kararı: `PRD-14` (onaylı; Dilim 1'de uygulandı, Dilim 2 kalan). Kabul kriterleri
    `docs/TEKNIK_SARTNAME.md` F-12.
  - İlerleme (2026-10-22): PLAN onaylı (B1–B3, `PRD-15`, `DAT-19`, ADR-006). Dilim 1 tamam ve
    kullanıcı kabul testinde **kabul edildi** (2026-10-22): Dilim 1a (shared, db migration 0012,
    core, testler) `9d4bc8c`, CI #83 yeşil; Dilim 1b (ekranlar, eylemler, ayar düzenleme `PRD-16`,
    e2e; REVIEW'un B1 ve B2 düzeltmeleri dahil) `667512a`, CI #84 yeşil. UAT özeti `CURRENT_STATE`.
    T200 açık: Dilim 2 kalan.
  - Kalan (Dilim 2): genel tedarikçi fiyat karşılaştırma ekranı; kod eşitliğinden kullanıcı onaylı
    eşleşme önerisi (otomatik eşleşme yalnız barkodla kalır, `PRD-15`); tedarikçi dosyası için örnek
    CSV/XLSX şablon indirmenin kapsam değerlendirmesi (UAT isteği 2026-10-21; emsal ürün aktarmada
    "Örnek şablonu indir", `urunler/aktar/page.tsx:58`).
  - UAT bulguları (2026-10-20…22): yeni görev T212–T215; T210 genişletildi; mevcut işlere bağlananlar
    T171 (20.000 satır), T201 (API bağlantısı), T211 (barkodla stok araması). "En düşük fiyat" ve
    artış/azalış göstergelerinin zaman sınırı yok; bu davranış korunur (F-12), iş açılmadı.
  - Yapılacak (V1): sağlayıcıdan bağımsız tedarikçi kalemi modeli; dosya kaynağı ve örnek API
    verisi; ürün ↔ tedarikçi eşleşmesi (bir ürüne birden çok tedarikçi); "Verileri Getir";
    son fiyat ve stok kaydı, fiyat geçmişi yalnız değişimde; tedarikçiler arası karşılaştırma.
  - Sıra: PLAN ve Dilim 1 tamam. Dilim 2, T171 ve T201'den sonra (kullanıcı kararı 2026-10-22);
    Dilim 2 iptal edilmedi, önceliği değişti.
  - Sınırlar: tedarikçi verisi ürün kartının alış/satış fiyatını ve `current_stock`'u
    değiştirmez, hareket üretmez (INV-3). Tedarikçi stoğu "Açılış Stoğu"na (`openingQty`)
    asla eşlenmez: o sütun devir hareketi yazar (`DAT-18`). Farklı para birimi, vergi ya da
    fiyat türü doğrudan karşılaştırılmaz. Kiracı izolasyonu korunur (INV-4); tedarikçi fiyatı
    alış niteliğinde olduğu için varsayılan olarak çalışana gitmez (INV-10).
  - Yeniden kullanım adayı: `packages/core/src/import.ts` (`parseProductFile` → `previewImport`
    → `commitImport`; satır bazlı hata; `COLUMN_ALIASES`), barkod ve stok kodu eşleşmesi.
    `products.brand` zaten var.
  - Açık sorular: ilk gerçek sağlayıcı ve veri biçimi (seçilmedi); belirsiz eşleşmenin nasıl
    onaylanacağı; tedarikçi kataloğundan yeni ürün açılıp açılmayacağı; para birimi ve vergi
    verisinin kaynakta nasıl geldiği; aynı barkodun farklı birim ya da koli çarpanıyla gelmesi
    (`DAT-17`); barkodsuz ürünün eşleşmesi (T177); fiyat geçmişinin saklama süresi.
  - Bağlı: T201, T202, T203, T171, T177. Karıştırılmaz: T53 (bizim sunduğumuz REST), T182 (POS
    satış aktarımı).
  - Doğrula: F-12 kabul kriterleri; özellikle "Verileri Getir" sonrası hareket sayısı,
    `current_stock` ve ürün kartı fiyatları aynı, değişmeyen fiyat geçmiş satırı üretmiyor.
  - Kaynak: kullanıcı önerisi 2026-10-16; ekip kararı 2026-10-17.
- [ ] **T144 (P1)** - operasyon - **İnternetten erişilebilir HTTPS test ortamı (staging) yok**
  - Neden: uygulama yalnız localhost'ta. Giriş, ürün yükleme ve stok hareketlerinin gerçek
    bir alan adında HTTPS ile çalıştığı çevrim içi bir test ortamı gerekiyor (`OPS-12`).
  - Sıra: T200'ün ilk BUILD diliminden sonraki yakın adım; B2B geliştirmesini geciktirmez.
  - Yapılacak: barındırma seçimi (`OPS-01` Open; aday Vercel + Supabase, onaysız
    kesinleşmez); runbook adımlarıyla ayrı test veritabanı ve `stok_app` rolü; yalnız sentetik
    veri; HTTPS alan adı; sağlık ucu ve duman testi.
  - Sınırlar: test ve üretim ayrı ortam ve veritabanı; teste gerçek müşteri verisi girmez.
    Bulut veritabanının yedeği sağlayıcının yedeğidir, yerel `db:backup` (`OPS-10`) değildir;
    tatbikat T129. Telefon köprüsü oturumları süreç belleğinde: çok örnekli dağıtımda
    `ENABLE_PHONE_SCANNER` kapalı kalır (`ARC-14`).
  - Önkoşul: internete açılmadan önce Supabase fonksiyon yetkileri (T124). Bilinen sınırlar:
    UTC sunucuda gün sınırı (T122), cron planı (`OPS-02`, T112), harici izleme yok (T129).
  - Bağlı: T42 (üretim, ayrı iş), `OPS-01`, `OPS-12`, T124, T129, T167. Özellik kaydı
    `docs/TEKNIK_SARTNAME.md` F-13.
  - Doğrula: alan adından HTTPS ile giriş, ürün aktarma ve stok hareketi; `/api/v1/health`
    200; uygulama bağlantısı `stok_app` (superuser değil) ve RLS açık.
  - Kaynak: eski P2 kaydı ("Staging ortamı yok"); ekip kararıyla P1, 2026-10-17.
- [ ] **T201 (P1)** - entegrasyon - **B2B harici API kaynağı: yetkili veri çekme, gizli bilgi ve hata yönetimi**
  - Neden: V1 örnek API verisiyle doğrulanacak, gerçek API sağlayıcı seçilince bağlanacak. Her
    sağlayıcı için ayrı ve denetimsiz çekme kodu yazılırsa gizli bilgi, hata ve mükerrer
    kayıt sorunları her seferinde yeniden açılır.
  - Sıra: T171'den sonraki ana iş, T200 Dilim 2'nin önünde (kullanıcı kararı 2026-10-22). İlk
    hedef: erişimi sağlanabilen gerçek bir tedarikçiyle uçtan uca çalışan entegrasyon. Gerçek
    sağlayıcı belirlenmeden "her sağlayıcıyla çalışır" iddiası yok: sözleşme örnek veriyle
    sınanır, gerçek uyum sağlayıcı seçilince kanıtlanır.
  - Kapsam beklentisi (kullanıcı, 2026-10-22): güvenli bağlantı; kimlik doğrulama ve gizli
    anahtarın korunması; tedarikçi ürün kodu ve barkodla eşleştirme (`PRD-15` kuralları); fiyat ve
    tedarikçi stoğu; elle yenileme ("Verileri Getir") ve anlaşılır hata; mevcut veri modeli ve fiyat
    geçmişi kuralları (`DAT-19`, ADR-006); ileride birden çok tedarikçiye açık, sağlayıcıdan bağımsız
    yapı. Sağlayıcı, kimlik doğrulama yöntemi ve teknik yaklaşım PLAN'da kanıtla seçilir.
  - Yapılacak: sağlayıcı bağdaştırıcısının sözleşmesi (çıktısı T200'ün tedarikçi kalemi);
    kimlik doğrulama; gizli bilginin kiracı bazında korunması (log, URL ve hata metnine
    gitmez: `PROJECT_BRAIN` §12.7); hata yönetimi (sessiz başarısızlık yok, §12.5); tekrarlı
    ve idempotent çekme (sayfalama, oran sınırı, yeniden deneme).
  - Sınırlar: hiçbir zaman stok hareketi üretmez; fiziksel stoğu (`current_stock`) ve ürün kartının
    alış/satış fiyatını otomatik değiştirmez (`PRD-14`). Kiracı izolasyonu (INV-4) ve satın alma
    fiyatı yetkisi (INV-10) korunur. Ayrı API sunucusu ya da dış servis varsayılmaz (§14: monolit).
    Yeni kütüphane ya da gizli bilgi deposu seçimi onay ister.
  - Açık sorular: kimlik doğrulama biçimleri; gizli bilginin nerede ve nasıl saklanacağı
    (şifreleme, anahtar yönetimi, döndürme); barındırmanın dış ağ çağrısına etkisi (`OPS-01`);
    kişisel veri gelirse KVKK (T164); yeni tehditler için `SECURITY_MODEL`'e S satırı.
  - Bağlı: `PRD-14`, T200, T203. `ARC-07` (bizim REST yüzeyimiz; bu iş ters yön, istemci
    tarafı). Karıştırılmaz: T53, T182.
  - Doğrula: gizli bilginin log/hata/URL'de görünmediği, tekrarlı çekmenin mükerrer
    üretmediği, hata yolunun veriyi değiştirmediği testler (`dogrula`).
  - Kaynak: kullanıcı önerisi 2026-10-16; ekip kararı 2026-10-17.

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
  - Yeniden üretildi (2026-10-10 00:25 ve 01:36, yerel UTC+3, DB UTC): `cron.test.ts`'in
    üç testi (T88.1 kasa açığı ×2, T36 sağlık alarmı) yerel saatle kırmızı, `TZ=UTC` ile
    19/19 yeşil. Gece 00:00–03:00 arası yerel test koşusu bu yüzden kırılıyor.
  - Ek (2026-10-18): T36 testinin ("her şey yolundayken") kırmızısı saat dilimi değil koşu
    saatiydi: alarm anı sabit bugün 10:00, hareketler "şimdi" yazılıyordu; süreç saatiyle
    08:00'den önce koşunca kırmızı (CI #76, UTC 00:05; `TZ=UTC` de yetmiyordu). Test son
    hareketi alarm anından 1 saat önceye yazacak biçimde düzeltildi; yerel saat 00–21 arası
    sekiz noktada yeşil. Kayıttaki diğer iki test (T88.1) T122'ye bağlı kalıyor.
  - Kısmen ele alındı (WS-C-lite, T173): Excel hücreleri ve dosya adı sabit
    Europe/Istanbul. Hâlâ sunucu saatine bağlı olanlar: ekran `formatDateTime`
    (`apps/web/src/lib/format.ts`, bulutta UTC gösterir), tarih filtresinin gün sınırı
    (`dayStartIso`/`dayEndIso`, ekran ve Excel indirmesi ortak), cron ve rapor günü.

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

- [ ] **T129 (P1)** - operasyon - **Harici izleme ve yedek geri yükleme tatbikatı yok**
  - Neden: `/api/v1/health`'i yoklayan uptime izleyici yok; cron'un 500'ü yalnız
    platform loglarında; hata takibi (Sentry vb.) yok. HEALTH_ALARM SMTP'ye bağlı:
    SMTP bozuksa onu haber verecek alarm da gidemiyor. Geri yükleme tatbikatı hiç
    yapılmadı (runbook §7).
  - Bağlı: T42.

- [ ] **T167 (P1)** - güvenlik - **Telefon tarama pilotunun tüneli bütün uygulamayı internete açıyor**
  - Neden: `cloudflared tunnel --url http://localhost:3000` yalnız `/tara`'yı değil giriş
    sayfası dahil her yolu dışarı açıyor. Demo hesaplarının parolaları README'de herkese
    açık; gerçek dükkân verisiyle tünel açık kalırsa adresi bulan biri giriş ekranına
    ulaşır (kaba kuvvet kilidi S9 var, tek savunma o ve rastgele tünel adresi).
  - Kanıt: WS-SCAN spike ve Phase 2 (2026-10-09); README "Telefonla barkod okutma" adımları.
  - Yapılacak: tüneli yalnız `/tara`, `/api/tara/*`, `/_next/static/*` yollarına sınırlamak
    (cloudflared ingress yol kuralları ya da Cloudflare Access) ya da sabit adlı, erişim
    kontrollü tünel. O zamana kadar: tünel yalnız test/kullanım süresince açık.
  - Bağlı: `SECURITY_MODEL` S18, `ARC-14`, T137.
  - Doğrula: tünel adresinden `/giris` 403/404, `/tara` ve `/api/tara/*` çalışıyor.
  - Kaynak: WS-SCAN kapanışı, 2026-10-09.

- [ ] **T42 (P1)** - deploy - **Vercel + Supabase üretim kurulumu**
  - Kod tarafı T114–T119 ile hazır. Hesap kurulumu, plan kararı (`OPS-02`) ve ilk
    migration insana ait; adımlar `docs/uretim-runbook.md`'de.
  - Önkoşul: T121–T126, T129. Zamanlayıcının canlıda kurulması (T112) bu işin parçası.
  - Sıra: önce çevrim içi test ortamı (T144, `OPS-12`); üretim ayrı ortam ve veritabanı.

- [ ] **T110 (P1)** - arayüz - **JS kapalıyken formlar kullanılamıyor (streaming Suspense)**
  - BLOKE: `UX-08`. Depodaki tarayıcılar gerçekten JS'sizse P0'a çıkar.

- [ ] **T91 (P1)** - araştırma - **Fiyat senaryolarını gerçek kullanıcıda gözlemle**
  - Kalan iki soru: 5 yıllık ürünün faturası var mıydı (varsa T90'ın endeks yarısı
    gereksiz olabilir); enflasyon zararını satarken mi sonradan mı fark etti.
    T90'dan önce yapılmalı.

## P2

- [ ] **T216 (P2)** - cron - **Kuyruğa alınan büyük dışa aktarma hiç çalışmıyor: cron'da `STOCK_EXPORT`/`MOVEMENT_EXPORT` işleyicisi yok**
  - Neden: `planExport` büyük raporu kuyruğa atıp e-postayla göndermeyi vaat ediyor, ama
    `runCron` `runQueuedJobs`'a yalnız `DAILY_REPORT`, `LOW_STOCK_SCAN`, `HEALTH_ALARM`
    işleyicilerini veriyor. İşleyicisi olmayan iş `SERVER_ERROR` ("no handler") ile başarısız
    sayılıyor: kullanıcı raporu hiç almıyor. Ekran ise "Bu boyuttaki rapor arka planda
    hazırlanıp e-posta ile gönderilir" diyor (`apps/web/src/components/export-control.tsx:71`);
    README bu sınırı ve sorunu açıkça yazıyor (T171 belge senkronu).
  - Kanıt: `packages/core/src/cron.ts:529-537` (işleyici haritası); `packages/core/src/jobs.ts:333-345`
    (işleyicisiz iş başarısız); kuyruğa alma `apps/web/src/server/export.ts:21`,
    `packages/core/src/exports.ts:357`, `:390`. `createExportJobHandler` yalnız `exports.test.ts`'te
    kullanılıyor. Kod okumasıyla bulundu; tarayıcıda ya da üretimde denenmedi.
  - Bağlı: T138 (cron turu sınırı), `OPS-02`.
  - Doğrula: kuyruğa giden bir stok raporu için `runCron` turundan sonra işin `DONE` olduğu ve
    e-postanın gönderildiği bir test (gerçek PostgreSQL, sahte posta taşıyıcısı).
  - Kaynak: T171 BUILD sırasında kod okuması, 2026-10-23.
- [ ] **T204 (P2)** - güvenlik - **Web eylemleri ham hatayı logluyor; Drizzle hata mesajı sorgu parametrelerini (fiyat, barkod) taşıyor**
  - Neden: beklenmeyen bir veritabanı hatasında Drizzle'ın hata mesajı `Failed query: …` ile
    birlikte `params: [...]` satırını da içeriyor. `console.error('[import action]', err)` gibi
    ham hata loglayan bir eylem, içe aktarılan alış/satış fiyatlarını ve barkodları stdout'a, oradan
    log toplayıcıya yazar. `PROJECT_BRAIN` §12.7 ve `observability.ts` "fiyat ve barkod loglanmaz"
    diyor; INV-10'un log yolu bu durumda açık.
  - Kanıt: T200 1a'da `dogrula` sırasında fark filtresi kaldırılınca `suppliers.test.ts` hata
    çıktısında `params: [{"supplier_code":"A","barcode":"sup-P-1-U",…,"price":"9.0000",…}]`
    görüldü (2026-10-19). Ham hata loglayan yerler: `apps/web/src/app/(panel)/urunler/aktar/actions.ts:45`,
    `hareket/phone-scan-actions.ts:35`, `server/export.ts:26`, `server/form.ts` (`errorQuery`), `server/http.ts:35`.
    Hangisinin fiyat taşıyan sorguya ulaştığı tek tek doğrulanmadı.
  - Yapılacak: beklenmeyen hatada yalnız SQLSTATE/constraint ve hata sınıfı loglanır
    (`pgErrorCode`, `pgConstraint`).
  - İlerleme (T200 1b, 2026-10-20): tedarikçi eylemleri bu kuralla yazıldı
    (`server/safe-log.ts` `logUnexpected`, `server/form.ts` `safeErrorQuery`; `safe-log.test.ts`,
    `dogrula` ile kırmızısı görüldü). PostgreSQL'in "Failing row contains (…)" ayrıntısı da satır
    değerlerini taşıyor; testte o da var. Kalan ham yerler yukarıdakiler; `errorQuery` öteki
    sayfaların formlarında hâlâ ham yazıyor.
  - Bağlı: S7, INV-10, T200.
  - Doğrula: kayıtta DB hatası üreten bir test, log yazıcısında fiyat ve barkod geçmediğini sınar.
  - Kaynak: T200 Dilim 1a, `dogrula`, 2026-10-19.
- [ ] **T205 (P2)** - core - **Virgülsüz noktalı sayı ("1.234") ondalık okunuyor; Türkçe binlik ayırıcı olabilir**
  - Neden: `parseTurkishNumber` virgül yoksa noktayı ondalık sayıyor. Türkçe hazırlanmış bir CSV'de
    "1.234" bin iki yüz otuz dört demek olabilir; fiyat bin kat düşük, sessizce kaydedilir. xlsx'in
    sayı hücresi etkilenmez (hücre sayı olarak gelir); risk metin hücrelerinde ve CSV'de.
  - Kanıt: `packages/core/src/import.ts` `parseTurkishNumber`. Ürün içe aktarma (F-02) ve tedarikçi
    dosyası (F-12) aynı fonksiyonu kullanıyor. Gerçek bir dosyada görülmedi (tahmini bulgu).
  - Yapılacak: biçim kararı (belirsiz yazımı satır hatası mı saymalı) ve iki içe aktarmada aynı kural.
    Tedarikçi tarafında 1b önizlemesi okunan fiyatı gösterecek; bu tek başına kalıcı çözüm değil.
  - Bağlı: F-02, F-12, T200.
  - Doğrula: "1.234" ve "1.234,00" içeren CSV'nin önizlemesi.
  - Kaynak: T200 Dilim 1a, 2026-10-19.
  - Durum (2026-10-23): T171 K1 ile çözüldü: `DAT-20` (belirsiz yazım satır hatası, iki içe
    aktarmada aynı kural `isAmbiguousTurkishNumber`); testler `import.test.ts`,
    `supplier-feed.test.ts`. T171'in manuel UAT'siyle birlikte kapanacak.
- [ ] **T207 (P2)** - test - **`invariant.test.ts` (1000 hareket) bu makinede 30 sn sınırını aşıyor; yerel `pnpm test` kırmızı**
  - Neden: test ~32 sn sürüyor, vitest sınırı 30 sn. Invariant BOZULMUYOR (sınır yükseltilince
    defter = projeksiyon, yeşil); sorun süre payı. Yerel kapı kırmızı göründüğünde gerçek bir
    kırmızı gözden kaçabilir. CI #82 (Linux) yeşil.
  - Kanıt: 2026-10-19, Windows 11 + Docker Desktop. HEAD `93b38f6` kodunda (T200 değişiklikleri
    stash'te) 32,3 sn ve 32,5 sn; T200 1a ile 31,5 sn. Yani T200 kaynaklı değil.
  - Yapılacak: bu teste açık bir zaman sınırı mı, hareket başına maliyetin ölçümü mü (ör. T171 ile
    ortak darboğaz) karar. Kararsız test sayıp kapı dışına almak YOK (T109).
  - Doğrula: yerel `pnpm --filter @stok/core run test` yeşil; süre ölçümü kayıtlı.
  - Kaynak: T200 Dilim 1a kapıları, 2026-10-19.
- [ ] **T190 (P2)** - operasyon - **Zamanlanmış yedekten (WS-1.3b) önce: kuşak koruması ve `pg_dump` bekleme sınırı**
  - Neden: WS-1.3a'nın saklaması volume kuşağı ayırmıyor; kazara `db:reset` (ya da Docker Desktop
    verisinin silinmesi) sonrası 14 başarılı koşu reset öncesi bütün dökümleri döndürür. Elle
    kullanımda boş uygulama hemen fark edilir; gözetimsiz günlük koşuda iki hafta içinde sessizce
    olur. Ayrıca `pg_dump` tablo kilidini sınırsız bekliyor (ör. süren bir migration): elle koşuda
    Ctrl+C yeter, zamanlanmış koşu asılı kalır.
  - Kanıt: WS-1.3a planı (hazy-humming-flurry) E-8 ve E-11, 1.3b'ye ertelendi;
    `packages/db/src/backup-policy.ts` `planRetention`, `dumpCommand`.
  - Bağlı: WS-1.3b, `OPS-10`.
  - Doğrula: reset öncesi ve sonrası damgalı sahte dökümlerle saklama testi (eski kuşak silinmez);
    kilit tutan bir oturum açıkken `--lock-wait-timeout` ile yedeğin süre içinde reddedilmesi.
  - Kaynak: WS-1.3a planı, 2026-10-16.

- [ ] **T188 (P2)** - db - **`tenant:create`, tablolar başka şemaya çözülürse oraya yazabilir**
  - Neden: T187'de seed'e eklenen şema kontrolü (`search_path` veritabanı/rol ayarı ya da rolle
    aynı adlı şema) `tenant:create`'te yok; `provisionTenant` tablo adlarını şemasız yazıyor.
    Yalnız ekleme yapıyor (veri kaybı yok) ve şema gölgesi veritabanı sahibinin işlemiyle
    oluşuyor; gösterilen veritabanı ise artık doğrulanıyor.
  - Kanıt: **doğrulanmadı (çıkarım)**. Mekanizma seed için ölçüldü: `seed-guard.test.ts`
    "gölge veritabanında tablolar public dışına çözülüyor (kontrol)".
  - Bağlı: T187, S12. **Gerçek pilotta yeni kiracı oluşturulmadan önce düzeltilmeli**
    (kullanıcı kararı, 2026-10-13).
  - Doğrula: gölge şemalı izole bir `stok_test_*` veritabanında `tenant:create` çalıştırılıp
    kaydın nereye yazıldığı ölçülür; risk doğrulanırsa seed'deki çözümleme kontrolü
    (`seed.ts` `schemaShadowed`) burada da uygulanır.
  - Kaynak: T187 uygulaması, 2026-10-13.

- [ ] **T132 (P2)** - defter - **`current_stock` uygulama rolünce yazılabilir**
  - Neden: `stok_app`'ten yalnız DELETE geri alınmış; INSERT/UPDATE serbest (trigger
    çağıranın yetkisiyle çalışıyor). Tek yazma kapısı (`DAT-02`) bir konvansiyon;
    ihlal ancak sonradan invariant'la görülür. Seçenek: SECURITY DEFINER trigger +
    REVOKE.
  - Kanıt: `packages/db/migrations/0002_ledger_projection_rls.sql:64`.

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
  - Not (WS-SCAN): CSP eklenirken `/tara` için `script-src 'wasm-unsafe-eval'` (ZXing WASM
    derlemesi) ve `Permissions-Policy: camera=(self)` gerekiyor; yoksa iPhone'da okutma
    sessizce başlamaz. WASM kendi origin'imizden (`/_next/static/media/`) geliyor, CDN yok.

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

- [ ] **T165 (P2)** - auth - **Parolasını değiştiren kullanıcı panele geri düşüyor; o tarayıcının oturumu ≤15 dk açık kalıyor**
  - Neden: `savePassword` refresh oturumlarını iptal edip `/giris?bilgi=parola`'ya
    yönlendiriyor ama çerezleri silmiyor. Access token yalnız imzadan doğrulandığı
    için `/giris` oturumu geçerli görüp `/panel`'e atıyor. "Parolanız değiştirildi"
    bildirimi hiç görünmüyor; ekrandaki "tüm oturumlar kapanır ve yeniden giriş
    yapmanız gerekir" vaadi, parolayı şüpheyle değiştiren kullanıcının kendi
    tarayıcısında ≤15 dk gecikiyor.
  - Kanıt: `apps/web/src/app/(panel)/ayarlar/page.tsx:85-109` (çerez silinmiyor),
    `apps/web/src/app/giris/page.tsx:24`, vaat `ayarlar/page.tsx:255`. Tarayıcı
    teşhisi 3/3 tur: gezinme `/giris?bilgi=parola` → `/panel`, ardından `/stok`
    açılıyor; eski parola reddediliyor, yeni parola giriyor.
  - Bağlı: S5, T134.
  - Doğrula: e2e; parola değişince bildirim görünüyor ve korumalı sayfa `/giris`'e
    yönleniyor. Muhtemel düzeltme yönlendirmeden önce `endSession()` (doğrulanmadı).
  - Kaynak: WS-A tarayıcı doğrulaması, 2026-10-09.

- [ ] **T168 (P2)** - web - **Telefonla okutmada UPC-A 12 hane, kayıtlı barkod 13 hane olabilir**
  - Neden: ZXing UPC-A'yı 12 hane döndürüyor; aynı ürünün sistemdeki barkodu (USB
    okuyucunun yazdığı ya da Excel'den aktarılan) başında 0 olan 13 hane olabilir. O
    durumda telefon okuması laptopta "barkod tanımlı değil" gösterir. Türkiye'deki
    ürünlerin çoğu EAN-13 (869…) olduğu için sıklığı bilinmiyor; **doğrulanmadı**.
  - Kanıt: `apps/web/src/app/tara/scan-logic.ts` (`SCAN_FORMATS` UPC-A ve EAN-13 ayrı
    biçim); iPhone kabul testinde UPC'li ürün denenmedi.
  - Doğrula: gerçek bir UPC-A ürünü telefonla ve USB okuyucuyla okut, iki değeri ve kayıtlı
    barkodu karşılaştır. Normalizasyon gerekiyorsa sessiz değil, ölçülmüş bir kuralla.
  - Kaynak: WS-SCAN spike bulgusu, 2026-10-09.

- [ ] **T183 (P2)** - güvenlik - **Uygulama sunucusu yerel ağda HTTP ile bütün arayüzlerde açık**
  - Neden: `next start` varsayılan olarak bütün arayüzlerde dinliyor; yerel ağdaki herkes
    giriş ekranına şifresiz HTTP ile ulaşıyor (parola ağda açık metin; `APP_URL` yoksa çerez
    `Secure`, varsa şemaya bağlı). Veritabanı portu WS-1.1'de kapatıldı, uygulama portu açık
    kaldı. WS-1 kapsamı dışında bırakılan açık risk (K9).
  - Kanıt: `apps/web/package.json:9` (`"start": "next start"`, `-H` yok); ölçülmedi.
  - Bağlı: S19 (Açık), T167 (tünel kapısı yalnız `127.0.0.1`'e bağlanacak), T175 (telefondan
    ürün yönetimi yerel ağ erişimine dayanmamalı).
  - Doğrula: ölçüm (`netstat`, başka cihazdan `:3000`), sonra karar (`-H 127.0.0.1` ya da
    bilinçli yerel ağ erişimi + HTTPS).
  - Kaynak: WS-1 Engineering Review A-3, 2026-10-13.
- [ ] **T211 (P2)** - core - **Stok listesi araması ürün barkodunu kapsamıyor; yalnız ad ve SKU**
  - Neden: `/stok`'ta barkodu (ör. `86910000150`) yazıp Filtrele'ye basan kullanıcı "ürün
    bulunamadı" görüyor; aynı ürün SKU ile (`YIL-0016`) bulunuyor. Etiketten ya da okuyucuyla
    barkod girerek stok arayan kişi ürünün kayıtlı olmadığını sanar, mükerrer ürün açabilir.
  - Kanıt: T200 UAT Senaryo 2, kullanıcı gözlemi (2026-10-20, yerel `next dev`, Yılmaz demo
    kiracısı). Kod: `packages/core/src/stock.ts:76-83` (`whereClause`: yalnız `name_norm` ve `sku`
    üzerinde `LIKE`; `product_barcodes` yok; yorum okutulanın "çoğu zaman kod" olduğunu varsayıyor).
    Ctrl+K paleti (`searchAll`, `stock.ts:268-288`) barkodu ayrı yoldan tam eşleşmeyle buluyor;
    `/stok` o yolu kullanmıyor.
  - Yapılacak: `listStock` aramasına ürünün aktif barkodları. Barkodda tam mı parça eşleşme mi:
    BUILD planında (palet tam eşleşme kullanıyor, gerekçe `stock.ts:264-266`).
  - Kabul: ad, SKU ve aktif barkodla arama; arşivlenmiş barkod eşleşmez, arşivli ürün yalnız
    "arşiv" süzgeciyle gelir; başka kiracının barkodu eşleşmez (INV-4, `tenant_id` + RLS); birden
    çok barkodu eşleşen ürün TEK satır (JOIN değil EXISTS), toplam ve sayfalama doğru; aynı arama ve
    süzgeç koşullarında stok listesinin eşleşen ürün kümesi ile Excel dışa aktarmasının ürün kümesi
    tutarlı, sayfalama ve yetki kuralları korunur; regresyon testleri gerçek PostgreSQL'de.
  - Etki: stok listesi araması `stock.ts` → `whereClause` / `listStock`; `listStock`'u `/stok`,
    panelin kritik listesi, `getProduct` (`stock.ts:687`; yalnız `productId`, arama yok) ve
    `searchAll` (Ctrl+K `/api/arama`, tedarikçi bağlama paneli) çağırıyor. Excel dışa aktarma
    araması `exports.ts:113-125` → `exportStock`: aynı koşulun KOPYASI, `listStock`'u çağırmıyor
    (stok sayfasındaki Excel düğmesi, raporlar, `/api/rapor/stok`); yalnız `whereClause` değişirse
    liste ile Excel ayrışır. Palette barkod isabeti ürün listesinde ikinci kez görünebilir; kararı
    BUILD'de. (Graphify `affected` + grep, 2026-10-21.)
  - Bağlı: F-07, T200 (UAT'de bulundu). Arşiv: T19 (stok tablosu araması), T85/T86 (birleşik
    arama, Ctrl+K).
  - Doğrula: core testi: adla, SKU ile, barkodla arama; arşivlenmiş barkod; iki barkodlu ürün tek
    satır; başka kiracının barkodu; aynı aramayla `exportStock` aynı ürün kümesini verir
    (`exports.test.ts`). Tarayıcıda `/stok?ara=86910000150` Mavi Klasör'ü gösterir.
  - Kaynak: T200 UAT Senaryo 2, 2026-10-20.

## P3

- [ ] **T209 (P3)** - web - **Başarısız kayıttan sonra hata, yeni önizlemede de görünüyor (tedarikçi sihirbazı)**
  - Neden: `tedarikciler/[id]/refresh-wizard.tsx` hata metnini `sizeError ?? saved.error ??
    state.error` ile seçiyor ve kayıt eyleminin durumu yeni önizlemede sıfırlanmıyor. Kayıt bir
    kez hata verirse (oturum düşmesi, eşzamanlı değişiklik), kullanıcı yeni dosyayı başarıyla
    önizlese de eski kayıt hatası önizlemenin üstünde kalıyor; dosyanın hâlâ hatalı olduğunu
    sanabilir. Veri etkisi yok.
  - Kanıt: kod okuması (T200 1b REVIEW, D1); tarayıcıda yeniden üretilmedi.
  - Öneri: kayıt durumunu önizlemeye bağlamak (ör. kayıt formu, önizlemenin kimliğiyle
    anahtarlanmış bir alt bileşende).
  - Doğrula: e2e: kaydı hatayla bitir → yeni dosyayı önizle → eski hata görünmüyor.
  - Kaynak: T200 Dilim 1b REVIEW, 2026-10-20.
- [ ] **T210 (P3)** - web - **T200 1b ekranlarında ertelenen küçük kullanılabilirlik ve test boşlukları**
  - Neden ve kanıt (REVIEW: kod okuması ve tarayıcı turu, 2026-10-20):
    - Kalem tablosunun sayfalayıcısında çapa yok: sayfa değişince ekran en üste dönüyor, tablo
      ise sayfanın en altında.
    - "Bağlantıyı kaldır" sonrası bildirim "Kalem yok sayıldı" diyor. Davranış doğru (kalem
      IGNORED olur, otomatik eşleşmeye dönmez); metin düğmenin adıyla örtüşmüyor.
    - Ürün sayfasındaki "beyan edilirse … karşılaştırılır" cümlesi `PRD-16` gereği "sonraki
      Verileri Getir'den sonra" demeli; boş durum metni elle bağlanan kalemleri anmıyor.
    - Mobil tedarikçi listesinde "Eşleşme bekleyen" sütunu yatay kaydırmanın arkasında.
    - Test boşlukları: ayar düzenleme (K1) ile "Yok say" / "Bağlantıyı kaldır" e2e'de sürülmüyor
      (core testleri var); eylemdeki "dosya okunmadan önce" yetki kapısı core kapısından ayrı
      kanıtlanmadı; çalışanın masaüstü ürün sayfası yerleşimi görsel olarak denenmedi. UAT'de elle
      denendi (2026-10-21/22): "Yok say" (S6.2), çalışanın ürün sayfasında tedarikçi bölümünün
      olmaması (S10.1); e2e boşluğu duruyor.
  - UAT ekleri (kullanıcı, 2026-10-21):
    - UX-4: önizlemedeki "Eşleşme bekleyen: 2" kaydedilirse oluşacak durumu, alttaki "Eşleşme
      bekleyenler (0)" kayıtlı durumu gösteriyor; iki yer aynı sözcüğü kullanıyor, farkı yazmıyor
      (`refresh-wizard.tsx:200`, `[id]/page.tsx:297`).
    - UX-5: sıfır fiyatlı satırın hatası "Fiyat: Fiyat sıfırdan büyük olmalı"; alan etiketi zod
      mesajının önüne ekleniyor (`supplier-feed.ts:564-566`), mesaj zaten "Fiyat" ile başlıyor
      (`schemas.ts:374`). Davranış doğru, yalnız metin.
  - Doğrula: her madde için tarayıcı turu ya da e2e.
  - Kaynak: T200 Dilim 1b REVIEW, 2026-10-20; UAT ekleri T200 UAT, 2026-10-21.
- [ ] **T212 (P3)** - web - **Tedarikçi listesinde arama ve süzgeç yok (UX-1)**
  - Neden: tedarikçi sayısı arttıkça aranan firma zor bulunuyor (demo kiracısında 61 tedarikçi);
    liste yalnız ada göre sıralı, sayfalamasız ve aramasız.
  - Kanıt: T200 UAT S1 ve S4.8, kullanıcı geri bildirimi (2026-10-20/21). `tedarikciler/page.tsx`
    (arama alanı yok); sıralama `suppliers.ts:124` (`name_norm`); tedarikçi başına eşleşme bekleyen
    sayısı zaten hesaplanıyor (`suppliers.ts:110`, `unmatchedCount`).
  - Yapılacak: önce adla arama (Türkçe normalizasyon, `name_norm`), ardından "eşleşme bekleyeni
    olanlar" süzgeci.
  - Bağlı: F-12, T200.
  - Doğrula: ad parçasıyla arama doğru tedarikçiyi getirir; süzgeç yalnız eşleşme bekleyeni
    olanları gösterir; başka kiracının tedarikçisi görünmez.
  - Kaynak: T200 UAT, 2026-10-21.
- [ ] **T213 (P3)** - web - **Ürün toplu aktarma ile tedarikçi fiyat listesi yükleme yeterince ayrışmıyor (UX-3)**
  - Neden: kullanıcı tedarikçi CSV'sini önce `Stok → Toplu aktarma`'ya yükledi. Ekranın hatası
    ("Dosyada "Stok Kodu" ve "Ürün Adı" sütunları olmalı. Bulunanlar: Tedarikçi Kodu, …") doğru ama
    kullanıcıyı Tedarikçiler → Verileri Getir'e yönlendirmiyor. Veri etkisi yok: çözümleme reddetti.
  - Kanıt: T200 UAT S2, 2026-10-21; sunucu günlüğünde yalnız `analyzeAction`, kayıt eylemi yok.
  - Öneri: iki ekranın başlık ve açıklamasında amaç ayrımı; tedarikçi başlıkları (ör. "Tedarikçi
    Kodu") tanınınca tedarikçi ekranına yönlendiren ipucu. Seçim PLAN'da.
  - Bağlı: F-02, F-12.
  - Doğrula: tarayıcıda tedarikçi dosyası ürün aktarmaya yüklenince yönlendirme görünür.
  - Kaynak: T200 UAT, 2026-10-21.
- [ ] **T214 (P3)** - web - **Eşleşme bekleyen tedarikçi kalemleri görsel olarak ayrışmıyor; aynı durum için iki terim (UX-6)**
  - Neden: eşleşmemiş kalem bugün gri düz metin; durum etiketi "Eşleşmedi", süzgeç ve başlıklar
    "Eşleşme bekleyen" diyor. Yapılacak iş gözden kaçabilir.
  - Kanıt: `packages/shared/src/suppliers.ts:55` (`UNMATCHED`: "Eşleşmedi"); `[id]/page.tsx`
    kalem satırı (`text-ink-2`, vurgu yok). Kullanıcı isteği, T200 UAT S4.8, 2026-10-21.
  - Öneri: eşleşme bekleyen satıra hafif sarı arka plan (`bg-warn-soft`) ve metinli, simgeli
    `Badge tone="warn"` etiketi (ör. "Eşleşme bekliyor"); renk tek başına gösterge olmaz (WCAG 1.4.1);
    tek terim. Belirteçler hazır (`--warn-soft` / `--warn-soft-ink`, 6,69:1; koyu tema tanımlı).
  - Bağlı: F-12, T210.
  - Doğrula: satırdaki ikincil metnin `warn-soft` üstünde kontrastı (WCAG 1.4.3) açık ve koyu
    temada; tarayıcı turu.
  - Kaynak: T200 UAT, 2026-10-21.
- [ ] **T215 (P3)** - web - **Ürün sayfasında son fiyat değişiminin tarihi görünmüyor (UX-7)**
  - Neden: "▲ %7,7 arttı" rozeti son değişimi gösteriyor ama tarihini göstermiyor. Yanındaki
    "Son alındı" verinin alınma zamanı ve değişmeyen bir yenilemede ileri gidiyor (UAT S8.3); rozet
    o tarihte değişmiş gibi okunabilir.
  - Kanıt: `listProductOffers` `lastChange.createdAt` döndürüyor; `supplier-offers.tsx:114-119`
    yalnız tür, yön ve yüzde iletiyor. Tedarikçi sayfasındaki "Son fiyat değişimleri" tarih
    gösteriyor ama tedarikçi başına son 50 satırla sınırlı (`[id]/page.tsx:142`).
  - Korunacak: "En düşük fiyat" ve artış/azalış göstergelerinin zaman sınırı yok (kullanıcı onayı
    2026-10-22, F-12); bu iş yalnız tarihi ekler.
  - Bağlı: F-12, T200.
  - Doğrula: tarayıcıda değişmeyen bir yenilemeden sonra rozetin yanındaki tarih değişimin tarihi kalır.
  - Kaynak: T200 UAT, 2026-10-22.
- [ ] **T208 (P3)** - web - **Tam 4 MB'lık dosya istemci denetimini geçip Next'in gövde sınırına çarpıyor**
  - Neden: `next.config.ts` `bodySizeLimit`'i dosya sınırıyla aynı (`MAX_UPLOAD_BYTES`, 4 MiB) ve
    Next bu sınırı BÜTÜN isteğe uyguluyor. Çok parçalı form ek yükü (~0,9 KB) yüzünden 4 MiB'a
    1 KB'tan yakın bir dosya istemcideki `size > maxUploadBytes` denetimini geçiyor, Next ise isteği
    eyleme ulaşmadan reddediyor. Kullanıcı "Dosya çok büyük" yerine panelin genel hata ekranını
    görüyor ("Bu ekran yüklenemedi … yalnızca okuma yapıyor"); sunucudaki Türkçe boyut mesajına
    hiç ulaşılmıyor. Veri kaybı ya da sızıntı yok; pencere ~1 KB.
  - Kanıt: 2026-10-20 tarayıcı ölçümü, tedarikçi sihirbazı: 4.192.256 B dosya → istek 4.193.191 B,
    önizleme geldi; 4.194.304 B → istek 4.195.242 B, sunucu logu `Body exceeded 4194304 limit`,
    yanıt 500, hata sınırı göründü; 4.194.305 B → istemci denetimi durdurdu, istek gitmedi.
    Ürün içe aktarma (`urunler/aktar`) T171'den sonra dosyayı yüklemiyor (tarayıcıda okuyor,
    satırları ~1,5 MB'lık parçalarla gönderiyor); bu görev artık yalnız tedarikçi sihirbazını etkiliyor.
  - Öneri: `bodySizeLimit = MAX_UPLOAD_BYTES + zarf payı` (ör. 64 KB; Vercel'in 4,5 MB sınırının
    altında kalır). Böylece 4 MB'a kadar her dosya eyleme ulaşır, üstünü Türkçe kontrol karşılar.
  - Bağlı: T118 (sınırın tek kaynağı, arşiv), T200.
  - Doğrula: iki sayfada tam 4 MiB ve 4 MiB + 1 B dosyayla tarayıcı testi; genel hata ekranı
    görülmemeli.
  - Kaynak: T200 Dilim 1b ölçümü, 2026-10-20.
- [ ] **T206 (P3)** - altyapı - **Repo kökünde izlenmeyen `~/` klasörü yerel `pnpm lint`'i düşürüyor**
  - Neden: kökte `~/.claude/skills/gstack` kopyası duruyor (git'te izlenmiyor, `.gitignore`'da yok).
    Biome onu da tarıyor: yerelde `pnpm lint` 1.072 dosyaya bakıp 97 hatayla düşüyor; CI temiz
    checkout'ta etkilenmiyor. Yerel kapı kırmızı göründüğü için gerçek bir lint hatası gözden kaçabilir.
  - Kanıt: 2026-10-19 `pnpm lint` → 1.072 dosya, hataların hepsi `~\.claude\skills\gstack\…`;
    proje klasörleriyle `biome lint apps packages scripts db design .github` → 215 dosya, 0 tanı.
    Klasör 2026-08-27 tarihli; muhtemelen bir araç `~`'yi yerel yol olarak açtı (doğrulanmadı).
  - Yapılacak: klasörün sahibine sorup kaldırmak ya da `.gitignore`/Biome `files.ignore` ile dışlamak.
    Silme kullanıcı onayı ister.
  - Doğrula: `pnpm lint` yerelde 215 civarı dosyayla temiz.
  - Kaynak: T200 Dilim 1a kapıları, 2026-10-19.
- [ ] **T145 (P3)** - güvenlik - scrypt N=2¹⁴ → 2¹⁷ (girişte yeniden özetleme ile). `packages/db/src/password.ts:31`
- [ ] **T146 (P3)** - migration - Additive kuralını (`DAT-13`) zorlayan otomatik kontrol yok; 0009 `RENAME COLUMN` ihlal etmiş.
- [ ] **T147 (P3)** - gizlilik - Hareket formunun hata yolunda girilen fiyatlar URL'de taşınıyor (tarayıcı geçmişi, erişim logları).
- [ ] **T148 (P3)** - test - `test:e2e:ci`'daki `--grep-invert @kararsiz` ölü filtre; artık hiçbir test etiketli değil.
- [ ] **T149 (P3)** - deploy - `apps/web/package.json`'da `engines` yok; Root Directory `apps/web` olunca Vercel'in Node sürümü sabit değil.
- [ ] **T150 (P3)** - test - E2E testleri demo veritabanını kalıcı değiştiriyor (2026-10-08 koşusu: +4 ürün, +4 hareket, +2 kullanıcı) ve seed verisine bağımlı. T171'in `t171-toplu-aktarim.spec.ts`'i koşu başına ~40 + iptal testinde birkaç yüz ürün ekliyor (iptal anına bağlı). T171 doğrulamasında E2E ayrı bir `stok_test_*` veritabanına ve 3100 portuna yönlendirilerek koşuldu (`DATABASE_URL`/`MIGRATION_DATABASE_URL` ortamdan, `PORT`/`SMOKE_PORT`); çözüm için olası yol.
- [ ] **T151 (P3)** - test - `pnpm test` `stok_test_*` veritabanlarını silmeden bırakıyor (zararsız).
- [ ] **T152 (P3)** - repo - `.claude/gstack-main/bin/gstack-global-discover.ts` lisanssız artık üçüncü taraf dosyası; 32 MB'lık vendor kopyası git geçmişinde.
- [ ] **T153 (P3)** - db - FK'lar kiracı-bileşik değil (RI kontrolü RLS'i atlıyor); bugün uygulama kontrolleriyle kapalı, savunma derinliği yok.
- [ ] **T154 (P3)** - bakım - Satır içi action'lı çok büyük sayfa dosyaları (ör. `hareket/page.tsx` 549 satır). Yalnız ilgili işe dokunulurken ele alınır.
- [ ] **T78 (P3)** - performans - Aylık stok değeri özet tablosu. BLOKE: `DAT-15`.
- [ ] **T166 (P3)** - operasyon - Kalan `openssl` önerileri: `CRON_SECRET` uyarısı (`apps/web/src/server/config.ts:173`, `.env.example:72`) ve runbook'taki `stok_app` parolası (`docs/uretim-runbook.md:47`). openssl Windows'ta varsayılan olarak yok; `AUTH_SECRET` için node komutuna geçildi (T133), bunlar WS-A kapsamı dışında kaldı.
- [ ] **T169 (P3)** - ci - Telefon kamerası ve çözücü yolu otomatik testte yok. `e2e/telefon-tarama.spec.ts` telefonu API istemcisiyle taklit ediyor; Playwright'ın headless shell'inde `getUserMedia` yok (`NotSupportedError`), geliştirme makinesinde Playwright'ın tam Chromium'u açılmıyor (`spawn UNKNOWN`). Yerelde kurulu Edge + sahte kamera aygıtı + sentetik EAN-13 Y4M ile uçtan uca geçti (2026-10-09, repoda değil). Seçenek: CI'da (Linux) tam Chromium + `--use-file-for-fake-video-capture` ile tek senaryo. Tetikleyici: çözücü ya da Next/Turbopack yükseltmesi.
- [ ] **T170 (P3)** - ürün - Ürünün birimi sonradan değiştirilince (KG → ADET) eski koli çarpanları ve kesirli hareketler denetlenmiyor; birim kuralı (T130, `DAT-17`) yalnız yeni yazımlarda. Kritik seviye (`minStock`) da birim hassasiyetine bağlı değil (adetli üründe 0,5 kabul). Kaynak: WS-B, 2026-10-10.
- [ ] **T172 (P3)** - import - İçe aktarma devrinde fiyatın ekonomik tarihi ("Açılış Fiyat Tarihi", `PRC-05`) ve "Tahmini" sütunu yok; devir bugünün alış fiyatıyla yazılıyor. (Satır notlarının indirilebilir raporda olmaması T171 ile çözüldü: aktarım raporu devri atlanan ve yazılamayan satırları da içeriyor.) Plan polish'i; tetikleyici: eski stoğu geçmiş fiyatla değerlemek isteyen müşteri. Kaynak: WS-B, 2026-10-10.
- [ ] **T189 (P3)** - test - **`db:reset`'in iki kurtarma yolu kalıcı testte yok**
  - Neden: `docker stop` hatası ve asıl kapsayıcı silindikten sonra `docker volume rm` hatası
    `db-reset.test.ts`'te üretilemiyor (CLI `docker`'ı kabuksuz çağırıyor, araya girecek bir
    kanca yok). Bu yolların kodu değişirse gerileme fark edilmez.
  - Kanıt: 2026-10-14'te geçici mutasyonla (çağrıya geçersiz bayrak) dört senaryo gerçek
    Docker'da, ayrı `stok_test_reset_*` projelerinde doğrulandı: durdurma hiç gerçekleşmeden
    hata → kapsayıcı kesintisiz çalışıyor; durdurup hata → aynı kapsayıcı yeniden açıldı;
    volume silinemedi → aynı volume'le kapsayıcı yeniden kuruldu, başlangıçta çalışıyorsa
    çalışır, duruyorsa başlatılmamış; her durumda volume `CreatedAt` ve veri işareti aynı.
  - Doğrula: üretim koduna test kancası eklemeden hata enjeksiyonu (ör. yerel soket/pipe
    üzerinden Docker API vekili) bulunursa bu dört senaryo `db-reset.test.ts`'e taşınır.
  - Kaynak: WS-1.2b commit öncesi inceleme, 2026-10-14.
  - Ek (WS-1.3a, 2026-10-16): Docker katmanı `docker.ts`'e taşındı; `db-reset-target.test.ts`
    dört reti sabitledi (compose araması, kapsayıcı yok, CLI yok, volume projeye ait değil).
    Hâlâ testsiz: "birden çok kapsayıcı" ve "compose servisi değil" (`compose ps` süzgeci
    yüzünden kancasız üretilemiyor), "veri dizini volume değil" (ayrı bind kurulumu ister).
- [ ] **T191 (P3)** - test - Geçici compose projesi kuran üç test dosyası (`db-reset.test.ts`, `db-reset-target.test.ts`, `backup.test.ts`) fikstürü kopya olarak taşıyor: compose JSON'u ve "gözden çıkarılabilir proje" ön koşulu ayrışabilir. `db-reset.test.ts`, WS-1.3a refactor'ünün davranış kanıtı olduğu için bilerek değiştirilmedi. WS-1.4 (tatbikat) dördüncü kullanıcı olunca ortak test modülüne alınır. Kaynak: WS-1.3a, 2026-10-16.
- [ ] **T193 (P3)** - güvenlik - Yedek dizini kuralı yalnız OneDrive'ı (ortam değişkenleri) tanıyor; Dropbox, Google Drive ve benzeri senkron klasörleri algılanmıyor. `STOK_BACKUP_DIR` böyle bir klasörü gösterirse döküm (parola özetleri, kişisel veri, alış fiyatları) buluta gider. Doğrulanmadı (bu makinede başka istemci yok). `SECURITY_MODEL` S20. Kaynak: WS-1.3a, 2026-10-16.
- [ ] **T194 (P3)** - db - `pg_dump` çıktısı akışla alındığı için arşivde veri ofseti yok: `pg_restore -j` (paralel geri yükleme) kullanılamıyor, sıralı geri yükleme çalışır. 12 MB'ta önemsiz; veritabanı büyürse geri yükleme süresi uzar. Seçenek: kapsayıcıda dosyaya döküm + `docker cp` (WS-1.3a planı Soru 4, alternatif a). Doğrula: WS-1.4'te sıralı geri yükleme süresi ölçülür. Kaynak: WS-1.3a, 2026-10-16.
- [ ] **T195 (P3)** - altyapı - **`wait-for-db.mjs` imajın geçici init sunucusunu "hazır" sayabilir**
  - Neden: Docker kipinde betik kapsayıcının içinden `pg_isready` (Unix soketi) ve host'tan TCP
    portuna bakıyor. Taze volume'de imajın `docker-entrypoint.sh`'ı `db/init/*.sql`'i
    `listen_addresses=''` ile yalnız sokette dinleyen geçici bir sunucuda koşturuyor: bu sırada
    `pg_isready` "hazır" diyor, Linux'ta `docker-proxy` de portu arkasında dinleyen olmadan kabul
    ediyor. Betik bu pencerede dönerse ardından koşan `migrate` geçici sunucunun kapanmasına denk
    gelip `ECONNRESET` ya da `57P03` alabilir.
  - Kanıt: çıkarım, bu pencerede dönüş gözlenmedi. Yakın biçimi CI #72'de yaşandı
    (`backup.test.ts`, betik yalnız TCP'ye bakınca); `1e47741` yalnız o testte `SELECT 1`
    kapısıyla kapattı. Yerel ölçümde bekleme olmadan `up -d`'den hemen sonraki ilk sorgu `57P03`
    aldı.
  - Bağlı: `db:up`, `db:reset` (volume yeniden kurulunca), `scripts/demo.mjs`, `db-reset.test.ts`;
    WS-1.4 tatbikatı taze kümede bekleyecekse o da. Arşivdeki T59 (kapalı) açık port biçimini kapatmıştı.
  - Doğrula: taze volume'le `db:up` ve hemen ardından `migrate` tekrarlı koşuda yeşil. Seçenek:
    betik "hazır" demeden önce yayımlanan porta `SELECT 1` göndersin ya da `pg_isready`'yi
    `-h 127.0.0.1` ile TCP'den sorsun. Düzelince `backup.test.ts`'teki `waitForQuery` kaldırılabilir mi bakılır.
  - Kaynak: WS-1.3a CI #72 analizi, 2026-10-16.
- [ ] **T197 (P3)** - test - **Doğrulamanın CLI'da son adı engellediği entegrasyon testiyle kanıtlı değil**
  - Neden: `backup.test.ts`'in 2. testi `verifyDump`'ı doğrudan çağırıyor, 7. testi `pg_dump`
    aşamasında düşüyor. `backup()` içindeki `verifyDump` çağrısı kaldırılsa ya da sonucu yok
    sayılsa bütün testler yeşil kalır. Bugün sıra doğru; ileride bir düzenleme doğrulanmamış
    dökümü son adla ve `.sha256`'yla kaydedebilir, saklama da sağlam eskileri silebilir.
  - Kanıt: kod okuması, koşulmadı. `packages/db/src/backup.ts:384` (`verifyDump`, `renameNew`'den
    önce); `backup.test.ts` test 2 ve 7. WS-1.3a `dogrula` D1 yalnız `verifyDump`'ın içini sınadı.
  - Doğrula: kancasız entegrasyon testi. Geçici projede `current_stock`'un adını değiştir, CLI'ı
    koş: çıkış 1, içindekiler reti, son adlı döküm ve `.partial` yok, `failed` log satırı var; adı
    geri al. `dogrula`: `verifyDump` çağrısı kaldırılınca bu test kırmızı yanmalı.
  - Bağlı: `OPS-10`, `SECURITY_MODEL` S20.
  - Kaynak: WS-1.3a bağımsız REVIEW (Y2), 2026-10-16.
- [ ] **T198 (P3)** - güvenlik - **Yedek kaynağının `DATABASE_URL` kontrolü sunucunun kimliğini değil port numarasını karşılaştırıyor**
  - Neden: `assertAppDatabase` uygulama adresinin yerel olduğuna, portunun compose `db`'nin
    yayımladığı portla aynı olduğuna ve veritabanı adının `stok` olduğuna bakıyor. `localhost` ya
    da `::1` adresi, aynı port numarasında başka bir loopback adresinde dinleyen ikinci bir
    PostgreSQL'e gidebilir. Uygulama oraya bağlıyken komut Docker'daki veritabanını
    "uygulamanınki" diye yedekler.
  - Kanıt: doğrulanmadı (çıkarım). `packages/db/src/backup.ts:214-216`. Bu makinede tetikleyici
    yok: S19 ölçümünde tek dinleyici `127.0.0.1:5433`; `.env.example` `127.0.0.1` kullanıyor.
  - Doğrula: pilottan önce `DATABASE_URL`'in `127.0.0.1` olduğunu denetle. Daha güçlü kontrol
    gerekirse uygulamanın bağlantısından ve kapsayıcıdan aynı sunucu kimliği okunup karşılaştırılır.
    Sınama: aynı portta `::1`'de ikinci bir PostgreSQL dinlerken komut reddetmeli.
  - Bağlı: `OPS-10`, `SECURITY_MODEL` S19, S20.
  - Kaynak: WS-1.3a bağımsız REVIEW (Y3), 2026-10-16.
- [ ] **T199 (P3)** - operasyon - **`db:backup --status`, log'un son satırı okunamazsa "Son koşu" satırını hiç basmıyor**
  - Neden: `lastLogEntry` bozuk son satırda `null` dönüyor; yorumu "durum 'bilinmiyor' der"
    diyor. Ama `statusReport` "Son koşu" satırını yalnız `lastRun` varsa basıyor. Bozuk bir son
    satır başarısız bir koşuyu gizler. Çıkış kodu bu satıra bakmıyor.
  - Kanıt: `packages/db/src/backup-policy.ts:322` (yorum) ve `:400` (`if (s.lastRun)`).
  - Doğrula: saf durum testi. Log boş değil ama son satırı bozuksa "Son koşu : bilinmiyor (log
    okunamadı)" görünür; log yoksa satır yine yok.
  - Bağlı: `OPS-10`, WS-1.3b (gözetimsiz koşuda son koşunun görünürlüğü).
  - Kaynak: WS-1.3a bağımsız REVIEW (Y4), 2026-10-16.

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

Öncelik sırası kullanıcı kararıyla belirlendi (2026-10-13; ürün araştırması
`~/.claude/plans/urun-yol-haritasi-2026-10-13.md`). Temel kararlar: stok doğruluğu ve
operasyonel kullanım kolaylığı birinci öncelik; ürün barkodu isteğe bağlı; sistem çok
kullanıcılı ama ortak laptop kullanımına özel hedef yok; önce kritik stok uyarıları,
tükenme tahmini sonra; öncelik günlük stok takibi, 2026 yıl sonu envanteri zorunlu hedef
değil. Kayıtlarda "Ürün kararı" onaylı kapsamdır; "Teknik not" henüz onaylanmamış tasarım girdisidir.

- En üst öncelik (kullanıcı kararı 2026-10-22; 2026-10-17 sırasının yerine): T171 (20.000 satır
  içe aktarma), sonra T201 (gerçek tedarikçi API'si), sonra T200 Dilim 2; UX iyileştirmeleri uygun
  dilimlerde. T200 Dilim 1 kabul edildi (2026-10-22). T144 (HTTPS test ortamı, `OPS-12`) ayrı
  operasyon hattında. Sıra ve kayıtlar P1'de.
- Öncelikli: T155 (sayım), T175 (telefondan ürün yönetimi), T176 (uygulama içi gün sonu
  raporu), T177 (barkodsuz ürün).
- Kritik stok takibi mevcut, yeniden geliştirilmeyecek (doğrulandı 2026-10-13): ürün bazlı
  eşik `products.min_stock` (`packages/db/src/schema.ts:157-158`, ürün formunda "Kritik eşik"),
  kritik liste `/stok?kritik=1`, panel uyarısı ve "Kritik stok" listesi
  (`apps/web/src/app/(panel)/panel/page.tsx:65-80,286-297`), bildirim zili (`alert-bell.tsx`),
  kritik stok e-postası (`packages/core/src/cron.ts:283`). Açık kalan: T170.
- Değerlendirilecek: T178 (seri barkod okutma). Mevcut hâli yeterli, iş açılmadı: barkoddan
  hızlı ürün tanımlama.
- Ertelendi: T179 (tükenme tahmini), T180 (geçmiş tarihli stok), T181 (web'de PIN geçişi), T156
  (etiket). Koşullu: T182 (satış aktarımı). Sonraki sürüm: T202 (B2B sipariş), T203 (B2B
  periyodik senkron).

- [ ] **T155** - Sayım (stocktake) akışı (eski E2, P1; ürün önceliği 2026-10-13). Sayım tabloları o gün eklenir (`PROJECT_BRAIN` §12.10).
  - Ürün kararı: barkodlu ve barkodsuz ürün sayımı; ürün ya da kategori bazlı kısmi sayım;
    sayıma ara verip devam etme; sistem ve fiziksel miktar karşılaştırması; yetkili onayıyla
    fark düzeltmesi; append-only defter korunur; sayım sırasındaki hareketler doğru hesaba
    katılır; telefondan sayım seçeneği değerlendirilir.
  - Teknik not (onaylanmadı): `COUNT_ADJUST_*` bugün tek yazma kapısından geçemiyor
    (`packages/shared/src/schemas.ts:128`, `userSelectable` refine); aday desen
    `requireFirstMovement` gibi sunucu tarafı çağıran seçeneği (`movements.ts:86-92`). Fark,
    satırın sayıldığı andaki sistem miktarına göre delta olarak yazılmalı ("sayılanı yaz"
    aradaki satışı siler); farkı 0 satır hareket üretmez (`schema.ts:343`). STAFF `stock:read`
    ile sistem miktarını görüyor, kör sayım ürün kararı ister (`roles.ts:78`). Büyük onay
    T171 süresine yakın (2.000 satır ~47 sn).
  - Bağlı: T177 (barkodsuz), T175 / `PRD-12` (telefondan sayım), T127, T171.
  - Doğrula: sayım sırasında satış ve çift onay yarışı testleri, `dogrula`; elle
    `COUNT_ADJUST` reddi testleri (`movements.test.ts:244`, `dusman-qa.test.ts:209`,
    `reasons.test.ts:46`) yeşil kalır.
- [ ] **T175** - ürün - **Telefondan ürün yönetimi** (ürün önceliği 2026-10-13)
  - Ürün kararı: telefonla barkod okutma korunur; telefondan ürün arama ve ürün bilgisi
    güncelleme; yetkili kullanıcı telefondan stok giriş/çıkışı yapar; barkodsuz ürün
    desteklenir; güvenli kimlik doğrulama ve yetkilendirme; mevcut telefon köprüsünün güvenlik
    modeli izinsiz genişletilmez.
  - Çakışma: `PRD-12` (Active) "telefonla okutma stok hareketi değildir; telefona
    ürün/fiyat/stok gitmez" diyor. Bu iş yeni bir karar ister: köprüyü genişletmek değil,
    telefonda kimliği doğrulanmış ayrı bir istemci. Karar verilene kadar köprü (`ARC-14`,
    `SECURITY_MODEL` S18) olduğu gibi kalır.
  - Teknik not (onaylanmadı): kamera güvenli bağlam (HTTPS) istiyor; T167'nin tünel kısıtı
    telefonda tam uygulamayı kapatacağı için yol ya erişim kontrollü kalıcı HTTPS ya da mobil
    istemci (`PRD-03`, T53, T26–T49). T167'nin çözümü bu yolu kapatmamalı.
  - Bağlı: `PRD-12`, `ARC-14`, T167, T177, T53.
- [ ] **T176** - rapor - **Uygulama içi gün sonu raporu** (ürün önceliği 2026-10-13)
  - Ürün kararı: günlük stok özeti; günlük giriş/çıkış hareketleri; en çok hareket gören
    ürünler; kullanıcı bazlı işlem özeti; kritik seviyeye düşen ürünler; Europe/Istanbul gün
    sınırı; eksik satış verisi kasa açığı ya da ciroda yanıltıcı sonuç üretmez. Excel/PDF
    indirme ileride değerlendirilir.
  - Teknik not (onaylanmadı): bugünkü özet yalnız e-postada (`cron.ts:102-176`), gün filtresi
    DB oturum saatinde (`cron.ts:133`, UTC), kasa açığı toplamı TypeScript `Number` ile
    (`cron.ts:157,177`, INV-8 sapması). Fiyatı girilmemiş satış "0 açık" gösterilmemeli; alış
    fiyatı yalnız yetkiliye (INV-10).
  - Bağlı: T122 / `DAT-16` (gün sınırı), T121 (e-posta raporu ayrı iş).
- [ ] **T177** - ürün - **Barkodsuz ürün desteği** (ürün kararı 2026-10-13: barkod isteğe bağlı)
  - Neden: yeni ürün için barkod bugün zorunlu (`schemas.ts:280` "En az bir barkod gerekli",
    `import.ts:609-611`) ve hareket girişi barkodla (`schemas.ts:126`).
  - Teknik not (onaylanmadı): seçenekler iç kod üretimi (T156 ile) ya da ürün kimliğiyle
    hareket yolu; `DAT-18` devri, `PRD-12` köprüsü ve içe aktarma etkilenir.
  - Bağlı: T155, T175, T156.
- [ ] **T178** - hareket - **Seri barkod okutma** (değerlendirilecek, 2026-10-13). Kayıttan sonra
  sebep sıfırlanıyor (`hareket/page.tsx:145-148`), mal kabulünde her kalemde yeniden seçiliyor.
  Yanlış sebebin sessizce tekrarlanma riski tasarımda ele alınmalı.
- [ ] **T156** - Barkod üretme + etiket basma (eski E5, P2); T16 bununla birlikte. Ertelendi (2026-10-13); barkodsuz ürün kararı (T177) bu işe dayanabilir.
- [ ] **T179** - ürün - **Stok tükenme tahmini ve satın alma önerisi** (ertelendi, 2026-10-13: önce
  kritik stok uyarıları). Tetikleyici: birkaç haftalık hareket verisi ve satışların eksiksiz
  girildiğinin bilinmesi.
- [ ] **T180** - rapor - **Geçmiş tarihli stok raporu** (ertelendi, 2026-10-13: 2026 yıl sonu
  envanteri zorunlu hedef değil). Değerleme kısmı T78 / `DAT-15` ile çakışır.
- [ ] **T181** - auth - **Web'de PIN ile hızlı kullanıcı geçişi** (ertelendi, 2026-10-13: ortak laptop
  kullanımına özel hedef yok). Teknik not: `PIN` sayaç kapsamı var ama PIN kilit politikası yok
  (`packages/core/src/rate-limit.ts:52,68` yalnız `LOGIN_EMAIL`/`LOGIN_IP`); şema 4 haneli PIN
  kabul ediyor (`schemas.ts:383`). Mobil karşılığı T32.
- [ ] **T182** - entegrasyon - **POS / satış programından satış aktarımı** (koşullu, 2026-10-13).
  Pilot işletmenin satışı nerede kaydettiği öğrenilene kadar açılmaz. Önkoşul: T127.
- [ ] **T202** - entegrasyon - **B2B üzerinden sipariş** (sonraki sürüm, 2026-10-17). V1'de yok
  (`PRD-14`). Tam sipariş yönetimi `PROJECT_BRAIN` §14'te kapsam dışı; açılmadan önce ayrı ürün
  kararı ister. Önkoşul: T200, T201.
- [ ] **T203** - entegrasyon - **B2B verisinin otomatik periyodik senkronu** (sonraki sürüm,
  2026-10-17). V1'de yenileme yalnız "Verileri Getir" düğmesiyle (`PRD-14`). Bağlı: T201,
  `OPS-02` (zamanlayıcı), T139 (cron kiracıları sırayla işliyor).
- [ ] **T157** - Maliyet takibi + kâr raporu (eski E8, P2). BLOKE: `DAT-15`. Geçmiş hareketlerde fiyat verisi yok.
- [ ] **T158** - Raf/konum yönetimi arayüzü (eski E9, P3). Şema hazır.
- [ ] **T159** - Mobilde tam katalog senkronu (P2). Tetikleyici: sahada "ürün adını göremiyorum" şikâyeti.
- [ ] **T160** - Mobil cihaz test otomasyonu, Maestro (P3). Tetikleyici: elle kontrol listesinin atlanması.
- [ ] **T161** - Çok katmanlı paketleme hiyerarşisi (P3). Tetikleyici: ikiden fazla paket seviyesi isteyen müşteri.

**Ürünleştirme**

- [ ] **T163** - Parola kurtarma. Son yönetici parolasını unutursa veritabanına elle müdahale gerekiyor.
- [ ] **T164** - KVKK: aydınlatma metni, saklama süresi, kiracı verisini dışa aktarma ve silme (tehdit S10).

**Yön (henüz madde değil):** çok depo / transfer, satın alma siparişi (B2B tedarikçi verisi
T200'de, B2B sipariş T202'de),
e-Fatura / e-Arşiv, Logo / Mikro / Paraşüt köprüsü, SaaS kayıt / abonelik / faturalama,
FIFO maliyet.

## Kapananlar

_(Bu dosyada açılıp kapanan görevler buraya iner. T1–T119'un kapanış kayıtları arşivde.)_

- [x] **T196 (P2)** - operasyon - **CLI, junction/symlink içeren ya da uzantısız yoldan çağrılınca hiçbir şey yapmadan 0 dönüyordu**
  - Sorun: `backup.ts` ve `db-reset.ts` `main`'i `resolve(process.argv[1])` ile `import.meta.url`
    eşitse koşturuyordu. Node ana modülü realpath ile çözüyor, `argv[1]`'i çözmüyor. Yol bir
    junction ya da symlink içerince `node`/`tsx` ile doğrudan çağrılan `db:backup`, `--status` ve
    `db:reset` çıktısız 0 dönüyordu: yedekte "yedek var" yanılgısının sessiz biçimi (S20). Uzantısız
    çağrı da (`tsx src/backup`) aynı sonucu veriyordu: tsx yolu `.ts`'e çözüyor, `argv[1]` uzantısız
    kalıyor. CI duman adımı yalnız çıkış koduna baktığı için bunu göremezdi. pnpm üzerinden çağrı
    etkilenmiyordu: pnpm paket dizinini gerçek yola çeviriyor (ölçüldü).
  - Kapanış (2026-10-16): ortak `packages/db/src/cli-entry.ts` iki tarafı da JS `realpathSync` ile
    çözüyor; `argv[1]` yoksa modülün uzantısıyla yeniden deniyor. `cli-entry.test.ts` iki CLI'ı
    gerçek yol, bağlantı (Windows'ta junction, CI'da symlink) ve uzantısız bağlantı üzerinden
    koşuyor, içe aktarmanın CLI başlatmadığını gösteriyor. Eski kodda 3 bağlantı testi kırmızıydı
    (çıkış 0). `dogrula`: realpath kaldırılınca 4, yalnız `argv[1]` çözülünce 1, iki CLI eski
    kontrole dönünce 3, uzantı eki kaldırılınca 4, uzantı her zaman eklenince 1, dış `try`
    kaldırılınca 1 test kırmızı yandı. CI demo adımı artık başarı satırlarını da arıyor. Kaynak:
    WS-1.3a bağımsız REVIEW (Y1).

- [x] **T192 (P2)** - operasyon - **Varsayılan yedek dizini normal bir terminalde doğrulanmadı (paketli uygulama yönlendirmesi)**
  - Sorun: Claude masaüstü uygulamasının (MSIX paketi) alt süreçlerinde `%LOCALAPPDATA%` altına
    yeni yazılan klasör paketin özel `LocalCache`'ine yönleniyor; WS-1.3a'nın elle doğrulaması (W1)
    bu yüzden gerçek `%LOCALAPPDATA%\stok\yedek`'i değil paket klasörünü sınadı. Komut bunu
    "Hedef" satırında ve bir uyarıyla söylüyor (`relocationNote`).
  - Kapanış (2026-10-16): kullanıcı Claude dışındaki normal bir Windows terminalinde
    `pnpm db:backup` ve `pnpm db:backup --status`'u çalıştırdı, ikisi de beklenen sonucu verdi
    (kullanıcı bildirimi; çıktı oturuma aktarılmadı).

- [x] **T187 (P1)** - güvenlik - **Silme kapısının gösterdiği hedef ile seed'in bağlandığı hedef ayrışabiliyordu**
  - Sorun: `describeTarget` hedefi adresin ana makine, port ve yolundan okuyordu; postgres.js
    tanımadığı sorgu parametrelerini başlangıç mesajına koyuyor (`?database=` başka veritabanı,
    `?search_path=`/`?options=` başka şema), yolu çözmeden kullanıyor (`%`), port yoksa `PGPORT`'u
    alıyor. Ayrıca `search_path` veritabanı/rol ayarıyla ya da rolle aynı adlı şemayla (`"$user"`)
    değişince seed'in saydığı `tenants` ile CASCADE'in sildiği defter ayrı şemalarda olabiliyordu.
    `PGOPTIONS` postgres.js'i etkilemiyor (ölçüldü).
  - Kapanış (2026-10-13): (A) `target.ts` sorgu parametresi, `%` kodlu yol ya da
    eksik port varsa hedefi yerel saymıyor; (B) `wipe-guard.ts` bağlanılan veritabanı
    (`current_database()`) yazılan hedef değilse silmeyi reddediyor; seed'in tabloları `public`'e
    çözülmüyorsa da reddediyor (`schemaShadowed`, silinen tablo listesiyle tek kaynak); `tenant:create`
    gösterilen ile bağlanılan veritabanı ayrışınca soru sormadan duruyor.
    Test: `target.test.ts` +6, `wipe-guard.test.ts` +5, `seed-guard.test.ts` `?database=` ve
    gölge şema alt süreç testleri (her biri kontrol testiyle), yeni `tenant-create.test.ts` 3.
    `dogrula` (yalnız `stok_test_*`): A kaldırılınca B reddetti (bağlanılan ≠ gösterilen); A+B
    kaldırılınca seed gösterilen adla verilen onayla `stok_test_seeddivert`'i sildi; şema kuralı
    ya da seed'in şema ölçümü kaldırılınca pilotun `public.locations` kaydı silindi, kiracısı
    kaldı (ayrışma ölçüldü); A kapalıyken seed B'ye adresin adını verince silme oldu (B'nin
    bağlantısı gerçek); `tenant:create` kontrolü kaldırılınca araç izole veritabanına yazdı.
    Kapı: lint 199 dosya, typecheck, test 911/911, drift "No schema changes", build PASS; e2e
    koşulmadı (UI değişmedi, T150).
  - Kalan: veritabanı sahibinin `pg_catalog`'u yolda sona koyup katalog fonksiyonlarını
    gölgelemesi kapsam dışı (öyle bir aktör veriyi doğrudan silebilir); `tenant:create` şema
    gölgesi T188; rol düzeyinde `ALTER ROLE … SET search_path` (veritabanı belirtmeden) paylaşılan
    kümeyi değiştireceği için ayrıca denenmedi, aynı mekanizma `ALTER DATABASE` ve
    `ALTER ROLE … IN DATABASE` ile ölçüldü ve kontrol çözümlemeye baktığı için kaynaktan bağımsız.

- [x] **T186 (P3)** - test - **`seed-guard.test.ts`'in uzak hedef testleri yerelde gerçek bir veritabanına ulaşmıyordu**
  - Sorun: WS-1.1'den beri `127.0.0.2:5433` yerelde reddediliyor; testler korumadan değil bağlantı
    hatasından kırmızı/yeşil olabiliyordu. 1.2a'nın adsız hedef testleri de koruma bozulunca
    `postgres` veritabanına gidiyordu.
  - Kapanış (2026-10-13): test `127.0.0.2`'de bağlantı sayan bir TCP yönlendirici
    açıp test kümesine iletiyor; kontrol testi adresin `stok_test_seedguard`'a gerçekten ulaştığını
    ölçüyor; "bağlantı açmadan" sayaçla kanıtlanıyor. Seed asenkron koşuyor (`spawnSync` olay
    döngüsünü kilitleyip yönlendiriciyi durdururdu). Adsız hedef testleri `PGDATABASE` ile izole
    `stok_test_seeddivert`'e yönleniyor. Mevcut 7 testin amacı ve kontrolleri aynı; 1–2. testlere
    adres ve sayaç, hepsine `await` eklendi. `dogrula`: uzak hedef kuralı kaldırılınca seed
    `127.0.0.2` üzerinden `stok_test_seedguard`'ı GERÇEKTEN sildi (çıkış 0); bağlantı öncesi
    çağrı kaldırılınca ret mesajı aynı kaldı ama sayaç kırmızı yaktı.

- [x] **T185 (P1)** - veri - **Seed, adreste veritabanı adı yokken boş onayla demo dışı veriyi silebiliyordu**
  - Sorun: `postgresql://…:5433` gibi adsız bir adreste hedefin adı `""` oluyor ve
    `--wipe-non-demo-data=` (boş onay) bu adla eşleşiyordu. PostgreSQL adsız adreste
    kullanıcı adıyla aynı adlı veritabanına bağlandığı için silinen veritabanı adreste yazmıyordu.
  - Kapanış (WS-1.2a, 2026-10-13): kural `packages/db/src/wipe-guard.ts`'e taşındı.
    Adsız hedef bağlantı açılmadan reddediliyor; boş onay hiçbir adı onaylamıyor.
    Seed'in diğer davranışı ve mesajları aynı. Test: `wipe-guard.test.ts` 17,
    `seed-guard.test.ts` mevcut 7 değişmeden ve 2 yeni (adsız hedef). `dogrula`: adsız kapı
    kaldırılınca 7 kırmızı; boş onay kapısı da birlikte kaldırılınca eski açık `{ allowed: true }`
    olarak yeniden üretildi. RLS kapısı, ad eşleşmesi ve seed'in bağlantı öncesi çağrısı da
    ayrı ayrı kaldırılınca kırmızı yandı. Kapı: lint, typecheck, test 891/891, drift
    "No schema changes", build PASS. e2e koşulmadı (UI değişmedi, T150).

- [x] **T184 (P1)** - güvenlik - **Veritabanı portu yerel ağa ve IPv6'ya açıktı**
  - Sorun: `docker-compose.yml` `'5433:5432'` portu bütün arayüzlerde yayınlıyordu; repodaki
    varsayılan parolalarla aynı ağdaki herkes süper kullanıcı olarak bağlanabiliyordu (S19).
  - Kapanış (WS-1.1, 2026-10-13): port `'127.0.0.1:5433:5432'`,
    `.env.example` adresleri `127.0.0.1`, `wait-for-db.mjs` Docker'da host portunu da sınıyor.
    Ölçüm: önce yerel ağ IPv4'ü, iki küresel IPv6 adresi, WSL arayüzü ve `::1` açıktı; sonra
    yalnız `127.0.0.1:5433`, `::1` reddediyor, diğerleri ulaşılamıyor. Volume (oluşturma
    2026-10-08T12:40:28Z), küme kimliği ve 8 tablonun satır sayıları değişmedi; eski
    `localhost` `.env`'i ve `127.0.0.1` ile uygulama rolü bağlanıyor. `dogrula`: host kontrolü
    kaldırılınca erişilemeyen portta (5499) "hazır" dedi, geri konunca çıkış 1. Kapı: lint,
    typecheck, test 872/872, drift "No schema changes", build PASS; e2e koşulmadı (UI değişmedi, T150).
  - Kalan: varsayılan parolalar (WS-1 dışı), gerçek ikinci cihazdan deneme yapılmadı, T183.

- [x] **T173 (P1)** - export - **Excel'deki tarih-saatler UTC görünüyor**
  - Sorun: exceljs seriyi anın UTC duvar saatinden üretiyor, Excel hücresinde saat dilimi
    yok. 12:15'teki hareket 09:15, 00:30'daki ÖNCEKİ günde görünüyordu (sunucu TZ'sinden
    bağımsız; pilot laptopta da). Dosya adı damgası sunucu yerel saatine bağlıydı.
  - Kapanış (WS-C-lite, 2026-10-10): `excel.ts` `buildWorkbook` her `Date` hücresini,
    `exportFileName` damgayı `Intl` + IANA `Europe/Istanbul` duvar saatine çeviriyor;
    stok "Son Hareket", hareket "Tarih", gün sonu "Saat" kapsanıyor. Kanıt: `excel.test.ts`
    (normal, gün farkı, yıl sınırı, 2015 kışı +02, süreç TZ'si UTC/New_York/Tokyo, girdi
    değişmiyor), `exports.test.ts` gerçek PG (hücre = `created_at` + 3 sa, `listMovements`
    UTC anı aynı); `dogrula` D1–D4 kırmızıya döndü; gerçek tarayıcıda 16/16 satır.

- [x] **T174 (P1)** - export - **Hareketler ekranında tarih filtreli "Excel'e aktar" 400 dönüyor**
  - Sorun: sayfa `YYYY-MM-DD`'yi `dayStartIso`/`dayEndIso` ile sayıp "N satır" gösteriyor,
    indirme rotası aynı değeri ham şemaya veriyordu (`from: Invalid datetime`).
  - Kapanış (WS-C-lite, 2026-10-10): `apps/web/src/app/api/rapor/shared.ts` geçerli tarih-only
    değeri sayfayla aynı sınıra çeviriyor; çevrilemeyen değer ham gidip 400 almaya devam
    ediyor (validation gevşemedi). Kanıt: `shared.test.ts`, `route-authz.test.ts` (200 ve
    `xyz` → 400), E2E `faz10-fiyat.spec.ts`; `dogrula` D5 (birim, rota, E2E 400) ve D6.

- [x] **T130 (P2)** - doğrulama - **Birim hassasiyeti zorlanmıyor; çok küçük miktar 500 veriyor**
  - Sorun: "0,5 adet" kabul ediliyordu; `decimalsOf` `toString()` ile `1e-7`'yi 0 basamak
    sayıyor, değer 0.000'a ölçeklenip DB CHECK'ine 500 olarak çarpıyordu; hata metni her
    durumda "sıfırdan büyük olmalı" diyordu.
  - Kapanış (WS-B, 2026-10-10): `decimalsOf` üstel gösterime dayanıklı (miktar, para,
    çarpan); birim kuralı efektif miktarda (miktar × çarpan) `createMovement`'ta, ölçekli
    bigint üzerinde, kilitten önce (`DAT-17`); adetli üründe koli çarpanı tam sayı
    (oluşturma, `addBarcode`, içe aktarma); `INVALID_QUANTITY` metni sebebi söylüyor.
    Kanıt: `unit-precision.test.ts` 8/8, `schemas.test.ts`, `errors.test.ts`,
    `products.test.ts`; `dogrula` dört koruma kırmızıya döndü; E2E `birim-ve-devir.spec.ts`
    (0,5 adet Türkçe hata, miktar korunuyor, stok değişmiyor).

- [x] **T128 (P1)** - import - **Açılış stoğu toplu girilemiyor**
  - Sorun: içe aktarma yalnız ürün yaratıyordu; 800 ürünlük müşteri 800 ayrı devir girmek zorundaydı.
  - Kapanış (WS-B, 2026-10-10): "Açılış Stoğu" sütunu (`DAT-18`); "Miktar/Stok/Adet" okunmuyor
    ve önizlemede söyleniyor; devir `createMovement` ile OPENING (fiyat Alış Fiyatı, tekli
    barkod, kilit altında `requireFirstMovement`, UUID v5 deterministik anahtar); tekrar
    çalıştırma ikinci devri yazmıyor, hareketli üründe devir atlanıp ürün güncelleniyor.
    Kanıt: `opening-import.test.ts` 21/21, `first-movement.test.ts` 8/8, `uuid-v5.test.ts`
    4/4 (RFC 9562 vektörü); `dogrula` sekiz koruma kırmızıya döndü; eşzamanlı aynı-anahtar
    çağrısının `duplicate` yerine `PRODUCT_HAS_MOVEMENTS` aldığı yarış bulunup düzeltildi;
    E2E devirli CSV; 2.000 satır devirli ilk koşu 47,1 sn (T171).

- [x] **T131 (P2)** - CI - **Migration drift adımı sessizce geçebiliyor**
  - Sorun: adım başarıyı yalnız çıkış kodu + temiz `migrations` ile ölçüyordu; araç
    sonuç üretmeden 0 dönerse yeşil kalırdı (yanlış pozitif). "Çökmede 0" önceki
    gözlemdi, 2026-10-09'da yeniden üretilemedi (eksik ve hata fırlatan config: çıkış 1).
  - Kapanış (PRE, 2026-10-09): adım drizzle-kit'in no-op satırını da istiyor (fail
    closed). Kanıt: `dogrula`, çıktısız stub'da eski adım yeşil, yeni adım kırmızı;
    scratch depoda gerçek drift kırmızı. Yan not, doğrulanmadı: drizzle-kit
    Windows'ta mutlak `out` yolunu çalışma dizinine ekliyor.

- [x] **T125 (P1)** - veri - **Seed, ortam koruması olmadan defter dahil her şeyi TRUNCATE ediyor**
  - Sorun: hedef kontrolü yoktu; yanlış kabuktaki `pnpm seed` / `pnpm demo --seed`
    üretimi silerdi. Yeniden üretildi: `127.0.0.2` hedefi ve yerel pilot kiracı
    siliniyordu, `stok_app` ile TRUNCATE'e kadar gidiyordu.
  - Kapanış (WS-A, 2026-10-09): üç kapı (`packages/db/src/seed.ts`, hedef çözümü
    `target.ts`): uzak hedef bağlantıdan önce ve bayraksız reddediliyor; RLS'e tabi
    rol reddediliyor; seed'e ait olmayan kiracı varsa yalnız yerelde ve hedefin
    adıyla (`--wipe-non-demo-data=<ad>`) siliyor. Kanıt: `seed-guard.test.ts` 7/7,
    `target.test.ts` 10/10; `dogrula` iki kapı için (uzak kapı kaldırılınca 5,
    yerel kapı kaldırılınca 3 kırmızı); `pnpm demo --seed --no-server` ayrı test
    veritabanında temizken geçiyor, pilot kiracı varken reddediyor. TRUNCATE'in
    trigger dışında kalması DB gerçeği olarak sürüyor (S3).

- [x] **T133 (P2)** - güvenlik - **`.env.example`'daki `AUTH_SECRET` üretimde kabul ediliyor**
  - Sorun: kontrol yalnız uzunluğa bakıyordu; depoda açık yazan sır + kiracı
    UUID'si = sahte yönetici token'ı.
  - Kapanış (WS-A, 2026-10-09): `NODE_ENV=production`'da `.env.example` ve CI
    değerleri reddediliyor, mesaj sırrı yazmıyor (`apps/web/src/server/config.ts`
    `PUBLIC_EXAMPLE_SECRETS`); liste, değerleri o iki dosyadan okuyan testle senkron.
    `pnpm demo` yeni `.env`'e Node ile rastgele anahtar yazıyor, var olana
    dokunmuyor (örnekse uyarıyor). Kanıt: `config.test.ts` 12/12; `dogrula` (2
    kırmızı); `next start` iki örnek sırla da çıkış 1, sır çıktıda yok; rastgele
    sırla açılıyor. CI'ın `next build`'i kontrolü çalıştırmıyor, smoke işi demo'nun
    ürettiği rastgele sırla açılıyor.

- [x] **T162** - Kiracı açma / onboarding aracı. Bugün yalnız seed ya da elle SQL (`SEC-03`).
  - Kapanış (WS-A, 2026-10-09): `pnpm tenant:create` (`packages/db/src/tenant-create.ts`,
    `provision.ts`). Sahip rolüyle, tek transaction, `withTenant` ile; hedef ve kiracı
    sayısı gösterilip "evet" isteniyor; parola üretiliyor ve bir kez gösteriliyor;
    başka kiracıdaki e-posta (`auth_lookup_user`) advisory lock altında reddediliyor
    (geçici kural, `SEC-14`). Kanıt: `provision.test.ts` 9/9,
    `provisioned-login.test.ts` (gerçek giriş yolu, `stok_app`); `dogrula` üç koruma
    (e-posta kontrolü, atomiklik, kilit). Tarayıcıda: CLI'la açılan iki sentetik
    yönetici üretim derlemesinde giriyor, ürün izolasyonu korunuyor.
