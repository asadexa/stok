# ADR-002: Tenant izolasyonu veritabanında, uygulamada değil

- **Tarih:** 2026-08-12
- **Durum:** Kabul edildi
- **İlgili:** PLAN.md D5, Bölüm 4 (tehdit S1), T46

## Bağlam

Sistem çok kiracılı: aynı veritabanında birden fazla işletmenin stoğu duruyor.
Bir işletmenin diğerinin verisini görmesi, bu üründe **kurtarılamaz** bir hata
— müşteri kaybı değil, sektörde iş kaybı.

Uygulama seviyesinde izolasyon "her sorguya `WHERE tenant_id = ?` ekle"
demek. Sorun şu: bu kural **her yeni sorguda yeniden hatırlanmak** zorunda.
Bir `WHERE` unutulduğunda ne typecheck ne test kırmızı yanıyor; sorgu
çalışıyor, sadece fazla satır dönüyor.

## Karar

İzolasyon **PostgreSQL Row Level Security** ile zorlanıyor.

1. Uygulama veritabanına **`stok_app`** rolüyle bağlanıyor. Bu rol tabloların
   sahibi DEĞİL, superuser DEĞİL, `BYPASSRLS` yetkisi YOK.
2. Her tablo `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`.
   Politika: `tenant_id = current_tenant_id()`.
3. `current_tenant_id()` oturum ayarından okuyor. Ayar yoksa `NULL` döner ve
   **hiçbir politika satır geçirmez** — güvenli varsayılan.
4. Ayarı yalnızca `withTenant()` yapıyor, `SET LOCAL` ile: transaction
   bitince düşüyor. `SET LOCAL` olmasaydı ayar havuza dönen bağlantıda
   kalır ve bir sonraki isteğe **sızardı** — havuzlanmış bağlantılarda
   RLS'in en klasik hatası.
5. `postgres` rolü yalnızca migration çalıştırıyor.

Tavuk-yumurta durumları (giriş sırasında tenant henüz bilinmiyor, cron'un
oturumu yok) **dar kapsamlı `SECURITY DEFINER` fonksiyonlarıyla** çözülüyor:
`auth_lookup_user()` yalnızca `(user_id, tenant_id)` döndürüyor,
`cron_tenants()` yalnızca UUID listesi. `search_path` sabitleniyor, yetki
`PUBLIC`'ten alınıp yalnızca `stok_app`'a veriliyor.

## Elenen yollar

**Uygulama seviyesinde `WHERE tenant_id`.** Tek bir unutulmuş `WHERE` bütün
müşterilerin verisini sızdırır ve hiçbir otomatik kontrol bunu yakalamaz.
Kod incelemesine güvenmek, bu ölçekteki bir hata için yeterli bir savunma
değil.

**`current_tenant_id() IS NULL` iken her satırı geçiren politika.** Giriş
problemini çözerdi ama güvenli varsayılanı **tersine** çevirirdi: tenant
ayarlamayı unutan her kod yolu tüm veriyi görürdü. En kötü hata tipi —
sessiz ve geniş.

**Tenant başına ayrı veritabanı.** Gerçekten izole ama migration, yedek ve
bağlantı havuzu maliyeti müşteri sayısıyla doğrusal artıyor; tek kirletici
sorgu bile kalmadığı için cazip, ama on müşteride operasyon yükü RLS'in
riskini aşıyor.

**Uygulamanın sahip rolüyle bağlanması.** `FORCE ROW LEVEL SECURITY` sahibi
de politikalara tabi tutuyor ama sahip politikayı `ALTER` edebilir. D5'in
tamamını çöpe atardı.

## Sonuçlar

**İyi:** İzolasyon, kodun doğruluğundan **bağımsız**. `WHERE`'i unutan bir
sorgu boş döner — sızdırmaz.

**Bedel:** Her yeni kod yolu `withTenant()` içinden geçmek zorunda. Dışından
yapılan sorgu veri sızdırmıyor ama **boş** dönüyor ve bu, teşhisi ilk bakışta
kafa karıştıran bir arıza ("sorgu doğru, sonuç yok").

**Bedel:** Oturumsuz her ihtiyaç (giriş, cron) ayrı bir `SECURITY DEFINER`
fonksiyonu gerektiriyor. Her biri denetlenmesi gereken dar bir delik; bu
yüzden ikisi de aynı politikayı yeniden kullanıyor, ikinci bir kapı
açılmıyor.

## Nasıl doğrulanıyor

- `packages/db/src/rls.test.ts` — çapraz tenant okuma/yazma reddi
- `packages/core/src/role-matrix.test.ts` — rol matrisi sunucuda
- Testler **gerçek PostgreSQL** ile ve `stok_app` rolüyle koşuyor; sahte bir
  bağlantıyla koşsalardı politikaların varlığını değil kodun niyetini
  sınarlardı
