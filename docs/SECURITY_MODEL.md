# SECURITY_MODEL — aktif tehdit modeli

Bugün geçerli tehditler, onlara karşı duran korumalar ve bilinen açıklar.
Güvenlik, kiracı izolasyonu, auth, fiyat gizliliği ya da yönetim uçları üzerinde
çalışırken okunur. Genel model (roller, RLS akışı, token akışı) `PROJECT_BRAIN.md`
§8–§9'da; açıkların işi `TODOS.md`'de; geçerli kararlar `DECISIONS.md`'de.

Kod yorumlarındaki "tehdit S7" gibi ID'ler bu dosyaya işaret eder. S1–S12'nin
ilk hali ve o günkü olasılık/etki puanları arşivde
(`docs/archive/PLAN-2026-09.md` Bölüm 4). S13–S17 2026-10-08 denetiminde eklendi.

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
- **Katman:** `packages/core/src/authz.ts`, `movements.ts`, `excel.ts`, `observability.ts`.
- **Test:** `role-matrix.test.ts`, `prices.test.ts`, `observability.test.ts`,
  `e2e/demo-yolu.spec.ts`, `e2e/faz10-fiyat.spec.ts`.
- **Açık:** "alan yok = yetki yok, `null` = girilmemiş" sözleşmesi `/api/v1` yazılırken
  açıkça belgelenmeli (T53). Hata yolunda yöneticinin girdiği fiyatlar URL'de taşınıyor (T147).

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
  Sahip rolüyle koşan iki araç: `seed` uzak hedefte hiçbir bayrakla çalışmaz, RLS'e
  tabi rolle çalışmaz, seed'e ait olmayan kiracı varken yalnız yerelde ve hedefin
  adı yazılınca siler (T125). `pnpm tenant:create` yalnız ekler; yazmadan önce
  hedefi (YEREL/UZAK) ve kiracı sayısını gösterip "evet" ister (T162).
- **Katman:** `db/init/01-roles.sql`, migration 0002, `biome.json`, runbook,
  `packages/db/src/seed.ts`, `target.ts`, `tenant-create.ts`.
- **Test:** `rls.test.ts` (T46.4), `packages/db/src/smoke.test.ts` (uygulama ve
  sahip bağlantısı gerçekten farklı), `pnpm lint`, `seed-guard.test.ts`, `target.test.ts`.
- **Açık:** "yerel" adrese bakılarak belirleniyor: `localhost`'a tünellenmiş bir
  üretim veritabanı YEREL görünür; orada seed'i yalnız 3. kapı (seed'e ait olmayan
  kiracı) durdurur.

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

---

## Katmandan bağımsız açıklar

- **Güvenlik başlıkları yok:** CSP yok, `frame-ancestors`/X-Frame-Options yok; panel iframe'e konabilir (T137).
- **Yönetici eylemleri için denetim izi yok** (T141).
- **Harici izleme ve alarm yok:** güvenlik olayları dahil (T129).
- **Repo public ve korumasız:** güvenlik tasarımı ve demo kimlik bilgileri herkese açık (T120, T140).
