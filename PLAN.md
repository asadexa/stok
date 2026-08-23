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

**Test durumu:** 316 test yeşil (shared 54, db 46, core 216). Entegrasyon testleri gerçek
PostgreSQL'e koşuyor; her paket kendi test veritabanını sıfırdan kuruyor.

**CI:** `.github/workflows/ci.yml` — her push ve PR'da typecheck, migration
drift kontrolü ve tüm test paketi, `postgres:17` servis konteyneriyle koşuyor.
T42 (deploy pipeline) hâlâ açık; bu sadece doğrulama tarafı.

**Açık uçlar (ikisi de T34'e bağlı):**
- `auth_prune_attempts()` yazıldı ama çağıran yok; `auth_attempts` yavaşça büyür.
- `runQueuedJobs()` yazıldı ama çağıran cron yok; kuyruğa alınan export işleri
  bir işçi çalıştırılana kadar QUEUED bekler.

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
  - `auth_prune_attempts()` var ama HENÜZ ÇAĞRILMIYOR; gün sonu cron'una (T34)
    bağlanacak, yoksa tablo yavaşça büyür.

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
- [ ] **T23 (P1, human: ~4sa / CC: ~30dk)** - web - **E1: Excel/CSV toplu ürün içe aktarma** + önizleme + hata raporu
  - Kaynak: Bölüm 11 boş durumlar. Bu olmadan sistem ilk gün kurulamaz
- [ ] **T24 (P2, human: ~3sa / CC: ~20dk)** - web - Kullanıcı yönetimi (ekle, rol ver, pasifleştir)
- [ ] **T25 (P2, human: ~2sa / CC: ~15dk)** - web - "Sistem Sağlığı" kartı (son senkron, bekleyen kayıt, aktif cihaz)
  - Kaynak: Bölüm 8

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

- [ ] **T34 (P1, human: ~4sa / CC: ~30dk)** - cron - **E6: Gün sonu raporu** (Excel eki + e-posta), idempotent
- [ ] **T35 (P1, human: ~3sa / CC: ~25dk)** - cron - **E7: Kritik stok taraması + push bildirim**
- [ ] **T36 (P2, human: ~3sa / CC: ~20dk)** - gözlem - Yapısal log + 5 metrik + 5 alarm
  - Kaynak: Bölüm 8
- [ ] **T37 (P1, human: ~2sa / CC: ~15dk)** - gözlem - Invariant ihlali alarmı (kırmızı)

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
- [ ] **T45 (P1, human: ~1sa / CC: ~10dk)** - güvenlik - ESLint kuralı: route handler içinde doğrudan `db` kullanımı yasak, sadece `withTenant()`
  - Kaynak: D5. RLS'i insan disiplinine bırakmamak için makine zorlaması
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

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Kapsam ve strateji | 1 | ISSUES_OPEN | Mod SELECTIVE EXPANSION, 10 fırsat sunuldu, 6 kabul, 4 ertelendi, 4 kritik açık |
| Eng Review | `/plan-eng-review` | Mimari ve testler (zorunlu) | 1 | ISSUES_OPEN (PLAN) | 16 bulgu, 6 karar (D4-D9), 9 düzeltme, 8 yeni görev, 4 kritik açık taşındı |
| Codex Review | `/codex review` | Bağımsız 2. görüş | 0 | - | Codex kurulu değil |
| Design Review | `/plan-design-review` | UI/UX açıkları | 0 | - | Çalıştırılmadı |
| DX Review | `/plan-devex-review` | Geliştirici deneyimi | 0 | - | Çalıştırılmadı |

**ENG REVIEW BULGULARI:** Mimari 5 (2 P1), Kod kalitesi 6 (2 P1), Test 30 kapsam boşluğu
(en kritiği RLS ve rol matrisi), Performans 4 (1 P1). Kapsam meydan okuması 1 azaltma üretti.

**KRİTİK AÇIKLAR:** 4 (G1 Excel boyutu, G2 Türkçe karakter, G3 yazıcı hatası, G4 cron mail
hatası). Dördü de T14-T17'de kapatılıyor. Eng review yeni kritik açık eklemedi ama
G1'in çözümünü değiştirdi (stream yerine eşik üstü arka plan işi).

**UNRESOLVED:** 4. Bunlar hiçbir zaman açıkça cevaplanmadı, varsayılanlarla ilerleniyor:
U1 negatif stok politikası (varsayılan: çalışan engellenir, admin geçebilir),
U2 maliyet yöntemi (varsayılan: ağırlıklı ortalama, **muhasebeciye sorulmalı**),
U3 hosting (varsayılan: Supabase),
U4 ürünün asıl çözdüğü acı (ilk demoda hangi ekranın açılacağını belirler).

**OUTSIDE VOICE:** Çalıştırılmadı. Codex kurulu değil; Claude alt ajanı ile bağımsız
ikinci görüş alınabilir, kullanıcı onayı bekliyor.

**VERDICT:** CEO + ENG İNCELEMELERİ TAMAMLANDI. Uygulamaya başlanabilir.
U2 (maliyet yöntemi) tek yönlü kapı olduğu için Faz 2'den önce cevaplanmalı;
diğer üç açık soru uygulama sırasında geri alınabilir.
