# PROJECT_BRAIN — Stok Takip

Projenin uzun ömürlü zihinsel modeli: ne için var, nasıl düşünülmüş, neyi asla
bozmamalı. **Güncel durum, bug ve iş listesi burada değil**: güncel durum
`CURRENT_STATE.md`'de, geçerli kararlar `DECISIONS.md`'de, işler `TODOS.md`'de,
tehdit modeli `docs/SECURITY_MODEL.md`'de, kararın uzun gerekçesi `docs/ADR/`'de.

Bu dosya ancak model değiştiğinde güncellenir (yeni katman, yeni invariant,
kapsamın sınırı). Özellik eklemek onu tek başına değiştirmez.

---

## 1. Amaç

Küçük ve orta ölçekli depolar ve perakende işletmeler (kırtasiye, hırdavat) için
barkod tabanlı stok takibi. Türkçe, çok kiracılı (`PRD-01`).

Ürünün cevapladığı asıl soru "elimde kaç tane var" değil, **"neden bu kadar"**:
40 adet kırmızı defter nereye gitti, ne zaman, kim tarafından. Bu yüzden stok bir
sayı olarak tutulmuyor; değiştirilemez bir hareket defterinin toplamı (§6).

Hazır sistemler (ERPNext, InvenTree) yerine sıfırdan yazılmasının iki gerekçesi
var: beş dakikada öğrenilen Türkçe arayüz ve telefonun el terminaline dönüşmesi
(mobil, henüz yazılmadı). Geri kalan her şey hazır sistemlerde de var.

## 2. Kullanıcılar ve roller

| Kişi | Rol | Ne ister |
|---|---|---|
| İşletme sahibi / yönetici | `ADMIN` | "Bir sorun var mı?" sorusuna tek bakışta cevap, kasa açığının görünür olması, rapor, kullanıcı ve ürün yönetimi |
| Depocu / tezgâhtar | `STAFF` | Hızlı mal girişi/çıkışı, ürün ve stok sorgusu. Alış fiyatını görmez, yalnız kendi hareketlerini görür |
| Muhasebeci (dolaylı) | — | Excel çıktısı; maliyet yöntemi kararı onun (`DAT-15`) |

Yalnız iki rol var. Rol matrisi kodda tek kaynak (`packages/shared/src/roles.ts`)
ve sunucuda zorlanır; arayüzde düğmeyi gizlemek yetki kontrolü değildir.

## 3. Temel kullanım senaryoları

- **Mal kabulü**: barkod (USB okuyucu = klavye) → ürün ve mevcut stok görünür →
  miktar + sebep (satın alma, iade, diğer) → kayıt; ekranda "446 → 496".
- **Satış / çıkış**: aynı akış; liste fiyatından sapılırsa sapma sebebi zorunlu
  (kasa açığı kontrolü, §7).
- **Fire / kullanım / tedarikçiye iade**: çıkış sebepleri; fire ve kullanımda fiyat yok.
- **Devir (açılış)**: elde zaten olan malın sisteme ilk girişi; fiyat zorunlu,
  fiyatın ekonomik tarihi ayrı tutulur.
- **İlk kurulum**: ürün kataloğunu Excel/CSV'den toplu aktarmak (önizle → onayla);
  "Açılış Stoğu" sütunu devri yine tek yazma kapısından, ürünün ilk hareketi olarak yazar (`DAT-18`).
- **Gözetim**: panel (uyarılar, bugün, son hareketler), kritik stok, hareket logu
  (kim / ne zaman / neden), sistem sağlığı.
- **Rapor**: stok ve hareket Excel'i; gün sonu raporu ve alarm e-postaları (cron).
- **Yönetim**: kullanıcı ekleme, rol, pasifleştirme, parola sıfırlama.
- **Gelecek** (yazılmadı): mobilde kamerayla offline okutma, sayım, etiket basma.

## 4. Kapsamın genel çerçevesi

- **Var**: tek bir Next.js web uygulaması. Yönetici ve çalışan aynı panelden,
  role göre kısıtlanmış olarak çalışır. Web'in kendisi Server Action ile çalışır;
  dışarıya açık REST yüzeyi bugün yalnız `/api/v1/health` ve `/api/cron`; pilot
  bayrağı açıkken ayrıca telefon tarama köprüsü `/api/tara/*` (`ARC-14`, S18).
- **Planlanmış, yazılmamış**: native mobil uygulama (`PRD-03`), mobilin ihtiyaç
  duyduğu `/api/v1` REST sözleşmesi (`ARC-07`, `ARC-09`), offline outbox (`ARC-10`).
- **Bilinçli kapsam dışı**: §14.

Hangi özelliğin bugün çalıştığı, kısmi olduğu ya da bozuk olduğu `CURRENT_STATE.md`'de.

## 5. Monorepo ve katmanlar

```
packages/shared  ← saf TS: zod şemaları, sebep/rol/birim/fiyat sözlükleri, hata kodları
      ▲                + Türkçe metinleri. I/O yok, Node API'si yok (ileride React Native).
packages/db      ← Drizzle şeması, migration'lar (RLS/trigger/fonksiyonlar elle SQL),
      ▲                bağlantılar (appDb / adminDbUnsafe), withTenant(), seed, test altyapısı
packages/core    ← iş mantığının TAMAMI: createMovement, authz, auth, ürün, kullanıcı,
      ▲                import/export, iş kuyruğu, cron, sağlık. Next/React bilmez.
apps/web         ← Next.js App Router: sayfalar, Server Action'lar, ince route handler'lar,
                       oturum çerezleri. SQL yazmaz; appDb() alıp core'a geçirir.
```

| Katman | Olmaması gereken | Nasıl zorlanıyor |
|---|---|---|
| shared | I/O, Node'a özgü API | Yalnız `zod` bağımlılığı (kural yok, konvansiyon) |
| db | İş kuralı | Konvansiyon |
| core | Next/React; `adminDbUnsafe` | Biome `noRestrictedImports` |
| web | Sorgu; `withTenant`, `adminDbUnsafe` | Biome `noRestrictedImports`; `drizzle-orm` bağımlılığı yok |

Sorgular core'da yazıldığı için kiracı kapsamı tek yerde denetlenebilir. Paketler
derlenmez; web onları `transpilePackages` ile kaynaktan derler.

## 6. Stok defteri modeli (ADR-001)

**Defter** `stock_movements` append-only. UPDATE ve DELETE iki katmanda kapalı:
uygulama rolünden yetki geri alınmış, ayrıca bir trigger her durumda istisna
fırlatıyor. Düzeltme, silmek değil ters hareket yazmak; ürün ve barkod da
silinmez, arşivlenir (`DAT-10`).

**Projeksiyon** `current_stock` bir önbellek değil, denetlenen bir kopya. INSERT
sonrası trigger yazıyor; yani hareketi kim yazarsa yazsın güncellenir.

**Tek yazma kapısı** `createMovement()` (`packages/core/src/movements.ts`, `DAT-02`). Sıra:

1. Yetki kontrolü
2. zod doğrulaması
3. Idempotency anahtarı aranır (varsa mevcut kayıt döner)
4. Barkod → ürün (arşivli barkod çözülmez)
5. Arşiv kontrolü
6. `current_stock` satırını `FOR UPDATE` ile kilitle → çıkışta yeterlilik kontrolü
7. Fiyatı sunucuda çöz (§7)
8. INSERT (trigger projeksiyonu yazar)
9. Projeksiyon beklenenle aynı mı, aynı transaction içinde doğrula

Deadlock'ta üç deneme; aynı anahtarla yarışan iki istekte UNIQUE indeks kazananı belirler.

**Kurallar**

- Kullanıcı her zaman pozitif miktar girer; işareti sebep belirler. "-5 yerine 5
  girdim" hatası yapısal olarak imkânsız.
- Koli barkodunda girilen miktar × `qty_multiplier`. Kural iki yönlü: koli > 1,
  diğer türler tam 1.
- Miktar `NUMERIC(14,3)` (kg/metre/litre için; INTEGER değil), kodda 1000 ile
  ölçeklenmiş `bigint` (`numeric.ts`). Para `NUMERIC(12,2)`, zaman `timestamptz`.
  Kayan nokta karar veren hiçbir yolda kullanılmaz.
- Negatif stok: çıkışta yalnız yönetici `allowNegative` ile geçebilir; giriş her
  zaman serbesttir, çünkü stoğu gerçeğe yaklaştırır (`DAT-08`).
- Sıralama ve log sunucu saatiyle; cihaz saati `client_created_at`'e ayrı yazılır.

## 7. Fiyat defteri (kasa açığı)

Defter yalnız "kaç tane"yi değil "kaça"yı da kaydeder. Amaç açığı engellemek
değil, **gizlenemez** yapmak. Senaryo: fiş 110 ₺ yazıyor, müşteri tanıdık diye
100 ₺ ödüyor, kasada 10 ₺ açık kalıyor. Tasarım: `docs/designs/fiyat-defteri.md`.

| Sütun | Anlam |
|---|---|
| `unit_price` | Gerçekleşen birim fiyat. Girişte alış, çıkışta hasılat (eski adı `unit_cost`) |
| `list_price` | O anki liste fiyatı. Sunucu üründen okur ve harekete DONDURUR; ürün sonradan zamlansa da geçmiş fark değişmez |
| `client_list_price` | İstemcinin gördüğünü iddia ettiği fiyat. Karşılaştırmaya girmez, uyuşmazlığı görünür kılar |
| `price_override_reason` | Sapma sebebi; listeden seçilir. DB CHECK: fark varsa sebep zorunlu (`PRC-03`) |
| `price_source` | `LIST` / `MANUAL` / `RECEIPT` / `INDEXED` / `ESTIMATED`. İstemci yalnız `RECEIPT`/`ESTIMATED` iddia edebilir; gerisini sunucu türetir |
| `price_date` | Fiyatın ekonomik tarihi. Boşsa hareket tarihi (`PRC-05`) |

Hangi ürün fiyatının "liste fiyatı" sayılacağını sebebin `priceBasis`'i belirler:
`SALE` → satış fiyatı, `PURCHASE` → alış fiyatı, `null` → fiyat yok
(`shared/reasons.ts`). Fire, kullanım ve sayım fiyat taşımaz.

Görünürlük satır bazındadır: satış dayanaklı satırın fiyatı (satış, müşteri
iadesi) çalışana açık, alış/devir fiyatı kapalı. Alan **silinir**, `null`'a
çevrilmez: alanın yokluğu "yetki yok", `null` "girilmemiş" demektir. Gün sonu
raporu kasa açığını e-postanın GÖVDESİNDE kullanıcı bazında, (liste − birim) ×
adet olarak toplar.

Yenileme maliyeti (Adım 3) henüz yazılmadı (`PRC-08`, `PRC-11`).

## 8. Çok kiracılılık ve RLS (ADR-002)

- Uygulama veritabanına **`stok_app`** rolüyle bağlanır: tabloların sahibi
  değil, superuser değil, BYPASSRLS yok. `postgres` (sahip) yalnız migration ve
  seed çalıştırır (`MIGRATION_DATABASE_URL`) (`SEC-01`).
- Her tabloda `ENABLE` + `FORCE ROW LEVEL SECURITY`. Politika
  `tenant_id = current_tenant_id()`; `current_tenant_id()` oturum ayarını okur.
- Ayarı yalnız `withTenant(tenantId, tx => …)` kurar: `set_config(…, true)` =
  `SET LOCAL`, yani transaction bitince düşer ve havuza dönen bağlantıya sızmaz.
- Ayar yoksa politikalar hiçbir satır geçirmez: `withTenant` dışından yapılan
  sorgu sızdırmaz, **boş döner**. Arıza belirtisi "sorgu doğru, sonuç yok"tur.
- Kiracı bağlamı bilinmeden yapılması gerekenler dar `SECURITY DEFINER`
  fonksiyonlarıyla çözülür (`SEC-02`):
  - `auth_lookup_user(email)` → yalnız `(user_id, tenant_id)`
  - `cron_tenants()` → kiracı + en eski aktif yönetici
  - `auth_record_failure` / `auth_read_attempts` / `auth_clear_attempts` /
    `auth_prune_attempts` → kaba kuvvet sayacı (tablo kiracısız, uygulamaya kapalı)
- `tenants` tablosuna uygulama yazamaz; kiracı açmak provisioning işidir (`SEC-03`).
- Referans bütünlüğü (FK) kontrolleri RLS'i atlar. Kullanıcıdan gelen yabancı
  kimlikler (ör. `locationId`) bu yüzden core'da kiracı içinde ayrıca doğrulanır
  (`assertLocationExists`).

## 9. Kimlik doğrulama ve yetki

1. **Giriş**: e-posta → `auth_lookup_user` → `withTenant` içinde parola özeti
   (scrypt) → token çifti.
   - Kilit kontrolü scrypt'ten ÖNCE yapılır.
   - Bulunmayan e-postada da scrypt süresi harcanır (kullanıcı sayımına karşı).
   - Aynı e-posta birden fazla kiracıda bulunursa `TENANT_AMBIGUOUS` döner ve
     istemci `tenantId` ile tekrar dener (`SEC-14`).
2. **Token'lar**: HS256 JWT (`AUTH_SECRET` ≥ 32 karakter, yoksa sunucu açılmaz).
   - Access 15 dk: yalnız imzadan doğrulanır, DB'ye gitmez; pasifleştirmenin
     etkisi en fazla bu kadar gecikir (bilinçli takas).
   - Refresh 30 gün: her kullanımda DB'den `tokenVersion` + aktiflik kontrol
     edilir. Oturum iptali `tokenVersion`'ı artırır.
3. **Web taşıması**: `stok_at` / `stok_rt` httpOnly çerezleri, SameSite=Lax;
   `Secure` bayrağı `APP_URL` şemasından, tanımsızsa açık (fail closed). Süresi
   dolan access token render sırasında sessizce yenilenir. Render çerez
   yazamadığı için kalıcı hâle getirme işini `/oturum/yenile` yapar.
4. **Mobil taşıması** (planlı): `Authorization: Bearer`, aynı `actorFromAccessToken`.
5. **Yetki**: `Actor { tenantId, userId, role }` token'dan gelir, istemciden asla.
   - `requirePermission` ihlalde 403 fırlatır.
   - Fiyat gizleme ayrı bir katmandır (`redact*`). Ekran rolü ikinci kez
     yorumlamaz, cevabın şeklinden türetir.
   - Çalışan yalnız kendi hareketlerini görür (`movementUserScope`).

Tehditler, korumalar ve bilinen açıklar: `docs/SECURITY_MODEL.md` (S1–S17).

## 10. Arka plan işleri ve cron

- `background_jobs`: `QUEUED → RUNNING → SUCCEEDED | FAILED`. Deneme hakkı varsa
  60 sn sonra tekrar; `FAILED` son durumdur (başarısızlık bir satır olarak görünür kalmalı).
- Ayrı bir işçi süreci yok. `POST|GET /api/cron` (`CRON_SECRET`) her kiracı için sırayla:
  1. Günün işlerini dedupe anahtarıyla planla: gün sonu raporu, kritik stok,
     sağlık alarmı (saatlik).
  2. Kuyruğu işle; elle istenen büyük export'lar da burada işlenir.
  3. Bakım: eski sayaçları buda, invariant'ı denetle.
- Uç, invariant kırıksa ya da bir iş kalıcı başarısızsa 500 döner. Alarm ilkesi: `OPS-09`.
- Sistem sağlığı üç sessiz arızayı izler: defter/projeksiyon ayrışması, kuyrukta
  çürüyen iş, hareketsizlik.

## 11. Kritik invariant'lar

Bunlardan birini bozan değişiklik, testler yeşil olsa bile bozuktur.

| # | Invariant | Nerede zorlanıyor |
|---|---|---|
| INV-1 | Her ürün için `SUM(stock_movements.delta) = current_stock.qty` | Trigger; `createMovement` transaction içi kontrolü; cron/sağlık `checkStockInvariant`; `invariant.test.ts` |
| INV-2 | Defter append-only: UPDATE/DELETE yok | Yetki + trigger (migration 0002); `rls.test.ts` |
| INV-3 | Stoğu yalnız `createMovement()` değiştirir | Konvansiyon + grep. `current_stock` uygulama rolüne yazılabilir; sertleştirme TODOS'ta |
| INV-4 | Uygulama `stok_app` ile bağlanır; her tabloda FORCE RLS; kiracı bağlamı yalnız `withTenant` | `rls.test.ts`, Biome kuralı |
| INV-5 | Çıkış kilit altında kontrol edilir; eşzamanlı çıkışlar stoğu yetkisiz negatife düşüremez | `FOR UPDATE`; `concurrency.test.ts` |
| INV-6 | Aynı idempotency anahtarı ikinci bir hareket üretmez | UNIQUE indeks; `kaos.test.ts`, `movements.test.ts` |
| INV-7 | Liste fiyatından sapma sebepsiz kaydedilemez; liste fiyatı istemciden alınmaz | DB CHECK + sunucu çözümü; `prices.test.ts` |
| INV-8 | Miktar/para hesabında kayan nokta yok | `numeric.ts`, `NUMERIC` sütunlar |
| INV-9 | Sebep/rol/birim/barkod türü/iş türü listeleri tek kaynaktan; DB CHECK onlardan üretilir | `schema-sync.test.ts` |
| INV-10 | Alış fiyatı çalışana hiçbir yoldan gitmez (cevap, hata metni, log, Excel) | `role-matrix.test.ts`, `prices.test.ts`, e2e |

## 12. Güvenlik ve mimari ilkeleri

1. **Kural veritabanında da durur.** Uygulama kodu unutabilir: ledger,
   projeksiyon, RLS ve fiyat sapması DB seviyesinde zorlanır, uygulama da
   kullanıcıya anlaşılır hata vermek için aynısını ikizler.
2. **Güvenli varsayılan kapalı taraftır.** Ayarsız RLS boş döner; `APP_URL` yoksa
   çerez `Secure`; `CRON_SECRET` yoksa uç kapalı; eksik yapılandırmada sunucu açılmaz.
3. **Tek kaynak.** Bir liste ya da kural üç yerde yazılmaz; üretilir ve senkronu
   test edilir. Kod değerleri (sebep, rol, birim) İngilizce, çünkü API'ye, Excel'e
   ve ileride muhasebe entegrasyonlarına gidiyor; Türkçe etiketler aynı dosyada.
4. **Hata yutulmaz.** Genel `catch` yok. Her hata ya tekrar denenir, ya
   kullanıcıya görünür biçimde bozulur, ya bağlam eklenip yeniden fırlatılır.
   Sunucu sabit `{code, message, details}` döner; Türkçe metin koddan üretilir,
   `message` ekrana basılmaz.
5. **Sessiz başarısızlık en pahalı hatadır.** Başarısız iş satır olarak kalır;
   alarm gerçek bir sorunda çalar ve gürültü yapmaz.
6. **Ölçülmemiş koruma koruma değildir.** Güvenlik ve invariant korumaları,
   kaldırılınca testin kırmızı yandığı görülerek doğrulanır (`dogrula` skill'i).
7. **Gizli veri loga ve URL'ye gitmez.** Fiyat ve barkod loglanmaz; iç kimlikler
   hata detayından süzülür.
8. **Gerçek ortamda test.** Doğruluğun çoğu PostgreSQL'de durduğu için testler
   gerçek PG'ye ve `stok_app` rolüyle koşar; DB mock'lanmaz.
9. **Ortamı hazırlamak uygulamanın işi.** Uygulama kök `.env`'i kendisi okur,
   yapılandırmayı açılışta (derlemede değil) doğrular; kurulum betiği uygulamanın
   hatasını örtmez.
10. **Kullanılmayan şema eklenmez.** "İleride lazım olur" diye eklenen tablo
    hazırlık değil bakım borcudur; özellik geldiğinde tasarımı büyük ihtimalle
    değişir. Sayım tabloları bu yüzden yok (`count_session_id` kapısı açık).

## 13. Tasarım ilkeleri

- Ekran önce "bir sorun var mı?" sorusunu cevaplar: uyarılar → bugün → son
  hareketler → tablo.
- Okunaklı tablo ve büyük, net sayı. Grafik yalnız sayının ALTINDA ve
  destekleyicidir; süs ve AI şablonu yoktur.
- Renk tek başına anlam taşımaz: renk + ikon + metin.
- Depo koşulları (eldiven, kötü ışık, acele): büyük dokunma hedefi (ölçü kararı
  açık: `UX-04`), yüksek kontrast, belirgin odak halkası, sesli kayıt onayı.
- Barkod okuyucu klavyedir: alan otomatik odaklanır, Enter gönderir.
- Boş durum bir özelliktir: "henüz ürün yok" ekranı toplu aktarmaya götürür.
- Türkçe tek dil; Türkçe sayı ve tarih biçimi; Türkçe büyük/küçük harf kuralları.
- Tasarım token'ları ve ölçüler: `apps/web/src/app/globals.css`, `components/field.tsx`.
  Kurallar tuvali `design/`.

## 14. Bilinçli kapsam dışı

Abonelik/faturalama ve kiracı self-servis kaydı (ilk müşteri gelmeden erken),
mikroservis / ayrı API servisi (monolit aynı işi yapıyor), FIFO maliyet (ilk
yöntem kararı `DAT-15`), e-Fatura ve Logo/Mikro/Paraşüt köprüsü, tedarikçi ve
sipariş yönetimi, mock API katmanı (gerçek Postgres + seed var), ayrı donanım
terminali desteği (telefonun kendisi terminal), çoklu dil. Ertelenen özellikler
(sayım, etiket, maliyet raporu, konum, çok depo) `TODOS.md` → "Product / Future".
