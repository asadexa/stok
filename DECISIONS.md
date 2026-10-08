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

## Mimari

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| ARC-07 | Dış istemciler için REST, tRPC değil: mobil ve muhasebe entegrasyonları (Logo/Mikro) aynı sözleşmeyi kullanacak | Active (uygulanmadı) | PLAN §0 | Web bugün Server Action kullanıyor (`PROJECT_BRAIN` §4) |
| ARC-09 | API versiyonlama `/api/v1` + `X-Client-Version` + `426 CLIENT_TOO_OLD` | Active (uygulanmadı) | ADR-005 | |
| ARC-10 | Mobil offline outbox; idempotency anahtarı OKUTMA anında üretilir; önbellek yalnız okutulan ürünler; çevrimdışı tanınmayan barkod reddedilmez, işaretlenir | Active (uygulanmadı) | ADR-003 · D-1.3, D9 | Sunucu tarafı hazır. Tam katalog: T159 |
| ARC-13 | Mobil dağıtım EAS Build + EAS Update (JS değişikliği OTA ile geri alınabilir; native değişiklik mağaza turu ister) | Active (uygulanmadı) | PLAN §2 · D6 | ADR-005'in bağlamı "mobil geri alınamaz" diyor: çelişki, T143 |

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
| DAT-16 | Saat dilimi: gün sınırı ve mesai neye göre (sabit Europe/Istanbul mu, kiracı ayarı mı) | Open | denetim 2026-10-08 | Kod bugün sunucu yerel saatini varsayıyor: T121, T122 |

## Fiyat defteri

Model `PROJECT_BRAIN.md` §7'de; tasarım `docs/designs/fiyat-defteri.md`.

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| PRC-03 | Liste fiyatından sapma sebebi zorunlu, listeden seçilir ("Diğer"de not zorunlu); DB CHECK'te epsilon yok | Active | PLAN T88 · "D6 iptal" | Ayarlanabilir tolerans tasarlanıp reddedildi: fiyat barkod/fişten gelir, kazara sapma yoktur |
| PRC-05 | Devirde (OPENING) fiyat zorunlu (append-only: sonradan eklenemez); fiyatın ekonomik tarihi `price_date` ayrı; geçmiş tarih yalnız satış dayanaklı OLMAYAN sebeplerde | Active | PLAN T89 | Açılış stoğu içe aktarma (T128) da buna uymalı |
| PRC-08 | Yenileme maliyeti: hesap SQL `numeric` ile (TS'te kayan nokta ya da ikinci bigint seti yok); kaynak sırası son alış → Yİ-ÜFE endeksli → alış fiyatı; `price_index` = ENABLE+FORCE RLS + `SELECT USING (true)` + yazma REVOKE; `(tenant_id, product_id, created_at DESC) WHERE reason='PURCHASE'` kısmi indeksi | Active (uygulanmadı) | PLAN T90 · Faz 10 "D5, D6, D9" | `USING (true)` deseni yalnız ulusal açık veri için; kiracı tablosuna kopyalanmaz |
| PRC-11 | T90 / T91 açık soruları ve teyit bekleyen varsayımlar: "son alış yeterince yeni" eşiği (öneri 90 gün); Yİ-ÜFE'yi kim, ne sıklıkla günceller ve bayatlık uyarısı; `client_list_price` uyuşmazlığı raporda nasıl görünür; sapma sebebi listesinin içeriği; fire/kullanımda fiyat olmaması (kodda uygulandı) | Open | `docs/designs/fiyat-defteri.md` "Açık sorular" · PLAN Faz 10 | T90'ı blokluyor |

## Güvenlik ve kiracı

Tehdit ve koruma ayrıntısı `docs/SECURITY_MODEL.md`'de.

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| SEC-01 | Kiracı izolasyonu veritabanında: uygulama `stok_app` (sahip değil, BYPASSRLS yok); tüm tablolarda ENABLE + FORCE RLS; bağlam yalnız `withTenant()` (`SET LOCAL`) | Active | ADR-002 · D5 | |
| SEC-02 | Kiracı bağlamı bilinmeden yapılması gerekenler yalnız dar SECURITY DEFINER fonksiyonlarıyla; `search_path` sabit; "tenant NULL iken her şeyi geçir" politikası YOK | Active | ADR-002 | Supabase yetkileri doğrulanmadı: T124 / S15 |
| SEC-03 | `tenants` tablosuna uygulama yazamaz; kiracı açmak provisioning işidir | Active | migration 0002 | Araç yok: T162 |
| SEC-14 | E-posta tekilliği global mi; kiracı içiyse girişte kiracı seçimi nasıl | Open | denetim 2026-10-08 | Bugünkü model: kullanıcı tek kiracıya ait, kiracı değiştirici yok (PLAN Faz 9b). T123 / S14 |

## Operasyon

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| OPS-01 | Barındırma: Vercel + Supabase mi, kendi VPS mi | Open | PLAN · U3 | Varsayılan Vercel + Supabase; kod ve runbook buna göre. "Veri Türkiye'de kalsın" talebi VPS gerektirebilir. Görsel depolama (T136) buna bağlı |
| OPS-02 | Saatlik cron için Vercel Pro mu, harici zamanlayıcı mı | Open | PLAN T42.1, T115 | Hobby günde bir cron veriyor |
| OPS-03 | Üretim veritabanı: `stok_app` önce güçlü parolayla ELLE yaratılır, sonra `init`; migration'ı insan çalıştırır (build adımında değil, doğrudan 5432); `MIGRATION_DATABASE_URL` uygulamanın çalışma ortamına konmaz | Active | runbook §1–§3 · T119 | Adımlar runbook'ta |
| OPS-09 | Alarm/rapor ilkesi: sorun yoksa e-posta gitmez; ilk geçici hata alarm değildir; sağlık alarmı saatlik ve tekrarsız. Gürültü yapan alarm, alarmı öldürür | Active | PLAN T35, T36 | Kalıcı FAILED işler bunu bozuyor: T126 |

## Tasarım

İlkeler `PROJECT_BRAIN.md` §13'te; burada yalnız açık kararlar.

| ID | Karar | Durum | Kaynak · Eski ID | Not |
|---|---|---|---|---|
| UX-04 | Dokunma hedefi: tek kural 56 px mi, kademeli (gezinme 48 / kontrol 52 / barkod-miktar 64) mi | Open | PLAN T106 | Tasarım tuvali kademeli diyor; kodda 44 px de var |
| UX-08 | Formların JavaScript'siz çalışması bir hedef mi (depodaki tarayıcılar) | Open | PLAN T110 | T110'u blokluyor; JS'siz ise P0 |
| UX-09 | Hareket formunda fiyat alanları sebebe göre gizlensin mi (yalnız progressive enhancement) | Open | PLAN T108 | Önce ölçüm |
