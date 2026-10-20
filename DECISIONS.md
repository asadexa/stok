# DECISIONS — karar indeksi

Yalnız **uzun ömürlü ve hâlâ anlamlı** kararlar: yokluğunda bir geliştiricinin
makul biçimde yanlış ve pahalı bir ürün/mimari kararı verebileceği şeyler.
Gerekçe burada değil, kaynakta (ADR, tasarım belgesi, arşiv).

**Burada OLMAYANLAR ve yerleri**

| Ne | Nerede |
|---|---|
| Sistemin nasıl çalıştığı (katmanlar, defter, fiyat modeli, auth akışı, invariant'lar) | `PROJECT_BRAIN.md` |
| Tehditler ve korumalar | `docs/SECURITY_MODEL.md` |
| Yapılacak işler | `TODOS.md` |
| Kodda gerekçesiyle yazılı düşük seviyeli tercihler (Biome, SHA sabitleme, havuz ayarı, yükleme sınırı…) | İlgili dosyanın yorumu |
| Eski kararların tarihçesi ve eski numaraları | `docs/archive/` |

**Durum**

- `Active`: geçerli. "(uygulanmadı)" kararın verildiğini, kodun henüz yazılmadığını söyler.
- `Open`: karar VERİLMEDİ. Varsayılan yazılıysa bağlayıcı değil; bloklanan iş TODOS'ta `BLOKE:` taşır.
- `Superseded → <ID>`: yerine geçen kayıt yazılı; satır silinmez.

**ID**: `<ALAN>-<nn>`, numara yeniden kullanılmaz (aradaki boşluklar göçte birleştirilen
kayıtlardır). Alanlar: `PRD` ürün · `ARC` mimari · `DAT` veri/defter · `PRC` fiyat ·
`SEC` güvenlik · `OPS` operasyon · `UX` tasarım. Karar değişince eski satır
`Superseded` olur, yenisi yeni ID alır; ADR gerektiriyorsa önce ADR yazılır.
Kaynak `PLAN` = `docs/archive/PLAN-2026-09.md`.

---

## Ürün ve kapsam

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| PRD-01 | Hedef: tek depolu KOBİ; şema baştan çok kiracılı (her tabloda `tenant_id`) | Active | PLAN §0 · D1 | Kapsam dışı liste `PROJECT_BRAIN` §14 |
| PRD-03 | v1 web paneli; native mobil (Expo, offline) planlı ama kullanıcı kararıyla EN SONA bırakıldı | Active | PLAN §0 · D2 | Mobil görevleri TODOS "Product / Future" |
| PRD-06 | Davet e-postası yok; çalışanın parolasını yönetici belirler (depo çalışanının iş e-postası çoğu zaman yok) | Active | PLAN T24 | Parola kurtarma tasarımı (T163) bunu hesaba katmalı |
| PRD-11 | Ürünün asıl çözdüğü acı hangisi (sayım tutmuyor / sorumlu yok / sipariş kaçıyor) | Open | PLAN · U4 | İlk demoda hangi ekranın açılacağını belirler |
| PRD-12 | Telefonla okutma stok hareketi DEĞİLDİR: telefon yalnız barkod metnini laptoptaki `/hareket?barkod=` akışına taşır; stok yalnız laptopta Kaydet'le (`createMovement`, laptop kullanıcısının yetkisi) değişir. Telefonda her gönderim bilinçli adım ("Sonraki Ürünü Tara"); laptopta değiştirilmiş form yeni okumayla değişmez | Active | WS-SCAN, 2026-10-09 (iPhone kabul testi) | `SECURITY_MODEL` S18. Telefona ürün/fiyat/stok gitmez |
| PRD-13 | Hedef uzun ömürlü, ticari olarak kullanılabilir bir ürün; önceki hızlı teslim (48 saat) hedefi geçersiz. Pilot ilk gerçek kullanımdır, kapsamın sınırı değildir. Öncelik: stok doğruluğu, sonra operasyonel kolaylık. Özellik gerçek kullanıcı değeriyle seçilir; iş küçük, test edilebilir workstream'lerle ilerler; erken optimizasyon ve "ileride lazım olur" yapısı eklenmez | Active | Kullanıcı kararı, 2026-10-13 | Mimari ilkeler `PROJECT_BRAIN` §12 |
| PRD-14 | B2B V1, tedarikçi verisi (P1): tedarikçinin ürün, fiyat ve stok bilgisi çekilir. Bir ürün birden çok tedarikçiye bağlanabilir; tedarikçiler arasında güncel fiyat ve stok karşılaştırılır. Yenileme kullanıcının "Verileri Getir" düğmesiyle; çekilen fiyat ve stok her değişim için onay istenmeden kaydedilir. Fiyat değiştiyse önceki ve güncel fiyat saklanır, artış/azalış gösterilir; değişmeyen fiyat geçmiş kaydı üretmez. Tedarikçi fiyatı ürün kartının alış/satış fiyatını, tedarikçi stoğu işletmenin fiziksel stoğunu değiştirmez ve hareket üretmez. Para birimi, vergi ya da fiyat türü farklı fiyatlar yanlış biçimde karşılaştırılmaz. V1'de B2B sipariş ve otomatik periyodik senkron yok | Active | Ekip kararı, 2026-10-17 · T200, T201 | Uygulama: T200 Dilim 1a (`9d4bc8c`, CI #83) ve 1b (`667512a`, CI #84), dosya kaynağı ve örnek API verisiyle; kullanıcı kabul testi bekleniyor, Dilim 2 kalan. Gerçek tedarikçi API entegrasyonu T201 kapsamında. Gerçek sağlayıcı seçilmedi: V1 sağlayıcıdan bağımsız model, dosya kaynağı ve örnek API verisiyle doğrulanır; gerçek API sağlayıcı seçilince. Mevcut içe aktarma ve eşleştirme altyapısının yeniden kullanımı değerlendirilir. Tam tedarikçi/sipariş yönetimi kapsam dışı (`PROJECT_BRAIN` §14); sonraki sürüm T202 (sipariş), T203 (periyodik senkron). Bizim sunduğumuz REST (`ARC-07`, T53) ayrı konu. Özellik kaydı `docs/TEKNIK_SARTNAME.md` F-12 |
| PRD-15 | B2B V1 eşleşme ve karşılaştırma kuralları: otomatik eşleşme YALNIZ barkodla (kod/ad benzerliğiyle değil); elle bağlama ve "yok say" yenilemede korunur. Fiyatın ait olduğu miktar ürün eşleşmesinden ayrı ve yalnız açık beyandan gelir (satırdaki "Fiyat Miktarı" ya da yöneticinin tedarikçi düzeyinde "1 ürün birimi" beyanı; varsayılan BELİRSİZ); koli barkodu miktar üretmez. Karşılaştırma ve yüzde yalnız para birimi, KDV durumu, fiyat türü ve miktar aynı ve biliniyorsa. Dosya Önizle → Kaydet ile tek onayla uygulanır; fiyat değişimleri tek tek onaylanmaz | Active | T200 PLAN, kullanıcı onayı 2026-10-19 (B1, B2) | Uygulama: `packages/core/src/suppliers.ts` (1a); ekranlar 1b. Veri modeli DAT-19 / ADR-006 |
| PRD-16 | Tedarikçi ayarlarını (ad, varsayılan para birimi, KDV durumu, fiyat türü, "1 ürün birimi" beyanı) düzenlemek YALNIZ sonraki "Verileri Getir"i etkiler. Mevcut kalemler yeni varsayılanlarla yeniden yorumlanmaz, fiyat geçmişi geriye dönük değişmez; koşul farkı bir sonraki yenilemede "koşul değişimi" olarak kaydedilir | Active | T200 1b PLAN, kullanıcı onayı 2026-10-20 (K1) | Uygulama: `updateSupplier` (`packages/core/src/suppliers.ts`); test "tedarikçi ayarlarını düzenleme (K1)". Kalemleri yeniden yorumlamak, dosyada olmayan kalemi değiştirmek demek olurdu (`DAT-19`: yokluk bilgi değildir) |

## Mimari

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| ARC-07 | Dış istemciler için REST, tRPC değil: mobil ve muhasebe entegrasyonları (Logo/Mikro) aynı sözleşmeyi kullanacak | Active (uygulanmadı) | PLAN §0 | Web bugün Server Action kullanıyor (`PROJECT_BRAIN` §4) |
| ARC-09 | API versiyonlama `/api/v1` + `X-Client-Version` + `426 CLIENT_TOO_OLD` | Active (uygulanmadı) | ADR-005 | |
| ARC-10 | Mobil offline outbox; idempotency anahtarı OKUTMA anında üretilir; önbellek yalnız okutulan ürünler; çevrimdışı tanınmayan barkod reddedilmez, işaretlenir | Active (uygulanmadı) | ADR-003 · D-1.3, D9 | Sunucu tarafı hazır. Tam katalog: T159 |
| ARC-13 | Mobil dağıtım EAS Build + EAS Update (JS değişikliği OTA ile geri alınabilir; native değişiklik mağaza turu ister) | Active (uygulanmadı) | PLAN §2 · D6 | ADR-005'in bağlamı "mobil geri alınamaz" diyor: çelişki, T143 |
| ARC-14 | Telefon → laptop tarama köprüsü (pilot): QR eşleşmesi, oturum **süreç belleğinde**, laptop **salt okunur polling** (`?since=`), telefon `Bearer` token; WebSocket/SSE/DB tablosu yok. Yalnız tek süreçli `next start`'ta doğru; çok örnekli kurulumda (Vercel) `ENABLE_PHONE_SCANNER` kapalı kalmalı, orada paylaşılan bir depo gerekir | Active | WS-SCAN, 2026-10-09 | Sunucu yeniden başlarsa oturumlar düşer (telefon "bağlantı kapandı" görür). Kamera çözücüsü barcode-detector + zxing-wasm, WASM kendi origin'imizden. Tünel riski T167 |

## Veri ve stok defteri

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| DAT-01 | Stok, append-only hareket defterinin sonucu; `current_stock` trigger'la tutulan, denetlenen projeksiyon | Active | ADR-001 · D-1.1 | |
| DAT-02 | Stoğu değiştiren TEK fonksiyon `createMovement()`. İstisnalar yalnız sahip rolüyle: test için `seedOpeningStock`, demo verisi için `seed.ts` | Active | ADR-001 · T9 | Projeksiyon uygulama rolünce yazılabilir: T132 |
| DAT-08 | Negatif stok: çalışan engellenir; yönetici `allowNegative` ile geçer; girişler her zaman serbest | Active | PLAN · U1 | Varsayılan uygulanmış, kullanıcı açıkça teyit etmedi |
| DAT-10 | Silme yok: ürün ve barkod arşivlenir (arşivli barkod çözülmez, tekillik kısmi indeks); defterdeki hata ters hareketle (`reverses_id`) düzeltilir | Active | ADR-001 · T21 | Ters hareket akışı yazılmadı: T127 |
| DAT-11 | Türkçe arama `tr_norm()` + GIN trgm; collation'a ve `lower()`/`unaccent`'e güvenilmez; sıralama `name_norm` ile | Active | PLAN · D-4.1 | Yeni her arama/sıralama da buna uymalı |
| DAT-13 | Migration'lar yalnız ileri uyumlu (additive); kolon silme, tip değiştirme, NOT NULL ekleme iki sürümde. DB'de geri alma yolu yok | Active | runbook §2, §7 | 0009 ihlal etmiş; zorlama yok: T146 |
| DAT-15 | Maliyet yöntemi: FIFO mu ağırlıklı ortalama mı | Open | ADR-004 · U2 | Varsayılan ağırlıklı ortalama, bağlayıcı değil; karar muhasebeciye ait |
| DAT-16 | Saat dilimi: gün sınırı ve mesai neye göre (sabit Europe/Istanbul mu, kiracı ayarı mı) | Open | denetim 2026-10-08 | Kod bugün sunucu yerel saatini varsayıyor: T121, T122. İstisna: Excel hücreleri ve dosya adı sabit Europe/Istanbul (WS-C-lite, `excel.ts`); kiracı ayarı seçilirse oradan okunmalı |
| DAT-17 | Birim hassasiyeti YAZILAN miktarda (girilen × barkod çarpanı) ve ürünün biriminde: adet tam sayı, kg/metre/litre ≤3 ondalık. Karar `createMovement`'ta, ölçekli bigint üzerinde, kilitten önce; önizleme ve formlar yalnız erken uyarı. Adetli üründe koli çarpanı tam sayı | Active | WS-B, 2026-10-10 · T130 | 0,5 koli × 12 = 6 adet geçer. Birim değişimi sonrası eski veri: T170 |
| DAT-18 | İçe aktarmada açılış stoğu yalnız "Açılış Stoğu" (ve açık eş adları) sütunundan; "Miktar/Stok/Adet" okunmaz, uyarılır. Devir `createMovement` ile OPENING, ürünün tekli barkodu ve Alış Fiyatı'yla; yalnız ürünün İLK hareketi olabilir (kilit altında); idempotency anahtarı UUID v5 (`tenant:ürün`), ürün başına tek içe aktarma devri | Active | WS-B, 2026-10-10 · T128 | Hareketli üründe devir atlanır, ürün güncellenir. Ad alanı UUID'si değiştirilemez (`import.ts`) |
| DAT-19 | Tedarikçi verisi stok defterinden ayrı; kalemin güncel hâli + yalnız değişimde append-only fiyat geçmişi (`stok_app` UPDATE/DELETE yok). Değişmeyen fiyat ve karşılaştırılabilirlik kuralı DB'de (CHECK, üretilen sütun). Tedarikçi fiyatı NUMERIC(14,4). Dosyada olmayan kalem değişmez ve işaretlenmez (yokluk bilgi değildir) | Active | ADR-006 · T200 (B3) | Yenileme kopyası ve stok geçmişi saklanmaz, sonradan geri üretilemez. Geçmişin saklama süresi açık (T200 PLAN K6) |

## Fiyat defteri

Model `PROJECT_BRAIN.md` §7'de; tasarım `docs/designs/fiyat-defteri.md`.

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| PRC-03 | Liste fiyatından sapma sebebi zorunlu, listeden seçilir ("Diğer"de not zorunlu); DB CHECK'te epsilon yok | Active | PLAN T88 · "D6 iptal" | Ayarlanabilir tolerans tasarlanıp reddedildi: fiyat barkod/fişten gelir, kazara sapma yoktur |
| PRC-05 | Devirde (OPENING) fiyat zorunlu (append-only: sonradan eklenemez); fiyatın ekonomik tarihi `price_date` ayrı; geçmiş tarih yalnız satış dayanaklı OLMAYAN sebeplerde | Active | PLAN T89 | İçe aktarma devri buna uyuyor (`DAT-18`); geçmiş tarihli devir fiyatı içe aktarmada yok: T172 |
| PRC-08 | Yenileme maliyeti: hesap SQL `numeric` ile (TS'te kayan nokta ya da ikinci bigint seti yok); kaynak sırası son alış → Yİ-ÜFE endeksli → alış fiyatı; `price_index` = ENABLE+FORCE RLS + `SELECT USING (true)` + yazma REVOKE; `(tenant_id, product_id, created_at DESC) WHERE reason='PURCHASE'` kısmi indeksi | Active (uygulanmadı) | PLAN T90 · Faz 10 "D5, D6, D9" | `USING (true)` deseni yalnız ulusal açık veri için; kiracı tablosuna kopyalanmaz |
| PRC-11 | T90 / T91 açık soruları ve teyit bekleyen varsayımlar: "son alış yeterince yeni" eşiği (öneri 90 gün); Yİ-ÜFE'yi kim, ne sıklıkla günceller ve bayatlık uyarısı; `client_list_price` uyuşmazlığı raporda nasıl görünür; sapma sebebi listesinin içeriği; fire/kullanımda fiyat olmaması (kodda uygulandı) | Open | `docs/designs/fiyat-defteri.md` "Açık sorular" · PLAN Faz 10 | T90'ı blokluyor |

## Güvenlik ve kiracı

Tehdit ve koruma ayrıntısı `docs/SECURITY_MODEL.md`'de.

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| SEC-01 | Kiracı izolasyonu veritabanında: uygulama `stok_app` (sahip değil, BYPASSRLS yok); tüm tablolarda ENABLE + FORCE RLS; bağlam yalnız `withTenant()` (`SET LOCAL`) | Active | ADR-002 · D5 | |
| SEC-02 | Kiracı bağlamı bilinmeden yapılması gerekenler yalnız dar SECURITY DEFINER fonksiyonlarıyla; `search_path` sabit; "tenant NULL iken her şeyi geçir" politikası YOK | Active | ADR-002 | Supabase yetkileri doğrulanmadı: T124 / S15 |
| SEC-03 | `tenants` tablosuna uygulama yazamaz; kiracı açmak provisioning işidir | Active | migration 0002 | Araç: `pnpm tenant:create` (sahip rolüyle, operatör makinesinden; T162) |
| SEC-14 | E-posta tekilliği global mi; kiracı içiyse girişte kiracı seçimi nasıl | Open | denetim 2026-10-08 | Bugünkü model: kullanıcı tek kiracıya ait, kiracı değiştirici yok (PLAN Faz 9b). T123 / S14. Karar verilene kadar kiracı açma aracı başka kiracıdaki e-postayı reddediyor (geçici, T162) |

## Operasyon

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| OPS-01 | Barındırma: Vercel + Supabase mi, kendi VPS mi | Open | PLAN · U3 | Varsayılan Vercel + Supabase; kod ve runbook buna göre. "Veri Türkiye'de kalsın" talebi VPS gerektirebilir. Görsel depolama (T136) buna bağlı. Çevrim içi test ortamı (`OPS-12`, T144) bu seçimi bekliyor |
| OPS-02 | Saatlik cron için Vercel Pro mu, harici zamanlayıcı mı | Open | PLAN T42.1, T115 | Hobby günde bir cron veriyor |
| OPS-03 | Üretim veritabanı: `stok_app` önce güçlü parolayla ELLE yaratılır, sonra `init`; migration'ı insan çalıştırır (build adımında değil, doğrudan 5432); `MIGRATION_DATABASE_URL` uygulamanın çalışma ortamına konmaz | Active | runbook §1–§3 · T119 | Adımlar runbook'ta |
| OPS-09 | Alarm/rapor ilkesi: sorun yoksa e-posta gitmez; ilk geçici hata alarm değildir; sağlık alarmı saatlik ve tekrarsız. Gürültü yapan alarm, alarmı öldürür | Active | PLAN T35, T36 | Kalıcı FAILED işler bunu bozuyor: T126 |
| OPS-10 | Yerel (pilot) yedek, `pnpm db:backup`: yalnız compose `db` kapsayıcısındaki ve uygulamanın `DATABASE_URL`'inin gösterdiği yerel `stok` yedeklenir. Dizin `%LOCALAPPDATA%\stok\yedek` ya da `STOK_BACKUP_DIR`; repo içi, OneDrive, göreli ve `\\` önekli yollar reddedilir. "Doğrulanmış döküm" = içindekiler (TOC) + tam okuma + SHA-256; `pg_restore --list` tek başına yetmez (kesik arşivi geçiriyor). Son 14 kayıtlı döküm tutulur; silme yalnız başarılı koşudan sonra | Active | WS-1 R-1 (2026-10-13; K1, K2, K4, Q-3), WS-1.3a | Başka yere yedek ve uygulama içi gösterge yok; roller dökümde yok, gerçek kurtarma prosedürü ayrı (T129). Geri yükleme kanıtı WS-1.4. Kuşak koruması ve `pg_dump` bekleme sınırı 1.3b'den önce (T190). `SECURITY_MODEL` S20 |
| OPS-11 | Pilot kapısı: doğrulanmış yedek (WS-1.3a) ve geri yükleme tatbikatı (WS-1.4) pilot laptopunda yeşil geçmeden oraya hiçbir WS-1 değişikliği uygulanmaz; elle alınan döküm bunun yerine geçmez | Active | WS-1 R-1 (SC-6), 2026-10-13 | Tatbikat henüz yok; pilot laptopuna dokunulmadı |
| OPS-12 | İnternetten erişim (P1): önce HTTPS ve gerçek alan adıyla çevrim içi bir test ortamı (giriş, ürün yükleme, stok hareketi). Test ortamı ile gerçek müşteri verisi kullanılan üretim ayrı ortam ve ayrı veritabanıdır; test ortamına gerçek müşteri verisi girmez. Yerel Docker yedeği (`OPS-10`) bulut veritabanının yedeği sayılmaz | Active (uygulanmadı) | Ekip kararı, 2026-10-17 · T144, T42 | Barındırma seçimi `OPS-01`'de açık (aday Vercel + Supabase), onaysız kesinleşmez. Telefon köprüsü çok örnekli dağıtımda kapalı (`ARC-14`). Bulut yedeği ve tatbikatı runbook §7, T129. Özellik kaydı `docs/TEKNIK_SARTNAME.md` F-13 |

## Tasarım

İlkeler `PROJECT_BRAIN.md` §13'te; burada yalnız açık kararlar.

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| UX-04 | Dokunma hedefi: tek kural 56 px mi, kademeli (gezinme 48 / kontrol 52 / barkod-miktar 64) mi | Open | PLAN T106 | Tasarım tuvali kademeli diyor; kodda 44 px de var |
| UX-08 | Formların JavaScript'siz çalışması bir hedef mi (depodaki tarayıcılar) | Open | PLAN T110 | T110'u blokluyor; JS'siz ise P0 |
| UX-09 | Hareket formunda fiyat alanları sebebe göre gizlensin mi (yalnız progressive enhancement) | Open | PLAN T108 | Önce ölçüm |
