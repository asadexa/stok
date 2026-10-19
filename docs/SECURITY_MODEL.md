# SECURITY_MODEL — aktif tehdit modeli

Bugün geçerli tehditler, onlara karşı duran korumalar ve bilinen açıklar.
Güvenlik, kiracı izolasyonu, auth, fiyat gizliliği ya da yönetim uçları üzerinde
çalışırken okunur. Genel model (roller, RLS akışı, token akışı) `PROJECT_BRAIN.md`
§8–§9'da; açıkların işi `TODOS.md`'de; geçerli kararlar `DECISIONS.md`'de.

Kod yorumlarındaki "tehdit S7" gibi ID'ler bu dosyaya işaret eder. S1–S12'nin
ilk hali ve o günkü olasılık/etki puanları arşivde
(`docs/archive/PLAN-2026-09.md` Bölüm 4). S13–S17 2026-10-08 denetiminde, S18
2026-10-09'da WS-SCAN ile eklendi.

**Güncelleme kuralı:** yeni koruma eklenince ya da açık kapanınca ilgili satır
güncellenir. Yeni tehdit yeni ID alır; ID yeniden kullanılmaz.

---

### S1 — Kiracılar arası veri sızıntısı (A, B'nin stoğunu görür)
- **Koruma:** uygulama `stok_app` ile bağlanır; her tabloda ENABLE + FORCE RLS;
  bağlam yalnız `withTenant()` (`SET LOCAL`); ayarsız sorgu boş döner.
- **Katman:** PostgreSQL (migration 0002), `packages/db/src/client.ts`.
- **Test:** `packages/db/src/rls.test.ts` (okuma/yazma reddi, SET LOCAL sızıntısı, FORCE ve politika taraması).
- **Açık:** FK'lar kiracı-bileşik değil, RI kontrolü RLS'i atlar (T153). Supabase'e özgü rol yetkileri doğrulanmadı (S15).

### S2 — IDOR: kimliği değiştirerek başkasının kaydına erişmek
- **Koruma:** RLS başka kiracının satırını görünmez yapar; işlemler core'da
  `requirePermission`; kullanıcıdan gelen yabancı kimlikler (ör. `locationId`)
  kiracı içinde ayrıca doğrulanır.
- **Katman:** DB + `packages/core`.
- **Test:** `rls.test.ts` ("B ürününü kimliğiyle istemek boş döner"), `apps/web/src/app/api/route-authz.test.ts`.
  Tedarikçi kalemini ürüne bağlarken ürün kiracı içinde aranıyor (`bindSupplierItem`):
  `suppliers.test.ts` başka kiracının ürününe bağlamayı NOT_FOUND ile reddediyor; kontrol
  kaldırılınca bağlama FK'dan geçti (`dogrula`, 2026-10-19).
- **Açık:** S1'in FK notu.

### S3 — Hareket kaydının silinmesi ya da değiştirilmesi (kendi hatasını gizleme)
- **Koruma:** `stock_movements` append-only: `stok_app`'ten UPDATE/DELETE geri
  alınmış + her durumda istisna fırlatan trigger. Düzeltme ters hareketle.
- **Katman:** DB (migration 0002).
- **Test:** `rls.test.ts` (T5: uygulama rolü ve sahip rolü UPDATE/DELETE edemez).
- **Açık:** TRUNCATE trigger kapsamında değil; sahip rolü defteri TRUNCATE
  edebilir. Bunu yapan tek kod `seed` ve hedef korumasına bağlı (S12). Ters
  hareket akışı yok, düzeltmeler bağlantısız (T127).

### S4 — Paylaşılan cihazda "kim yaptı" bilgisinin bozulması
- **Koruma (web):** her kullanıcının kendi girişi; hareket `user_id`'yi token'dan
  alır, istemciden değil. Çıkış çerezleri siler.
- **Katman:** `packages/core/src/movements.ts`, `apps/web/src/server/session.ts`.
- **Açık:** mobildeki hızlı PIN geçişi (E10) yazılmadı (T32). Paylaşılan bir PC'de
  çıkış yapılmazsa oturum 30 güne kadar sürer.

### S5 — Çalınan / ele geçen token ile işlem yapmak
- **Koruma:** access token 15 dk ve yalnız imzadan doğrulanır; refresh 30 gün ve
  her kullanımda DB'den `tokenVersion` + aktiflik kontrol edilir; pasifleştirme,
  rol değişikliği ve parola değişimi oturumları iptal eder; HS256 sabit; refresh
  token access olarak kullanılamaz. Kendi parolasını değiştirmek mevcut parolayı
  ister: başında kimse olmayan açık bir oturum parolayı değiştirip sahibini
  kilitleyemez. Yöneticinin başkası için yaptığı sıfırlama istemez. Üretimde
  (`NODE_ENV=production`) depoda açık yazan örnek `AUTH_SECRET` değerleriyle
  (`.env.example`, CI) sunucu açılmaz (T133).
- **Katman:** `packages/core/src/auth.ts`, httpOnly çerezler, `apps/web/src/server/config.ts`.
- **Test:** `packages/core/src/auth.test.ts`, `apps/web/src/server/config.test.ts`
  (örnek değerleri o iki dosyadan okur).
- **Açık:** pasifleştirmenin etkisi ≤15 dk gecikir (bilinçli takas). Çıkış refresh
  token'ı iptal etmiyor, rotasyon yok (T134). Kendi parolasını değiştirenin
  çerezleri silinmiyor; o tarayıcı ≤15 dk açık kalıyor (T165). Örnek dışındaki
  zayıf ama uzun anahtarlar ayırt edilmiyor.

### S6 — Çalışanın yetkisini aşması (ürün/kullanıcı yönetimi, negatif stok, başkasının geçmişi)
- **Koruma:** rol matrisi tek kaynak (`packages/shared/src/roles.ts`), her yazma
  yolunda sunucuda `requirePermission`; sayfalar da yetkisiz rolü yönlendirir;
  çalışanın `userId` filtresi yok sayılır; `allowNegative` yalnız yöneticide.
  Yönetici kendini düşüremez, son aktif yönetici korunur.
- **Katman:** `packages/core/src/authz.ts`, `users.ts`, `apps/web` sayfaları.
- **Test:** `role-matrix.test.ts`, `route-authz.test.ts`, `users.test.ts`,
  `e2e/t38-kritik-akislar.spec.ts` (çalışan yönetim ekranlarına giremiyor).

### S7 — Alış fiyatının çalışana görünmesi
- **Koruma:** fiyat alanı cevaptan SİLİNİR (`null` değil). Hareketlerde kural satır
  bazında: satış dayanaklı fiyat açık, alış/devir kapalı. Sapma hatasının metni alış
  fiyatını içermez. Log fiyat yazmaz. Excel fiyat sütununu role göre çıkarır.
  Ekran rolü yeniden yorumlamaz, cevabın şeklinden türetir.
- **Tedarikçi fiyatı (T200):** alış fiyatı niteliğinde. `supplier:read` ve `supplier:manage`
  yalnız yönetici; çalışana alan gizlenmiş bir okuma da yok, her tedarikçi fonksiyonu 403 döner.
- **Katman:** `packages/core/src/authz.ts`, `movements.ts`, `excel.ts`, `observability.ts`,
  `suppliers.ts`.
- **Test:** `role-matrix.test.ts`, `prices.test.ts`, `observability.test.ts`, `suppliers.test.ts`
  (çalışan on fonksiyonun hepsinde FORBIDDEN; `dogrula` ile kanıtlı),
  `e2e/demo-yolu.spec.ts`, `e2e/faz10-fiyat.spec.ts`.
- **Açık:** "alan yok = yetki yok, `null` = girilmemiş" sözleşmesi `/api/v1` yazılırken
  açıkça belgelenmeli (T53). Hata yolunda yöneticinin girdiği fiyatlar URL'de taşınıyor (T147).
  Ham hata loglayan eylemler Drizzle'ın sorgu parametrelerini (fiyat, barkod) loga yazabilir (T204).

### S8 — Girdi alanlarından enjeksiyon (barkod, not, arama)
- **Koruma:** parametreli sorgular (Drizzle `sql` şablonu); zod uzunluk sınırları
  (barkod 64, not 500, arama 100); sebep ve sözlükler enum + DB CHECK.
- **Katman:** `packages/shared/src/schemas.ts`, `packages/core`.
- **Test:** `packages/core/src/dusman-qa.test.ts` (kaçırma denemesinden sonra tablo duruyor; her ret "stok değişmedi" kontrolüyle).

### S9 — Girişte kaba kuvvet
- **Koruma:** kalıcı sayaç tablosu (uygulama rolüne kapalı, yalnız SECURITY
  DEFINER fonksiyonları). E-posta 5 hata → 60 sn, üstel, 15 dk tavan; IP 50 hata.
  Kilit scrypt'ten ÖNCE kontrol edilir. Bilinmeyen e-postada da scrypt süresi
  harcanır ve hata sayılır. Parola en az 8 en fazla 200 karakter.
- **Katman:** migration 0005, `packages/core/src/rate-limit.ts`, `auth.ts`.
- **Test:** `rate-limit.test.ts`, `auth.test.ts`.
- **Açık:**
  - IP, `x-forwarded-for`'un ilk değerinden okunuyor; kendi sunucusunda sahtelenebilir (T135).
  - E-posta kilidi kasıtlı olarak başkası tarafından tetiklenebilir; 15 dk tavanla sınırlı.
  - `TENANT_AMBIGUOUS` yolu hata saymıyor (T123).
  - Supabase'de sayaç fonksiyonları dışarıdan çağrılabilir olabilir (S15).
  - scrypt N=2¹⁴ (T145).

### S10 — Kişisel veri (KVKK): çalışan adı + zaman + işlem
- **Koruma:** log satırlarında barkod ve fiyat yok; kişisel veri yalnız kiracı içinde, RLS altında.
- **Açık:** aydınlatma metni, saklama süresi, kiracı verisini dışa aktarma ve silme
  yok (T164). Ürün görselleri üçüncü taraf sunuculardan doğrudan çekiliyor;
  çalışanın IP'si oraya gidiyor (S17).

### S11 — PIN kaba kuvveti (paylaşılan telefon)
- **Koruma:** sayaç deposunda `PIN` kapsamı ve `users.pin_hash` (scrypt) hazır.
- **Açık:** PIN girişi ve kilit politikası yazılmadı (T32). Tehdit mobil gelince devreye girer.

### S12 — RLS'i atlayan rolle bağlanmak (sahip / `service_role`)
- **Koruma:** `stok_app`'te BYPASSRLS yok, superuser değil, sahip değil; FORCE RLS
  sahibi de bağlar; Biome kuralı uygulama kodunda `adminDbUnsafe`'i yasaklar;
  `MIGRATION_DATABASE_URL` uygulamanın çalışma ortamına konmaz (runbook §3).
  Sahip rolüyle koşan iki araç: `seed` uzak hedefte ve adreste veritabanı adı
  yokken hiçbir bayrakla çalışmaz, RLS'e tabi rolle çalışmaz, seed'e ait olmayan
  kiracı varken yalnız yerelde ve hedefin adı yazılınca siler; boş onay hiçbir
  adı onaylamaz (T125, T185). Gösterilen hedef ile bağlanılan hedef ayrışamaz
  (T187): sorgu parametreli, `%` kodlu ya da portsuz adres yerel sayılmaz; silmeden
  önce bağlanılan veritabanı (`current_database()`) yazılan adla, seed'in tabloları
  `public` ile karşılaştırılır. `pnpm db:reset` (WS-1.2b) bütün volume'ü siler ve
  aynı kuralın üstüne kümeyi sınıflandırır: Docker yerel değilse, volume compose
  `db` kapsayıcısına ait değilse ya da başka kapsayıcı kullanıyorsa, volume adı
  onaylanmamışsa kapsayıcıya hiç dokunmaz; onaylıysa kapsayıcıyı durdurup volume'ü
  ağsız, TCP dinlemeyen, salt okunur geçici bir kapsayıcıda inceler. Yalnız
  `stok`/`postgres`/şablonlar, bilinen roller ve tablespace'ler, açık izin
  listesindeki uygulama tabloları (FORCE RLS ve politikasıyla) varsa ve hedef
  inceleme sonrası değişmediyse siler; aksi halde kapsayıcıyı geri açar. Docker ya
  da katalog çıktısı beklenen biçimde değilse (eksik alan dahil) sonuç ret.
  `--dry-run` canlı ve salt okunurdur, nihai onay değildir. `pnpm tenant:create`
  yalnız ekler; bağlanılan veritabanı gösterilenle aynı değilse durur, değilse
  hedefi (YEREL/UZAK) ve kiracı sayısını gösterip "evet" ister (T162, T187).
- **Katman:** `db/init/01-roles.sql`, migration 0002, `biome.json`, runbook,
  `packages/db/src/wipe-guard.ts`, `seed.ts`, `target.ts`, `tenant-create.ts`,
  `db-reset.ts`, `docker.ts` (compose `db` → volume hedef zinciri; yedekle ortak).
- **Test:** `rls.test.ts` (T46.4), `packages/db/src/smoke.test.ts` (uygulama ve
  sahip bağlantısı gerçekten farklı), `pnpm lint`, `wipe-guard.test.ts`,
  `seed-guard.test.ts` (uzak adres test içi yönlendiriciyle gerçekten erişilebilir,
  bağlantı sayılıyor: T186), `target.test.ts`, `tenant-create.test.ts`,
  `db-reset.test.ts` (gerçek Docker, her koşuda geçici `stok_test_reset_*` projesi),
  `db-reset-target.test.ts` (Docker katmanının retleri: compose araması, kapsayıcı
  yok, CLI yok, volume projeye ait değil), `schema-sync.test.ts` (reset izin
  listesi migration'larla senkron), `cli-entry.test.ts` (reset junction/symlink ve uzantısız
  yoldan da çalışıyor, çıktısız 0 dönmüyor: T196).
- **Açık:** "yerel" adrese bakılarak belirleniyor: `localhost`'a tünellenmiş bir
  üretim veritabanı YEREL görünür; orada seed'i yalnız seed'e ait olmayan kiracı
  kapısı durdurur. Veritabanı sahibinin `pg_catalog`'u arama yolunda sona koyup
  katalog fonksiyonlarını gölgelemesi kapsam dışı (öyle bir aktör veriyi doğrudan
  silebilir). `tenant:create` şema gölgesinde başka şemaya yazabilir (T188).
  `db:reset`'te inceleme sonrası kontrol ile silme arasındaki milisaniyelerde kasıtlı
  paralel Docker müdahalesi. `docker volume rm` geri alınamaz; silmeden önce
  `pnpm db:backup` ile doğrulanmış döküm alınabiliyor (S20), ama geri yükleme kanıtı
  WS-1.4 tatbikatına kadar yok. Durdurma ve volume silme hatasındaki kurtarma yolları
  gerçek Docker'da geçici hata enjeksiyonuyla doğrulandı, kalıcı testte yok (T189).

### S13 — Kasa açığının gizlenmesi (fiyat manipülasyonu)
- **Koruma:** liste fiyatını sunucu üründen okur ve harekete dondurur; istemcinin
  gönderdiği liste fiyatı karşılaştırmaya girmez. Sapma sebebi DB CHECK ile zorunlu.
  İstemci fiyat kaynağı olarak yalnız `RECEIPT`/`ESTIMATED` iddia edebilir. İleri
  tarihli fiyat her sebepte, geçmiş tarihli fiyat satış dayanaklı sebeplerde
  reddedilir (karşılaştırmayı atlatma kaçağı). "Bugün" sunucu saatinden.
- **Katman:** DB (migration 0009), `packages/core/src/movements.ts`, `packages/shared/src/schemas.ts`.
- **Test:** `prices.test.ts`, `e2e/faz10-fiyat.spec.ts`.
- **Açık:** ürün fiyatı düzenlemeleri audit'lenmiyor; yönetici liste fiyatını
  düşürüp satıp geri yükseltirse fark kayda geçmez (T141). Saat dilimi tanımsız;
  UTC sunucuda "bugün" 03:00'a kadar dün (T122).

### S14 — Kiracılar arası giriş engelleme ve e-posta sayımı
- **Koruma:** bilinmeyen e-posta ile yanlış parola aynı hatayı verir. Kiracı açma
  aracı başka kiracıda kayıtlı e-postayla yönetici açmıyor (geçici kural, T162);
  uygulama içinden kullanıcı eklemek bu kontrolü yapmıyor.
- **Açık:** e-posta tekilliği yalnız kiracı içinde. B kiracısının yöneticisi aynı
  e-postayla kullanıcı açarak A'daki kişinin web girişini engelleyebilir (web
  `TENANT_AMBIGUOUS`'ı çözemiyor). Belirsizlik parola doğrulanmadan döndüğü için
  e-postanın birden fazla kiracıda olduğu sayaçsız öğrenilebilir (T123; karar `SEC-14`).

### S15 — Supabase Data API üzerinden SECURITY DEFINER fonksiyonlarına erişim
- **Koruma:** migration'lar fonksiyon yetkisini `PUBLIC`'ten geri alıp yalnız `stok_app`'e verir; `search_path` sabit.
- **Açık:** **doğrulanmadı.** Supabase `anon`/`authenticated` rollerine varsayılan
  EXECUTE veriyorsa `auth_clear_attempts` (S9'u devre dışı bırakır),
  `auth_record_failure`, `auth_lookup_user` ve `cron_tenants` dışarıdan
  çağrılabilir. Test yalnız PUBLIC'e bakıyor (T124). Deploy öncesi zorunlu.

### S16 — Yönetim uçlarının kötüye kullanımı (`/api/cron`, `/api/v1/health`)
- **Koruma:** `CRON_SECRET` ≥32 karakter; tanımsızsa uç kapalı; sabit zamanlı
  karşılaştırma; dedupe sayesinde tekrar tetikleme yeni iş üretmez. Sağlık ucu
  yalnız `{status}` döner, bağlantı hatasının metnini sızdırmaz.
- **Katman:** `apps/web/src/app/api/cron/route.ts`, `api/v1/health/route.ts`.
- **Test:** `route-authz.test.ts` (cron: sırsız/kısa/yanlış sır, GET ve POST), `api/v1/health/route.test.ts`.

### S17 — Dışarıdan gelen ürün görseli adresleri
- **Koruma:** yalnız `http(s)` şeması (`javascript:` / `data:` reddi); adres `<img src>` ile basılır, HTML olarak değil.
- **Katman:** `packages/shared/src/schemas.ts` (`imageUrlSchema`), `apps/web/src/components/product-cell.tsx`.
- **Test:** `products.test.ts`, `import.test.ts`.
- **Açık:** tarayıcı görseli doğrudan üçüncü taraftan çekiyor; çalışanın IP'si,
  UA'sı ve origin referer'ı gidiyor; `referrerPolicy` yok; `http` kabul ediliyor (T136).

### S18 — Telefon tarama köprüsü (girişsiz telefon → laptop ekranı)
- **Tehdit:** girişsiz `/tara` ve `/api/tara/*` üzerinden başkasının laptop ekranına
  barkod koymak, başka kullanıcının okumasını görmek, okutmayla stok değiştirmek,
  tünelden ürün/fiyat verisi okumak.
- **Koruma:**
  - Varsayılan kapalı: `ENABLE_PHONE_SCANNER` açıkça `true` değilse sayfa ve dört uç
    404; geçersiz değerle sunucu açılmaz.
  - Telefonun yetkisi yalnız "bu laptop kullanıcısının ekranına barkod metni koy":
    telefon kiracı, kullanıcı, ürün, miktar ya da fiyat göndermiyor; cevapta yalnız
    sıra numarası var, ürün/fiyat/stok yok (INV-10).
  - Okutma stok hareketi değil: uçlar veritabanına gitmiyor, `createMovement`
    çağırmıyor. Stok yalnız laptopta Kaydet'le, laptop kullanıcısının yetkisiyle
    değişiyor (`PRD-12`).
  - Oturum sunucudaki aktörden kuruluyor (`movement:create`); laptop polling'i yalnız
    aktörün kendi oturumunu görüyor, parametrede oturum kimliği yok. Kullanıcı başına
    tek oturum.
  - QR token'ı 256 bit, tek kullanımlık, 2 dk; adresin fragment'inde (loga ve
    Referer'a düşmüyor). Telefon token'ı 256 bit, `Authorization` başlığıyla (çerez
    yok, CORS yok → CSRF yok). İkisinin de yalnız SHA-256 özeti saklanıyor.
  - QR tabanı yalnız `https:` origin. Barkod `barcodeSchema` + yazdırılabilir ASCII;
    oturum başına saniyede 5 okuma; aynı okuma kimliği ikinci kez sayılmıyor. Telefon
    10 dk sessiz kalırsa oturum kapanıyor, mutlak sınır 12 sa; Kes hemen iptal ediyor.
- **Katman:** `apps/web/src/server/scan-sessions.ts`, `apps/web/src/app/api/tara/*`,
  `apps/web/src/app/(panel)/hareket/phone-scan-*.ts(x)`, `apps/web/src/server/config.ts`.
- **Test:** `scan-sessions.test.ts`, `api/tara/tara.test.ts` (IDOR, tek kullanım,
  süre, geçersiz token, bayrak, "okumalar defteri ve stoğu değiştirmiyor" gerçek PG
  ile), `e2e/telefon-tarama.spec.ts`; `dogrula` ile 8 koruma (2026-10-09).
- **Açık:**
  - Tünel açıkken uygulamanın tamamı (giriş sayfası dahil) internetten erişilebilir (T167).
  - Eşleştirmede deneme sayacı yok; 256 bit entropiye güveniliyor.
  - Laptop kullanıcısı çıkış yapsa ya da pasifleştirilse de telefon oturumu en geç
    boşta kalma süresine kadar yaşıyor; etkisi yalnız o kullanıcının ekranına barkod
    koymak.
  - QR ekranda görünür: süresi içinde fotoğraflayan ilk cihaz eşleşir; laptop
    "Telefon bağlı" gösterir, Kes iptal eder.
  - Oturum süreç belleğinde: yalnız tek süreçli `next start` (`ARC-14`).

### S19 — Veritabanı portunun ağa açık olması
- **Tehdit:** yerel ağdaki (küresel IPv6 adresi varsa ve modem izin veriyorsa
  internetteki) biri 5433'e repodaki varsayılan parolalarla süper kullanıcı olarak
  bağlanır: bütün kiracıların verisi, RLS'in atlanması, `COPY … TO PROGRAM` ile
  konteynerde komut çalıştırma.
- **Koruma:** compose portu yalnız `127.0.0.1` (`'127.0.0.1:5433:5432'`, WS-1.1);
  `.env.example` bağlantı adresleri `127.0.0.1`. `wait-for-db.mjs` Docker'da içeriden
  `pg_isready`'e ek olarak host portunu da sınıyor; yayın bozulursa "hazır" demiyor.
- **Ölçüm (2026-10-13, geliştirme laptopu):** önce `0.0.0.0`, `[::]` (Docker Desktop) ve
  `[::1]` (`wslrelay.exe`) dinliyordu; yerel ağ IPv4'ü, iki küresel IPv6 adresi ve WSL
  arayüzünden TCP bağlantısı açıktı. Sonra tek dinleyici `127.0.0.1:5433`; `::1` reddediyor,
  diğer adresler ulaşılamıyor. Volume, küme kimliği ve satır sayıları değişmedi.
- **Katman:** `docker-compose.yml`, `.env.example`, `scripts/wait-for-db.mjs`.
- **Test:** elle ölçüm (netstat + adres başına TCP denemesi); `wait-for-db` host kontrolü
  `dogrula` ile (kaldırılınca erişilemeyen portta "hazır" diyor); CI demo işi kurulumu
  `.env.example`'daki `127.0.0.1` ile yapıyor.
- **Açık:**
  - Parolalar repodaki varsayılanlar (`postgres/postgres`, `stok_app/stok_app_dev`): bu
    makinedeki her süreç, başka yerel kullanıcı ve aynı Docker ağındaki konteynerler
    bağlanabilir. Parola rotasyonu WS-1 dışında.
  - Gerçek ikinci bir cihazdan deneme yapılmadı; ret aynı makineden ağ adresleriyle ölçüldü.
  - Uygulama sunucusu (`next start`) yerel ağda HTTP ile bütün arayüzlerde açık (T183).

### S20 — Yerel yedek dökümü (`pnpm db:backup`, WS-1.3a)
- **Tehdit:** döküm bütün kiracıların verisini taşıyor (süper kullanıcıyla alınıyor, RLS'e
  takılmıyor): parola özetleri, kişisel veri, alış fiyatları (INV-10). Yanlış yere yazılırsa
  sızar (public repo, buluta senkron klasör); yanlış veritabanından alınırsa ya da yarım
  kalırsa "yedek var" yanılgısı doğar; saklama yanlış çalışırsa sağlam yedeği siler.
- **Koruma:**
  - Dizin `%LOCALAPPDATA%\stok\yedek` ya da `STOK_BACKUP_DIR`. Gerçek yol (`realpath`,
    junction/`subst`/eşlenmiş sürücü çözülerek) repo içiyse, OneDrive altındaysa, göreli,
    sürücüsüz ya da `\\` önekliyse ret; dizin yaratılmadan önce ve sonra denetleniyor.
    Gerçek konum istenenden farklıysa (paketli uygulama yönlendirmesi) çıktıda söyleniyor.
  - Kaynak: yalnız yerel Docker ucu, compose `db` kapsayıcısı (`docker.ts` zinciri) ve
    uygulamanın `DATABASE_URL`'inin gösterdiği yerel port ile `stok` veritabanı (`OPS-10`).
  - Döküm `.partial`'a yazılıyor; içindekiler (`dbname: stok`, temel tabloların `TABLE` ve
    `TABLE DATA` girdileri) ve tam okuma geçmeden son adını ve `.sha256`'sını almıyor.
    Doğrulama veritabanına bağlanmıyor (`-d` yok); geri yükleme değil.
  - Saklama yalnız başarılı koşudan sonra, en yeni 14 kayıtlı döküm; bu koşunun dökümü,
    desen dışı dosyalar ve `.sha256`'sız dökümler silinmez. Yeni dosyalar `wx` ile.
  - Log ve çıktı yalnız meta veri: satır verisi, parola ve bağlantı adresi yazılmıyor.
  - Komut, junction/symlink içeren ya da uzantısız yoldan çağrılsa da gerçekten çalışıyor;
    çıktısız 0 dönmüyor. CI duman adımı çıkış kodunun yanında başarı satırlarını da arıyor (T196).
- **Katman:** `packages/db/src/backup.ts`, `backup-policy.ts`, `docker.ts`, `cli-entry.ts`.
- **Test:** `backup-policy.test.ts` (dizin kuralı win32 ve posix, TOC, saklama, kalıntı,
  durum), `backup.test.ts` (gerçek Docker, geçici `stok_test_backup_*` projesi: kesik ve
  bozuk arşiv reddi, yanlış veritabanı arşivi, yasak dizin, uzak uç, yanlış
  `DATABASE_URL`, saklama, `pg_dump` hatası, durmuş kapsayıcı, `--status` bozulmayı
  görüyor). On koruma `dogrula` ile kaldırılınca kırmızı görüldü (WS-1.3a). M1 ölçümü:
  kesik ve baytı bozulmuş arşivde `pg_restore --list` çıkış 0, tam okuma ret.
  `cli-entry.test.ts` (iki CLI gerçek yol, bağlantı ve uzantısız yol üzerinden; içe aktarma CLI
  başlatmıyor).
- **Açık:**
  - Döküm şifresiz; diskte okunabilir. Pilot makinesinde BitLocker kontrolü P-0'ın
    parçası (`OPS-11`). Özel bir `STOK_BACKUP_DIR`'in erişim yetkileri denetlenmiyor.
  - Yedek ve volume aynı diskte: disk arızasına ve cihaz kaybına karşı korumuyor (başka
    yere yedek kapsam dışı, `OPS-10`).
  - Döküm roller ve küme geneli nesneleri içermiyor; gerçek kurtarma prosedürü yazılmadı
    (`OPS-10`, T129).
  - Dropbox, Google Drive gibi diğer senkron klasörleri algılanmıyor (T193). Elle repoya
    kopyalanan döküm araç dışında.
  - Paketli bir uygulamanın (ör. Claude masaüstü) alt sürecinde varsayılan dizin paketin
    özel klasörüne yönleniyor (uygulama kaldırılınca silinir); komut bunu "Hedef" satırında ve
    bir uyarıyla söylüyor. Normal terminalde varsayılan dizin doğrulandı (T192, kapandı).
  - Saklama volume kuşağını ayırmıyor: kazara reset sonrası 14 başarılı koşu eski dökümleri
    döndürür; zamanlamadan (WS-1.3b) önce ele alınacak (T190).
  - `--status` yalnız en yeni dökümün SHA-256'sını yeniden hesaplıyor; geri
    yüklenebilirliğin kanıtı WS-1.4 tatbikatı.
  - Kaynağın uygulamanınki olduğu port numarasıyla doğrulanıyor, sunucu kimliğiyle değil:
    `localhost`/`::1` aynı portta başka bir loopback adresindeki ikinci bir PostgreSQL'e
    gidebilir (T198, doğrulanmadı).

---

## Katmandan bağımsız açıklar

- **Güvenlik başlıkları yok:** CSP yok, `frame-ancestors`/X-Frame-Options yok; panel iframe'e konabilir (T137). CSP eklenirken telefon okutması için `'wasm-unsafe-eval'` ve kamera izni gerekecek (T137 notu).
- **Yönetici eylemleri için denetim izi yok** (T141).
- **Harici izleme ve alarm yok:** güvenlik olayları dahil (T129).
- **Repo public ve korumasız:** güvenlik tasarımı ve demo kimlik bilgileri herkese açık (T120, T140).
