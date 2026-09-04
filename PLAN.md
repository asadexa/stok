# Stok Takip Sistemi - Ürün ve Mimari Planı

Üretildi: `/plan-ceo-review` | 2026-08-22 | Mod: SELECTIVE EXPANSION
Durum: ONAY BEKLİYOR

---

## 0. KARARLAR (verildi)

| # | Karar | Seçim | Gerekçe |
|---|---|---|---|
| D1 | Hedef kitle | Tek depo + SaaS'a hazır şema | `tenant_id` bugün bedava, sonradan 2-3 hafta |
| D2 | Uygulama yaklaşımı | Monolit Next.js web + native Expo mobil | Offline barkod okutma ürünün kalbi, PWA bunu iOS'ta veremiyor |
| D3 | İnceleme modu | SELECTIVE EXPANSION | v1 disiplini + fırsatları görme isteği |

### Teknoloji seçimi

```
apps/web       Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui
apps/mobile    Expo (React Native) + expo-camera + expo-sqlite + expo-notifications
packages/shared  zod şemaları + paylaşılan tipler (tek API sözleşmesi)
DB             PostgreSQL + Row Level Security (Supabase önerilir)
ORM            Drizzle (SQL'e yakın, migration'lar okunabilir)
API            Next.js Route Handlers, düz REST, /api/v1/*
Excel          exceljs (sunucu tarafı, stream)
Barkod üretimi bwip-js (Code128)
Monorepo       pnpm workspace
Deploy         Vercel (web) + EAS (mobil) + Supabase (DB)
```

**Neden REST, tRPC değil:** mobil istemci ve ileride Logo/Mikro/e-fatura entegrasyonu aynı
sözleşmeyi kullanacak. tRPC TypeScript dışına açılmıyor.

**Neden Supabase:** Row Level Security'yi bedava getiriyor. Multi-tenant sızıntı bu projenin
en büyük güvenlik riski ve RLS onu veritabanı seviyesinde kapatıyor, "sorguda filtre koymayı
unutmam" varsayımına bırakmıyor.

---

## 1. VERİ MODELİ (planın kalbi)

### Temel ilke: stok bir sayı değil, bir sonuçtur

Brief'te "Mevcut stok 35, giriş +20, yeni stok 55" akışı var. Bu `UPDATE products SET stock = 55`
demek ve üç şeyi birden bozar:

1. İki çalışan aynı anda okutursa biri sessizce kaybolur (lost update)
2. Hata olduğunda geriye dönüp ne olduğunu bulamazsın
3. "Kim ne yaptı" logu ile stok sayısı ayrı iki gerçek olur, biri diğerini tutmaz

Doğrusu: **append-only hareket defteri (ledger)**. Stok, hareketlerin toplamıdır. Düzeltme,
kaydı silmek değil, ters hareket yazmaktır. Bunun bedava yan etkisi: "Log Kayıtları" özelliği
ayrıca yazılmaz, veri modelinin kendisi zaten odur.

### Şema

```sql
tenants            (id, name, created_at)

users              (id, tenant_id, email, name, role, pin_hash, active, created_at)
                   role: 'admin' | 'calisan'

products           (id, tenant_id, sku, name, category, brand,
                    unit,              -- 'adet' | 'kg' | 'metre' | 'litre'
                    purchase_price NUMERIC(12,2),
                    sale_price     NUMERIC(12,2),
                    min_stock      NUMERIC(14,3),   -- kritik stok eşiği
                    location_id, archived_at, created_at)
                   UNIQUE (tenant_id, sku)

product_barcodes   (id, tenant_id, product_id, barcode, kind,
                    qty_multiplier NUMERIC(10,3) NOT NULL DEFAULT 1,
                    created_at)
                   kind: 'UNIT' | 'CASE' | 'EAN' | 'INTERNAL'
                   UNIQUE (tenant_id, barcode)      -- tenant içinde tek
                   CHECK (kind <> 'CASE' OR qty_multiplier > 1)
                   -- Koli barkodu okutulunca: girilen miktar x qty_multiplier
                   -- Ekranda "5 koli x 12 = 60 adet" gösterilir (D7)

locations          (id, tenant_id, code, name)      -- raf/konum

stock_movements    (id, tenant_id, product_id, user_id,
                    delta          NUMERIC(14,3),   -- + giriş, - çıkış
                    reason         TEXT,
                    note           TEXT,
                    location_id,
                    unit_cost      NUMERIC(12,2),   -- girişte alış fiyatı
                    idempotency_key TEXT,
                    count_session_id,
                    reverses_id,                    -- düzeltme ise hangi hareketi ters çeviriyor
                    created_at, client_created_at)
                   UNIQUE (tenant_id, idempotency_key)
                   INDEX  (tenant_id, product_id, created_at DESC)
                   INDEX  (tenant_id, created_at DESC)
                   -- UPDATE ve DELETE YASAK (aşağıda DB seviyesinde zorlanıyor)

current_stock      (tenant_id, product_id, qty, last_movement_at)
                   PRIMARY KEY (tenant_id, product_id)
                   -- Gerçek tablo, ama TÜRETİLMİŞ veri. Gerçeğin kaynağı
                   -- stock_movements. Bu tablo trigger ile bakımlı bir
                   -- projeksiyondur. Materialized view DEĞİL: PostgreSQL'de
                   -- materialized view artımlı güncellenmez, her harekette
                   -- tam REFRESH gerektirir ve bu iş yükünde kabul edilemez.

-- ÇIKARILDI (D4): stock_count_sessions, stock_count_lines
-- Sayim özelliği (TODOS E2) yazılırken eklenecek. Kullanılmayan şema
-- hazırlık değil, bakım borcudur. stock_movements.count_session_id
-- nullable sütunu kalıyor: özellik geldiğinde geriye dönük bağlama kapısı.
```

### Sebep kodları (reason)

Değerler İngilizce, etiketler Türkçe (D-2.3, D-2.4). Sebep kodları API cevaplarına
ve Excel'e gidiyor; ileride Logo/Mikro entegrasyonu bunları tüketecek.

```
GİRİŞ   PURCHASE | RETURN_IN  | COUNT_ADJUST_UP   | OPENING | OTHER_IN
ÇIKIŞ   SALE     | DAMAGE     | RETURN_OUT        | USAGE   | COUNT_ADJUST_DOWN | OTHER_OUT
```

**Tek kaynak kuralı:** liste `packages/shared/reasons.ts` içinde bir zod enum
olarak yaşar. DB CHECK constraint ondan üretilir, Türkçe etiket eşlemesi de
aynı dosyada. Üç yerde ayrı ayrı yazılırsa drift kaçınılmaz. Senkronu
doğrulayan bir test var (T44).

`delta`'nın işareti kullanıcıdan değil, `reason`'dan türetilir. Kullanıcı her zaman pozitif
miktar girer, sistem işareti koyar. Bu, "-5 girmek isterken 5 girdi" hatasını yapısal olarak
imkansız kılar.

### Değiştirilemezlik zorlaması (kritik)

```sql
-- Uygulama rolünün stock_movements üzerinde SADECE INSERT yetkisi olur.
REVOKE UPDATE, DELETE ON stock_movements FROM app_user;
-- Ek güvenlik: trigger
CREATE TRIGGER no_mutate BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION raise_immutable_ledger();
```

Admin bile logu değiştiremez. Değiştirebiliyorsa "kim ne yaptı" ekranı hiçbir şey ispat etmez
ve ürünün ana değer önerisi çöker.

### Tenant izolasyonu: RLS gerçekten nasıl zorlanıyor (D5)

RLS politikası yazmak tek başına yetmez. Uygulama veritabanına `postgres`
kullanıcısıyla veya Supabase `service_role` anahtarıyla bağlanırsa o rol
`BYPASSRLS` taşır ve **yazılan her politika sessizce devre dışı kalır**. Tek
tenant'la test ederken bu asla fark edilmez.

Zorlama üç parçalı:

```sql
-- 1) İKİ AYRI ROL. Uygulama, tabloların sahibi OLMAYAN rolle bağlanır.
--    postgres  → tabloların sahibi, SADECE migration çalıştırır
--    stok_app  → uygulamanın bağlandığı login rolü, BYPASSRLS yok
CREATE ROLE stok_app LOGIN PASSWORD '...'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE  ROW LEVEL SECURITY;   -- sahibe de uygula
-- (aynısı diğer tenant'lı tablolar için)

-- 2) Politika, oturum değişkeninden tenant okur
CREATE POLICY tenant_isolation ON products
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

```ts
// 3) Her istek tek bir boğazdan geçer
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>) {
  return db.transaction(async (tx) => {
    // true = LOCAL, yani sadece bu transaction boyunca geçerli
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`)
    return fn(tx)
  })
}
```

**Uygulama sırasında yapılan sadeleştirme:** ilk tasarımda `SET LOCAL ROLE app_user`
vardı. Gerek kalmadı: uygulama zaten `stok_app` olarak bağlanıyor, yani rol değiştirmeye
ihtiyaç yok. Bir hareketli parça az, aynı garanti. İki bağlantı dizesi `.env.example`
içinde ayrı ayrı tanımlı (`DATABASE_URL` uygulama, `MIGRATION_DATABASE_URL` migration)
ve karıştırılmaması gerektiği orada da yazılı.

`current_setting('app.tenant_id', true)` ayarlanmamışsa NULL döner ve politika
hiçbir satır geçirmez. Yani `withTenant` dışından yapılan bir sorgu **veri
sızdırmaz, boş döner**. Güvenli varsayılan bu yönde.

Kural: veri erişen her route handler `withTenant` içinden geçer. Doğrudan `db`
kullanımı ESLint kuralıyla yasaklanır (T45).

### Kritik karar: miktar tipi

`NUMERIC(14,3)`, `INTEGER` değil. Bugün sadece adet satıyor olabilirsin ama kg/metre/litre
gelen ilk müşteride migration yazmak zorunda kalırsın. Maliyet farkı bugün sıfır.

### Kritik karar: para ve zaman

- Para: `NUMERIC(12,2)`. Asla `float`.
- Zaman: DB'de her şey UTC (`timestamptz`). Gösterimde `Europe/Istanbul`.
  Karıştırırsan "Ahmet 14:30'da giriş yaptı" logu yanlış saat gösterir ve loga güven biter.

---

## 2. MİMARİ

```
                    ┌──────────────────────────────┐
                    │   packages/shared (TS)       │
                    │   zod şemaları + tipler      │
                    │   TEK API SÖZLEŞMESİ         │
                    └───────┬──────────────┬───────┘
                            │              │
              ┌─────────────┘              └─────────────┐
              ▼                                          ▼
   ┌──────────────────────┐                  ┌──────────────────────┐
   │  apps/web            │                  │  apps/mobile         │
   │  Next.js 15          │                  │  Expo / React Native │
   │  ├ Admin paneli      │                  │  ├ Barkod okutma     │
   │  ├ Stok tablosu      │                  │  ├ Giriş / Çıkış     │
   │  ├ Hareket logu      │                  │  ├ Ürün arama        │
   │  ├ Excel export      │◀───HTTPS/REST────│  ├ SQLite outbox     │
   │  └ /api/v1/*         │    Bearer JWT    │  └ Senkron kuyruğu   │
   └──────────┬───────────┘                  └──────────────────────┘
              │
              │  Tek yazma kapısı: createMovement()
              ▼
   ┌──────────────────────────────────────────┐
   │  PostgreSQL + RLS                        │
   │  stock_movements (append-only, gerçek)   │
   │  current_stock  (projeksiyon, türetilmiş)│
   └──────────────────────────────────────────┘
              ▲
              │ cron (Vercel Cron)
   ┌──────────┴───────────┐
   │ Gün sonu raporu      │
   │ Kritik stok taraması │
   └──────────────────────┘
```

**Tek yazma kapısı kuralı:** Stok değiştiren TEK bir sunucu fonksiyonu olur (`createMovement`).
Web de mobil de aynı endpoint'i çağırır. İki ayrı implementasyon = iki ayrı hata kümesi.

**Eşzamanlılık: kontrol ve yazma atomik olmalı (D-1.2).** `current_stock`'u okuyup
sonra INSERT etmek klasik bir TOCTOU yarışıdır: iki eşzamanlı istek ikisi de
"yeterli stok var" kontrolünden geçer ve stok negatife düşer. Doğru desen tek
transaction ve satır kilidi:

```sql
BEGIN;
  -- 1) Ürün satırını kilitle. Aynı ürüne yazan diğer istekler burada bekler.
  SELECT qty FROM current_stock
   WHERE tenant_id = $1 AND product_id = $2
     FOR UPDATE;

  -- 2) İş kuralı kontrolü (kilit altında, artık güvenli)
  --    qty + delta < 0 ve admin override yoksa → InsufficientStock, ROLLBACK

  -- 3) Ledger önce yazılır: gerçeğin kaynağı burası
  INSERT INTO stock_movements (...) VALUES (...);

  -- 4) Projeksiyon güncellenir (trigger de yapabilir, sıra aynı)
  UPDATE current_stock
     SET qty = qty + $delta, last_movement_at = now()
   WHERE tenant_id = $1 AND product_id = $2;
COMMIT;
```

Ürün satırı yoksa (ilk hareket) `INSERT ... ON CONFLICT DO UPDATE` ile atomik
oluşturulur. Kilit ürün bazlı olduğu için farklı ürünlere yazanlar birbirini
beklemez; günde yüzlerce hareket ölçeğinde ölçülebilir etkisi yoktur.

### Veri akışı: stok girişi, dört yol

```
MUTLU YOL
  Barkod okut
    → idempotency_key ÜRETİLİR (uuid) ve outbox satırıyla birlikte SQLite'a yazılır
      ⚠ Anahtar gönderim anında değil, OKUTMA anında üretilir (D-1.3).
        Gönderimde üretilirse uygulama yeniden başladıktan sonraki tekrar
        denemede yeni anahtar oluşur ve tam olarak önlemek istediğimiz
        çift kayıt meydana gelir.
    → product_barcodes lookup (tenant_id + barcode) → product_id, qty_multiplier
    → miktar + sebep seç   →  efektif miktar = girilen x qty_multiplier
    → POST /api/v1/movements { idempotency_key, barcode, qty, reason }
    → withTenant(tenantId, tx => { ... })   -- RLS bağlamı kurulur
    → 201 { new_qty }
    → mobil: outbox'tan sil, ekranda yeni stok, bip + yeşil

NIL YOLU  (barkod veritabanında yok)
    → 404 { code: 'BARCODE_UNKNOWN' }
    → Çalışan ekranı: "Bu barkod tanımsız" + [Admin'e bildir] butonu
      (çalışan ürün ekleyemez, rol kuralı)
    → Admin ekranı: aynı barkodla hızlı ürün tanımlama formu açılır
    ⚠ Brief'te bu yol yoktu. Depoda EN SIK yaşanan olay budur.

BOŞ YOLU  (miktar 0, boş veya negatif)
    → zod validation reddeder, hareket yazılmaz
    → miktar > 0 zorunlu; işaret reason'dan gelir

HATA YOLU  (ağ kopuk / DB hatası / 5xx)
    → mobil: kayıt outbox'ta [pending] kalır
    → exponential backoff (2s, 4s, 8s, 30s, 60s)
    → idempotency_key sayesinde tekrar gönderim çift kayıt yaratmaz
    → 5 dk'dan eski bekleyen kayıt varsa ekranda kalıcı rozet:
      "12 kayıt gönderilemedi" (dokun → detay)
    ⚠ Brief'te senkron görünürlüğü yoktu. Sessiz veri kaybı riski #1.
```

### Durum makineleri

```
OUTBOX KAYDI (mobil cihazda)

   [pending] ──gönder──▶ [sending] ──201──▶ [synced] ──▶ yerelden silinir
       ▲                     │
       │                     ├──ağ hatası / 5xx──▶ [pending]  (backoff ile tekrar)
       │                     │
       │                     └──4xx (iş kuralı reddi)──▶ [rejected]
       │                                                     │
       └─────────── kullanıcı düzeltip yeniden gönderir ─────┘

   GEÇERSİZ GEÇİŞ: [synced] → [pending]
   ENGELİ: idempotency_key sunucuda UNIQUE. Aynı anahtar ikinci kez gelirse
           sunucu 200 + mevcut kaydı döner, yeni hareket YAZMAZ.


```

(Sayım oturumu durum makinesi TODOS.md'ye taşındı, özellikle birlikte gelecek.)

### Mobil offline okuma: ürün önbelleği (D9)

Outbox yazma tarafını çözüyor. Okuma tarafı da gerekiyor: çalışan barkodu
okuttuğunda ekranda ürün adı ve mevcut stok görmeli, yoksa doğru ürüne
yazdığını doğrulayamaz.

**Seçilen yaklaşım: sadece daha önce okutulan ürünler önbelleklenir.**

```
  Barkod okutuldu
        │
        ├── SQLite önbellekte VAR ──▶ ürün adı + son bilinen stok gösterilir
        │                             "son güncelleme 14:20" notu ile
        │
        └── önbellekte YOK
              ├── çevrimiçi  ──▶ sunucudan çek, önbelleğe yaz, göster
              │
              └── çevrimdışı ──▶ "Çevrimdışı: ürün doğrulanamadı"
                                 Kayıt YİNE DE alınır, unresolved=true ile
                                 kuyruğa yazılır. Senkronda çözülür:
                                   • barkod tanınırsa → normal hareket
                                   • tanınmazsa → [rejected], kullanıcıya
                                     "3 okutma tanımsız barkod" bildirimi
```

Kritik nokta: çevrimdışı tanınmayan barkod **reddedilmez, işaretlenir**.
Reddetmek, çalışanın malı sisteme hiç girmemesi demek olurdu ve o veri geri
gelmez. İşaretlemek, veriyi korur ve sorunu görünür kılar.

**Bilinen sınır (kabul edildi):** yeni gelen mal ve ilk kez okutulan ürün
önbellekte olmaz, yani mal kabulü çevrimdışı yapılırken doğrulama çalışmaz.
Tam katalog senkronu TODOS.md'de duruyor; sahada canı yakarsa yol yazılı.

### Ölçeklenme

| Yük | Durum |
|---|---|
| 1x (1 depo, 800 ürün, 300 hareket/gün) | Rahat |
| 10x (10 depo, 5k ürün, 3k hareket/gün) | Rahat. Monolit sorun çıkarmaz |
| 100x | İlk kırılan: Excel export'un sunucu belleğine 100k satır alması. Çözüm: stream export. İkinci: hareket listesi sayfalaması. `current_stock` satır kilidi ürün bazlı olduğu için sorun değil |

### Tek nokta arızaları

- **Postgres.** Yedek şart. Supabase/Neon otomatik PITR verir; kendi VPS'inde günlük `pg_dump` + haftalık restore tatbikatı.
- **Vercel.** Down olursa web durur, mobil offline moda düşer ve kuyruğa yazmaya devam eder. v1'de kabul edilebilir.

### Geri alma (rollback)

| Katman | Yöntem | Süre |
|---|---|---|
| Web | Vercel instant rollback | < 1 dk |
| DB migration | Sadece additive (kolon ekle). Silme asla aynı sürümde | - |
| Mobil, JS değişikliği | **EAS Update** ile önceki paketi yeniden yayınla | < 5 dk |
| Mobil, native değişiklik | Store onayı gerekir | 1-3 gün |

Not (D6): önceki sürümde "mobil geri alma YOK" yazıyordu, bu Expo kullanılırken
yanlıştı. EAS Update, uygulamanın JS paketini mağaza onayı olmadan günceller ve
geri alma dakikalar sürer. Sadece native modül değişiklikleri (kamera kütüphanesi
sürümü, yeni izin) mağaza turunu gerektirir. Pratikte hataların çoğu JS tarafında
olduğu için bu, planın en riskli maddesini büyük ölçüde kapatıyor.

Yine de **sunucu tarafı feature flag** korunuyor: OTA güncellemesi kullanıcının
uygulamayı yeniden açmasını bekler, feature flag anında etki eder. İki mekanizma
birbirinin yedeği.

---

## 3. HATA VE KURTARMA HARİTASI

| Kodyolu | Ne ters gidebilir | İstisna |
|---|---|---|
| `createMovement` | Barkod bulunamadı | `BarcodeNotFound` |
| | Ürün arşivlenmiş | `ProductArchived` |
| | Miktar geçersiz (0, negatif, NaN) | `InvalidQuantity` |
| | Çıkış eldekinden fazla | `InsufficientStock` |
| | Aynı idempotency_key | `DuplicateMovement` |
| | DB bağlantı havuzu doldu | `PoolExhausted` |
| | Transaction deadlock | `SerializationFailure` |
| `syncOutbox` (mobil) | Ağ yok | `NetworkUnavailable` |
| | Token süresi doldu | `TokenExpired` |
| | Sunucu 5xx | `ServerError` |
| | Uygulama sürümü çok eski | `ClientTooOld` |
| `exportExcel` | Satır sayısı bellek sınırını aştı | `ExportTooLarge` |
| | Türkçe karakter bozuldu | (sessiz, kodlama hatası) |
| `printBarcode` | Yazıcı yanıt vermiyor | `PrinterUnavailable` |
| `dailyReportCron` | E-posta gönderilemedi | `MailDeliveryFailed` |

| İstisna | Yakalanıyor? | Aksiyon | Kullanıcı ne görür |
|---|---|---|---|
| `BarcodeNotFound` | E | 404 dön | "Bu barkod tanımsız" + admin'e bildir |
| `ProductArchived` | E | 409 dön | "Bu ürün arşivde, admin'e başvurun" |
| `InvalidQuantity` | E | 400, zod mesajı | Alan altında kırmızı uyarı |
| `InsufficientStock` | E | 409 + mevcut miktar | "Elde 3 var, 5 çıkamaz" + [Yine de yap] (admin) |
| `DuplicateMovement` | E | 200 + mevcut kayıt | Hiçbir şey (şeffaf, doğru davranış) |
| `PoolExhausted` | E | 503 + Retry-After | "Sistem yoğun, tekrar deneniyor" (mobil kuyrukta tutar) |
| `SerializationFailure` | E | 3 kez tekrar dene, sonra 503 | Aynı |
| `NetworkUnavailable` | E | Outbox'ta tut, backoff | Sarı rozet: "3 kayıt bekliyor" |
| `TokenExpired` | E | Refresh dene, olmazsa login | Giriş ekranı, **kuyruk korunur** |
| `ServerError` | E | Outbox'ta tut, backoff | Sarı rozet |
| `ClientTooOld` | E | Zorunlu güncelleme ekranı | "Uygulamayı güncelleyin" + store linki |
| `ExportTooLarge` | E | 413 + "tarih aralığını daraltın"; eşik üstü kuyruğa | "Rapor hazırlanıyor, e-posta ile gelecek" |
| Türkçe karakter bozulması | E | Fixture testi her koşuda doğruluyor | Doğru metin |
| `PrinterUnavailable` | **H ← AÇIK** | - | Buton takılı kalır ← KÖTÜ |
| `MailDeliveryFailed` | E | 1 tekrar (60 sn sonra), sonra iş FAILED | Admin panelinde kalıcı uyarı |

### KRİTİK AÇIKLAR ve kapatma planı

| # | Açık | Kapatma |
|---|---|---|
| G1 | ~~`ExportTooLarge` yakalanmıyor~~ **KAPANDI (T14)** | 20k altı senkron, üstü kuyruk + e-posta, 200k üstü "tarih aralığını daraltın" |
| G2 | ~~Türkçe karakter sessizce bozuluyor~~ **KAPANDI (T15)** | xlsx (UTF-8 XML), üretilen dosya geri okunup karşılaştırılıyor |
| G3 | Yazıcı hatası sessiz | **AÇIK.** TODOS E5 ile birlikte: timeout + "Yazıcıya ulaşılamadı" + PDF'e düşme |
| G4 | ~~Cron e-posta hatası sessiz~~ **KAPANDI (T17)** | `background_jobs` satırı FAILED kalıyor, admin paneli okuyor, 1 tekrar |

**Kural:** `catch (e)` genel yakalama yasak. Her istisna adıyla yakalanır. Yakalanan her hata
ya tekrar dener, ya kullanıcıya görünür şekilde bozulur, ya da bağlam ekleyip yeniden fırlatır.
"Yut ve devam et" bu projede hiçbir yerde kabul edilebilir değil, çünkü ürünün tek işi doğru
sayı söylemek.

### Hata cevap sözleşmesi (D-2.2)

```jsonc
{ "code": "INSUFFICIENT_STOCK",       // sabit, makine okur, ASLA değişmez
  "message": "qty 5 > available 3",   // İngilizce, sadece log ve hata ayıklama
  "details": { "available": 3, "requested": 5 } }
```

Kullanıcıya gösterilen Türkçe metin **istemcide** `code`'dan üretilir. Sunucu
Türkçe metin dönerse metni değiştirmek için deploy gerekir ve mobil uygulama
kendi diline çeviremez. `message` alanı hiçbir zaman doğrudan ekrana basılmaz.

---

## 4. GÜVENLİK VE TEHDİT MODELİ

| # | Tehdit | Olasılık | Etki | Plan bunu karşılıyor mu |
|---|---|---|---|---|
| S1 | Multi-tenant veri sızıntısı (A müşterisi B'nin stoğunu görür) | Orta | **Yüksek** | RLS ile kapatılıyor |
| S2 | IDOR: `/api/v1/products/123` id değiştirerek başkasının ürünü | Yüksek | Yüksek | RLS + rol kontrolü |
| S3 | Çalışan kendi hatasını gizlemek için hareket siliyor | Orta | **Yüksek** | Ledger değiştirilemez, DB seviyesinde |
| S4 | Telefon paylaşımı, "kim yaptı" bozuk | **Yüksek** | Orta | PIN ile hızlı kullanıcı geçişi (E10) |
| S5 | Çalınan telefondaki token ile hareket yazma | Düşük | Orta | Kısa ömürlü JWT + refresh + uzaktan oturum kapatma |
| S6 | Çalışan yetkisi aşımı (ürün silme, fiyat görme) | Orta | Orta | Rol kontrolü **sunucuda**, UI'da gizlemek yeterli değil |
| S7 | Alış fiyatı çalışana görünüyor | Orta | Orta | Fiyat alanları çalışan API cevabından çıkarılır |
| S8 | Barkod alanından enjeksiyon | Düşük | Yüksek | Parametreli sorgu (Drizzle zaten yapıyor) + uzunluk sınırı |
| S9 | Kaba kuvvet giriş denemesi | Orta | Orta | Kademeli kilit, kalıcı sayaç (T51) |
| S10 | KVKK: çalışan adı + saat + işlem = kişisel veri | Kesin | Orta | Aydınlatma metni + saklama süresi politikası. Türkiye'de satacaksan yükümlülük |
| S11 | PIN kaba kuvvet: 4-6 hane, cihazda sınırsız denenebilir | Orta | Orta | 5 yanlışta 60 sn kilit, 10 yanlışta oturum kapat + tam giriş (D-2.5) |
| S12 | RLS yazılıp `postgres`/`service_role` ile bağlanma: politikalar sessizce devre dışı | **Yüksek** | **Yüksek** | `app_user` rolü + `FORCE ROW LEVEL SECURITY` + `withTenant` (D5). Test T46 |

**Rol matrisi (sunucuda zorlanır):**

| İşlem | admin | calisan |
|---|---|---|
| Ürün ekle / düzenle / arşivle | ✓ | ✗ |
| Barkod ekle | ✓ | ✗ |
| Stok giriş / çıkış | ✓ | ✓ |
| Ürün / stok görüntüle | ✓ | ✓ |
| Alış fiyatı ve maliyet gör | ✓ | ✗ |
| Hareket geçmişi (tüm kullanıcılar) | ✓ | sadece kendi |
| Excel export | ✓ | ✗ |
| Kullanıcı ekle / yetki ver | ✓ | ✗ |
| Sayım başlat | ✓ | ✓ |
| Sayım onayla | ✓ | ✗ |
| Negatif stoğa izin ver | ✓ | ✗ |

---

## 5. UÇ DURUMLAR

| Etkileşim | Uç durum | Plan |
|---|---|---|
| Barkod okutma | Aynı barkod 2 sn'de 3 kez okundu | 800 ms debounce, tek kayıt |
| | Barkod okundu, kullanıcı miktar girmeden çıktı | Taslak atılır, hareket yazılmaz |
| | Etiket yıpranmış, yanlış okundu | Ürün adı ekranda büyük gösterilir, kullanıcı doğrular |
| | Aynı barkod iki üründe | UNIQUE kısıt engeller, ekleme anında hata verir |
| Stok çıkışı | Elde 3, çıkış 5 | 409 + admin isterse `[Yine de yap]` (negatif stok, loglanır) |
| | İki telefon offline'da toplam 8 çıkardı, elde 5 vardı | Senkronda ikincisi 409 alır, `[rejected]` olur, kullanıcıya sorulur |
| Form gönderimi | Çift tıklama | idempotency_key aynı, sunucu 200 + mevcut kayıt |
| | Deploy sırasında gönderim | 503 + Retry-After, kuyrukta kalır |
| Liste görünümü | 0 sonuç | Boş durum ekranı + [Excel'den toplu yükle] (E1) |
| | 10.000 ürün | Sunucu tarafı sayfalama + arama, sanal liste |
| | Sayfa açıkken veri değişti | 30 sn'de bir yenile veya "yeni hareket var" rozeti |
| Arka plan işi | Gün sonu raporu 3 üründe patladı | Kısmi rapor gönderilmez, hata admin paneline düşer |
| | Cron iki kez çalıştı | Rapor idempotent (aynı gün için tek kayıt) |
| Mobil | Uygulama kuyruk doluyken silindi | **Veri kaybı.** Uyarı: "3 kayıt gönderilmedi" çıkışta |
| | Telefon saati yanlış | `client_created_at` ayrı saklanır, sıralama sunucu saatiyle |
| Excel | Türkçe karakter | UTF-8 + fixture testi (G2) |
| | Tarih formatı | `gg.aa.yyyy ss:dd`, hücre tipi tarih |

---

## 6. TEST PLANI

### Yeni akışlar

```
UX AKIŞLARI          Barkod okut → giriş | Barkod okut → çıkış | Ürün ekle |
                     Ürün ara | Stok görüntüle | Hareket geçmişi | Excel indir |
                     Sayım yap | Toplu ürün yükle | Kullanıcı yönet

VERİ AKIŞLARI        Hareket yazma | Projeksiyon güncelleme | Offline senkron |
                     Excel üretimi | Kritik stok taraması

ARKA PLAN İŞLERİ     Gün sonu raporu | Kritik stok bildirimi | Outbox senkron

DIŞ ENTEGRASYONLAR   Push bildirim servisi | E-posta servisi | Etiket yazıcı

HATA YOLLARI         Bölüm 3'teki 14 istisna sınıfının tamamı
```

### En kritik test (bu geçmiyorsa sistem yalan söylüyor)

```
INVARIANT: her ürün için
  SUM(stock_movements.delta WHERE product_id = X) == current_stock.qty WHERE product_id = X

Test: 1000 rastgele hareket (giriş, çıkış, düzeltme, eşzamanlı) üret,
      sonra invariant'ı doğrula. Her CI koşusunda çalışır.
```

### Cuma gecesi 02:00 testi (bunlar geçerse rahat uyursun)

1. **Eşzamanlılık:** 20 paralel istek aynı ürüne çıkış yazıyor, elde 10 var. Sonuç: tam 10 başarılı, 10 reddedilmiş, stok tam 0. Negatif yok, kayıp yok.
2. **Offline dayanıklılık:** Uçak modunda 50 okutma, sonra ağ aç. Sonuç: 50 hareket, çift yok, sıra doğru.
3. **Idempotency:** Aynı isteği 10 kez gönder. Sonuç: 1 hareket.
4. **Düşman QA testi:** Miktar alanına `1e999`, `-0`, `0.0001`, `999999999999`, boşluk, emoji. Hepsi 400.
5. **Kaos:** Senkron ortasında DB'yi kapat. Sonuç: kuyruk korunur, ağ dönünce tamamlanır, hiçbir kayıt kaybolmaz.

### Test piramidi

```
  E2E (Playwright)        ~8 senaryo   ← barkod okut→stok, sayım, Excel
  Entegrasyon (API+DB)   ~40 test     ← createMovement'ın her hata yolu
  Birim                  ~120 test    ← zod şemaları, hesaplamalar, projeksiyon
```

### Kırılganlık riski

- Saat bağımlı testler (gün sonu raporu) → saat enjekte edilebilir olmalı, `new Date()` doğrudan çağrılmaz
- Push bildirim ve e-posta → testte sahte servis
- Barkod kamerası → E2E'de simüle edilmiş barkod girişi

---

## 7. PERFORMANS

| Konu | Risk | Plan |
|---|---|---|
| N+1 sorgu | Hareket listesi + ürün adı + kullanıcı adı | Tek join, Drizzle `with` |
| Index | `stock_movements` tarih sorgusu | `(tenant_id, created_at DESC)` ve `(tenant_id, product_id, created_at DESC)` |
| Index | Barkod arama | `UNIQUE (tenant_id, barcode)` zaten kapsıyor |
| Index | Ürün adı arama | **Türkçe normalizasyon** (aşağıda), sonra `pg_trgm` GIN |
| Bellek | Excel büyük rapor | Eşik altı: stream indirme. Eşik üstü: arka plan işi + e-posta (aşağıda) |
| Cache | Kritik stok listesi | Projeksiyondan doğrudan, cache gerekmez |
| Bağlantı havuzu | Serverless + Postgres | **Klasik tuzak.** Supabase pooler / Neon serverless driver şart |
| p99 hedefi | `POST /movements` | < 300 ms (barkod okutma akıcı hissetmeli) |
| p99 hedefi | Stok listesi (1000 ürün) | < 800 ms |

### Türkçe arama normalizasyonu (D-4.1)

`unaccent` + `lower()` Türkçe'de güvenilmez: `ı I i İ` dört ayrı harf ve
`lower()` davranışı veritabanı collation'ına göre değişir. "ısıtıcı" arayan
kullanıcı "Isıtıcı" ürününü bulamayabilir. Collation'a bağlı olduğu için
kurulumda doğrulanmalı, ama collation'dan bağımsız doğru çözüm şu:

```sql
-- Uygulama seviyesinde değil, veritabanında sabitlenmiş normalizasyon
CREATE FUNCTION tr_norm(t text) RETURNS text IMMUTABLE AS $$
  SELECT lower(translate(t, 'İIıŞşĞğÜüÖöÇç', 'iiisSgGuUoOcC'))
$$ LANGUAGE sql;

ALTER TABLE products
  ADD COLUMN name_norm text GENERATED ALWAYS AS (tr_norm(name)) STORED;

CREATE INDEX products_name_norm_trgm ON products USING GIN (name_norm gin_trgm_ops);
```

Arama sorgusu da `tr_norm($query)` ile normalize edilir. Böylece hangi collation
kurulu olursa olsun sonuç aynı ve index kullanılabilir kalır.

### Büyük Excel raporu (D-4.2)

Serverless fonksiyonun toplam çalışma süresi sınırlı (Vercel'de plana göre
10-300 sn). 50 bin satırlık hareket raporu stream edilse bile bu sınırı zorlar
ve kullanıcı yarım inen bir dosya görür, üstelik hata da almaz.

```
  Export isteği
      │
      ├── tahmini satır < 20.000 ──▶ senkron stream indirme (mevcut davranış)
      │
      └── tahmini satır ≥ 20.000 ──▶ arka plan işi kuyruğa
                                     ekranda: "Rapor hazırlanıyor,
                                     bitince e-posta ile gelecek"
                                     ↓
                                     T34'ün gün sonu raporu altyapısı
                                     yeniden kullanılır, yeni servis yok
```

---

## 8. İZLENEBİLİRLİK

### Yapısal log

Her hareket için tek satır JSON: `{tenant_id, user_id, product_id, delta, reason, source: 'web'|'mobile', latency_ms, idempotency_key}`

### Metrikler

| Metrik | Çalışıyor sinyali | Bozuk sinyali |
|---|---|---|
| Günlük hareket sayısı | Normal aralıkta | Ani düşüş |
| Senkron gecikmesi p95 | < 5 sn | > 60 sn |
| Outbox'ta bekleyen kayıt | ~0 | Artan trend |
| Reddedilen hareket oranı | < %1 | > %5 (UX sorunu var) |
| `BARCODE_UNKNOWN` oranı | < %2 | > %10 (ürün tanımları eksik) |

### Alarmlar

1. **"Mesai saatinde 2 saattir hiç hareket yok"** - sistemin sessizce bozulduğunun en iyi tek sinyali
2. Outbox bekleyen > 50 kayıt (herhangi bir cihazda)
3. Invariant ihlali (projeksiyon ≠ ledger toplamı) - **kırmızı alarm**
4. Gün sonu raporu gönderilemedi
5. 5xx oranı > %1

### Admin panelinde "Sistem Sağlığı" kartı

Son senkron zamanı, bekleyen kayıt sayısı, aktif cihazlar, son 24 saat hareket grafiği.
Bu kart, "sistem çalışıyor mu" sorusunu destek çağrısı olmadan cevaplar.

### Hata ayıklanabilirlik testi

3 hafta sonra "15 Ağustos'ta 40 adet kırmızı defter nereye gitti" sorusu gelirse:
ledger + log ile cevap **tek sorguda** çıkar. Bu, ledger mimarisinin en somut getirisi.

---

## 9. DAĞITIM

### Sıra

```
1. DB migration (sadece additive)
2. Web deploy (Vercel)
3. Mobil sürüm (EAS → store, 1-3 gün onay)
```

### Sürüm uyumu (en sık unutulan şey)

Eski mobil sürüm yeni API'ye vurmaya devam eder. Plan:
- `/api/v1` versiyonlaması
- Her istekte `X-Client-Version` header
- Sunucu minimum sürümü bilir; altındaysa `426 ClientTooOld` → zorunlu güncelleme ekranı
- Kırıcı değişiklik yapmadan önce en az 2 sürüm geçiş dönemi

### Deploy anı riski

Eski ve yeni kod aynı anda çalışır. Kural: migration'lar geriye uyumlu. Kolon silme, tip
değiştirme, NOT NULL ekleme ayrı sürümde ve iki aşamada.

### Deploy sonrası kontrol (ilk 5 dakika)

1. `/api/v1/health` 200 mü
2. Bir test hareketi yaz, ledger'da gör, projeksiyonu doğrula
3. Excel export indir, aç, Türkçe karakterlere bak
4. Mobil uygulamadan bir okutma yap
5. Hata oranı grafiği düz mü

---

## 10. UZUN VADE

| Konu | Değerlendirme |
|---|---|
| Geri döndürülebilirlik | **4/5.** Ledger mimarisi ve tenant_id doğru kurulursa çoğu şey değiştirilebilir |
| Tek yönlü kapı | Maliyet yöntemi (FIFO vs ağırlıklı ortalama). Geçmiş raporları etkiler |
| Teknik borç | RLS kullanılmazsa: tenant sızıntı borcu (yüksek faizli) |
| | Mobil offline yazılmazsa: sonradan eklemek mobili baştan yazmak demek |
| Yol bağımlılığı | Ledger doğru kurulursa maliyet, çok depo, e-fatura hepsi ek özellik. Yanlış kurulursa hepsi yeniden yazım |
| Bilgi yoğunlaşması | `docs/ADR/` altında 5 karar kaydı yaz: ledger, tenant, offline, maliyet, versiyonlama |

### Faz 2 / Faz 3

```
FAZ 2 (v1'den 2-3 ay sonra)
  Maliyet takibi (ağırlıklı ortalama) → kâr raporu
  Sayım akışı tam (mobil sayım modu)
  Çok depo / çok konum
  Tedarikçi ve sipariş takibi

FAZ 3
  e-Fatura / e-Arşiv entegrasyonu
  Logo / Mikro / Paraşüt köprüsü
  Müşteri ve satış modülü
  SaaS: kiracı kaydı, abonelik, faturalama
```

**Platform potansiyeli:** Ledger + tenant + REST API, üzerine kurulacak her şeyin temeli.
Bu üçü doğruysa Faz 2 ve 3 özellik ekleme işidir, mimari işi değil.

---

## 11. TASARIM VE KULLANICI DENEYİMİ

### Admin ekranı bilgi hiyerarşisi

Brief'te sıra "Güncel Stok" sonra "Log Kayıtları" şeklinde. Patronun ekrana bakınca sorduğu
ilk soru bu değil. İlk soru: **"bir sorun var mı?"**

```
┌────────────────────────────────────────────────────────────┐
│  [!] 4 ürün kritik seviyede        [!] 2 kayıt senkronlanmadı │  ← ÖNCE
├────────────────────────────────────────────────────────────┤
│  Bugün:  ↑ 12 giriş (340 adet)    ↓ 28 çıkış (95 adet)      │  ← SONRA
├────────────────────────────────────────────────────────────┤
│  Son Hareketler                              [Excel indir]  │
│  14:30  Ahmet    ↑ +50   Kırmızı Defter                    │
│  14:12  Mehmet   ↓  -2   Mavi Kalem                        │
├────────────────────────────────────────────────────────────┤
│  Stok Tablosu     [ara...]  [kategori v]     [Excel indir]  │  ← EN SON
└────────────────────────────────────────────────────────────┘
```

### Mobil çalışan ekranı: 3 dokunuş kuralı

```
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│                 │   │ Kırmızı Defter  │   │  ✓ KAYDEDİLDİ   │
│   [ KAMERA ]    │──▶│ Mevcut: 35      │──▶│                 │
│   barkod ara    │   │                 │   │  35  →  55      │
│                 │   │ Miktar: [ 20 ]  │   │                 │
│  ● 3 bekliyor   │   │ [GİRİŞ] [ÇIKIŞ] │   │  bip + titreşim │
└─────────────────┘   └─────────────────┘   └─────────────────┘
     okut               miktar + yön            onay (otomatik kapanır)
```

Tasarım kuralları:
- **Kamera hep açık.** "Tara" butonuna basmak bir dokunuş fazla.
- **Büyük dokunma hedefleri.** Depoda eldiven var, soğuk var, acele var. Minimum 56 px.
- **Sesli ve titreşimli geri bildirim.** Başarılı = tek bip + yeşil, hata = çift bip + kırmızı. Çalışan ekrana bakmaz, dinler.
- **Senkron rozeti her ekranda görünür.** Sessiz kayıp olmaz.
- **Yüksek kontrast.** Depoda ışık kötü, ekran parlar.

### Boş durumlar (özellik, sonradan akla gelen şey değil)

| Ekran | Boş durum |
|---|---|
| Stok tablosu, hiç ürün yok | "Henüz ürün yok" + **[Excel'den toplu yükle]** + [Tek ürün ekle] |
| Arama sonuç yok | "'defter' bulunamadı" + [Yeni ürün olarak ekle] (admin) |
| Hareket geçmişi boş | "Bu ürüne ait hareket yok" |
| Kritik stok listesi boş | "Her şey yolunda" (olumlu, boş değil) |

**Toplu yükleme kritik:** İlk gün 800 ürünü tek tek eklemeyecek. Bu olmadan ürün kurulamaz.

### AI slop riski

Genel dashboard şablonu, anlamsız pasta grafikleri, gradient kartlar bu üründe zarar verir.
Depo yazılımı **okunaklı tablo** ve **büyük net sayı** ister. Süsleme, güveni azaltır.

### Erişilebilirlik

- Klavye ile tam gezinme (admin barkod okuyucuyu klavye olarak kullanır, fare yok)
- Barkod okuyucu = klavye emülasyonu. Arama kutusu sayfa açılınca **otomatik odaklanmalı**.
- Renk tek başına anlam taşımasın (kritik stok = kırmızı + ikon + metin)

---

## KAPSAM KARARLARI

### v1'e EKLENDİ (SELECTIVE EXPANSION, hepsi küçük efor, yüksek etki)

| # | Özellik | Efor | Neden |
|---|---|---|---|
| E1 | Excel/CSV toplu ürün içe aktarma | S (human ~1g / CC ~1s) | Bu olmadan sistem ilk gün kurulamaz. Aslında zorunlu |
| E3 | Offline senkron sağlık rozeti | S (human ~0.5g / CC ~30dk) | Sessiz veri kaybını görünür kılar. Güvenin temeli |
| E4 | Sesli + titreşimli okutma geri bildirimi | S (human ~2sa / CC ~15dk) | Çalışan ekrana bakmadan çalışır. Hız 2 katına çıkar |
| E6 | Gün sonu otomatik rapor (cron + e-posta) | S (human ~1g / CC ~1sa) | Brief'te açıkça istenmiş |
| E7 | Kritik stok push bildirimi | S (human ~0.5g / CC ~45dk) | Uyarı ekranda beklerse kimse görmez |
| E10 | PIN ile hızlı kullanıcı geçişi | S (human ~0.5g / CC ~30dk) | Paylaşılan telefonda "kim yaptı" bunsuz yalan söyler |

### TODOS.md'ye ERTELENDİ

| # | Özellik | Efor | Öncelik |
|---|---|---|---|
| E2 | Sayım (stocktake) akışı, mobil sayım modu | M | P1 |
| E5 | Barkod üretme + etiket yazdırma | M | P2 |
| E8 | Maliyet takibi (ağırlıklı ortalama) + kâr raporu | M | P2 |
| E9 | Raf/konum yönetimi UI (sütun v1'de geliyor) | S | P3 |

### KAPSAM DIŞI (bilinçli olarak yapılmıyor)

| Konu | Neden |
|---|---|
| SaaS kiracı yönetimi, abonelik, faturalama | İlk müşteri gelmeden yazmak erken optimizasyon. Şema hazır |
| Mikroservis / ayrık API | Monolit aynı işi yapıyor, deploy karmaşıklığı 3 katı |
| FIFO maliyet | Ağırlıklı ortalama v2'de yeter, FIFO v3 |
| e-Fatura / Logo / Mikro | Faz 3. Ledger doğruysa ek özellik |
| Sipariş / tedarikçi yönetimi | Faz 2 |
| Mock API katmanı | Gerçek Postgres + seed script kullanılacak, mock iki kere iş |
| Barkod donanım terminali desteği | Telefonun kendisi terminal. Ürünün ana argümanı bu |
| Çoklu dil (i18n) | Türkçe tek dil, ama metinler sabit dosyada tutulur |

---

## MEVCUT DURUM

Son güncelleme: 2026-08-22. **Faz 0-3 tamamlandı** (T1-T15, T17), Faz 8'den
T44/T46/T47/T50 ve güvenlik görevi T51 de bitti.

**Dört kritik açıktan üçü kapandı:** G1 (Excel boyutu), G2 (Türkçe karakter),
G4 (cron mail hatası). G3 (yazıcı) TODOS E5'i bekliyor — basılacak bir şey
olmadan timeout sarmalayıcısı yazmak test edilemez kod üretirdi.

```
packages/shared   sebep kodları, roller, birimler, zod şemaları, hata sözleşmesi
packages/db       Drizzle şeması, migration'lar, RLS, withTenant(), seed, test altyapısı
packages/core     createMovement() TEK YAZMA KAPISI, auth + rol matrisi,
                  iş kuyruğu, Excel export, NUMERIC aritmetiği
apps/web          henüz yok (Faz 4)
apps/mobile       henüz yok (Faz 5)
```

`packages/core` mimari diyagramda ayrı bir kutu olarak görünmüyor çünkü plan yazılırken
servis katmanı `apps/web` içinde düşünülmüştü. Ayrı pakete alındı: tek yazma kapısının
Next.js olmadan test edilebilmesi gerekiyor ve cron işleri de aynı kapıyı çağıracak.

**Test durumu:** 546 test yeşil (shared 56, db 53, core 385, web 52). Entegrasyon testleri gerçek
PostgreSQL'e koşuyor; her paket kendi test veritabanını sıfırdan kuruyor.

**CI:** `.github/workflows/ci.yml` — her push ve PR'da typecheck, migration
drift kontrolü ve tüm test paketi, `postgres:17` servis konteyneriyle koşuyor.
T42 (deploy pipeline) hâlâ açık; bu sadece doğrulama tarafı.
CI incelemesi (2026-08-30) iki P1 boşluk buldu: kurulumdan girişe giden yol
hiç yürünmüyor (T93) ve `apps/web` sıfır testle sessizce atlanıyor (T94).
Tamamı Faz 11 altında, T93-T102.

**Açık uçlar KAPANDI (T34).** `POST /api/cron` her turda kuyruğu işliyor ve
`auth_prune_attempts()`'i çağırıyor. Kalan koşul kod değil kurulum: zamanlayıcı
o ucu vurmuyorsa hiçbiri çalışmaz. `CRON_SECRET` tanımsızsa uygulama açılırken
uyarıyor (`next.config.ts`) — sessiz kalsaydı, raporun hiç çıkmadığı ilk gün
değil aylar sonra fark edilirdi.

Yeniden kullanılabilecek **sistem** var (ERPNext, InvenTree) ve D1'de bilinçli olarak
sıfırdan yazma seçildi. Gerekçe: gerçek fark Türkçe 5 dakikada öğrenilen arayüz ve
telefonun el terminaline dönüşmesi. Bu ikisi hazır sistemlerde yok, geri kalan her şey var.

---

## HAYAL DURUMU FARKI

Bu plan seni 12 aylık hedefin yaklaşık **%60**'ına götürüyor. Kalan %40 (maliyet muhasebesi,
çok depo, entegrasyonlar) şemayı bugün doğru kurarsan ek özellik; yanlış kurarsan yeniden yazım.
Kritik olan üç şey: append-only ledger, `tenant_id`, offline outbox. Bunlar doğruysa gerisi
zamanla gelir.

---

## HATA MODU KAYDI

| Kodyolu | Hata modu | Yakalanır? | Test? | Kullanıcı görür? | Loglanır? |
|---|---|---|---|---|---|
| createMovement | Barkod yok | E | E | E | E |
| createMovement | Yetersiz stok | E | E | E | E |
| createMovement | Çift gönderim | E | E | Hayır (doğru) | E |
| createMovement | Deadlock | E | E | E (tekrar) | E |
| syncOutbox | Ağ yok | E | E | E (rozet) | E |
| syncOutbox | Token süresi doldu | E | E | E | E |
| syncOutbox | Uygulama eski | E | E | E | E |
| exportExcel | Çok büyük | E | E | E (kuyruk + e-posta) | E | ← G1 KAPANDI (T14) |
| exportExcel | Türkçe karakter | E | E | E (bozulmuyor) | E | ← G2 KAPANDI (T15) |
| printBarcode | Yazıcı yok | **H** | H | **Takılı buton** | H | ← **KRİTİK AÇIK G3** |
| dailyReportCron | Mail hatası | E | E | E (admin paneli) | E | ← G4 KAPANDI (T17) |

**4 kritik açıktan 3'ü kapandı** (T14, T15, T17). G3 (yazıcı) TODOS E5'i bekliyor.

---

## UYGULAMA GÖREVLERİ

Bu incelemenin bulgularından türetildi. Efor: insan ekibi / Claude Code.

### Faz 0: Temel (1. gün)

- [x] **T1 (P1, human: ~1sa / CC: ~10dk)** - altyapı - Git init, pnpm monorepo iskeleti (`apps/web`, `apps/mobile`, `packages/shared`)
- [x] **T2 (P1, human: ~2sa / CC: ~20dk)** - altyapı - Postgres kurulumu (Supabase projesi) + Drizzle bağlantısı + `.env` yönetimi

### Faz 1: Veri modeli (planın kalbi)

- [x] **T3 (P1, human: ~4sa / CC: ~30dk)** - db - Şema migration'ı: tenants, users, products, product_barcodes, locations, stock_movements, stock_count_*
  - Kaynak: Bölüm 1. Miktar `NUMERIC(14,3)`, para `NUMERIC(12,2)`, zaman `timestamptz`
  - Doğrula: `drizzle-kit push` + şema testi
- [x] **T4 (P1, human: ~3sa / CC: ~25dk)** - db - `current_stock` projeksiyonu + trigger ile bakım
- [x] **T5 (P1, human: ~2sa / CC: ~15dk)** - db - Ledger değiştirilemezliği: `REVOKE UPDATE, DELETE` + trigger
  - Kaynak: Tehdit S3. Bu olmadan "kim ne yaptı" ekranı hiçbir şey ispat etmez
- [x] **T6 (P1, human: ~4sa / CC: ~30dk)** - güvenlik - RLS zorlaması: `app_user` rolü (BYPASSRLS yok), `FORCE ROW LEVEL SECURITY`, tenant politikaları, `withTenant()` yardımcısı
  - Kaynak: D5, Tehdit S1, S2, S12. RLS yazmak tek başına yetmez; bağlanılan rol politikaları atlayabilir
  - Doğrula: T46 çapraz tenant testi
- [x] **T7 (P1, human: ~3sa / CC: ~20dk)** - db - Index'ler + **Türkçe normalizasyon**: `tr_norm()` fonksiyonu, `products.name_norm` generated column, GIN trgm index
  - Kaynak: D-4.1. `unaccent` + `lower()` Türkçe'de collation'a bağlı, güvenilmez
- [x] **T8 (P1, human: ~2sa / CC: ~20dk)** - db - Seed script: 200 ürün, 3 kullanıcı, 5000 gerçekçi hareket

### Faz 2: Çekirdek servis

- [x] **T9 (P1, human: ~7sa / CC: ~50dk)** - api - `createMovement()` tek yazma kapısı: validation, idempotency, **`SELECT ... FOR UPDATE` ile atomik stok kontrolü**, ledger insert, projeksiyon, **`qty_multiplier` uygulaması**
  - Kaynak: Bölüm 2 "tek yazma kapısı" + D-1.2 (TOCTOU yarışı) + D7 (koli çarpanı)
  - Doğrula: 40 entegrasyon testi, Bölüm 3'teki her hata yolu, T12 eşzamanlılık
- [x] **T10 (P1, human: ~2sa / CC: ~15dk)** - api - Adlandırılmış istisna sınıfları + hata cevap sözleşmesi (`{code, message, details}`)
  - Kaynak: Bölüm 3. Genel `catch` yasak
- [x] **T11 (P1, human: ~3sa / CC: ~20dk)** - test - **Invariant testi**: `SUM(movements.delta) == current_stock.qty`, 1000 rastgele hareket
  - Kaynak: Bölüm 6. Bu geçmiyorsa sistem yalan söylüyor
- [x] **T12 (P1, human: ~3sa / CC: ~25dk)** - test - Eşzamanlılık testi: 20 paralel çıkış, elde 10. Negatif yok, kayıp yok
- [x] **T13 (P1, human: ~4sa / CC: ~30dk)** - api - Auth + rol kontrolü (sunucu tarafı), rol matrisi zorlaması
  - Kaynak: Bölüm 4 rol matrisi. Tehdit S6, S7
- [x] **T51 (P1, human: ~3sa / CC: ~25dk)** - güvenlik - Giriş kaba kuvvet koruması: IP ve hesap bazlı deneme sayacı, kademeli gecikme, hesap kilitleme
  - Kaynak: Tehdit S9. Sayaç `auth_attempts` tablosunda, KALICI: bellekte tutulsaydı
    her deploy saldırgana sıfırdan başlama hakkı verirdi.
  - Uygulama rolü tabloya doğrudan erişemiyor; sadece üç SECURITY DEFINER
    fonksiyonu (`auth_record_failure` / `auth_read_attempts` / `auth_clear_attempts`).
    Uygulama kodundaki bir hata korumayı devre dışı bırakamaz.
  - Eşik ve kilit eğrisi TypeScript'te (`packages/core/src/rate-limit.ts`):
    e-posta 5 hata → 60 sn, üstel, 15 dk tavan; adres 50 hata (paylaşılan NAT).
    T32 PIN kilitlemesi (D-2.5) aynı depoyu farklı politikayla kullanacak.
  - Tavan bilinçli: sınırsız artan kilit, saldırganın meşru kullanıcıyı kalıcı
    olarak dışarıda bırakmasına izin verirdi.
  - `auth_prune_attempts()` T34'te gün sonu cron'unun bakım adımına bağlandı:
    her turda 7 günden eski sayaçlar siliniyor (kilit penceresi en fazla
    15 dk, daha eskisi yalnızca yer kaplıyor).

### Faz 3: Kritik açıkların kapatılması

G1, G2 ve G4 kapandı. G3 (yazıcı) TODOS E5'e bağlı, aşağıda gerekçesi yazılı.

- [x] **T14 (P1, human: ~4sa / CC: ~30dk)** - export - Excel: 20k satır altı stream indirme, üstü arka plan işi + e-posta (T34 altyapısı)
  - Kaynak: KRİTİK AÇIK G1 + D-4.2 (serverless zaman aşımı)
- [x] **T15 (P1, human: ~2sa / CC: ~15dk)** - export - Türkçe karakter fixture testi (`Ğ Ü Ş İ Ö Ç ğ ü ş ı ö ç`) + tarih/sayı formatı
  - Kaynak: KRİTİK AÇIK G2. Sessiz bozulma en kötü hata tipi
- [ ] **T16 (P2, human: ~2sa / CC: ~15dk)** - print - Yazıcı timeout + PDF'e düşme
  - Kaynak: KRİTİK AÇIK G3
  - **BEKLİYOR — bilinçli.** G3'ün kullanıcıya görünen hali "buton takılı kalır",
    ama o buton henüz yok: etiket üretme ve basma işini TODOS E5 taşıyor ve v1
    kapsamı dışında. Var olmayan bir taşıyıcının etrafına timeout sarmalayıcısı
    yazmak, test edilemeyen ve E5 geldiğinde büyük ihtimalle değişecek bir kod
    üretirdi. **E5 ile BİRLİKTE yapılmalı**, ondan önce değil.
- [x] **T17 (P1, human: ~2sa / CC: ~15dk)** - cron - Rapor gönderim hatası admin paneline düşer + 1 tekrar
  - Kaynak: KRİTİK AÇIK G4

### Faz 4: Web arayüzü

- [x] **T18 (P1, human: ~6sa / CC: ~45dk)** - web - Admin dashboard, Bölüm 11 hiyerarşisiyle (uyarılar → bugün → son hareketler → tablo)
  - Stok tablosu ayrı sayfada (T19): panelde dördüncü blok olarak kritik
    ürün listesi duruyor, tam tablo değil. On bin satırı dashboard'a
    koymak, "bir sorun var mı" sorusunun cevabını ekranın dışına iterdi.
  - "Bugün" özeti çalışan için KENDİ hareketleri; başarısız iş sayacı
    (G4) çalışana hiç gösterilmiyor.
- [x] **T19 (P1, human: ~5sa / CC: ~40dk)** - web - Stok tablosu: arama, filtre, sayfalama, kritik stok vurgusu
  - Arama, filtre ve sayfa adres çubuğunda: yer imine eklenebiliyor,
    paylaşılabiliyor, geri tuşu çalışıyor.
  - Sıralama `name_norm` üzerinden. Veritabanı collation'ı `C.UTF-8` ve
    ham `ORDER BY name` Türkçe baş harfli her ürünü listenin dibine
    indiriyordu.
- [x] **T20 (P1, human: ~4sa / CC: ~30dk)** - web - Hareket logu: kullanıcı/tarih/ürün/sebep filtreleri
  - Kullanıcı filtresi sadece admin'de; çalışanın gönderdiği `?kullanici=`
    sunucuda yok sayılıyor (`movementUserScope`).
  - Sayfalama `limit + 1` ile: defterde her sayfa için ikinci bir
    `count(*)` çalıştırmak sayfanın kendisinden pahalıya gelirdi.
- [x] **T21 (P1, human: ~4sa / CC: ~30dk)** - web - Ürün ekleme/düzenleme/arşivleme + çoklu barkod yönetimi
  - Barkod da arşivleniyor, silinmiyor: `stock_movements.barcode_id` FK ile
    bağlı, gerçek DELETE 23503 ile patlardı (migration 0007).
  - Son aktif barkod kaldırılamıyor — barkodsuz ürün depoda okutulamaz.
  - Arşivlenen barkod artık çözülmüyor; tekillik index'i kısmi olduğu için
    aynı etiket doğru ürüne yeniden bağlanabiliyor.
  - D7 çarpan kuralı iki yönlü oldu: koli > 1, diğer türler tam olarak 1.
- [x] **T22 (P1, human: ~3sa / CC: ~25dk)** - web - Excel export butonları (stok + hareket)
  - Karar sayfa çizilirken veriliyor (`planExport`, sadece sayar): düğmede
    kaç satır ineceği yazıyor ve üç yol üç farklı şey gösteriyor.
  - İndirme adresi salt okunur bir `GET`; kuyruğa alma ayrı bir POST. Tek
    bağlantı olsaydı sayfayı yenilemek her seferinde yeni iş kuyruğa alırdı.
  - `exportStockSchema`'ya `search` eklendi: ekranda 12 satır görüp
    dosyada 4000 satır almak sessiz bir yalandı.
- [x] **T23 (P1, human: ~4sa / CC: ~30dk)** - web - **E1: Excel/CSV toplu ürün içe aktarma** + önizleme + hata raporu
  - Kaynak: Bölüm 11 boş durumlar. Bu olmadan sistem ilk gün kurulamaz
  - Üç adım, ikisi salt okuma: çözümle → önizle → onayla. Onaydan önce
    hiçbir şey yazılmıyor (test bunu doğruluyor).
  - Satır bazlı hata, dosya bazlı red değil: tek bozuk satır 799 doğru
    satırı reddetmiyor. Hatalı satırlar Excel raporu olarak iniyor.
  - Onay adımı istemcinin sınıflandırmasına güvenmiyor; önizleme sunucuda
    yeniden hesaplanıyor.
  - Türkçe sayı ("1.234,56"), noktalı virgüllü CSV, BOM ve Türkçe birim
    etiketleri destekleniyor — hepsi muhasebeden gelen dosyanın gerçeği.
  - Bu ekran JavaScript gerektiriyor (bilinçli istisna, gerekçesi
    actions.ts'te): kurulum günü masa başında yapılan tek seferlik iş.
- [x] **T24 (P2, human: ~3sa / CC: ~20dk)** - web - Kullanıcı yönetimi (ekle, rol ver, pasifleştir)
  - Parolayı yönetici belirliyor, davet e-postası yok: depoda çalışanın iş
    e-postası çoğu zaman yok, davet gidecek adres de yok.
  - İki kilit: yönetici kendi rolünü düşüremez/kendini pasifleştiremez ve
    son aktif yönetici korunur. İkisi de gerekli — biri olmadan tek
    yönetici kendini, diğeri olmadan iki yönetici birbirini düşürür.
  - Pasifleştirme ve rol değişikliği oturumları iptal ediyor. Access token
    imzadan doğrulandığı için etki en fazla 15 dk gecikmeli (bilinçli takas).
- [x] **T25 (P2, human: ~2sa / CC: ~15dk)** - web - "Sistem Sağlığı" kartı (son senkron, bekleyen kayıt, aktif cihaz)
  - Üç sessiz bozulma yolu izleniyor: defter/projeksiyon ayrışması,
    kuyrukta çürüyen iş, hareketsizlik.
  - Panelde DEĞİL kendi sayfasında: invariant taraması bütün hareketleri
    gruplayarak tarıyor, her panel yenilemesinde beklenemez. Panelde kapı var.
  - Her satırda durum + ne yapmalı. "3 bekleyen iş" bir şey söylemez;
    "en eskisi 2 saattir bekliyor, işçi çalışmıyor olabilir" söyler.
- [x] **T52 (P1, human: ~3sa / CC: ~25dk)** - web - **Web'de elle hareket girişi** (barkod + miktar + sebep)
  - **PLAN BOŞLUĞU, sonradan fark edildi.** Hareket girişi sadece mobilde
    (T27) planlanmıştı. Sonuç: web arayüzü tamamlandığında bile `createMovement`
    — ürünün kalbi, tek yazma kapısı — hiçbir ekrandan çağrılamıyor. Kullanıcı
    ürün tanımlayabiliyor, listeye bakabiliyor, Excel alabiliyor ama TEK BİR
    MAL KABULÜ giremiyor.
  - Mobil beklenemez: Faz 5 sekiz görev ve kullanıcı testi ondan önce yapılacak.
  - Mobil gelse de gerekli kalıyor: barkodsuz mal kabulü, iade, sayım
    düzeltmesi — elle giriş depoda kalıcı bir ihtiyaç.
  - **Kullanıcı testine başlamadan ÖNCE yapılmalı**; aksi halde test, kurulum
    ekranlarının testine iner.
  - Kaynak: Bölüm 8

- [x] **T54 (P2, human: ~2sa / CC: ~20dk)** - tasarım - **Tasarım kuralları tuvali** (`design/`)
  - Kullanıcının gönderdiği envanter panosu görselinden YAPI ve YOĞUNLUK
    alındı; grafik mobilyası alınmadı. Bölüm 11 zaten yasaklıyor: "Genel
    dashboard şablonu, anlamsız pasta grafikleri, gradient kartlar bu üründe
    zarar verir."
  - Renk, ölçü ve tipografi değerleri UYDURULMADI: `globals.css`,
    `field.tsx` ve `hareket/page.tsx` dosyalarından alındı. Tuval bir
    öneri değil, mevcut sistemin yazıya dökülmüş hali.
  - Kontrast oranları hesaplandı (oklch → sRGB → WCAG), tahmin edilmedi.
    Hesap üç açık çıkardı → T55.
  - Yedi artboard: Kurallar, Renk, Tipografi, Bileşenler + uygulanmış
    Panel / Stok / Hareket ekranları.

- [x] **T55 (P2, human: ~2sa / CC: ~15dk)** - web - **Ölçülen erişilebilirlik açıklarını kapat**
  - T54'teki kontrast hesabının bulguları. Üçü de WCAG eşiğinin ALTINDA
    ve depoda ışık kötü — bu ürün için "sınırda geçer" yeterli değil.
  - `border-slate-300` → `border-slate-500` girdi kenarlığında.
    1,48:1 → 4,77:1. WCAG 1.4.11 arayüz sınırları için 3:1 istiyor;
    slate-300 kutunun nerede bittiğini kötü ışıkta göstermiyor.
  - `outline-none focus:border-slate-900` → 2 px odak halkası.
    Bugünkü işaret 1 px'lik bir ton değişimi. Admin barkod okuyucuyu
    klavye olarak kullanıyor, faresi yok: odak görünmezse hangi alana
    yazdığını bilmiyor.
  - İpucu metni `text-slate-500` → `text-slate-600`. 4,77:1 → 7,56:1;
    12 px'te sınırda bir orandan kaçınılır.
  - Doğrula: `field.tsx` içindeki `INPUT` sabiti tek yerden değişiyor;
    elle yazılmış kopyalar (`stok/page.tsx`, `hareket/page.tsx`) da
    aynı değere çekilmeli, yoksa ekranlar ayrışır.

  - **KAPANIŞ (T104 turu).** Üç maddenin ikisi T68'de kapanmıştı: kenarlık
    `--line-control` (#848aa8, 3,40:1) ve odak halkası (3 px, 7,25:1,
    `outline-none` kaldırıldı).
  - **Üçüncüsü kapanmamış, KÖTÜLEŞMİŞTİ.** 12 px ipucu `text-slate-500`
    (4,77:1) iken `text-ink-3`e (4,64:1) taşınmıştı. Dosyanın kendi yorumu
    "12 px'te sınırda geçiyordu" diye kabul ediyor ama yeni değer daha
    düşük. T55'in bulgusu zaten oranın sınırda olmasıydı; token değişimi
    onu çözmedi, bir tık aşağı çekti.
  - Ölçüldü (hex → sRGB → WCAG): `ink-3` aydınlık 4,64:1 / koyu 5,56:1;
    `ink-2` aydınlık 6,76:1 / koyu 7,54:1.
  - 12 px içerik taşıyan yedi yer `text-ink-2`ye alındı: iki form ipucu,
    ayarlar ipucu, "(siz)" işareti, barkod arşiv tarihi, arşiv eylem
    açıklaması, hareket listesinde stok kodu. Hepsi kullanıcının OKUMASI
    gereken metin.
  - `ink-3` kaldırılmadı: 14 px ve üstü ikincil metin ile yer tutucularda
    (44 kullanım) meşru. Kural token'ın yanına yazıldı.
- [x] **T56 (P3, human: ~4sa / CC: ~30dk)** - web - **Sol kenar çubuğu + yapışkan arama şeridi**
  - T54'ün referans görselden aldığı TEK yapısal değişiklik. Bugün üst
    şerit + `max-w-6xl` (1152 px) var.
  - Kazanç: menü hedefleri 56 px satıra çıkıyor (bugün `py-2`, yani
    ~36 px — kural 02 ihlali), arama kutusu her sayfada ve odaklı
    oluyor (kural 05), tablo tam genişliğe yayılıyor.
  - Bedel: 240 px yatay alan. 1100 px altında 72 px'lik ikon rayına
    inecek, yoksa dar ekranda tablo sıkışır.
  - P3: kural ihlalini kapatıyor ama mevcut ekranlar çalışıyor. T53 ve
    T34'ten sonra.

  - **KAPANIŞ (T104 turu).** Yapısal kısım T66-T68'de teslim edilmiş:
    `shell.tsx` içinde 244 px kalıcı `<aside>` (≥1024 px, `lg:sticky`),
    altında 64 px alt gezinme çubuğu (<1024 px), ve yapışkan üst şeritte
    her sayfada arama kutusu. Önerdiğim 72 px ikon rayı yerine alt çubuk
    seçilmiş — dokunmatik için daha iyi.
  - **56 px hedefi tutmadı ve bu bilinçli.** Menü satırları `h-12` (48 px),
    form kontrolleri `h-13` (52 px). `field.tsx` gerekçeyi yazıyor:
    referans görselin oranları için düşürülmüş, WCAG 2.5.5'in 44 px
    eşiğinin üstünde kalınmış.
  - **Ama kural metni güncellenmemiş.** PLAN Bölüm 11 ve CLAUDE.md hâlâ
    "minimum 56 px" diyor. Kod ile kural ayrıştı → T106.
- [x] **T57 (P1, human: ~2sa / CC: ~20dk)** - altyapı - **Demo yolu her platformda çalışsın**
  - **KULLANICI TESTİNDE ORTAYA ÇIKTI.** Windows'ta demo hiç başlamadı;
    kullanıcı ilk komutta duvara tosladı. İki ayrı hata vardı ve ikisi de
    "bende çalışıyor" sınıfındandı.
  - **(1) `scripts/demo.sh` bash'e bağlıydı.** CMD `./scripts/demo.sh`
    satırını tanımıyor, Git Bash her kurulumda PATH'te değil, WSL'de
    dağıtım kurulu olmayabiliyor. README ise onu "tek komut" diye
    gösteriyordu. `scripts/demo.mjs` ile değiştirildi: Node zaten zorunlu
    bir bağımlılık. `.sh` SİLİNDİ — iki koşucu iki kaynak demek olurdu.
    - `pg_isready` yerine TCP yoklaması: o komut Postgres istemci
      paketiyle geliyor ve Docker kullanan Windows makinesinde yok.
      Eski sürüm buna güvendiği için "çalışan Postgres yok" deyip
      gereksiz yere Docker yoluna sapıyordu.
    - Seed koruması ayrı bir dosyaya taşındı (`product-count.ts`):
      `tsx -e "..."` ile çok satırlı kod göndermek, tırnak kaçışları
      platforma göre değiştiği için Windows'ta sessizce bozuluyor.
  - **(2) `pnpm --filter X <script>` Windows'ta çalışmıyor.** pnpm ilk
    kelimeyi script değil çalıştırılabilir sayıyor:
    `'migrate' is not recognized`. `run` eklendi — README, kök
    package.json ve CI dahil on iki çağrı.
  - Kaynak: kullanıcı testi, 24.08.2026

- [x] **T58 (P1, human: ~1sa / CC: ~10dk)** - web - **`apps/web` kök `.env`'i kendisi yüklesin**
  - **T57'nin altından çıktı ve daha ciddiydi.** Next.js `.env` dosyalarını
    yalnızca kendi dizininde arıyor (`apps/web/.env`); bu depoda tek `.env`
    kökte. Uygulama derleniyor, açılıyor ve İLK GİRİŞ DENEMESİNDE
    "DATABASE_URL tanımlı değil" ile düşüyordu.
  - **Neden bugüne kadar görünmedi:** `demo.sh` `.env`'i kendi kabuğuna
    export ediyordu ve sunucu onu miras alıyordu. Yani `pnpm demo`
    çalışıyor, README'nin belgelediği `pnpm dev` çalışmıyordu. Script
    uygulamanın hatasını gizliyordu.
  - Çözüm `next.config.ts` içinde: yol dosyanın kendi konumundan türüyor,
    çalışma dizininden değil. `dotenv` mevcut değişkenlerin üstüne
    yazmıyor — gerçek ortam değişkeni her zaman kazanıyor.
  - **Ders:** kurulum scripti ortamı hazırlıyorsa, uygulamanın o ortam
    olmadan çalışmadığını kimse fark etmiyor. Ortamı hazırlamak
    uygulamanın işi.

- [x] **T59 (P1, human: ~2sa / CC: ~20dk)** - altyapı - **Veritabanı hazır olmadan migration koşmasın**
  - **KULLANICI TESTİ, İKİNCİ TUR.** `pnpm db:reset` konteyneri başlattı,
    hemen ardından koşan `migrate` hiçbir şey uygulamadı. drizzle-kit
    hatayı spinner'ın arkasında yuttuğu için geriye sadece `Exit status 1`
    kaldı ve kullanıcı yirmi dakika türev hatalarla uğraştı:
    `relation "current_stock" does not exist`, sonra
    `function auth_read_attempts(...) does not exist`. Hepsi tek bir
    sessiz başarısızlığın sonucuydu.
  - **Kök sebep: AÇIK PORT HAZIR DEMEK DEĞİL.** Docker portu konteyner
    başlar başlamaz yayınlıyor; `docker-proxy` dinliyor ama arkadaki
    Postgres hâlâ `initdb` ve `db/init/*.sql` ile uğraşıyor. TCP bağlantısı
    KURULUYOR, sorgu reddediliyor.
  - `scripts/wait-for-db.mjs`: Docker varsa konteynerin İÇİNDEN
    `pg_isready` (tek güvenilir cevap), yerel kurulumda TCP yeter — yerel
    Postgres portu ancak hazır olunca açıyor.
  - `db:up` ve `db:reset` artık bekliyor. `demo.mjs` de aynı modülü
    kullanıyor; eskiden "port açık" görünce beklemeden geçiyordu, yani
    aynı tuzak orada da vardı.

- [x] **T60 (P1, human: ~1sa / CC: ~15dk)** - web - **Eksik yapılandırmada sunucu açılmasın**
  - Kullanıcı testinde AYNI HATA İKİ KEZ yaşandı: önce `DATABASE_URL`,
    sonra `AUTH_SECRET`. İkisinde de uygulama derlendi, açıldı ve ilk
    giriş denemesinde düştü; ekranda "SERVER_ERROR" yazıyordu. Kurulum
    hatası, çalışma hatası kılığında görünüyordu.
  - `next.config.ts` içinde `assertServerConfig()`: eksikleri TEK SEFERDE
    listeliyor ve ne yapılacağını söylüyor. Tek tek söylemek, kullanıcıyı
    birini düzeltip diğerini keşfetme turuna sokardı.
  - **Konsola, giriş ekranına değil.** Kimliği doğrulanmamış bir sayfaya
    sunucunun neyi eksik olduğunu yazmak gereksiz bilgi verir; operatörün
    ihtiyacı olan yer zaten konsol.
  - **Derlemede koşmuyor** (`PHASE_PRODUCTION_BUILD` atlanıyor): `next
    build` hiçbir yere bağlanmıyor ve gizli anahtarları olmayan bir imaj
    kurma adımında da çalışabilmeli.
  - `APP_URL` eksikse uyarı: çerez `secure` bayrağı oradan türüyor ve yoksa
    açık kalıyor (fail closed). LAN'da düz HTTP kurulumda tarayıcı çerezi
    saklamıyor, giriş ekranı hiçbir hata göstermeden kendini tekrar ediyor
    — teşhis edilmesi en zor arıza türü.

- [x] **T61 (P1, human: ~1sa / CC: ~10dk)** - web - **Sunucu kusuru olan hatalar loga yazılsın**
  - **KULLANICI TESTİ, ÜÇÜNCÜ TUR.** Giriş `SERVER_ERROR` veriyordu ve
    sunucu günlüğünde HİÇBİR İZ yoktu: terminalde sadece `POST /giris 303`
    görünüyordu. `AppError` yakalanıp yönlendirmeye çevriliyor, mesajı
    yolda kayboluyordu.
  - Oysa `AppError`'ın mesajı teşhisi zaten yazıyordu:
    "AUTH_SECRET tanımlı değil veya 32 karakterden kısa (üret: openssl
    rand -base64 32)". Bu satır kimseye ulaşmadığı için teşhis, hatayı
    fırlatan satırın kaynak kodda elle bulunmasını gerektirdi.
  - `logServerFault()` — `errorQuery()` ve giriş ekranının catch bloğunda.
  - **Yalnızca 5xx.** "Parola hatalı" veya "elde yeterli stok yok"
    kullanıcının yaptığı bir şey, sunucunun kusuru değil; onları da loga
    yazmak günlüğü gürültüye boğar ve gerçek arızayı görünmez kılar.
  - **Ekrana değil konsola.** Kullanıcı genel metni görmeye devam ediyor;
    ayrıntı operatörün terminaline gidiyor. Kimliği doğrulanmamış bir
    sayfaya sunucunun iç durumunu yazmak gereksiz bilgi verir.
  - Doğrulandı: T60 guard'ı geçici olarak kapatılıp kısa bir `AUTH_SECRET`
    ile giriş denendi; ekran yine genel metni gösterdi, terminal sebebi
    yazdı. Guard geri alındı.

- [x] **T62 (P2, human: ~1sa / CC: ~15dk)** - altyapı - **Depo skill'leri (`.claude/skills/`)**
  - Kullanıcı "gstack skill'lerini entegre et" dedi. gstack bu ortamda
    YOK: ne makinede, ne depoda, ne eklenti kataloğunda. PLAN.md'deki
    GSTACK REVIEW REPORT tablosu o incelemelerin SONUÇLARINI kaydediyor,
    komutların kendisini değil.
  - Onun yerine bu projede tekrar tekrar elle uygulanan üç disiplin
    yazıya döküldü. Bunlar bugüne kadar yalnız oturum bağlamında
    yaşıyordu; bağlam bitince kayboluyorlardı.
  - `dogrula` — korumayı geçici kaldır, testin kırmızı yandığını gör,
    geri koy ve yerinde olduğunu doğrula. Bu projede ~15 kez uygulandı.
  - `demo-testi` — tarayıcıda sürme (dört kullanıcıya görünen hata
    yalnız böyle bulundu) ve demo kurulum yolunun platform tuzakları.
  - `gorev-kaydet` — bulguyu sohbette bırakma, PLAN.md'ye numaralı görev
    olarak yaz. T52, T53, T55, T57-T61 böyle doğdu.
  - Gerçek gstack bulunursa bunların yerini alabilir; çakışmıyorlar.

- [x] **T63 (P1, human: ~1sa / CC: ~15dk)** - db - **master'daki kırık smoke testi**
  - master'a inen `fc3d00f` iki dosya ekledi ve ikisi de sorunluydu.
  - `packages/db/src/smoke.test.ts` silinmiş `./test-support.js`
    modülünü import ediyordu (134cb32'de kaldırılmıştı). master'ın test
    paketi bu haliyle o dosyayı yükleyemeden düşüyordu. Git bunu
    ÇAKIŞMA OLARAK GÖSTERMİYOR — farklı dosyalar; sessiz anlamsal
    çakışma.
  - Dosyanın fikri doğruydu (iskele bozulduğunda diğer testlerin kafa
    karıştırıcı hataları arasında aramamak), dayandığı temel yoktu.
    Dört testinden ikisi kaldırılan iskelenin kendi temizlik
    mekanizmasını sınıyordu; kalan ikisinin karşılığı zaten
    rls.test.ts'te vardı. Bu yüzden port değil, mevcut iskeleye göre
    yeniden yazıldı.
  - `tatus -sb` — yanlış yazılmış bir `git status -sb` komutunun çıktısı
    yanlışlıkla commit edilmiş. Silindi.
  - Doğrulandı: yeni smoke testi 4/4 geçiyor; uygulama bağlantısı admin
    bağlantısıyla değiştirilince RLS testi kırmızı yanıyor, yani gerçekten
    ikisinin farkını sınıyor.

- [x] **T64 (P2, human: ~1sa / CC: ~15dk)** - altyapı - **Docker zorunlu olmaktan çıksın**
  - `db/init/*.sql` (pg_trgm eklentisi + `stok_app` rolü) yalnızca İKİ
    yerde uygulanıyordu: Docker konteyneri ilk kez oluşturulurken
    (`docker-entrypoint-initdb.d`) ve test veritabanı kurulurken
    (`testing.ts`).
  - Sonuç: kendi makinesine PostgreSQL kurmuş biri `pnpm demo`
    çalıştırdığında demo koşucusu açık portu bulup Docker'ı atlıyor, sonra
    migration "stok_app rolü yok" diyerek düşüyordu. Yani projenin Docker'a
    ihtiyacı yokken Docker fiilen ZORUNLUydu.
  - `packages/db/src/init-db.ts` — aynı SQL dosyalarını MEVCUT
    veritabanına uyguluyor. `testing.ts` ise onları düşürüp yeniden
    yarattığı veritabanına uyguluyor; ortak olan SQL dosyalarının kendisi,
    yani kurulum kodunun tek kopyası orada.
  - Her açılışta koşuyor. Üç ifade de idempotent
    (`CREATE EXTENSION IF NOT EXISTS`, rol bloğu `IF NOT EXISTS` korumalı,
    `GRANT` tekrarlanabilir), o yüzden "kuruldu mu" bayrağı tutulmuyor —
    tutulan her bayrak gerçekle ayrışabilecek ikinci bir kaynaktır.
  - Sahip bağlantısıyla (`MIGRATION_DATABASE_URL`): rol yaratmak ve
    eklenti kurmak uygulama rolünün yetkisi değil, olmamalı da.
  - Doğrulandı: boş bir veritabanında init öncesi `pg_trgm` yok (0), init
    sonrası var (1) ve `stok_app` CONNECT yetkisi almış. Arka arkaya iki
    kez koşturuldu, ikisi de temiz.

### Faz 4.5: Mobilin ön şartı

- [ ] **T53 (P1, human: ~6sa / CC: ~45dk)** - api - **`/api/v1` REST uçları** (mobil için)
  - **PLAN BOŞLUĞU, sonradan fark edildi.** `/api/v1/*` mimari bölümünde
    (satır 24, 224, 286) ve tehdit modelinde (S2) anlatılıyor ama numaralı
    bir görevi YOK. T26-T33'ün hepsi "mobil" ve API'nin var olduğunu
    varsayıyor.
  - Bugünkü durum: `bearerToken()` yazıldı ve test edildi, ama hiçbir
    yerden çağrılmıyor. Web `httpOnly` çerez kullanıyor; mobilin taşıma
    yolu kodda hazır, ucu yok.
  - **Faz 5'in tamamı buna bağlı.** T26 (auth), T27 (okutma), T28 (outbox)
    hiçbiri API olmadan başlayamaz.
  - Kapsam: login/refresh, ürün arama, barkod çözümleme, `POST /movements`
    (idempotency başlığıyla), stok sorgusu. `route()` sarmalayıcısı ve hata
    → HTTP eşlemesi zaten var (`apps/web/src/server/http.ts`).
  - `X-Client-Version` kontrolü (T33) bu uçlara takılacak.

### Faz 5: Mobil

- [ ] **T26 (P1, human: ~4sa / CC: ~30dk)** - mobil - Expo iskeleti, auth, güvenli token saklama
- [ ] **T27 (P1, human: ~6sa / CC: ~45dk)** - mobil - Barkod okutma ekranı: kamera hep açık, 800ms debounce, büyük hedefler
- [ ] **T28 (P1, human: ~8sa / CC: ~60dk)** - mobil - **Offline outbox**: SQLite kuyruk, durum makinesi, exponential backoff, idempotency
  - Kaynak: Bölüm 2 durum makinesi. Ürünün en kritik teknik parçası
  - **Kritik detay (D-1.3):** `idempotency_key` okutma anında üretilir ve outbox satırıyla birlikte diske yazılır. Gönderim anında üretilirse uygulama yeniden başladıktan sonraki tekrar denemede çift kayıt oluşur
- [ ] **T29 (P1, human: ~2sa / CC: ~15dk)** - mobil - **E3: Senkron sağlık rozeti** her ekranda + detay listesi
- [ ] **T30 (P1, human: ~2sa / CC: ~15dk)** - mobil - **E4: Sesli + titreşimli geri bildirim** (başarı/hata farklı ses)
- [ ] **T31 (P1, human: ~3sa / CC: ~20dk)** - mobil - Ürün arama + stok görüntüleme
- [ ] **T32 (P2, human: ~3sa / CC: ~20dk)** - mobil - **E10: PIN ile hızlı kullanıcı geçişi** + kilitleme (5 yanlış → 60 sn, 10 yanlış → tam giriş)
  - Kaynak: Tehdit S4 ve S11. Paylaşılan telefonda "kim yaptı" bunsuz yalan
- [ ] **T33 (P1, human: ~3sa / CC: ~20dk)** - mobil - Sürüm uyumu: `X-Client-Version` + zorunlu güncelleme ekranı
  - Kaynak: Bölüm 9. Mobil geri alınamaz, bu yüzden zorunlu

### Faz 6: Otomasyon ve izleme

- [x] **T34 (P1, human: ~4sa / CC: ~30dk)** - cron - **E6: Gün sonu raporu** (Excel eki + e-posta), idempotent
  - `packages/core/src/cron.ts` + `apps/web/src/app/api/cron/route.ts`.
    Tur: planla → kuyruğu işle → bakım (sayaç budama + invariant denetimi).
  - **En büyük işlevsel boşluk buydu:** `runQueuedJobs()` T14'te yazılmıştı
    ama ÇAĞIRANI YOKTU — kuyruğa giren rapor sonsuza kadar QUEUED'da
    bekliyordu. Elle istenen büyük Excel export'ları da (T14/G1) bu turda
    işleniyor; ayrı bir işçi yazmak "işçi ölmüş, kimse fark etmemiş" diye
    ikinci bir sessiz arıza sınıfı açardı.
  - İdempotent: `dedupeKey = "DAILY_REPORT:2026-09-03"`. Cron iki kez
    tetiklenirse ikinci çağrı yeni iş ÜRETMİYOR (Bölüm 5).
  - Tenant listesi migration 0010'daki `cron_tenants()` SECURITY DEFINER
    fonksiyonundan. Ortam değişkenine yazılsaydı yeni müşterinin raporu
    SESSİZCE çıkmazdı — G4'ün ta kendisi.
  - Kimlik: `CRON_SECRET` paylaşılan sırrı, sabit zamanlı karşılaştırma.
    **Sır tanımsızsa uç KAPALI** — "tanımsızsa doğrulama yapma", değişkeni
    eklemeyi unutan kurulumu herkese açık bir e-posta ucuna çevirirdi.
  - Alarm eşiği: invariant kırık ya da bir işin deneme hakkı bitti → 500.
    İlk SMTP hatası 200, çünkü işin bir hakkı daha var ve her geçici hatada
    alarm çalmak operatörü alarmı yok saymaya alıştırırdı.
- [x] **T35 (P1, human: ~3sa / CC: ~25dk)** - cron - **E7: Kritik stok taraması + push bildirim**
  - Tarama ve e-posta yazıldı (`createLowStockHandler`). **Push YOK:** mobil
    uygulama (Faz 5) henüz başlamadı, gönderilecek cihaz kaydı yok.
    Kritik ürün yoksa e-posta GÖNDERİLMİYOR — her sabah gelen "sorun yok"
    postası, gerçekten sorun olan sabah da okunmamasını sağlardı.
- [ ] **T36 (P2, human: ~3sa / CC: ~20dk)** - gözlem - Yapısal log + 5 metrik + 5 alarm
  - Kaynak: Bölüm 8
- [x] **T37 (P1, human: ~2sa / CC: ~15dk)** - gözlem - Invariant ihlali alarmı (kırmızı)
  - Her cron turunda `SUM(delta) == current_stock.qty` denetleniyor; kırıksa
    uç 500 dönüyor. Gövdeye yazıp 200 dönmek, gösterilen stoğun defterle
    uyuşmadığını kimsenin okumadığı bir JSON alanına gömerdi — kullanıcının
    fark etmeden yanlış sayıya bakması, sessiz kalabilecek en pahalı hata.

### Faz 7: Test ve yayın

- [ ] **T38 (P1, human: ~6sa / CC: ~45dk)** - test - E2E senaryoları (Playwright): 8 kritik akış
- [ ] **T39 (P1, human: ~3sa / CC: ~25dk)** - test - Düşman QA testleri (Bölüm 6, madde 4)
- [ ] **T40 (P1, human: ~3sa / CC: ~25dk)** - test - Kaos testi: senkron ortasında DB kapat
- [ ] **T41 (P2, human: ~2sa / CC: ~15dk)** - doküman - `docs/ADR/` 5 karar kaydı: ledger, tenant, offline, maliyet, versiyonlama
- [ ] **T42 (P1, human: ~3sa / CC: ~20dk)** - deploy - Vercel + Supabase + EAS pipeline, deploy sonrası kontrol listesi

### Faz 8: Mühendislik incelemesinden gelen görevler (D4-D9)

- [ ] **T43 (P1, human: ~0.5g / CC: ~30dk)** - deploy - **EAS Update + EAS Build CI/CD**: dev/staging/prod update kanalları, otomatik build, geri alma prosedürü
  - Kaynak: D6. "Mobil geri alma yok" maddesini kapatır, saha riskini 3 günden 5 dakikaya indirir
  - Doğrula: bir güncelleme yayınla, geri al, cihazda doğrula
- [x] **T44 (P1, human: ~2sa / CC: ~15dk)** - shared - `packages/shared/reasons.ts` tek kaynak: zod enum, Türkçe etiket eşlemesi, DB CHECK constraint senkron testi
  - Kaynak: D-2.3, D-2.4. Üç yerde ayrı yazılırsa drift kaçınılmaz
- [x] **T45 (P1, human: ~1sa / CC: ~10dk)** - güvenlik - Lint kuralı: uygulama katmanında RLS'i atlayan bağlantı yasak
  - Kaynak: D5. RLS'i insan disiplinine bırakmamak için makine zorlaması
  - **GÖREVİN İFADESİ DÜZELTİLDİ.** "Route handler içinde doğrudan `db`
    kullanımı yasak" diye yazılmıştı ama mevcut mimaride `appDb()` ZATEN
    her sayfa ve route'ta çağrılıyor — handle alınıp core servisine
    parametre geçiliyor, sorguyu core çalıştırıyor. O ifadeyi harfiyen
    uygulamak çalışan mimariyi yasaklardı.
  - Korunması gereken gerçek değişmez iki tane ve ikisi de ölçüldü:
    `apps/web` bugün SIFIR doğrudan sorgu çalıştırıyor, ve `adminDbUnsafe`
    uygulama kodunda hiç geçmiyor.
  - Kural Biome `noRestrictedImports` ile, iki katmanlı:
    - `packages/core` → `adminDbUnsafe` yasak
    - `apps/**` → `adminDbUnsafe` + `withTenant` yasak
  - **Neden `withTenant` de yasak:** web'de ona ihtiyaç duyulması, sorgunun
    yanlış katmanda yazıldığının işareti. Sorgular core'a ait.
  - **Neden ESLint değil Biome:** depo T95'te Biome'a geçti; ikinci bir
    linter ikinci bir kaynak olurdu. Ayrıca editörde anında uyarı veriyor.
  - `adminDbUnsafe`'in kendi yorumu zaten "Uygulama kodundan ASLA" diyordu;
    eksik olan tek şey bunu zorlayan makineydi.
  - Doğrulandı: üç ihlal (web'de iki, core'da bir) bilerek eklendi, lint
    üçünü de yakaladı; geri alındı, lint tekrar temiz.
- [x] **T46 (P1, human: ~3sa / CC: ~25dk)** - test - **RLS çapraz tenant test seti** (4 test): A→B okuma engelli, A→B yazma engelli, `SET LOCAL` yapılmadan 0 satır, uygulama rolü BYPASSRLS taşımıyor
  - Kaynak: Bölüm 3 test boşluğu. Test edilmeyen güvenlik kontrolü, varlığı bilinmeyen kontroldür
- [x] **T47 (P1, human: ~3sa / CC: ~25dk)** - test - Rol matrisi sunucu tarafı testleri (11 satırın her biri)
  - Kaynak: Tehdit S6, S7. Arayüzde butonu gizlemek yetki kontrolü değildir
- [ ] **T48 (P1, human: ~1g / CC: ~1sa)** - test - Outbox saf mantık test seti (sahte transport, tüm durum geçişleri) + `docs/mobil-cihaz-kontrol-listesi.md`
  - Kaynak: D8. Cihaz listesi 4 senaryo: arka plana atma, işletim sistemi uygulamayı öldürme, uçak modu, düşük pil
- [ ] **T49 (P1, human: ~0.5g / CC: ~40dk)** - mobil - Offline ürün önbelleği (okutulan ürünler) + çevrimdışı tanınmayan barkod akışı (`unresolved=true`, senkronda çözüm, bildirim)
  - Kaynak: D9. Çevrimdışı tanınmayan barkod reddedilmez, işaretlenir; reddetmek veriyi kaybetmek olur
- [x] **T50 (P2, human: ~2sa / CC: ~15dk)** - istemci - Hata kodu → Türkçe metin eşlemesi (web + mobil ortak, `packages/shared`)
  - Kaynak: D-2.2. Sunucu sabit `code` döner, metin istemcide üretilir

**Toplam:** 51 görev. Human ekip ~8-9 hafta. Claude Code ile ~10-12 gün.

Mühendislik incelemesi 8 görev ekledi, 1 görev çıkardı (sayim tabloları T3'ten),
6 görevi genişletti (T6, T7, T9, T14, T28, T32).

---

## ÇÖZÜLMEMİŞ KARARLAR

Bunlar uygulama başlamadan cevaplanmalı. Cevapsız kalırsa varsayılanı ben seçerim ama
ikisi de geri dönüşü pahalı:

| # | Soru | Varsayılanım | Neden önemli |
|---|---|---|---|
| U1 | Negatif stoğa izin var mı? | Çalışan: hayır (409). Admin: `[Yine de yap]` ile evet, loglanır | Depoda sayım tutmayınca çalışan tıkanır. Katı kural işi durdurur, gevşek kural veriyi bozar |
| U2 | Maliyet yöntemi (Faz 2) | Ağırlıklı ortalama | Sonradan değiştirmek geçmiş tüm raporları bozar. Muhasebecine sor |
| U3 | Hosting: Supabase mi kendi VPS mi? | Supabase (RLS + yedek + auth bedava) | Müşteri "veri Türkiye'de kalsın" derse VPS gerekir |
| U4 | Ürünün ana acısı hangisi: sayım tutmuyor / sorumlu yok / sipariş kaçıyor? | Üçü de kapsanıyor | Cevap, ilk müşteriye hangi ekranı önce göstereceğini belirler |

---

## MÜHENDİSLİK İNCELEMESİ KARARLARI (D4-D9)

| # | Konu | Karar | Etkilenen görev |
|---|---|---|---|
| D4 | Kullanılmayan sayim tabloları | Şemadan çıkarıldı, TODOS'a taşındı | T3 |
| D5 | Tenant izolasyonu | Drizzle + `withTenant()` + `SET LOCAL` + `app_user` rolü | T6, T45, T46 |
| D6 | Mobil dağıtım | EAS Update (OTA) + EAS Build CI/CD | T43 |
| D7 | Koli barkodu | `product_barcodes.qty_multiplier` | T3, T9 |
| D8 | Offline senkron testi | Saf mantık testleri + yazılı cihaz kontrol listesi | T48 |
| D9 | Offline ürün önbelleği | Sadece okutulanlar önbelleklenir (tam katalog TODOS'ta) | T49 |

Ayrıca karar gerektirmeyen 9 düzeltme plana işlendi: `current_stock` tanımı,
`FOR UPDATE` ile atomik stok kontrolü, `idempotency_key` üretim anı, hata cevap
sözleşmesi, sebep kodları tek kaynak, İngilizce enum değerleri, PIN kilitleme,
Türkçe arama normalizasyonu, büyük Excel raporu arka plan işi.

### Faz 9: Arayüz yeniden tasarımı (tasarım incelemesi 2026-08-25)

> **Numaralandırma notu:** Tasarım kararları **TD** öneki taşıyor (TD1-TD6).
> Bu, "MÜHENDİSLİK İNCELEMESİ KARARLARI (D4-D9)" bölümündeki D-kararlarından
> ayrıdır ve onlarla karıştırılmamalıdır.

`/plan-design-review` bulgularından türetildi. Karar TD1 = referans görselin tam
adaptasyonu; TD2 = Kategoriler + Raporlar + Ayarlar eklenir; TD3 = her rota için
yükleme iskeleti; TTD2 = mobilde alt gezinme çubuğu; TTD3 = `design/` tuvali yeniden yazılır.

Ölçülmüş tasarım sistemi ve tüm mockup'lar:
https://claude.ai/code/artifact/5579f41a-2794-4146-862b-114c9469c7a8

- [x] **T65 (P1, human: ~4sa / CC: ~30dk)** - arayüz - globals.css: 28 token × 2 tema (açık/koyu) + Outfit/IBM Plex yazı tipleri + tabular-nums yardımcıları
  - Neden: Bugün 4 token ve tek tema var; color-scheme:light sabit. Tipografi kararı hiç verilmemiş, sistem yazı tipi kullanılıyor.
- [x] **T66 (P1, human: ~6sa / CC: ~45dk)** - arayüz - shell.tsx: 244px kenar çubuğu + üst şerit (arama, bildirim, tema, avatar, kiracı)
  - Neden: Bugün üst şerit gezinme + max-w-6xl. Tasarım tuvali bu değişikliği onaylamıştı ama koda hiç uygulanmadı.
- [x] **T67 (P1, human: ~3sa / CC: ~25dk)** - arayüz - bottom-nav.tsx: 1024px altında 64px alt gezinme çubuğu, 4 sekme + Daha fazla (karar TD4)
  - Neden: Kod tabanında toplam 2 kırılma noktası var; 244px çubuk 375px telefonda ekranın üçte ikisini yer.
- [x] **T68 (P1, human: ~2sa / CC: ~15dk)** - erişilebilirlik - field.tsx: 3px odak halkası (7,25:1) + kontrol kenarlığı --line-control (3,40:1)
  - Neden: outline-none focus:border-slate-900 klavye kullanıcısının tek işaretini 1px ton farkına indiriyor. border-slate-300 beyaza karşı 1,48:1, WCAG 1.4.11 üç kat fazlasını istiyor.
- [x] **T69 (P1, human: ~1g / CC: ~40dk)** - arayüz - 11 rotaya loading.tsx (içerik şeklinde iskelet) + error.tsx + global-error.tsx (karar TD3)
  - Neden: apps/web/src altında tek bir loading.tsx veya error.tsx yok. Her sayfa async server component; geçişte eski sayfa donmuş halde bekliyor ve kullanıcı tekrar basıyor.
- [x] **T70 (P2, human: ~5sa / CC: ~35dk)** - arayüz - Yeni bileşenler: badge.tsx, kpi-card.tsx, product-cell.tsx, empty-state.tsx
  - Neden: Durum rozeti ve KPI kartı bugün sayfaların içine gömülü; boş durumlar her sayfada elle yazılmış, Kural 09 yapısal olarak zorlanmıyor.
- [x] **T71 (P2, human: ~6sa / CC: ~45dk)** - arayüz - panel/page.tsx: 4 KPI + alan grafiği + kritik ray + kategori halkası
  - Neden: Bugün 2 özet kartı var, grafik yok. Referans görselin panel düzeni bu turda uygulanıyor.
- [x] **T72 (P2, human: ~4sa / CC: ~30dk)** - arayüz - stok/page.tsx: SKU sütunu, ürün jetonu, durum rozeti, 44px satır
  - Neden: products.sku zaten var ama arayüzde hiç gösterilmiyor. Durum bugün sadece renkle kodlanıyor.
- [x] **T73 (P2, human: ~4sa / CC: ~30dk)** - özellik - kategoriler/page.tsx: GROUP BY category + ürün sayısı + toplam değer (karar TD2)
  - Neden: Görselde Kategoriler menüsü var; products.category bugün sadece filtre olarak kullanılıyor, kendi ekranı yok.
- [x] **T74 (P2, human: ~5sa / CC: ~35dk)** - özellik - raporlar/page.tsx: var olan export API üstüne arayüz (rapor tipi, filtre, kuyruk durumu) (karar TD2)
  - Neden: /api/rapor/* dört endpoint ile çalışıyor ama ekranı yok; kullanıcı raporun var olduğunu bilmiyor.
- [x] **T75 (P2, human: ~5sa / CC: ~35dk)** - özellik - ayarlar/page.tsx: profil, parola, toplu kritik eşik, tema tercihi (karar TD2)
  - Neden: Kritik eşik bugün ürün ürün giriliyor. Tema tercihinin saklanacağı bir yer yok.
- [x] **T76 (P2, human: ~1g / CC: ~50dk)** - arayüz - Kalan 8 ekranı yeni bileşenlere geçir (giris, hareket, hareketler, kullanicilar, saglik, urunler/*, not-found)
  - Neden: Yeni tasarım sistemi tüm ekranlarda tutarlı olmazsa iki dil aynı üründe çarpışır.
- [x] **T77 (P2, human: ~1g / CC: ~45dk)** - belgeleme - design/*.dc.html tuvalini yeni sisteme göre yeniden yaz (karar TD5)
  - Neden: Tuvalin dokuz kuralının üçü artık geçersiz. İki çelişen tasarım sistemi aynı depoda duruyor; üç ay sonra bakan biri yanlış kurala uyar.
- [ ] **T78 (P3, human: ~1g / CC: ~40dk)** - performans - Aylık stok DEĞERİ özet tablosu — **U2 KARARINA BAĞLI, BEKLİYOR**
  - Neden: Bu görev "panel grafiğinin veri kaynağı" diye açılmıştı. Panel grafiği T71'de
    yazıldı ve stok DEĞERİ değil hareket HACMİ gösteriyor: hacim `stock_movements.created_at`
    üstünde indexli, pencere 14 günle sınırlı ve tarayıcıda ölçüldüğünde hızlı. Yani özet
    tablosu bugün hiçbir sorguyu hızlandırmıyor.
  - **Asıl engel U2:** geçmişe dönük stok değeri bir maliyet yöntemi kararı gerektiriyor
    (ağırlıklı ortalama mı FIFO mu). Karar verilmeden hesaplanacak her seri yanlış olur.
    Bu yüzden özet tablosu ŞİMDİ yazılmıyor: kullanılmayan şema hazırlık değil bakım
    borcudur (mühendislik incelemesi D4 ile aynı gerekçe) ve özellik geldiğinde tasarımı
    büyük ihtimalle U2'nin cevabına göre değişecek.
  - **Tetikleyici:** U2 cevaplandığı gün. Ondan önce açılmamalı.
- [x] **T79 (P3, human: ~2sa / CC: ~15dk)** - erişilebilirlik - Atlama bağlantısı (skip link) + hareket onay şeridine aria-live
  - Neden: Klavye kullanıcısı her sayfada 9 menü satırını geçmek zorunda. Kayıt onayı ("446 → 496") ekran okuyucuya hiç duyurulmuyor.

- [x] **T87 (P1, human: ~1g / CC: ~1sa)** - auth - Oturum yenilemeyi render'dan çıkar
  - Neden: `currentActor()` süresi dolmuş access token'ı render sırasında yeniliyor ve
    çerez yazmaya çalışıyor. Next.js 15 bunu Server Component render'ında yasaklıyor;
    sonuç, giriş yaptıktan 15 dakika sonra HER sayfada 500 hatasıydı. Çökme try/catch
    ile kapatıldı (yenileme token'ı döndürülmediği için yutmak güvenli), ama çerez
    tazelenene kadar her render bir yenileme sorgusu yapıyor. Kalıcı çözüm: yenilemeyi
    bir route handler'a veya Node çalışma zamanlı middleware'e taşımak.

**Faz 9 tamamlandı (T65-T87), T78 hariç.**

T78 kapsamı düzeltildi ve U2'ye bağlandı: panel grafiği stok değeri değil hareket
hacmi gösteriyor (hacim indexli ve ucuz), yani özet tablosu bugün hiçbir sorguyu
hızlandırmıyor. Değerin zaman serisi maliyet yöntemi kararına bağlı.

**Faz 9 temel katmanı + TD2 ekranları tamamlandı (T65-T75).**

TD2 ile menü 6 → 9 satıra çıktı. Üç yeni ekranın hiçbiri YENİ VERİ MODELİ
gerektirmedi; üçü de var olanı görünür kıldı:

- **Kategoriler** — `products.category` bugüne kadar yalnızca stok tablosunda bir
  filtreydi. Ekran kategori bazında ürün sayısı, kritik sayısı, toplam adet ve
  stok değeri veriyor. Kategori ayrı tablo DEĞİL, serbest metin: "Kalem" ile
  "kalem" ayrı görünüyor ve bu bilinçli — normalizasyon, kullanıcının yazdığını
  sessizce değiştirip gizli bir eşleme kuralı yaratırdı.
- **Raporlar** — `/api/rapor/*` dört uçla zaten çalışıyordu ama ekranı yoktu;
  raporun var olduğunu yalnızca ilgili tablonun köşesine bakan biliyordu.
  Buradakiler filtresiz (tüm stok, tüm hareketler); filtre gerekiyorsa her kart
  ilgili tabloya yönlendiriyor.
- **Ayarlar** — kapsam üç şey: hesap bilgisi, tema, parola. İşletme ayarı ve
  bildirim tercihi GİRMEDİ çünkü arkalarında veri modeli yok; koymak, açılınca
  hiçbir şey yapmayan anahtarlar dizmek olurdu.

Yolda kapatılan bir güvenlik açığı: `setUserPassword` kendi parolanı mevcut
parolayı SORMADAN değiştirmene izin veriyordu. Yönetici sıfırlaması için doğru,
kendi hesabı için değil — depoda ekran açık bırakılıyor ve başında kimse olmayan
bir oturum parolanın değiştirilmesine yetmemeli. `changeOwnPassword` mevcut
parolayı doğruluyor; 6 test bunu kilitliyor. Doğrulama: 462 test geçiyor
(shared 56, db 53, core 353), `next build` 17 rota, açık ve koyu tema tarayıcıda
ölçüldü (`--focus` 7,25:1, `--line-control` 3,40:1), alt gezinme çubuğu 375 px'te
94×63 px hedeflerle çalışıyor, iskelet ekran kalıcı kabuğun içinde render ediliyor.

**Yol boyunca bulunan ve düzeltilen, plan dışı KUSURLAR:**

0. `apps/web/src/server/session.ts` — **giriş sonrası 15. dakikada her sayfa 500
   veriyordu.** Süresi dolmuş access token'ın sessiz yenilemesi render sırasında
   çerez yazmaya çalışıyor; Next.js 15 buna izin vermiyor. Kodun önlemek istediği
   şey ("kullanıcıyı 15 dakikada bir dışarı atma") çökmeye dönüşmüştü. Çökme
   kapatıldı, kalıcı çözüm T87.

1. `packages/db/src/testing.ts` — migration klasörü `new URL(...).pathname` ile
   çözülüyordu. Windows'ta bu `/C:/stok/...` üretiyor (sürücü harfinden önce eğik
   çizgi) ve drizzle `meta/_journal.json` dosyasını bulamıyor. Sonuç: **db ve core
   test paketleri Windows'ta hiç çalışmamış.** `fileURLToPath` ile düzeltildi;
   406 test ilk kez bu platformda koştu.
2. `apps/web/src/server/session.ts` — `currentActor()` `cache()` ile sarmalandı.
   Kabuk düzene taşınınca istek başına iki çağrı oluyor; sarmalanmasaydı süresi
   dolmuş access token'da yenileme iki kez çalışır ve refresh token iki kez
   döndürülürdü.

**T68 ve T69 tasarımdan bağımsız hatalardır.** T68 ölçülmüş bir erişilebilirlik
gerilemesi (`outline-none`, kenarlık 1,48:1), T69 ise bugün var olan ve kullanıcıya
"tıkladım mı" sorusu sorduran bir eksiklik. Tasarım kararı ne olursa olsun kapanmalıydı.


#### Faz 9b: Referans görselden gelen özellikler (karar TD6)

Görseldeki özellikler tek tek değerlendirildi. Üçü girdi, biri kapsam dışı kaldı.

| Karar | Özellik | Sonuç |
|---|---|---|
| **TD6.1** | Bildirim zili + sesli/titreşimli geri bildirim | **Dahil** — E4 ve E7 zaten v1 kapsamındaydı, yapılmamıştı (T80, T81) |
| **TD6.2** | Ürün fotoğrafı | **Dahil** — şema + yükleme + toplu aktarma (T82-T84) |
| **TD6.3** | Ctrl+K genel arama | **Dahil** — Kural 05'in işlevsel gereği (T85, T86) |
| **TD6.4** | Tedarikçiler / Siparişler | **Çıkar** — "KAPSAM DIŞI → Faz 2" kararı teyit edildi |
| — | Kiracı değiştirici | **Uygulanamaz** — `users.tenantId` notNull tek FK, bir kullanıcı tek işletmeye ait. Kontrol hesap menüsü olarak yorumlandı |

- [x] **T80 (P2, human: ~4sa / CC: ~30dk)** - özellik - Bildirim zili: kritik ürün + başarısız arka plan işi sayısı + açılır liste (E7 web karşılığı)
  - Neden: PLAN.md E7 v1 kapsamında ama yapılmadı. Referans görselde zil var; sayı bağlanmazsa boş süs kalır.
- [x] **T81 (P2, human: ~4sa / CC: ~25dk)** - arayüz - Barkod kaydında sesli + titreşimli geri bildirim + sessiz mod tercihi (E4 web karşılığı)
  - Neden: PLAN.md E4 v1 kapsamında: "çalışan ekrana bakmaz, dinler, hız 2 katına çıkar". Web hareket ekranında hiç yok.
- [x] **T82 (P2, human: ~2sa / CC: ~20dk)** - şema - products.image_url sütunu + migration + depolama yapılandırması
  - Neden: Referans görselde her ürünün fotoğrafı var; products tablosunda görsel sütunu yok. T83 ve T84 buna bağlı.
- [x] **T83 (P2, human: ~2g / CC: ~1,5sa)** - özellik - Ürün görseli yükleme + boyutlandırma + baş harf karesi ZORUNLU geri düşüş
  - Neden: Fotoğrafsız ürün bozuk görünmemeli: 800 kalemlik katalogda çoğu satır uzun süre fotoğrafsız kalacak.
- [x] **T84 (P2, human: ~4sa / CC: ~30dk)** - özellik - Toplu aktarmada görsel URL sütunu + önizlemede görsel doğrulama
  - Neden: Elle fotoğraf çekmeden tedarikçi kataloğundan eşleştirme yolu; fotoğrafın gerçekten dolmasının tek pratik yolu.
- [x] **T85 (P2, human: ~1g / CC: ~50dk)** - özellik - Birleşik arama endpoint: ürün + barkod + hareket, Türkçe normalizasyonla
  - Neden: Bugün arama sadece /stok içinde. Tasarım Kural 05 "arama hep görünür, hep odaklı" diyor; barkod okuyucu odak bulamazsa okutma sessizce kayboluyor.
- [x] **T86 (P2, human: ~1g / CC: ~45dk)** - arayüz - Ctrl+K komut paleti: barkod tam eşleşme → Giriş/Çıkış, SKU/ad → ürün, sonuç yok → yeni ürün ekle
  - Neden: PLAN.md boş durum tablosu zaten "arama sonuç yok → Yeni ürün olarak ekle" diyor; palet bunu her ekrandan erişilebilir kılıyor.

**T83'de baş harf karesi zorunlu geri düşüş.** Fotoğraf isteğe bağlı bir alan;
fotoğrafsız ürün bozuk değil, sade görünmeli. **T84 bu kararın diğer yarısı:**
800 kalemlik katalogda fotoğrafın elle çekilerek dolması gerçekçi değil, toplu
aktarmadaki URL sütunu doldurmanın tek pratik yolu.


### Faz 10: Fiyat defteri (office-hours 2026-08-30)

Tasarım belgesi: `docs/designs/fiyat-defteri.md` (ONAYLANDI).

Kullanıcıdan gelen üç istek — eski ürünü değerleme, enflasyona karşı korunma,
gerçek satış fiyatını kaydetme — tek eksikliğin üç yüzü çıktı: **defter "kaç
tane"yi kaydediyor, "kaça"yı kaydetmiyor.**

**Ölçülen bulgu:** `stock_movements.unit_cost` sütunu var, `createMovement`
kabul ediyor (`packages/core/src/movements.ts:168`), Excel'e çıkıyor, rol
bazlı gizleniyor — ama **arayüz bu alanı hiç sormuyor**
(`apps/web/src/app/(panel)/hareket/page.tsx:92`). Uygulamadan girilen her
hareketin `unit_cost` değeri `NULL`; yalnızca `seed.ts` dolduruyor. Şemadaki
"maliyet takibi bu veriyi bugünden topluyor" yorumu bugün doğru değil.

**U2 üzerindeki etkisi:** Bu üç görev U2'yi (maliyet yöntemi) çözmeyi
GEREKTİRMİYOR. FIFO / ağırlıklı ortalama "sattığımda hangi geçmiş maliyeti
düşeyim" sorusudur ve **kâr raporuna** (E8) aittir. Buradaki soru "bunu kaça
satmalıyım" — ileriye bakan bir soru, geçmiş maliyet eşleştirmesi gerektirmez.
U2 açık kalabilir; dahası T88 tarihli fiyat toplamaya başlayınca U2 gerçek
veriyle test edilebilir hale gelir.

- [x] **T88 (P1, human: ~2g / CC: ~2sa)** - hareket - Kasa açığı kontrolü: liste fiyatı dondurulur, sapma zorunlu sebeple açıklanır
  - **Neden (2026-08-30 düzeltmesi):** Bu bir kâr marjı özelliği DEĞİL, kasa
    mutabakatı kontrolü. Senaryo: kırtasiyede çalışan A4 satıyor, fiş liste
    fiyatından 110 ₺ yazıyor, müşteri tanıdık diye 100 ₺ alınıyor, kasada
    10 ₺ açık kalıyor. Amaç açığı engellemek değil, GİZLENEMEZ yapmak.
  - `unit_cost` → `unit_price` yeniden adlandırılıyor: sütun artık çıkışta
    satış hasılatı tutacak, ona "maliyet" demek kalıcı bir yalan olur. Yöne
    göre anlam türetmek bu depoda kurulu örüntü — `delta`'nın işareti de
    `reason`'dan türetiliyor.
  - **`list_price` harekete DONDURULUYOR.** Bu olmadan kontrol çürür:
    `products.sale_price` sonradan 110 → 120 olursa, geçmişteki 10 ₺'lik açık
    geriye dönük 20 ₺'ye dönüşür. Defter append-only olduğu için o günkü liste
    fiyatı da hareketle birlikte donmalı.
  - **Kural DB seviyesinde:** iki sütun aynı satırda olduğu için
    `CHECK (unit_price IS NULL OR list_price IS NULL OR unit_price = list_price
    OR price_override_reason IS NOT NULL)`. Epsilon YOK — bkz. tolerans notu. Deponun felsefesi bu —
    `movements_delta_nonzero_ck` ve `movements_reason_ck` zaten böyle.
  - **Sebep serbest metin DEĞİL, listeden.** Takip toplanabilirlik demek;
    serbest metin "bu ay tanıdık indirimine kaç lira gitti" sorusunu
    cevaplayamaz. `MOVEMENT_REASONS` örüntüsünün aynısı (kod tek kaynak,
    Türkçe etiketler orada, DB CHECK listeden üretilir):
    `TANIDIK`, `TOPTAN`, `KAMPANYA`, `HASARLI`, `ESKI_STOK`, `YUVARLAMA`,
    `YONETICI_ONAYLI`, `DIGER` (Diğer'de serbest metin zorunlu).
  - **`YUVARLAMA` LİSTEDE ama otomatik DEĞİL.** Yuvarlamak da satıcının
    kararıdır ve seçilerek işaretlenir.
  - **TOLERANS YOK (D6 iptal, 2026-08-30).** Tolerans "çalışan fiyatı elle
    yazarken kazara yuvarlar" varsayımına dayanıyordu. O varsayım yanlış:
    fiyat elle yazılmıyor, barkoddan ya da fiş OCR'ından geliyor. Otorite
    sistemde olduğu için KAZARA sapma diye bir şey yok; her sapma satıcının
    bilinçli kararı ve bilinçli kararın toleransı olmaz.
    Sonuç: CHECK'te epsilon yok, `tenants` tablosuna ayar sütunu eklenmiyor,
    `/ayarlar` ekranına tolerans alanı girmiyor. Üç iş birden düştü.
  - **`list_price` OTORİTESİ SUNUCUDA (karar D4, mühendislik incelemesi).**
    `createMovement` bu alanı `products.sale_price`'tan KENDİ okuyor; istemci
    gönderse bile yok sayılıyor. Aksi halde isteği kendi üreten biri
    `list_price = unit_price` yazıp sebep zorunluluğunu tamamen atlar ve
    kontrolün "gizlenemez" iddiası çöker.
  - **`client_list_price` AYRI kaydediliyor.** İstemcinin barkod/OCR anında
    GÖRDÜĞÜ fiyat. Sunucununkiyle farklıysa hareket işaretleniyor ve T88.1
    raporunda görünüyor. Çevrimdışı gecikmeli senkronda (Faz 5 / T28) satış
    günü ile senkron günü arasında fiyat değişmişse, fark sessiz kalmak
    yerine görünür oluyor. Bugün web'de ikisi hep eşit; alan Faz 5 için
    değil, UYUŞMAZLIĞI GÖRÜNÜR KILMAK için var.
  - **`price_source` alanı** (`price_estimated` boolean'ın yerine):
    `LIST` / `MANUAL` / `RECEIPT` / `INDEXED` / `ESTIMATED`. Kullanıcı ileride
    muhasebe uygulaması entegre edip fiş okutacak ve fiyat oradan gelecek;
    kaynak bugünden kayıtlı olmazsa o gün ikinci bir migration gerekir.
  - **Yetki: D7'DEN SAPILDI (2026-08-31, uygulama sırasında).** D7 çalışanın
    gördüğü fiyatı `saleUnitPrice` diye AYRI bir alanda döndürmeyi söylüyordu;
    tasarım belgesi (`docs/designs/fiyat-defteri.md`, ONAYLANDI) ise aynı
    alanın SATIR BAZINDA gizlenmesini söylüyor ve mevcut testin "girişlerde
    yok, satışlarda var" olarak güncellenmesini istiyor. **İki onaylı belge
    burada çelişiyordu.** Tasarım belgesindeki yol uygulandı:
    `unitPrice` / `listPrice` / `priceOverrideReason` satır bazında
    çıkarılıyor, ayrım `reasonPriceBasis(reason) === 'SALE'`.
    D7'nin haklı itirazı — "`m.unitCost == null` eksik alanı da yakalar ve
    `—` basar, çalışan 'girilmemiş' ile 'yetkim yok'u ayırt edemez" —
    ekranda ÜÇ AYRI DURUM basılarak kapatıldı ve tarayıcıda doğrulandı:
    alan yok → `gizli`, `null` → `—`, dolu → tutar. Sütun BAŞLIĞI da
    cevaptan türüyor (`Satış fiyatı` / `Birim fiyat`), rolden değil.
    Ayrım `reason === 'SALE'` yerine `priceBasis` üzerinden: müşteri
    iadesinde (`RETURN_IN`) de ödenen tutar satış fiyatıdır.
    `PURCHASE` ve `OPENING` fiyatları çalışana kapalı (tehdit S7).
    **Kalan risk:** presence kontrolü (`'unitPrice' in row`) `== null`
    kontrolünden farklı ve bunu bilmeyen bir tüketici sessizce yanlış
    yazar. Bugün tek tüketici var ve doğru yazılmış.
    **T53 notu (ZORUNLU):** `/api/v1` sözleşmesinde "alanın YOKLUĞU yetki
    yokluğudur, `null` girilmemiş demektir" açıkça yazılmalı; mobil bu
    ayrımı kaçırırsa çalışana "fiyat girilmemiş" gösterir.
  - **Sapma sebebi ZORUNLULUĞU hata metninde alış fiyatını SIZDIRMIYOR**
    (tarayıcı testinde yakalandı, 2026-08-31). Hata detayları Türkçe metne,
    oradan adres çubuğuna ve ağ sekmesine düşüyor; alış fiyatından sapan bir
    GİRİŞ yazan çalışan "Liste fiyatı 80,00 ₺" uyarısından listeden
    gizlediğimiz sayıyı öğrenirdi — yanlış fiyat yazarak sorgulanabilir bir
    kaçak. `listPrice` detaylara yalnızca yetkili role ya da satış dayanaklı
    sebeplerde konuyor; metin sayısız da anlamlı kalıyor.

- [x] **T88.1 (P1, human: ~2sa / CC: ~20dk)** - rapor - Kasa açığı gün sonu raporuna binsin
  - Neden: **Okunmayan kayıt kontrol değildir.** T88 açığı kaydediyor; onu
    takibe çeviren şey görünürlük. T34 gün sonu raporu zaten planda.
  - İçerik: "Bugün 7 harekette liste fiyatının altına inildi, toplam fark
    84 ₺. En çok: Ahmet (5 hareket, 60 ₺)." Kullanıcı bazında toplanır —
    hareket zaten `user_id` taşıyor.
  - Tolerans içinde kalan farklar da toplama DAHİL: çalışan tek tek
    sorgulanmıyor ama hiçbir kuruş rapordan düşmüyor.
  - **T88'e bağlı.** T34 yazılmadıysa önce o.
  - Açık, e-postanın GÖVDESİNDE — Excel ekinin içinde değil. Eki açmayan
    yönetici (telefondan bakan yönetici) açığı hiç görmezdi.
  - Sapma MİKTARLA ÇARPILIYOR: `(liste − birim) × adet`. Satır başına
    sayılsaydı 100 adetlik tek bir indirim, 1 adetlik indirimle aynı
    görünürdü.

- [x] **T89 (P2, human: ~2g / CC: ~yarım gün)** - hareket - Açılış değerlemesi: `OPENING` sebebine fiyat + ekonomik tarih + "tahmini" işareti
  - Neden: Müşteri 5 yıldır elinde tuttuğu malı sisteme girerken fiyat
    alanında tıkanıyor — eski fatura yok, bugünkü fiyat da doğru değil.
  - **Kritik alan fiyat değil TARİH.** Tarihsiz fiyat enflasyona göre
    düzeltilemez. `OPENING` hareketinin `created_at`'i bugün, malın ekonomik
    tarihi 5 yıl önce; ikisi ayrı sütun olmak zorunda (`price_date`).
    T90 bu sütun olmadan çalışamaz.
  - İki yol da formda: fatura varsa tutar + fatura tarihi (sistem bugüne
    taşır); fatura yoksa bugünkü yenileme bedeli + `price_estimated = true`.
  - **UYGULANDI 2026-08-31.** `price_estimated` boolean'ı YERİNE
    `price_source = 'ESTIMATED'` yazılıyor: ayrı bir bayrak, fiyat kaynağını
    iki yerden okunur hale getirir ve "fişten okundu ama tahmini" gibi
    anlamsız bir durumu temsil edilebilir kılardı.
  - **GEÇMİŞ TARİH T88'DE KAÇAK AÇABİLİRDİ — kapatıldı.** Geçmiş tarihli
    fiyat liste fiyatıyla karşılaştırılmıyor (aradaki fark indirim değil
    enflasyon). Serbest bırakılsaydı kasa açığı kontrolü TEK ALANLA
    atlanırdı: çalışan fiyat tarihine dünü yazar, karşılaştırma düşer,
    10 ₺'lik açık sebepsiz kaydedilirdi. Bu yüzden geçmiş tarih yalnızca
    satış dayanağı OLMAYAN sebeplerde kabul ediliyor; satış ve müşteri
    iadesinde fiyatın anı işlemin anıdır. Testi `prices.test.ts` içinde ve
    koruma kaldırılıp kırmızı yandığı görülerek doğrulandı.
  - **"Bugün" SUNUCU YEREL saatinden okunuyor, `toISOString()` ile DEĞİL.**
    UTC'ye çevirmek Türkiye'de (UTC+3) her gece 00:00–03:00 arasında dünü
    döndürürdü: o pencerede girilen "bugün" tarihli fiyat geçmiş sayılır,
    liste karşılaştırması sessizce düşer ve kasa açığı kontrolü her gece
    üç saat kapalı kalırdı. Mutasyon testi bunu ilk turda YAKALAYAMADI —
    testin kendisi de `toISOString()` kullanıyordu ve iki taraf aynı yanlış
    günü hesaplıyordu; test yerel saate çevrilince koruma kanıtlanabildi.
  - **Tarayıcı turunda bulunan hata (düzeltildi):** hata dönüşünde MİKTAR
    korunmuyordu. Kullanıcı 5 yazıp "birim fiyat zorunlu" hatası alıyor,
    fiyatı dolduruyor ve stoğa 5 yerine 1 giriyordu — ikinci gönderim
    BAŞARILI olduğu için hiçbir uyarı çıkmıyordu, yani hata mesajı sessiz
    bir YANLIŞ KAYIT üretiyordu. Alanları elle taşımak yerine
    `preserveFields()` yardımcısı yazıldı (`apps/web/src/server/form.ts`,
    testli). **Kalan risk:** sayfanın verdiği alan adı listesi birim testli
    değil, yalnızca tarayıcıda doğrulandı; listeye yeni bir alan eklenmesi
    unutulursa aynı sessiz sıfırlama geri gelir.

- [ ] **T90 (P2, human: ~1 hafta / CC: ~2-3g)** - fiyat - Yenileme maliyeti: satış anında "bugün yerine koymak kaça mal olur"
  - Neden: Bugünkü maliyetten giren mal 6 ay sonra aynı rakamdan satılırsa
    yerine yenisi konamıyor. **Enflasyon ürünü değil parayı değersizleştiriyor
    — hesaplanacak sayı yenileme maliyetidir**, "eskimiş maliyeti düzeltmek"
    değil.
  - Kaynak sırası: (1) son `PURCHASE` hareketinin `unit_price`'ı, `price_date`
    90 günden yeniyse — **en iyi kaynak budur, endeks değil**; (2) yoksa
    bilinen son fiyat × (bugünkü Yİ-ÜFE ÷ o tarihteki Yİ-ÜFE);
    (3) hiçbiri yoksa `products.purchase_price`.
  - **HESAP SQL'DE (karar D5, mühendislik incelemesi).** `replacementCost` bir
    sorgu; `numeric` çarpma/bölme PostgreSQL'de tam ondalık yapılıyor, TS'e
    yalnızca 2 basamaklı sonuç dönüyor. Gerekçe: `numeric.ts` miktara özel
    (`QTY_SCALE = 3`, `NUMERIC(14,3)` tavanı) ama para `numeric(12,2)` —
    yardımcılar yeniden kullanılamıyor. Kayan nokta ise deponun miktarda
    yasakladığı şeyin aynısı: endeks oranı 4 ondalıklı ve sonuç hem satış
    uyarısı hem rapor toplamı besliyor. İkinci bir ölçekli-bigint seti
    yazmak yerine zaten tam olan aracı kullanıyoruz.
  - **`price_index` RLS deseni (karar D6, mühendislik incelemesi).** Tablo
    tenant kapsamlı değil ama `rls.test.ts:247` public şemadaki HER tabloda
    RLS+FORCE istiyor ve `:271` politikanın tanımlı olmasını istiyor —
    politikasız FORCE RLS "her şeyi reddet" demek ve üretimde 500 olarak
    görünür. Desen: `ENABLE` + `FORCE ROW LEVEL SECURITY` +
    `CREATE POLICY ... FOR SELECT USING (true)` +
    `REVOKE INSERT, UPDATE, DELETE ON price_index FROM stok_app`.
    `rls.test.ts` politika listesine `price_index` eklenir.
    `USING (true)`'nun neden güvenli olduğu (ulusal açık veri, her tenant
    aynı satırları okur) migration yorumuna yazılır ki kimse bu deseni bir
    tenant tablosuna kopyalamasın. `auth_attempts` deseni (REVOKE ALL +
    SECURITY DEFINER) seçilmedi: o veri kimlik doğrulamadan ÖNCE yazıldığı
    ve tenant'a bağlanamadığı için kapalıydı, endeks ise açık veri.
  - **Uyarı, engel değil.** Eski stoğu elden çıkarmak için maliyetin altına
    satmak meşru bir karardır.
  - **Arayüzde açıkça yazmalı:** bu bir karar destek aracıdır, VUK mükerrer
    298/A kapsamındaki resmî enflasyon düzeltmesinin yerine geçmez. Aksi halde
    müşteri vergi uyumu sanar.
  - **KISMİ İNDEKS (karar D9, mühendislik incelemesi).** Mevcut dört indeksin
    hiçbirinde `reason` yok; "son PURCHASE" araması en yeniden geriye tarayıp
    alışı arıyor. Kırtasiyede bir kalem ayda bir alınıp günde onlarca kez
    satıldığı için aradaki yüzlerce satış satırı taranır — her satış ekranı
    açılışında. Migration ile birlikte:
    `CREATE INDEX ... ON stock_movements (tenant_id, product_id, created_at DESC)
    WHERE reason = 'PURCHASE'`.
    Kısmi indeks yalnızca eşleşen satırda güncellendiği için SATIŞ YAZMA
    YOLUNA SIFIR MALİYET getiriyor; "indeks yazmayı yavaşlatır" itirazı bu
    durumda geçerli değil.
  - **T88'e bağlı:** düzeltilecek fiyat verisi T88 toplamaya başlamadan yok.
  - **Doğrulanmadan başlanmasın:** Yİ-ÜFE'nin resmî endeks olduğu bilgi
    birikiminden söylendi, TÜİK'ten teyit EDİLMEDİ.

- [~] **T92 (P1, human: ~2g / CC: ~1sa)** - test - Faz 10 test kapsamı: sunucu testleri + T38'in öne çekilmesi
  - **SUNUCU TARAFI TAMAM (2026-08-31).** `packages/core/src/prices.test.ts`,
    29 test. Kapsanan yollar: liste fiyatı sunucudan okunuyor; istemcinin
    gönderdiği liste fiyatı sapmayı sıfırlayamıyor; fiyat yoksa CHECK
    geçiyor; eşitse sebep istenmiyor; farklı+sebepli kabul; farklı+sebepsiz
    RED; listede olmayan sebep hem zod hem DB CHECK ile red; "Diğer"de
    açıklama zorunlu; `client_list_price` ayrı saklanıyor ve uyuşmazlık
    görünür; giriş=alış / çıkış=satış dayanağı; liste fiyatı harekete
    donuyor (ürün zamlansa da geçmiş değişmiyor); D7 yetki ayrımı; devirde
    fiyat zorunlu; ileri tarihli ve satışta geçmiş tarihli `price_date`
    reddi; alış fiyatının hata metninden sızmaması.
    **On üç korumanın her biri tek tek kaldırılıp kırmızı yandığı görülerek
    doğrulandı** — biri (saat dilimi) ilk turda yakalanmadı, testin kendisi
    de aynı hatayı yapıyordu; düzeltildi.
  - **T38 / ARAYÜZ AKIŞLARI: YAZILDI, CI'YA BAĞLANMADI.**
    `apps/web/e2e/faz10-fiyat.spec.ts`, 9 senaryo. Bekleyen tek şey T109.
  - **KALAN:** `replacementCost` dört kolu ve `price_index` RLS testleri
    T90'a ait — o iş henüz yapılmadı, testleri de yazılamaz.

- [ ] **T109 (P1, human: ~yarım gün / CC: ~2sa)** - test - **Faz 10 tarayıcı testleri kararsız: sunucu eylemi sonrası sayfa render edilmiyor**
  - `apps/web/e2e/faz10-fiyat.spec.ts` her koşuda 9 senaryodan 1-3'ünde
    kırmızı yanıyor ve KIRILAN TEST HER SEFERİNDE DEĞİŞİYOR — yani gerçek
    bir ürün hatası değil, zamanlamaya bağlı bir takılma.
  - **Ölçülenler (hepsi eleme amaçlı yapıldı, hiçbiri sebep değil):**
    - Adres sunucu eyleminden sonra DOĞRU hata koduna dönüyor (`hata=...`),
      yani sunucu isteği alıp 303 veriyor.
    - Takılan anda `pg_stat_activity`: tek bağlantı, bekleyen kilit yok,
      "idle in transaction" yok. Veritabanı temiz.
    - `auth_attempts` BOŞ: kaba kuvvet koruması (T51) devreye girmiyor.
    - Giriş ~350 ms, sayfa yüklemeleri ~180 ms. Yavaşlık yok.
    - Gönderim süresi İKİ MODLU: ya ~110 ms ya 25 sn+ (90 sn'de de bitmiyor).
      Arada değer yok — yani yavaşlama değil, TAKILMA.
    - Hidratasyon beklendi (`networkidle`, ardından React'in kendi
      `__reactFiber$` izi) — düzelmedi.
    - Her teste ayrı ürün verildi (testler birbirinin stoğunu bozmasın) —
      düzelmedi.
    - Mevcut duman testi (`demo-yolu.spec.ts`) 3 koşuda 3 kez YEŞİL; o
      dosya form GÖNDERMİYOR, yalnızca okuyor.
  - **2026-09-03 ÖLÇÜMÜ — SUNUCU TEMİZ, İSTEMCİ GEZİNMİYOR.** Takılan
    gönderimde ağ izi alındı:
    - `POST /hareket` sunucuya ULAŞIYOR ve **303 dönüyor** — yani sunucu
      eylemi çalıştı, doğrulama yapıldı, yönlendirme üretildi.
    - Tarayıcı bu 303'ü İZLEMİYOR: adres çubuğu ilk haliyle kalıyor
      (`/hareket?barkod=…`, hata parametresi yok), `<main>` hâlâ gönderim
      ÖNCESİ formu gösteriyor (~838 karakter metin — iskelet değil, çünkü
      iskeletin metni yok), hata şeridi hiç oluşmuyor.
    - Yani kullanıcının gördüğü şey: **"Kaydet"e basıyor, hiçbir şey
      olmuyor.** Sessiz. Tekrar basmak çift kayıt üretmiyor (idempotency
      anahtarı okutma anında üretiliyor, D-1.3) — bu tasarım kararı
      burada kurtarıcı oldu.
    - Sıklık ölçüldü: 8 gönderimde 4'e kadar çıkıyor; oran koşudan koşuya
      değişiyor (önceki turda 5'te 1).
  - **2026-09-03 İKİNCİ TUR — KAPSAM SANILANDAN BÜYÜK.** Takılma hareket
    formuna ya da `redirect()`'e ÖZGÜ DEĞİL:

    | Form | Nerede | Takılan |
    |---|---|---|
    | Giriş | kök düzen, kabuk YOK | **0/12** |
    | Tema düğmesi | panel kabuğu içinde, `revalidatePath` | **7/12** |
    | Hareket kaydı | panel kabuğu içinde, `redirect` | 3–6/12 |

    Yani **panel kabuğundaki HER sunucu eylemi** etkileniyor: çıkış yap,
    tema, ürün kaydetme, kullanıcı yönetimi, içe aktarma… hepsi. Bu, hatayı
    "Kaydet bazen çalışmıyor"dan "panelde hiçbir yazma işlemi güvenilir
    değil"e çıkarıyor.
  - **KOLAY TEKRAR ÜRETİM (kullanıcı 30 saniyede doğrulayabilir):** panele
    gir, üst şeritteki TEMA düğmesine arka arkaya bas. Ekran temasının
    değişmediği tıklamalar bu hatadır. Seed verisi, barkod, form doldurma
    gerekmiyor. **Bunu kendi tarayıcında dene** — Playwright'a özgü olup
    olmadığı sorusunu tek başına cevaplıyor.
  - **ELENEN HİPOTEZLER (hepsi A/B ölçüldü, hiçbiri sebep değil):**
    - `loading.tsx` (Suspense sınırı): yerinde 3/10, kaldırılmış 2/10.
    - Hidratasyon zamanlaması: tıklamadan önce React'in `__reactFiber$`
      izi beklenip 2 sn daha beklendi → 3/10. Değişmedi.
    - Bağlantı ön-yükleme (`prefetch`): kapalıyken 6/16, açıkken 6/16.
    - `SessionKeepAlive` (T87, `/oturum/yenile`): ölçümde o istek HİÇ
      atılmıyor (`needsPersist` false), yani zaten devrede değil.
  - **JS AÇIK/KAPALI KARŞILAŞTIRMASI YAPILAMADI** ve sebebi ayrı bir
    bulgu: JavaScript kapalıyken form ZATEN render edilmiyor (T110).
    Yani kaçağın "istemci yönlendiricisinde" olduğu, JS'siz yolu
    çalıştırarak değil, yalnızca ağ iziyle gösterilebildi.
  - **BU KULLANICIYI ETKİLER.** Tarayıcı otomasyonuna özgü olduğunu
    gösteren bir kanıt YOK; istek gerçek bir tıklamayla gidiyor ve sunucu
    normal cevap veriyor. Bir sonraki adım Next sürümünü/`loading.tsx`
    sınırını değiştirip oranın düşüp düşmediğini ölçmek — `/hareket`
    altında Suspense sınırı var ve şüphe oraya işaret ediyor.
  - **SIRADAKİ ADIM:** kabuk bileşenlerini teker teker çıkarıp tema
    düğmesiyle ölçmek (`CommandPalette`, `AlertBell`, `ThemeToggle`,
    `SidebarNav`). Tema düğmesi ölçümü ucuz — seed verisi ve form
    doldurma gerektirmiyor, bir tıklama ve `<html data-theme>` kontrolü.
    Panel düzeninin kendisi (`alertSummary` sorgusu, `currentActor`
    önbelleği) de aday.
  - Çözülene kadar bu dosya CI kapısına BAĞLANMAMALI: kararsız bir kapı,
    kısa sürede kimsenin bakmadığı bir kapıya dönüşür.
  - Kaynak: T92
  - **Zorunlu regresyon testleri (kural gereği, tartışmasız).** `unit_cost` →
    `unit_price` mevcut davranışı değiştiriyor; kırılacağı ölçülen yerler:
    `role-matrix.test.ts:308,315,319,326`, `excel.test.ts:146`,
    `exports.test.ts:59`, `movements.test.ts:121`, `stock.test.ts:61-69`,
    `schema-sync.test.ts`, `rls.test.ts:247,271`.
  - **Sunucu tarafı (22 yol, mevcut yüzeyle yazılabilir):** list_price sunucudan
    okunuyor mu; fiyat yoksa CHECK geçiyor mu; eşitse sebep istemiyor mu;
    farklı+sebepli kabul, farklı+sebepsiz RED (kontrolün kalbi); listede
    olmayan sebep DB CHECK reddi; `client_list_price` uyuşmazlığı işaretleniyor
    mu; giriş=maliyet / çıkış=hasılat anlamı; D7 yetki üçlüsü (çalışanda
    `unitPrice` HİÇ yok / SALE'de `saleUnitPrice` var / PURCHASE+OPENING'de
    ikisi de yok); OPENING'de fiyat zorunlu; gelecek tarihli `price_date` reddi;
    `replacementCost` dört kolu (yeni alış / endeksli / endekste ay yok / hiç
    fiyat yok) — **D5 gereği numeric tamlığı burada ispatlanır**; endeks bayat
    uyarısı; `price_index` RLS'te SELECT var INSERT yok (D6).
  - **T38 ÖNE ÇEKİLİYOR (karar D8).** Beş kullanıcı akışının test yüzeyi YOK:
    liste fiyatı ön-dolu geliyor mu, fark rozeti çıkıyor mu, **sebep seçmeden
    gönderim engelleniyor mu**, "Diğer"de serbest metin zorunlu oluyor mu,
    yenileme maliyeti uyarısı görünüyor mu. Sunucu bunları kanıtlayamaz:
    form sebebi zorunlu yapmayı unutsa bile sunucu testleri yeşil yanar ve
    kasadaki kişi anlamadığı bir hata ekranıyla kalır. Bu depoda kullanıcıya
    görünen dört hata yalnızca gerçek tarayıcıda bulundu.
  - Playwright kurulumu bir kez; sonraki tüm arayüz işleri kazançlı çıkıyor.


  - ## 2026-09-04 ÖLÇÜMÜ — ARIZA İKİYE AYRILDI, BİRİ KAPANDI

  - **BAŞLIK YANLIŞTI.** Bu bir "kararsız test" değil, KULLANICIYA GÖRÜNEN
    BİR ÜRÜN HATASI. Testler doğru çalışıyordu; her koşuda farklı testin
    kırmızı yanması, hatanın kendisinin olasılıksal olmasındandı.

  - **(a) TEMA DÜĞMESİ — ÇÖZÜLDÜ.** Ölçüm (üretim derlemesi, gerçek
    tarayıcı): 12 tıklamanın 8'inde `<html data-theme>` DEĞİŞMİYOR. Çerez
    doğru yazılmış, eylem 200 dönmüş, SERT YENİLEMEDE yeni tema geliyor —
    ekran eski temada kalıyor.
    - Sebep: `revalidatePath('/', 'layout')` tek başına istemciyi kökten
      yeniden render ettirmiyor.
    - Düzeltme: eylem sonunda aynı adrese `redirect()` (`shell.tsx` →
      `cycleTheme`; adres istemciden gizli alanla geliyor ve açık
      yönlendirmeye karşı doğrulanıyor).
    - Ölçüm: öncesi 8/12 ve 5/12 asılı → sonrası **0/12**. Mutasyonla
      doğrulandı: yönlendirme kaldırılınca `e2e/t109-tema.spec.ts` ilk
      tıklamada kırmızı yanıyor.

  - **(b) HAREKET KAYDI — AÇIK.** Aynı sınıf, farklı yüzey ve düzeltmesi
    daha derin. Ölçüm (hata yolu, 12 tur): sunucu eylemi çalışıyor,
    `Next-Action` POST'u **303 dönüyor**, ve istemci yönlendiricisi turların
    **3-5'inde o yönlendirmeyi SESSİZCE DÜŞÜRÜYOR** — `framenavigated`
    olayı hiç ateşlenmiyor, konsolda ve ağda hata yok.
    - Kullanıcı için: "Kaydet'e bastım, hiçbir şey olmadı."
    - Çift kayıt riski YOK: idempotency anahtarı okutma anında üretiliyor ve
      sayfa gezinmediği için ikinci basış aynı anahtarı gönderiyor (D-1.3).
      Ama kullanıcı sayfayı YENİLERSE yeni anahtar üretilir.

  - **ELENEN AÇIKLAMALAR (hepsi ölçüldü, hiçbiri sebep değil):**
    - *Hidratasyon yarışı:* tıklama anında Kaydet formu HER ZAMAN hidrat
      (`__reactFiber$` izi var) — asılan turlarda da.
    - *`Link` ön getirme:* kapatınca 3-5/10 yerine 2/12. Azaltıyor,
      ÇÖZMÜYOR — ve gezinme hızını düşürdüğü için geri alındı.
    - *`loading.tsx`:* varken 3/10, yokken 2/10. Fark yok.
    - *`SessionKeepAlive`:* isteği hiç ateşlenmiyor (yalnızca sunucu çerezi
      yazamadığında basılıyor).
    - *Başarı yolu:* sert gezinmeden sonra 0/12 — arıza yumuşak gezinme
      geçmişi olan sayfalarda yoğunlaşıyor.

  - **SIRADAKİ ADIM, BU SIRAYLA:**
    1. **Next 16'ya yükselt (T105).** Bu, App Router'ın kendi yönlendirici
       hatası gibi görünüyor: sunucu her seferinde doğru cevabı üretiyor.
       Sürüm yükseltmesi denenmeden altyapı değiştirmek erken olur.
    2. Düzelmezse **Kaydet formunu sunucu eyleminden düz bir POST rotasına
       çevir** (`POST /hareket/kaydet` → 303). Tarayıcının kendi gezinmesi
       yönlendiriciye hiç uğramaz, yani arıza sınıfı tamamen kapanır ve
       ekran JS'siz de çalışır hale gelir (T110). Bedeli: sunucu
       eylemlerinin hazır getirdiği kaynak (origin) kontrolü elle
       yazılmalı — CSRF açığı bırakmadan.

  - `faz10-fiyat.spec.ts` üzerindeki `@kararsiz` etiketi DURUYOR ama
    gerekçesi düzeltildi: testler kırılgan değil, gerçek hatayı yakalıyorlar.
    T109(b) kapandığında etiket silinip CI kapısına alınacaklar.
- [ ] **T91 (P1, human: ~2sa / CC: —)** - araştırma - Üç senaryoyu gerçek kullanıcıda gözlemle
  - Neden: Talep kanıtı zayıf. Üç senaryonun hangisinin gerçekten tıkanmaya
    yol açtığı ayrıştırılmadı ve **bugünkü çözüm hiç sorulmadı** — kullanıcı o
    10 ₺ farkı bugün ne yapıyor bilmiyoruz. Bugün yaptığı şey rakiptir; yeni
    alan onu yenmek zorunda.
  - **(1) CEVAPLANDI 2026-08-30:** bugünkü çözüm YOK. Fiş liste fiyatını
    yazıyor, kasadan eksik para çıkıyor, fark hiçbir yere kaydedilmiyor.
    Status quo "kasa açık veriyor ve kimse nedenini yazmıyor" — T88'in
    yenmesi gereken şey bu. Kalan iki soru duruyor.
  - Öğrenilecek iki şey: (2) 5 yıllık
    ürünün eski faturası var mıydı — varsa T90'ın pahalı endeks yarısı hiç
    gerekmeyebilir; (3) enflasyon zararını satarken mi sonradan mı fark etti —
    satarken ise uyarı doğru yerde, sonradan ise asıl ihtiyaç rapor.
  - **T90 başlamadan önce yapılmalı**, T88 buna bakmadan yazılabilir.

**Açık kalan sorular (belgede tam listesi):** Yİ-ÜFE verisi elle mi otomatik
mi; `DAMAGE`/`USAGE` çıkışlarında fiyat ne olmalı (öneri: NULL, para el
değiştirmedi); "yeterince yeni alış" eşiği 90 gün mü; `unit_cost` yeniden
adlandırması onaylanıyor mu.


### Faz 11: CI incelemesi (2026-08-30)

CI'ın çekirdeği sağlam: gerçek PostgreSQL 17 (sürüm `docker-compose.yml` ile
aynı), migration drift kontrolü, dört adım CLAUDE.md'deki bitmiş sayılma
ölçütüyle birebir. İnceleme bunları değil, **neyin hiç sınanmadığını** buldu.

- [x] **T93 (P1, human: ~4sa / CC: ~40dk)** - altyapı - **Duman testi: temiz checkout'tan girişe giden yol CI'da yürünsün**
  - **CI bugüne kadar kullanıcıya görünen tek bir hata yakalamadı.** T57, T58,
    T59, T61 — dördü de P1, dördü de kullanıcı testinde çıktı, dördü de CI
    yeşilken vardı. Ortak noktaları tek cümlede toplanıyor: hepsi temiz
    checkout'tan çalışan uygulamaya giden yolda. CI o yolu hiç yürümüyordu;
    `pnpm install` ile başlayıp `next build` ile bitiyordu.
  - **DÜZELTME: ilk yazımdaki "curl yeterli" YANLIŞTI.** Giriş bir Server
    Action (`giris/page.tsx` içinde `'use server'`); çağırmak için derlemeye
    göre değişen bir `Next-Action` kimliği gerekiyor, `curl` ile
    sürdürülebilir şekilde tetiklenemez. Asıl kanıt falsifikasyondan geldi:
    T58 geri getirildiğinde `GET /giris` **200 dönmeye devam etti** ve
    oturumsuz yönlendirme de çalıştı; yalnızca giriş denemesi düştü. Yani
    curl ile GET probe'u yapan bir duman testi, var olma sebebi olan hatayı
    kaçırırdı.
  - **Yapılan:**
    - `scripts/demo.mjs` → `--no-server`. Bilinmeyen bayrak artık exit 1:
      `--noserver` yazım hatası sessiz geçseydi sunucu ön planda açılır ve
      iş akışı zaman aşımına kadar beklerdi, logda da ipucu olmazdı.
    - `apps/web/playwright.config.ts` + `e2e/demo-yolu.spec.ts` (4 senaryo).
      Sunucuyu Playwright açıp kapatıyor; arka plana atıp `curl` ile beklemek
      "açık port hazır demek değil" hatasını (T59) iş akışında tekrarlardı.
    - `.github/workflows/ci.yml` → `smoke` işi. **Servis konteyneri YOK ve
      `.env` elle yazılmıyor:** ikisi de olsaydı `pnpm demo`'nun kurduğu şey
      atlanır ve sınadığımızı sandığımız yol hiç koşmazdı.
    - `apps/web/tsconfig.json` → `e2e` ve `playwright.config.ts` kapsama
      alındı. Kapsam dışıyken bozuk bir spec ancak CI'da çalışırken patlardı.
  - **Falsifikasyonla doğrulandı (`dogrula` yordamı):**
    - **T58 geri getirildi** (kök `.env` yüklemesi kaldırıldı, açılış
      kontrolü etkisizleştirildi ki sunucu T58'deki gibi AÇILSIN): testler 3
      ve 4 kırmızı, 1 ve 2 yeşil kaldı, `Exit status 1`.
    - **Çalışana `price:read` verildi:** yalnızca 4. test kırmızı,
      `Expected: 0, Received: 1` — "Stoktaki değer" kartı göründü. Test,
      matrisin kendisini değil **rotanın matrisi çağırdığını** ölçüyor
      (tehdit S7).
    - **Panel oturum koruması kaldırılamadı:** `next build` tip kontrolünde
      reddediyor, çünkü `actor` null olabiliyor. O koruma testten önce TİP
      SİSTEMİ tarafından tutuluyor; bu yolla falsifiye edilemedi ve
      edilmesine gerek de yok.
    - Üç koruma da geri kondu; `git status` ve grep ile teyit edildi.
  - **Yeşil:** `pnpm typecheck` (4 paket), `pnpm test` (494 test),
    `next build`, duman testi 4/4.
  - **GERÇEK KOŞUDA DOĞRULANDI** (run 33318396877, PR #1): `smoke` işi
    1m33s'te yeşil. Runner'da `docker compose` kalktı, Playwright
    `--with-deps chromium` kuruldu, dört senaryo 5.8 sn'de geçti.
    Aynı koşuda `typecheck + test` de yeşil: migration drift kontrolü,
    testler ve web derlemesi 25 Ağustos'tan beri İLK KEZ çalıştı
    (typecheck ilk kapı olduğu için hepsi bloke duruyordu).
  - Kaynak: CI incelemesi 2026-08-30

- [x] **T94 (P1, human: ~1,5g / CC: ~2sa)** - web - **`apps/web` test yüzeyi: rota yetki kontrolleri ve oturum**
  - **7584 satır kod, sıfır test.** Projenin en büyük paketi bu ve `pnpm test`
    onu SESSİZCE atlıyor: `apps/web/package.json` içinde `test` scripti yok,
    `pnpm -r --if-present test` uyarı bile vermiyor.
  - **Somut arıza:** `packages/core/role-matrix.test.ts` yetki matrisini test
    ediyor, ama bir rotanın o matrisi ÇAĞIRDIĞINI kimse test etmiyor. Yetki
    kontrolü unutulmuş bir rota typecheck'ten geçer, testten geçer, CI yeşil
    yanar, çalışan Excel indirir. Tehdit S6/S7'nin gerçekten zorlandığı katman
    burası ve tamamen kapsamsız.
  - **Öncelik sırası:** beş API rotası (`arama`, `rapor/hareket`, `rapor/stok`,
    `rapor/sablon`, `rapor/aktarim-hatalari`) ve `server/session.ts`. Ekran
    testleri T92'deki Playwright işine bağlı, burada tekrarlanmıyor.
  - Alternatif: rotaları `packages/core`'a ince kabuk yapıp orada test etmek.
    Kabuk inceldikçe test değeri düşer, ama "kabuk gerçekten ince mi" sorusu
    yine bir test istiyor. Bu yüzden rota testi yazılıyor.
  - Doğrula: bir rotadan yetki kontrolünü geçici olarak kaldır, testin kırmızı
    yandığını gör, geri koy.
  - **KAPSAM DÜZELTMESİ.** "7584 satır" rakamı sayfa bileşenlerini de
    içeriyordu ve onlar T92'nin Playwright işine ait. Gerçekten test
    edilebilir sunucu mantığı ~830 satır: `server/` (648) ve beş rota (184).
    Rotalar ince; yetki kontrolü core'da, rota `requireActor()` çağırıp
    aktörü core'a geçiriyor.
  - **YAPILDI (rota katmanı):** `apps/web` artık `pnpm test`'e dahil.
    vitest koşumu kuruldu; sahtelenen TEK sınır `next/headers` (çerez
    kavanozu) ve `server-only`. Veritabanı, core'un yetki mantığı ve rota
    kodu gerçek koşuyor — core sahtelenseydi test "sahtenin sahteyi
    çağırdığını" doğrulamış olurdu.
    `src/app/api/route-authz.test.ts`, 14 test, üç arıza sınıfı:
    oturumsuz erişim, hata sözleşmesi yerine ham 500, çalışanın yetkisiz
    uca ulaşması.
  - **YOL BOYUNCA ÖĞRENİLEN:** `rapor/sablon` bilerek her oturumlu
    kullanıcıya açık (rotanın kendi gerekçesi: içerik kişiye özel değil,
    ama sütun adları iç yapıyı anlattığı için oturum isteniyor). Test bu
    kararı değiştirmiyor, sessizce değişirse haber veriyor.
  - **FALSİFİKASYONLA DOĞRULANDI (`dogrula`):** `rapor/sablon`'dan
    `await requireActor()` **ve** import'u silindi. Sonuç: `tsc --noEmit`
    TEMİZ, `next build` geçiyor, 494 core/db/shared testi yeşil — yalnızca
    bu test kırmızı (`rapor/sablon oturumsuz 200 döndü`). Yani uç oturumsuz
    herkese açılırdı ve bu testten başka hiçbir şey haber vermezdi.
    O rota özellikle savunmasız çünkü `requireActor()` sonucunu
    KULLANMIYOR; tip sistemi orada yardım edemiyor.
  - **YAPILDI (oturum katmanı), `src/server/session.test.ts` 17 test:**
    `secureCookies()` dört durumu (https, düz http, `APP_URL` yok, adres
    çözümlenemiyor); çerez seçenekleri (`httpOnly`, `sameSite: lax`, iki
    farklı ömür); çıkışta İKİ çerezin de silinmesi (yenileme çerezi kalsaydı
    bir sonraki istek oturumu sessizce geri getirirdi); sessiz yenileme yolu;
    salt okunur çerez deposunda çökmeme (T87 / 4b008e2).
  - **`secureCookies()` bu dosyanın en önemli testi.** Yanlış hesaplanınca
    ortaya çıkan arıza SESSİZ: LAN'da düz HTTP ile servis edilen kurulumda
    tarayıcı `Secure` çerezi saklamaz ve giriş ekranı hiçbir hata
    göstermeden kendini tekrar eder.
  - **YAPILDI (form katmanı), `src/server/form.test.ts` 21 test:**
    `rethrowControlFlow` (Next yönlendirmesi yutulursa BÜTÜN form
    gönderimleri sessizce hiçbir yere gitmez); `HIDDEN_DETAIL_KEYS` sızıntısı
    (iç kimlikler adres çubuğuna düşmemeli); beklenmeyen hatanın mesajının
    kullanıcıya gitmemesi; `logServerFault`'un yalnızca 5xx yazması (T61);
    `optional` (girilmedi) ile `nullable` (temizlendi) ayrımı — karışsaydı
    bir kez girilen alış fiyatı bir daha boşaltılamazdı; Türkçe ondalık
    virgülü; sayıya çevrilemeyen metnin sessizce 0 OLMAMASI.
  - **FALSİFİKASYONLA DOĞRULANDI (`dogrula`), üç ayrı koruma:**
    - `rapor/sablon`'dan `requireActor()` VE import'u silindi: typecheck
      temiz, build geçer, 494 diğer test yeşil — yalnızca rota testi
      kırmızı. O rota özellikle savunmasız çünkü `requireActor()` sonucunu
      kullanmıyor, tip sistemi yardım edemiyor.
    - `secureCookies()` kodun yorumunun uyardığı yanlış implementasyona
      (`NODE_ENV` tabanlı) çevrildi: `Secure` açık olması gereken üç durum
      kırmızı. Düz http durumu tesadüfen doğru kaldı — dört durumun birden
      sınanmasının sebebi bu.
    - `rethrowControlFlow`'un `throw err` satırı kaldırıldı: iki test
      kırmızı. `session.ts`'teki `try/catch` kaldırıldığında da iki test,
      kullanıcının ekranında 500 üretecek tam o istisnayla düştü.
    - Üç koruma da geri kondu, grep ile teyit edildi.
  - **KAPSAM DIŞI BIRAKILAN:** `server/theme.ts` (108 satır). Tema çerezi
    okuma/yazma; en kötü arızası yanlış tema gösterilmesi. Sessiz veri
    kaybı veya yetki sızıntısı üretmiyor, o yüzden bu görevin kapsamına
    alınmadı. Sayfa bileşenleri T92'nin Playwright işinde.
  - **Yeşil:** typecheck (4 paket), test 546 (shared 56, db 53, core 385,
    web 52), web derlemesi, migration drift yok.
  - Kaynak: CI incelemesi 2026-08-30

- [x] **T95 (P2, human: ~2sa / CC: ~20dk)** - altyapı - **Linter kur ya da sahte `pnpm lint` scriptini kaldır**
  - Kök `package.json` içinde `"lint": "pnpm -r --if-present lint"` duruyor.
    Hiçbir pakette `lint` scripti yok, depoda hiç linter kurulu değil. Komut
    çalışır, 0 döner, hiçbir şey yapmaz.
  - **Neden önemli:** yeşil yanan boş komut, kırmızıdan kötüdür. Biri "lint
    geçiyor" diye rapor eder ve kontrolün hiç var olmadığını kimse bilmez.
  - Öneri: Biome (tek bağımlılık, formatter + linter, hızlı). ESLint yerine
    seçilme sebebi eklenti zincirinin bakım yükü.
  - Alternatif: scripti silmek. Kabul edilebilir, ama **T45** (route handler'da
    doğrudan `db` kullanımını yasaklayan kural, D5'in makine zorlaması) bir
    linter olmadan hiç yazılamaz.
  - Doğrula: kasten kural ihlali içeren bir dosya ekle, `pnpm lint` kırmızı
    yansın, sonra sil.
  - **YAPILDI:** Biome 2.5.11 kuruldu, `biome.json` yapılandırıldı, kök
    `lint` scripti gerçek hâline getirildi (`biome lint .`) ve CI'da
    typecheck'ten ÖNCE koşuyor — saniyeler sürüyor ve tip sisteminin
    yakalayamadığı sınıfı yakalıyor.
  - **174 tanı → 0.** Yol, kuralları körlemesine kapatmak değildi:
    - `noNonNullAssertion` **kapalı** (174 tanının 128'i). `tsconfig`'de
      `noUncheckedIndexedAccess` açık; testte `!` kullanmak o ayarın
      doğrudan sonucu, stil hatası değil.
    - `noAutofocus` **kapalı**. PLAN.md Bölüm 11: "Barkod okuyucu = klavye
      emülasyonu, arama kutusu sayfa açılınca otomatik odaklanmalı."
      Kural bu üründe yanlış; bilinçli bir ürün kararına karşı çıkıyor.
    - `useSemanticElements` **kapalı**. `<search>` öğesi yeni ve tarayıcı
      desteği eşit değil; `<form role="search">` yaygın ve güvenilir kalıp.
    - `.claude/` hariç tutuldu: vendor gstack kopyası, depoya ait değil.
  - **GERÇEK İYİLEŞTİRME:** 18 dekoratif SVG ikona `aria-hidden="true"`
    eklendi (5 dosya). İkonlar metnin yanında duruyor (PLAN.md: renk +
    ikon + metin); ekran okuyucu için doğru davranış onları atlamak, başlık
    eklemek aynı bilgiyi iki kez okutur.
  - **İKİ GERÇEK DÜZELTME:** `nav-items.tsx` string birleştirme → şablon
    dizesi; `aktar/page.tsx`'te cümle noktalaması açık bir JSX ifadesine
    alındı (`{";"}`) — JSX artığı bir noktalı virgülle karışmasın.
  - **ALTI GEREKÇELİ BASTIRMA.** Gerekçesiz bastırma kuralı hiç açmamakla
    aynı şey; her biri NEDEN'i yazıyor. En önemli ikisi kuralın YANILDIĞI
    yerler: `save-feedback.tsx`'te `signature` bağımlılığı efekt gövdesinde
    kullanılmıyor ama olay da bu — yeniden tetikleme anahtarı, kaldırılsa
    ikinci kayıtta ses duyulmazdı (T79/T81). `command-palette.tsx`'te arka
    plana tıklama klavye kullanıcısını dışarıda bırakmıyor: `Escape` zaten
    dinleniyor ve kapsayıcı `role="dialog"` taşıyor.
  - **YOL BOYUNCA ÇIKANLAR:**
    - `badge.tsx`'teki dört ikonda `aria-hidden` ZATEN VARDI, yayılmış
      (`{...common}`) prop'tan geliyordu. Biome bunu çözemediği için yanlış
      pozitif veriyor; dosya başına gerekçeli bastırma kondu.
    - `movements.test.ts`'te hiçbir kuralı bastırmayan ÖLÜ bir
      `biome-ignore` vardı, kaldırıldı.
    - `biome-ignore` satırı hedefin HEMEN üstünde olmalı. Açıklama
      satırları onu aşağı itince bastırma tutmuyor ve Biome hem ihlali hem
      "kullanılmayan bastırma" uyarısını veriyor. Açıklama önce,
      `biome-ignore` en sonda.
  - **T45 AÇILDI.** Route handler'da doğrudan `db` kullanımını yasaklayan
    kural (D5'in makine zorlaması) artık yazılabilir; linter olmadan
    imkânsızdı.
  - **FALSİFİKASYONLA DOĞRULANDI (`dogrula`):** `a == b` içeren geçici bir
    dosya eklendi, `pnpm lint` `noDoubleEquals` ile **exit 1** verdi, dosya
    silindi. Eski script de sıfırla dönüyordu — fark tam olarak bu.
  - **Yeşil:** lint (146 dosya, 0 tanı), typecheck (4 paket), test 546,
    web derlemesi, migration drift yok.
  - Kaynak: CI incelemesi 2026-08-30

- [x] **T96 (P2, human: ~2sa / CC: ~30dk)** - altyapı - **Windows CI işi**
  - Proje Windows'ta geliştiriliyor ve CLAUDE.md'de "Windows tuzakları
    (yaşandı, tekrar etmesin)" başlıklı ayrı bir bölüm var. `scripts/demo.mjs`
    tamamen Windows yüzünden yazıldı (T57). Ama CI yalnızca `ubuntu-latest`
    üstünde koşuyor: o tuzakların tekrar etmediğini kimse doğrulamıyor.
  - **Somut arıza:** `pnpm --filter X <script>` Windows'ta
    `'migrate' is not recognized` veriyor. T57'de on iki çağrıya `run` eklendi.
    On üçüncüsü eklendiğinde CI susacak ve hatayı yine kullanıcı bulacak.
  - **Kapsam:** typecheck + web derlemesi + T93 duman testi. Tüm test paketini
    Windows'ta koşturmak gerekmiyor; oradaki riskler platformdan bağımsız ve
    koşu süresini iki katına çıkarır.
  - Alternatif: ayrı bir job. Matrix seçiliyor çünkü adımlar aynı; ikinci bir
    job ikinci bir kaynak olur ve zamanla ayrışır.
  - Doğrula: bir `pnpm --filter X run <script>` çağrısından `run` kelimesini
    kaldır, Windows işinin kırmızı yandığını gör.
  - **YAPILDI, İKİ PARÇA:**
    - **Statik tarama** (`scripts/check-pnpm-filter.mjs`, CI'da her
      platformda koşuyor): `pnpm --filter X <script>` kullanımını
      yasaklıyor. Dokümantasyon yer tutucuları (`<script>`) hariç
      tutuluyor — yoksa koruma kendi varlık sebebini açıklayan metni
      suçlar ve ilk çare onu kapatmak olurdu.
    - **Windows işi** (`windows-latest`): lint + typecheck + web derlemesi.
  - **KORUMA HEMEN BİR HATA BULDU.** `packages/db/src/testing.ts:62`,
    kullanıcıya gösterilen hata mesajının içinde: "komutu paket dizininden
    çalıştır" derken filtreden sonra doğrudan script adını yazıyordu, arada
    `run` yok. Yani mesaj Windows kullanıcısına ÇALIŞMAYAN bir komut
    öneriyordu. T57'nin on üçüncü
    örneği, tam da öngörülen yerden çıktı. Düzeltildi.
  - **NEDEN İKİ PARÇA.** Windows işi bu çağrıların çoğunu KOŞMUYOR:
    README'deki, hata mesajlarındaki ve dokümandaki komutlar hiç
    çalıştırılmıyor — bulunan hata da tam olarak öyle bir yerdeydi. Statik
    tarama orayı görüyor, koşan bir test görmüyor.
  - **WINDOWS İŞİ NE KAPSAMIYOR VE NEDEN:** veritabanına dokunan hiçbir şey.
    GitHub'ın Windows koşucusunda Linux konteyneri çalışmıyor; ne
    `postgres:17-alpine` servis konteyneri ne de `pnpm demo`nun kaldırdığı
    Docker kullanılabiliyor. Windows'a yerel Postgres kurmak mümkün ama
    koşuyu dakikalarca uzatır ve testlerin veritabanı tarafı platformdan
    bağımsız olduğu için kazancı düşük.
  - **FALSİFİKASYONLA DOĞRULANDI (`dogrula`):** `package.json`a geçici
    olarak filtreden sonra doğrudan script adı yazan bir kayıt eklendi,
    geri alındı. Temiz hâlde 180 dosya tarayıp 0 dönüyor.
  - **Korumanın kendi kısıtı:** bozuk biçimi ANLATMAK için birebir
    alıntılayan metin de yakalanıyor. Kaçış kapısı EKLENMEDİ; kaçış
    kapısı zamanla istismar edilir ve koruma anlamını yitirir. Bunun
    yerine belgeler biçimi üretmeden anlatıyor.
  - Yan not: linter, yeni yazılan bu betikte kullanılmayan bir import
    yakaladı. T95 daha ilk gününde işini yaptı.
  - **Yeşil:** tarama temiz, lint (0 tanı), typecheck (4 paket).
  - Kaynak: CI incelemesi 2026-08-30

- [x] **T97 (P2, human: ~10dk / CC: ~5dk)** - güvenlik - **CI `permissions:` bloğu**
  - İş akışında `permissions:` yok. `GITHUB_TOKEN`'ın varsayılan izinleri
    repo ve organizasyon ayarına bağlı; eski repolarda yazma yetkili geliyor.
    Bir action ya da bir bağımlılığın postinstall'ı o tokenı kullanabilir.
  - Düzeltme tek satır: `permissions:` altında `contents: read`. İş akışı
    hiçbir şey yazmıyor, daha fazlasına ihtiyacı yok.
  - Doğrula: koşu logundaki "GITHUB_TOKEN Permissions" bloğunda yalnızca
    `contents: read` görünsün.
  - **Yapıldı:** iş akışının başına `permissions:` / `contents: read`.
    Bu iş akışı hiçbir şey yazmıyor, daha fazlasına ihtiyacı yok.
  - Kaynak: CI incelemesi 2026-08-30

- [x] **T98 (P3, human: ~30dk / CC: ~10dk)** - güvenlik - **Action'ları commit SHA'sına sabitle**
  - `actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4`
    hareketli etiketler ve etiket sahibi tarafından taşınabilir. Ele geçirilen
    bir action CI ortamındaki her değişkeni okuyabilir.
  - **Bugün P3 çünkü** CI'daki `MIGRATION_DATABASE_URL` ve `AUTH_SECRET`
    zaten sabit ve iş akışında açıkta duruyor; kaybedilecek sır yok.
    **T42 (deploy) gerçek sırlarla geldiğinde bu P1 olur.**
  - Doğrula: `@v4` yerine tam SHA, yanına yorumda sürüm; güncellemeyi
    Dependabot açsın (T102).
  - **Yapıldı:** yedi `uses:` referansının tamamı commit SHA'sına sabitlendi
    (checkout v4.4.0, pnpm/action-setup v4.3.0, setup-node v4.4.0,
    upload-artifact v4.6.2), sürüm yanlarında yorumda.
  - **İncelik:** `pnpm/action-setup`'ın `v4`'ü ANOTASYONLU etiket.
    `f40ffcd` etiket NESNESİNİN SHA'sı; Actions commit SHA'sı bekliyor,
    o yüzden `v4^{}` ile çözülen `b906aff` yazıldı. Etiket nesnesi
    yazılsaydı iş akışı action'ı çözemezdi.
  - Doğrulandı: dördü de `git ls-remote` ile upstream'de aranıp
    beklenen etiketlere denk geldiği görüldü.
  - Kaynak: CI incelemesi 2026-08-30

- [x] **T99 (P3, human: ~20dk / CC: ~10dk)** - altyapı - **Node sürümünü sabitle**
  - CI Node 22 kullanıyor, geliştirme makinesi Node 24, `engines` yalnızca
    `>=22` diyor, `.nvmrc` yok. Üretimde hangi sürümün koşacağı hiçbir yerde
    yazmıyor.
  - Yön şu an tesadüfen iyi: CI daha eski sürümde koştuğu için Node 24'e özgü
    bir API kullanımı CI'da yakalanır. Tesadüf, karar değil; ters çevrilse
    (CI 24, geliştirme 22) hatayı üretimde öğrenirdik.
  - Düzeltme: `.nvmrc` eklensin, CI `node-version-file` ile onu okusun,
    `engines` daraltılsın.
  - Doğrula: `.nvmrc` değiştir, CI logunda o sürümün kurulduğunu gör.
  - **Yapıldı:** `.nvmrc` (22) eklendi, iki iş de `node-version-file`
    ile onu okuyor, `engines` `>=22 <25`e daraltıldı.
  - **Sürüm DEĞİŞTİRİLMEDİ.** CI zaten 22 koşuyordu; tek değişen, sürümün
    iş akışından tek bir kaynağa taşınması. Geliştirme makinesi 24'te;
    nvm/fnm kullanan biri artık CI ile aynı sürüme hizalanıyor. 22 mi 24
    mü sorusu ayrı bir karar ve burada verilmedi.
  - Kaynak: CI incelemesi 2026-08-30

- [x] **T100 (P3, human: ~10dk / CC: ~5dk)** - altyapı - **`concurrency` master koşularını iptal etmesin**
  - `concurrency.group` dal referansına bağlı ve `cancel-in-progress: true`.
    Master'a arka arkaya iki push gelirse birincisi iptal ediliyor ve o
    commit'in durumu hiç bilinmiyor.
  - Bugün zararsız çünkü deploy yok. **T42 geldiğinde** deploy yeşil koşuya
    bağlanacak ve iptal edilmiş bir commit "başarısız" gibi görünecek.
  - Düzeltme: `cancel-in-progress` yalnızca master DIŞINDAKİ dallarda açık
    olsun (ifade `github.ref` karşılaştırmasıyla yazılır).
  - **Yapıldı:** `cancel-in-progress` master dışındaki dallara
    sınırlandı; master koşuları artık iptal edilmiyor.
  - Kaynak: CI incelemesi 2026-08-30

- [x] **T101 (P3, human: ~3sa / CC: ~30dk)** - test - **Kapsam ölçümü**
  - 316 test ve 5052 satır test kodu var, ama hangi satırların kapsandığı
    ölçülmüyor. `apps/web`'in sıfır testi (T94) hiçbir sayıda görünmüyor; bu
    incelemede ancak `package.json` elle okunarak fark edildi.
  - Ölçülmeyen boşluk tartışılmıyor. Eşik koymak şart değil, rakamın PR'da
    görünmesi yeterli.
  - Alternatif: eşik koyup CI'ı kırmak. Seçilmedi — düşük kapsamlı ama doğru
    bir değişikliği bloklamak, kapsamı test yazarak değil test silerek
    yükseltmeye teşvik eder.
  - Doğrula: `vitest --coverage` çıktısında `apps/web` yüzde sıfır görünsün.
  - **YAPILDI:** `@vitest/coverage-v8`, dört pakete `test:coverage`, CI'da
    `Testler` adımı kapsamla koşuyor (testi iki kez koşturmamak için).
  - **BOŞLUK ARTIK BİR RAKAM:**
    `packages/core %93,6` · `packages/shared %91,7` ·
    `packages/db %48,3` · `apps/web %7,3`
  - `apps/web`'in %7'si beklenen ve T94'ün kapsam düzeltmesini doğruluyor:
    geri kalanı sayfa bileşenleri, yani T92'nin Playwright alanı.
    `packages/db`'nin %48'i seed/init gibi CLI betiklerinden.
  - **EŞİK KONMADI, bilinçli.** Eşik, kapsamı test yazarak değil test
    silerek yükseltmeye teşvik eder. Rakamın PR logunda görünmesi yeterli:
    ölçülmeyen boşluk tartışılmıyor, görünen boşluk tartışılıyor.
  - **Kurulum tuzağı:** `@vitest/coverage-v8` varsayılan olarak v4 çekti,
    paketler ise vitest 3'te. "Running mixed versions is not supported"
    uyarısı verip `reportsDirectory` okunamadı diye patladı. Sürüm eşlendi.
  - Kaynak: CI incelemesi 2026-08-30

- [x] **T102 (P3, human: ~30dk / CC: ~15dk)** - güvenlik - **Dependabot ve bağımlılık denetimi**
  - `.github` altında yalnızca `ci.yml` var. Bağımlılık güncellemesi elle,
    bilinen açık taraması hiç yok. `pnpm audit` çıktısına hiç bakılmamış
    olması, açığın yokluğu anlamına gelmiyor.
  - Kapsam: `.github/dependabot.yml` (npm + github-actions, haftalık) ve
    CI'da **bloklamayan** bir `pnpm audit --audit-level=high` adımı.
  - Alternatif: audit'i bloklayıcı yapmak. Seçilmedi — hemen düzeltilemeyen
    bir transitive açık bütün geliştirmeyi durdurur ve ilk çare kontrolü
    kapatmak olur.
  - **YAPILDI:** `.github/dependabot.yml` (npm + github-actions, haftalık,
    küçük sürümler tek PR'da gruplu) ve CI'da **bloklamayan**
    `pnpm audit --audit-level=high` adımı.
  - **İLK KOŞUDA DÖRT YÜKSEK ŞİDDETLİ AÇIK BULDU.** Biri doğrudan
    bağımlılıkta ve bu projenin güvenlik modelinin tam kalbinde:
    **`drizzle-orm`, yanlış kaçırılmış SQL tanımlayıcıları üzerinden SQL
    injection.** 0.44.7 kullanılıyordu, düzeltme 0.45.2'de.
    Yükseltildi; lint, typecheck, migration drift ve 546 test yeşil kaldı.
  - Kalan üçü (`sharp`, `postcss` ×2) Next üzerinden geçişli ve Next
    yükseltmesi gerektiriyor → **T104**.
  - **NEDEN BLOKLAMIYOR:** hemen düzeltilemeyen bir geçişli açık bütün
    geliştirmeyi durdurursa ilk çare adımı kapatmak olur. Görünür olması,
    bloklaması değil, işi görüyor — nitekim ilk koşuda gördü.
  - Kaynak: CI incelemesi 2026-08-30

- [x] **T103 (P3, human: ~30dk / CC: ~15dk)** - altyapı - **Action'ları v5 hattına taşı (Node 20 kullanımdan kalkıyor)**
  - **İLK GERÇEK KOŞUDA ORTAYA ÇIKTI** (run 33318396877). Sabitlenen `v4`
    hatları Node 20 hedefliyor; GitHub şu an zorla Node 24'te çalıştırıyor
    ve her koşuda uyarı basıyor:
    `actions/checkout`, `actions/setup-node`, `pnpm/action-setup`.
  - **Neden şimdi P3, ne zaman P1 olur:** bugün yalnızca uyarı, koşu yeşil.
    Zorlama kaldırıldığında action'lar hiç başlamayacak ve CI tamamen
    durur — o an P1 olur ve aceleye gelir. Şimdi yapmak ucuz.
  - **Kapsam:** `v5` hattının commit SHA'larına geç. T98'deki incelik
    burada da geçerli: anotasyonlu etiketlerde `git ls-remote <repo>
    'refs/tags/v5^{}'` ile ETİKET NESNESİNİN değil COMMIT'in SHA'sı
    alınmalı; Actions commit SHA'sı bekliyor.
  - Doğrula: push sonrası koşuda "Node.js 20 is deprecated" uyarısı
    kalmamalı.
  - **YAPILDI:** on `uses:` referansının tamamı v5 hattına, commit
    SHA'sıyla: checkout v5.1.0, setup-node v5.0.0, upload-artifact v5.0.0,
    pnpm/action-setup v5.0.0. Dördü de `git ls-remote` ile upstream'de
    doğrulandı.
  - T98'deki incelik burada da geçerliydi: `pnpm/action-setup`'ın etiketi
    anotasyonlu, `v5^{}` ile çözülen commit yazıldı.
  - **Doğrulanacak:** "Node.js 20 is deprecated" uyarısının kalkması ancak
    gerçek koşuda görülebilir; v5 hattının bu depoda sorunsuz çalıştığı da
    öyle. Bir sonraki CI koşusunda bakılacak.
  - Kaynak: CI incelemesi 2026-08-30, ilk gerçek koşu



- [x] **T104 (P2, human: ~1g / CC: ~2sa)** - altyapı - **Next yükseltmesi: üç geçişli yüksek şiddetli açık**
  - **T102'NİN İLK KOŞUSUNDA ÇIKTI.** `pnpm audit` üç yüksek şiddetli açık
    buluyor ve üçü de Next üzerinden geçişli: `sharp` (libvips CVE'leri) ve
    `postcss` ×2 (keyfi dosya okuma; source map üzerinden dizin gezinme).
  - **Neden P2, P1 değil:** üçü de DERLEME zamanı bileşenleri. `postcss`
    derlemede koşuyor, `sharp` görsel işlemede — ve bu üründe ürün
    görselleri `next/image` ile değil düz bir img etiketiyle gösteriliyor
    (T82-T84, adres kullanıcıdan geliyor). Yine de saldırı yüzeyi ve denetim
    kaydı için kapatılmalı.
  - **Kapsam:** Next sürümünü açıkların kapandığı hatta çıkar, sonra
    `pnpm audit` temiz mi bak.
  - **Yükseltme sonrası ZORUNLU:** duman testi (T93) ve web derlemesi. Next
    yükseltmeleri modül çözümlemesini etkiliyor ve `next.config.ts`teki
    `extensionAlias` ayarı kırılgan; bozulursa typecheck yeşil kalır,
    derleme patlar.
  - Doğrula: `pnpm audit --audit-level=high` yüksek şiddetli açık
    döndürmemeli; duman testi 4/4 kalmalı.
  - Kaynak: CI incelemesi 2026-08-30, T102 ilk koşusu
  - **KAPANDI, ama görevin varsayımı yanlıştı.** "Sürümü açıkların
    kapandığı hatta çıkar" diyordu; 15.x hattında öyle bir sürüm YOK.
    En yeni 15.5.24 bile `postcss`'i **8.4.31'e sabitliyor** ve yama
    8.5.18'de. Sürüm yükseltmek tek başına çözmüyor.
  - `sharp` farklıydı: Next'in kendi aralığı zaten `^0.34.3 || ^0.35.3`,
    yani yamalı hat destekleniyordu; pnpm sadece alt sınırı seçmişti.
  - Çözüm `pnpm-workspace.yaml` içinde `overrides`. package.json'daki
    `pnpm.overrides` alanı pnpm 11'de OKUNMUYOR — depo zaten `allowBuilds`
    ayarını workspace dosyasında tutuyor, override da oraya ait.
  - postcss override'ı yeni sürüm getirmiyor: depoda Tailwind için zaten
    8.5.26 vardı, ağaç tek sürüme indi.
  - Next 16 ikisini de kaynağında çözerdi (postcss 8.5.23, sharp ^0.35.3)
    ama major yükseltme; derleme zamanı bir P2 açığı için orantısız risk.
    Ayrı görev: **T105**.
  - Doğrulandı: `pnpm audit --audit-level=high` yüksek açık döndürmüyor
    (3 high + 2 moderate kapandı), lint temiz, typecheck temiz, 546 test
    yeşil, `next build` başarılı, duman testi 4/4.

- [ ] **T105 (P3, human: ~1g / CC: ~2sa)** - altyapı - **Next 16'ya geçiş**
  - T104 geçişli açıkları `overrides` ile kapattı; bu, kaynağı değil
    belirtiyi çözüyor. Next 16 `postcss` 8.5.23 ve `sharp` ^0.35.3
    getiriyor, yani override'lara gerek kalmıyor.
  - **Neden hemen değil:** major sürüm. `next.config.ts`teki
    `extensionAlias` ayarı modül çözümlemesine bağlı ve kırılgan —
    bozulursa typecheck yeşil kalır, derleme patlar (T104 notu).
  - Kapsam: yükselt, `extensionAlias`ı doğrula, override'ları kaldır,
    `pnpm audit` hâlâ temiz mi bak.
  - Doğrula: lint + typecheck + testler + `next build` + duman testi 4/4.
  - Kaynak: T104 kapanışı

- [ ] **T106 (P2, human: ~1sa / CC: ~15dk)** - tasarım - **56 px kuralı ile kod ayrıştı, biri düzeltilmeli**
  - PLAN Bölüm 11 ve CLAUDE.md "minimum 56 px dokunma hedefi (eldiven var)"
    diyor. Kod: menü satırı 48 px, form kontrolü 52 px, barkod/miktar 64 px.
  - İkisi de savunulabilir ama İKİSİ BİRDEN DOĞRU OLAMAZ. Yazılı kural ile
    kodun ayrışması, bu projede tekrar eden en pahalı hata sınıfı: sonraki
    kişi hangisine uyacağını bilemez.
  - **Karar kullanıcınındır, çünkü 56 px bir ürün kararıydı:** eldivenli el,
    soğuk, acele. Referans görselin oranları için indirmek estetik bir
    tercih; ikisini tartan kişi ürünü kullanacak olan.
  - Seçenekler: (a) kuralı 52/48'e indir ve gerekçesini yaz, (b) kodu 56'ya
    çıkar, (c) ikili kural yaz — "dokunma hedefi 56, işaretleme kontrolü 48".
  - Not: barkod ve miktar alanları 64 px'te kaldı, yani en sık dokunulan
    iki alan zaten hedefin üstünde.
  - Kaynak: T56 kapanışı

- [ ] **T107 (P3, human: ~10dk / CC: ~5dk)** - arayüz - **favicon yok: her sayfada 404**
  - Tarayıcıda ölçüldü (T88 demo turu): `GET /favicon.ico` → 404, ve bu
    konsola hata olarak düşüyor. Tek başına zararsız ama konsolu KİRLETİYOR:
    gerçek bir JS hatası bu gürültünün içinde gözden kaçar, ve tarayıcı
    testinin "konsol temiz mi" kontrolü hep kirli döner.
  - `apps/web/src/app/icon.svg` yeterli; kabuktaki kutu logosu zaten var.
  - Kaynak: T88 tarayıcı turu

- [ ] **T108 (P2, human: ~1sa / CC: ~20dk)** - hareket - **fiyat alanı sebebe göre açılıp kapanmıyor**
  - "Birim fiyat" ve "Sapma sebebi" alanları HER sebepte görünüyor,
    fire/kullanım seçilse bile.
    **GEREKÇE DEĞİŞTİ (T110):** eskiden "form JS'siz çalışıyor, koşullu
    gizleme JS gerektirir" deniyordu; o iddia ölçümle yanlış çıktı — JS
    kapalıyken form zaten kullanılamıyor. Yani teknik engel YOK; geriye
    yalnızca "gerekli mi" sorusu kalıyor ve o da aşağıdaki gibi ölçülmeden
    cevaplanmamalı. Sunucu yanlış eşleşmeyi `PRICE_NOT_APPLICABLE`
    ile reddediyor ve etikette hangi işlemlerde geçerli olduğu yazıyor — yani
    kullanıcı kaybolmuyor ama GEREKSİZ BİR TUR atıyor.
  - Ölçülmeden çözülmemeli: bu gerçekten yaşanıyor mu? Depoda fire girişi
    ne sıklıkta yapılıyor ve kullanıcı oraya fiyat yazmaya kalkıyor mu?
    Kalkmıyorsa bu iş HİÇ YAPILMAMALI — JS eklemek T52'nin kararını geri
    almak demek ve bedeli eski tarayıcıda formun tamamen çalışmaması.
  - Yapılacaksa: progressive enhancement (JS varsa gizle, yoksa hepsi
    görünür kalsın), JS'e bağımlı gizleme DEĞİL.
  - Kaynak: T88 tarayıcı turu

- [ ] **T110 (P1, human: ~2sa / CC: ~1sa)** - arayüz - **"JavaScript gerekmiyor" iddiası YANLIŞ: JS kapalıyken form kullanılamıyor**
  - Ölçüldü (2026-09-03, gerçek tarayıcı, `javaScriptEnabled: false`):
    `/hareket?barkod=…` sayfasında `main` metni yalnızca **"Sayfa
    yükleniyor"**, ve **"Kaydet" düğmesi hiç yok** (rol sorgusu 0 döndü).
    Giriş çalışıyor (303 → `/panel`), ama panel de iskelette kalıyor.
  - Sebep: sayfalar AKIŞLA (streaming Suspense) geliyor ve akan içeriği
    yerine koyan şey satır içi script'ler. JS kapalıyken içerik hiç
    yerleşmiyor. `loading.tsx` olan her ekran aynı durumda.
  - **Neden önemli:** iki ayrı karar bu yanlış iddiaya dayanıyordu —
    `hareket/page.tsx` başlığındaki "JavaScript de gerekmiyor" notu ve
    T108'in "alanları koşullu gizlemek JS gerektirir, o yüzden yapmıyoruz"
    gerekçesi. Kod yorumları düzeltildi; karar gerekçeleri yeniden
    kuruldu.
  - **Karar gerekiyor (kullanıcının):** depodaki eski Android tarayıcılar
    gerçekten JS'siz mi? Öyleyse bu P0'dır ve akış sınırları kaldırılmalı
    (ya da bu ekranlar için `loading.tsx` düşürülmeli). Değilse iddia
    kaldırıldığı için sorun kalmıyor ve T108 farklı gerekçeyle
    değerlendirilir.
  - Kaynak: T109 teşhisi

- [ ] **T111 (P2, human: ~1sa / CC: ~20dk)** - gözlem - Tekrar bekleyen iş, Sistem Sağlığı kartında SAĞLIKLI görünüyor
  - Ölçüldü (2026-09-03, T34 canlı sürüş): SMTP'siz kurulumda gün sonu
    raporu bir kez patlayıp `QUEUED`'a dönüyor (`last_error_code` dolu),
    kart ise "2 iş kuyrukta, işleniyor" diyor. Yani hata KAYITLI ama
    ekranda YOK.
  - Uyarı eşiği 1 saat; cron günde bir koştuğu için o satır ~24 saat
    "işleniyor" olarak duruyor. G4 tam olarak bu: kayıt var, görünürlük yok.
  - Çözüm: `queueCheck` `last_error_code IS NOT NULL AND status='QUEUED'`
    satırlarını ayrı sayıp `warn` dönsün — "1 iş bir kez başarısız oldu,
    tekrar denenecek".
  - Neden hemen yapılmadı: T34'ün kapsamı cron turu; kartın sorgusunu
    değiştirmek T25'in davranışını değiştirir ve kendi testini ister.
  - Kaynak: T34 canlı sürüşü

- [ ] **T112 (P2, human: ~2sa / CC: ~30dk)** - cron - Zamanlayıcının kendisi kurulmadı
  - `POST /api/cron` hazır ama onu VURAN bir şey yok. Deploy hedefi
    seçilmeden (T42) hangisi olacağı belli değil: Vercel Cron
    (`vercel.json`), systemd timer, ya da klasik crontab + curl.
  - **Bu kurulmadan gün sonu raporu hiç çıkmaz.** `next.config.ts` açılışta
    `CRON_SECRET` yoksa uyarıyor ama sır tanımlı olup zamanlayıcı yoksa
    hiçbir yerde ses çıkmıyor — "en son ne zaman koştu" bilgisi hiçbir
    yerde tutulmuyor.
  - Ek olarak: turun kendisi de izlenmeli. Zamanlayıcı ölürse bunu
    anlamanın tek yolu raporun gelmediğini fark etmek, yani G4.
  - **T42'ye bağlı.**
  - Kaynak: T34

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Kapsam ve strateji | 1 | ISSUES_OPEN | Mod SELECTIVE EXPANSION, 10 fırsat sunuldu, 6 kabul, 4 ertelendi, 4 kritik açık |
| Eng Review | `/plan-eng-review` | Mimari ve testler (zorunlu) | 1 | ISSUES_OPEN (PLAN) | 16 bulgu, 6 karar (D4-D9), 9 düzeltme, 8 yeni görev, 4 kritik açık taşındı |
| Codex Review | `/codex review` | Bağımsız 2. görüş | 0 | - | Codex kurulu değil |
| Design Review | `/plan-design-review` | UI/UX açıkları | 1 | ISSUES_OPEN | puan: 3/10 → 6/10, 9 karar (TD1-TD6), 22 görev (T65-T86), 2 kalem kapsam dışı |
| DX Review | `/plan-devex-review` | Geliştirici deneyimi | 0 | - | Çalıştırılmadı |

**ENG REVIEW BULGULARI:** Mimari 5 (2 P1), Kod kalitesi 6 (2 P1), Test 30 kapsam boşluğu
(en kritiği RLS ve rol matrisi), Performans 4 (1 P1). Kapsam meydan okuması 1 azaltma üretti.

**KRİTİK AÇIKLAR:** 4 (G1 Excel boyutu, G2 Türkçe karakter, G3 yazıcı hatası, G4 cron mail
hatası). Dördü de T14-T17'de kapatılıyor. Eng review yeni kritik açık eklemedi ama
G1'in çözümünü değiştirdi (stream yerine eşik üstü arka plan işi).

**UNRESOLVED:** 4 (ürün stratejisi) + 8 (tasarım kapsamı, yukarıda).
Ürün stratejisi açıkları: Bunlar hiçbir zaman açıkça cevaplanmadı, varsayılanlarla ilerleniyor:
U1 negatif stok politikası (varsayılan: çalışan engellenir, admin geçebilir),
U2 maliyet yöntemi (varsayılan: ağırlıklı ortalama, **muhasebeciye sorulmalı**),
U3 hosting (varsayılan: Supabase),
U4 ürünün asıl çözdüğü acı (ilk demoda hangi ekranın açılacağını belirler).

**OUTSIDE VOICE:** Çalıştırılmadı. Codex kurulu değil; Claude alt ajanı ile bağımsız
ikinci görüş alınabilir, kullanıcı onayı bekliyor.

**DESIGN REVIEW BULGULARI (2026-08-25):** Yedi geçiş çalıştırıldı. Bilgi mimarisi 3→7,
etkileşim durumları 2→5, kullanıcı yolculuğu 6→8, AI slop 7, tasarım sistemi uyumu 7→4
(iki çelişen sistem; T77 kapatıyor), duyarlılık ve erişilebilirlik 3→6. Genel 3/10 → 6/10.

Kodda iki ölçülebilir açık bulundu, ikisi de tasarımdan bağımsız:
`loading.tsx`/`error.tsx` hiçbir rotada yok (T69) ve `outline-none` +
`border-slate-300` (1,48:1) erişilebilirlik gerilemesi (T68).

Referans görselin 19 öğesi incelendi: 7'si bugünkü veriyle hazırdı, 4'ü bu tura girdi
(Kategoriler, Raporlar, Ayarlar, koyu tema). Kalanlar TTTD2'da tek tek karara bağlandı:
ürün fotoğrafı, bildirim zili ve Ctrl+K arama kapsama ALINDI (T80-T86); Tedarikçiler ve
Siparişler için "KAPSAM DIŞI → Faz 2" kararı TEYİT EDİLDİ.

TTTD2'da ortaya çıkan bir veri modeli gerçeği: görselin kiracı değiştirici kontrolü bu üründe
uygulanamaz. `users.tenantId` notNull ve tek FK, yani bir kullanıcı tam olarak bir
işletmeye ait; değiştirilecek bir şey yok. Kontrol hesap menüsü olarak yorumlandı.

**VERDICT (Faz 9):** CEO + ENG + DESIGN İNCELEMELERİ TAMAMLANDI.

---

### Faz 10 mühendislik incelemesi (2026-08-30)

| Çalıştırma | Durum | Sonuç |
|---|---|---|
| Step 0 — kapsam | tamam | Karmaşıklık eşiği aştı (T88 tek başına 15 dosya). Kullanıcı dördünü birden kilitlemeyi seçti |
| Section 1 — mimari | tamam | 4 bulgu (hepsi P1), 4 karar: D2/D3, D4, D5, D6 |
| Section 2 — kod kalitesi | tamam | 2 bulgu → 1 karar (D7) + 1 önemsiz (Excel başlığı) |
| Section 3 — test | tamam | 1 bulgu (D8) + zorunlu regresyon listesi → T92 |
| Section 4 — performans | tamam | 1 bulgu, 1 karar (D9) |
| **Dış ses (Codex)** | **ÇALIŞMADI** | `codex` kurulu değil; alt-ajan geri düşüşü bu oturumda kapalıydı. **Bu incelemeyi tek model yaptı — çapraz doğrulama yok.** |

**En ciddi bulgu:** planın kendisi tutarsızdı. `PLAN.md:1533`'teki DB CHECK ile
tolerans kararı birbirini kesiyordu; tolerans içindeki bir yuvarlama sebep
taşımadığı için CHECK tarafından reddedilecekti, yani mutlu yol kasada
veritabanı hatasıyla duracaktı. Kullanıcının "fiyat barkod/OCR'dan geliyor,
kazara sapma yok" düzeltmesi tolerans kavramını tamamen düşürdü ve üç iş
birden gitti (epsilon, `tenants` ayar sütunu, `/ayarlar` alanı).

**Kod okunarak doğrulanan diğer üç bulgu:**
- `numeric.ts` miktara özel (`QTY_SCALE = 3`), para `numeric(12,2)` — yardımcılar
  kullanılamıyor ve kod tabanında hiç para aritmetiği yok → hesap SQL'de (D5)
- `rls.test.ts:247` public şemadaki HER tabloyu tarıyor → `price_index`
  politikasız eklenirse test kırmızı, üretimde 500 (D6)
- `authz.ts:88`'in yazılı gerekçesi satır bazlı gizlemeyi dışlıyor → ayrı alan
  adı `saleUnitPrice` (D7)

**U2 üzerine düzeltme:** yukarıdaki Faz 9 verdict'i "U2 Faz 2'den önce
cevaplanmalı" diyordu. Faz 10 için geçerli DEĞİL. FIFO/ağırlıklı ortalama
"hangi geçmiş maliyeti düşeyim" sorusudur ve kâr raporuna (E8) aittir;
yenileme maliyeti ileriye bakan bir sayıdır. T88-T92 U2 beklemeden yazılabilir.

**TODOS.md:87 YANLIŞ:** "veri toplanmaya bugün başlıyor" diyor. Başlamıyor —
arayüz `unit_cost` alanını hiç göndermiyor. E8'in 4 günlük tahmini "geçmiş veri
hazır" varsayımına dayanıyor ve T88 girmezse E8 sıfır veriyle başlar. Düzeltilmeli.

**VERDICT (Faz 10):** ENG İNCELEMESİ TAMAMLANDI, DIŞ SES EKSİK. Dokuz karar
alındı, hepsi PLAN.md T88-T92'ye gerekçesiyle yazıldı. Uygulamaya başlanabilir.

**UNRESOLVED DECISIONS:**
- Sapma sebebi listesi onaylanmadı: `TANIDIK`, `TOPTAN`, `KAMPANYA`, `HASARLI`, `ESKI_STOK`, `YUVARLAMA`, `YONETICI_ONAYLI`, `DIGER` — kullanıcı eksik/fazla söylemedi, T88 bu listeyle başlıyor
- `DAMAGE` / `USAGE` çıkışlarında fiyat ne olmalı (öneri: NULL, para el değiştirmedi)
- "Son alış yeterince yeni" eşiği 90 gün mü — gerçek veri olmadan kalibre edilemez
- `client_list_price` sunucununkinden farklı çıkınca raporda ne yazacak, sadece işaret mi ayrı satır mı
- Yİ-ÜFE aylık güncellemesini kim yapacak ve bayatlama uyarısı hangi gecikmede çıkacak
- U2 maliyet yöntemi — Faz 10'u bloke etmiyor ama E8 (kâr raporu) için hâlâ açık
- Dış ses (Codex) çalışmadı; bu incelemenin bulguları çapraz doğrulanmadı
