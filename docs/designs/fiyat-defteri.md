# Tasarım: Fiyat defteri — hareketin kendi fiyatı

/office-hours ile üretildi · 2026-08-30
Dal: `claude/continue-from-where-left-9of0ad`
Depo: asadexa/stok
Durum: ONAYLANDI
Mod: Startup

## Sorun

Kullanıcıdan gelen üç istek:

1. **Eski ürünü stoğa girme.** Müşterinin 5 yıldır elinde tuttuğu bir malı
   sisteme ekleyecek. Eski fiyattan ekleyemiyor; yeni fiyatı nasıl belirleyecek?
2. **Enflasyon.** Bugünkü fiyattan giren mal 6 ay sonra aynı fiyattan satılırsa
   zarar oluyor. Buna karşı bir sistem.
3. **Gerçek satış fiyatı.** Liste fiyatı 110 ₺ olan maldan 100 ₺'ye satıldı.
   Aradaki 10 ₺ hiçbir yere yazılamıyor. Stok düşerken elle girilebilir bir
   fiyat alanı + açıklama alanı isteniyor.

Üçü de tek eksikliğin yüzleri: **defter "kaç tane"yi kaydediyor, "kaça"yı
kaydetmiyor.**

## Ölçülen mevcut durum

| Bulgu | Kaynak |
|---|---|
| `stock_movements.unit_cost` sütunu VAR, `numeric(12,2)` | `packages/db/src/schema.ts:267` |
| `createMovement` bu alanı kabul ediyor ve yazıyor | `packages/core/src/movements.ts:168` |
| Excel'e "Birim Maliyet" sütunu olarak çıkıyor | `packages/core/src/excel.ts:122` |
| Rol bazlı gizleniyor (`PRICE_FIELDS`, tehdit S7) | `packages/core/src/authz.ts:81` |
| **Arayüz bu alanı HİÇ SORMUYOR** | `apps/web/src/app/(panel)/hareket/page.tsx:92` |
| `note` (açıklama) alanı arayüzde ZATEN VAR | `apps/web/src/app/(panel)/hareket/page.tsx:277` |
| `OPENING` (Devir / açılış) sebebi ZATEN VAR | `packages/shared/src/reasons.ts` |

Sonuç: uygulamadan girilen her hareketin `unit_cost` değeri `NULL`. Sadece
`seed.ts` dolduruyor. Şemadaki *"maliyet takibi bu veriyi bugünden topluyor"*
yorumu bugün doğru değil — toplanmıyor.

3 numaranın istediği açıklama alanı zaten çalışıyor; eksik olan sadece fiyat.

## Talep kanıtı

Kullanıcı, üç senaryonun gerçek bir kullanıcı tarafından yaşandığını beyan
etti. Kapsam kararı: üçü de yapılacak, sıra kullanıcı için önemli değil.

**Kanıtın zayıf yanı, açıkça kaydediliyor:** kullanıcının kim olduğu (depocu /
patron / muhasebeci), tam olarak ne dediği ve o an ne yapmaya çalıştığı
sorulmasına rağmen yazılmadı. Üç senaryonun hangisinin gerçekten tıkanmaya yol
açtığı da ayrıştırılmadı. "Görev" bölümündeki iş bunun içindir.

## Bugünkü çözüm (status quo)

Bilinmiyor — sorulmadı. Kullanıcı 110 yerine 100'e sattığında bugün ne
yapıyor? Kâğıda mı yazıyor, aklında mı tutuyor, patrona mı söylüyor, hiçbir
şey mi yapmıyor? **Yeni özellik bunu yenmek zorunda ve ne olduğunu bilmiyoruz.**

## Premiseler

1. **Üç sorun tek eksikliğin üç yüzü.** Defter miktarı kaydediyor, fiyatı
   kaydetmiyor.
2. **Enflasyon ürünü değil parayı değersizleştiriyor.** İhtiyaç duyulan
   sayının adı *yenileme maliyeti*: bugün yerine koymak kaça mal olur.
   Kullanıcının "ürün değer kaybediyor" ifadesi tersine çevrildi ve bu,
   hesaplanacak şeyi değiştiriyor.
3. **Yenileme maliyetinin en iyi kaynağı endeks değil, son alış fiyatı.**
   Yİ-ÜFE ulusal ortalamadır; tedarikçi faturası gerçektir. Endeks yalnızca
   son alışı olmayan ürün için gerekir — yani tam olarak 1 numaradaki 5 yıllık
   ürün için. Bu, 1 ve 2 numarayı aynı özelliğin iki ucu yapıyor.
4. **Bu üç özellik U2'yi (maliyet yöntemi) çözmeyi GEREKTİRMİYOR.**
   FIFO / ağırlıklı ortalama tartışması *"sattığımda hangi geçmiş maliyeti
   düşeyim"* sorusunu cevaplar; bu bir **kâr raporu** sorusudur. Kullanıcının
   sorduğu *"bunu kaça satmalıyım"* ileriye bakan bir sorudur ve geçmiş maliyet
   eşleştirmesi gerektirmez. U2 yalnızca kâr raporunda (E8) mecburi hale gelir.
   Yan fayda: fiyatlar tarihli toplanmaya bugün başlarsa, U2 cevaplanırken iki
   yöntem gerçek veriyle karşılaştırılabilir — karar tahminle değil ölçümle
   verilir.
5. **Kritik alan fiyat değil TARİH.** Tarihsiz fiyat enflasyona göre
   düzeltilemez. 5 yıllık üründe hareketin `created_at`'i bugün, malın
   ekonomik tarihi 5 yıl öncedir. İkisi ayrı sütun olmak zorundadır.

## Değerlendirilen yaklaşımlar

**A — Fiyat defteri (SEÇİLDİ).** Fiyat hareketin içine yazılır, üç adımda
büyür. Var olan sütunu, `note` alanını, `OPENING` sebebini ve `redactPrices`
katmanını yeniden kullanır. Efor S+M+M, risk düşük-orta.

**B — Tam maliyet muhasebesi.** Reddedildi: muhasebeciden cevap gelene kadar
tek satır canlıya çıkmaz, üç sorun da haftalarca çözülmeden bekler.

**C — Önce uyarı, veri sonra.** Reddedildi: hiç veri toplamıyor. 6 ay sonra
"ne kadara sattık" sorusunun cevabı hiçbir yerde olmaz ve o veri geriye dönük
yazılamaz.

## Seçilen yaklaşım: A

Üçünü de kapsayan tek yol. 3 numarayı ilk adımda çözüyor, 1 ve 2'nin muhtaç
olduğu tarihli fiyat verisini ilk günden biriktirmeye başlıyor, U2'yi açık
bırakıyor.

### Şema

```sql
-- Anlam genişliyor: yön belirler (giriş = maliyet, çıkış = hasılat).
ALTER TABLE stock_movements RENAME COLUMN unit_cost TO unit_price;

-- Fiyatın ait olduğu ekonomik an. NULL = hareket tarihi.
-- 2 numara BU SÜTUN OLMADAN çalışamaz.
ALTER TABLE stock_movements ADD COLUMN price_date date;

-- O günkü liste fiyatı DONDURULUYOR. Ürün sonradan düzenlenirse geçmişteki
-- fark değişmesin diye; defter zaten bu yüzden append-only.
ALTER TABLE stock_movements ADD COLUMN list_price numeric(12,2);

-- Fiyat nereden geldi: LIST / MANUAL / RECEIPT / INDEXED / ESTIMATED.
-- Fiş entegrasyonu geldiğinde şema hazır olsun diye bugünden duruyor.
ALTER TABLE stock_movements ADD COLUMN price_source text;

-- Liste fiyatından sapma sebebi. Serbest metin DEĞİL, listeden.
ALTER TABLE stock_movements ADD COLUMN price_override_reason text;

-- Sapma sebepsiz olamaz. Kural satırı kimin yazdığından bağımsız korunuyor.
ALTER TABLE stock_movements ADD CONSTRAINT movements_price_override_ck
  CHECK (unit_price IS NULL OR list_price IS NULL
         OR unit_price = list_price
         OR price_override_reason IS NOT NULL);
```

Yeniden adlandırma gerekçesi: sütun artık çıkış hareketlerinde satış hasılatı
tutacak; ona "maliyet" demek kalıcı bir yalan olur ve ilk muhasebeciyi
yanıltır. Yöne göre anlam türetmek bu depoda zaten kurulu bir örüntü —
`delta`'nın işareti de kullanıcıdan değil `reason`'dan türetiliyor
(`packages/shared/src/reasons.ts`). Aynı ilke.

Ulusal endeks tablosu (Adım 3):

```sql
-- Tenant'sız: ulusal veri, herkes okur, kimse yazmaz.
CREATE TABLE price_index (
  period date PRIMARY KEY,          -- ayın ilk günü
  value  numeric(12,4) NOT NULL,    -- Yİ-ÜFE
  source text NOT NULL              -- 'TUIK'
);
```

RLS notu: `price_index` tenant kapsamlı değil. `stok_app` rolü için salt-okunur
politika gerekiyor; yazma yalnızca migration/cron rolünde olmalı.

### Adım 1 — Kasa açığı kontrolü (3 numara)

**2026-08-30 düzeltmesi.** İlk taslak bunu kâr marjı özelliği sanmıştı. Değil.
Kullanıcının anlattığı senaryo: kırtasiyede çalışan A4 satıyor, fiş liste
fiyatından 110 ₺ yazıyor, müşteri tanıdık diye 100 ₺ alınıyor, **kasada 10 ₺
açık kalıyor.** Amaç açığı engellemek değil, gizlenemez yapmak — kullanıcının
kendi ifadesiyle "takip amaçlı".

Bu, tasarımı dört yerde değiştiriyor:

**a) Açıklama zorunlu.** İsteğe bağlı `note` yetmez. Liste fiyatından
sapıldığında açıklama zorunlu hale gelir.

**b) `list_price` harekete dondurulur.** İlk taslakta yoktu ve bu eksiklik
kontrolü çürütürdü: `products.sale_price` sonradan 110 → 120 olursa, geçmişteki
10 ₺'lik açık geriye dönük 20 ₺'ye dönüşür. Defter tam da bunun için
append-only; o günkü liste fiyatı da hareketle birlikte donmalı.

```
list_price  = sistemin "olması gereken" dediği  (110)
unit_price  = gerçekte ne olduğu                (100)
fark        = 10 ₺, ürün sonradan düzenlense de değişmez
```

**c) Kural veritabanında zorlanır.** İki sütun aynı satırda:

```sql
CHECK (unit_price IS NULL OR list_price IS NULL
       OR unit_price = list_price
       OR price_override_reason IS NOT NULL)
```

Deponun kendi felsefesi — `movements_delta_nonzero_ck` ve `movements_reason_ck`
zaten böyle. Kural, satırı kimin yazdığından bağımsız korunuyor.

**d) Sebep serbest metin değil, listeden.** Takip toplanabilirlik demektir;
serbest metin "bu ay tanıdık indirimine kaç lira gitti" sorusunu cevaplayamaz.
`MOVEMENT_REASONS` örüntüsünün aynısı:

`TANIDIK` · `TOPTAN` · `KAMPANYA` · `HASARLI` · `ESKI_STOK` · `YUVARLAMA` ·
`YONETICI_ONAYLI` · `DIGER` (Diğer'de serbest metin zorunlu)

`YUVARLAMA` bilerek listede: 108,50 → 108 çok sık olur ve her yuvarlama zorunlu
açıklama tetiklerse çalışan refleksle "Diğer" seçmeye başlar, veri çöpe döner.

**Ve: okunmayan kayıt kontrol değildir.** Kayıt tek başına takip değil.
Gün sonu raporu (T34) kasa açığını taşımalı — "bugün 7 harekette liste
fiyatının altına inildi, toplam fark 84 ₺, en çok Ahmet". Bunsuz kimsenin
açmadığı bir tablo olur. Ayrı görev: T88.1.

**Fiş entegrasyonu için `price_source`.** Kullanıcı ileride muhasebe
uygulamasını entegre edip fiş okutacak; fiyat oradan gelecek. Fiyatın nereden
geldiği bugünden kayıtlı olmazsa o gün ikinci bir migration gerekir.
`price_estimated` boolean'ı yerine: `LIST` / `MANUAL` / `RECEIPT` / `INDEXED` /
`ESTIMATED`.

### Adım 2 — Açılış değerlemesi (1 numara)

`OPENING` sebebi seçildiğinde form üç alan daha açar:

- `birimFiyat` — bu sebepte **zorunlu**
- `fiyatTarihi` — varsayılan bugün, geçmiş tarih girilebilir
- `tahmini` — onay kutusu

Formdaki yönlendirme metni (1 numaranın cevabı budur):

> Elinizde eski fatura varsa o tutarı ve fatura tarihini girin — sistem bugüne
> taşır. Fatura yoksa bugün aynısını kaça alacağınızı girin ve "tahmini"
> işaretleyin.

Doğrulama: `price_date <= bugün`. `price_date` hareket tarihinden eskiyse
sistem bunu 5-yıllık-mal durumu sayar ve Adım 3'te endeksle düzeltir.

### Adım 3 — Yenileme maliyeti (2 numara)

`replacementCost(productId)` sırayla dener:

1. Son `PURCHASE` hareketinin `unit_price`'ı — `price_date` yeterince yeniyse
   (öneri: 90 gün) doğrudan kullanılır. **En iyi kaynak budur.**
2. Yoksa: bilinen en son fiyat × (bugünkü Yİ-ÜFE ÷ `price_date`'teki Yİ-ÜFE).
3. Hiçbiri yoksa: `products.purchasePrice`.

Arayüz: satış ekranında fiyat alanının altında

> Yerine koyma maliyeti: **130,00 ₺** · son alış 12.06.2026

Girilen fiyat yenileme maliyetinin altındaysa uyarı rozeti çıkar.

**Uyarı, engel değil.** Eski stoğu elden çıkarmak için maliyetin altına
satmak meşru bir karardır; engellemek yanlış olur.

### Yetki: çalışan hangi fiyatı görür

`redactPrices` bugün `unitCost`'u satırdan topluca siliyor. Sütun artık satış
hasılatı da tutacağı için kural satır bazına inmeli:

- `reason = 'SALE'` → çalışan görebilir. Satış fiyatı ticari sır değil;
  müşteri zaten biliyor, fiyatı çalışanın kendisi söyledi.
- Diğer tüm sebepler (`PURCHASE`, `OPENING` dahil) → gizli kalır. Tehdit S7
  alış fiyatını korur ve `OPENING` bir alış değerlemesidir.

Bu, `redactPrices`'ın `Omit<T, PriceField>` dönüş tipini kırar: alanın varlığı
artık satıra bağlı. Mevcut test *"çalışan cevabında unitCost ALANI HİÇ YOK"*
(`packages/core/src/role-matrix.test.ts:315`) *"girişlerde yok, satışlarda
var"* olarak güncellenmeli.

## Bu tasarımın YAPMADIĞI şeyler

Ticari üründe bunlar açıkça söylenmeli, yoksa müşteri yanlış varsayar:

- **Kâr raporu yok.** COGS hesabı U2 kararını gerektiriyor.
- **Resmî enflasyon düzeltmesi beyannamesi değil.** Bu bir karar destek aracı;
  VUK mükerrer 298/A kapsamındaki mali tablo düzeltmesinin yerine geçmez ve
  arayüzde bu yazmalıdır. Aksi halde müşteri vergi uyumu sanır.
- **Parti (lot) takibi yok.** Aynı üründen farklı fiyatlı stoklar ayrışmıyor.

## Açık sorular

| # | Soru | Etki |
|---|---|---|
| 1 | ~~Yİ-ÜFE nereden~~ **KARARLAŞTI:** bir kez toplu çekilir (~390 satır), sonra ayda bir elle. Bayatlama sessiz olmamalı — endeks eskiyse uyarı çıkmalı, yoksa yenileme maliyeti sessizce düşük görünür | Adım 3 |
| 2 | ~~Yİ-ÜFE doğrulanmadı~~ **ÇÖZÜLDÜ 2026-08-30:** hakedis.org üzerinden teyit edildi — aylık, 1994 Ocak → 2026 Temmuz, baz 2003=100, kaynak TÜİK. 5 yıllık ürün rahat kapsanıyor | — |
| 3 | `DAMAGE` / `USAGE` çıkışlarında fiyat ne olmalı? Öneri: NULL (para el değiştirmedi) | Fire raporlaması |
| 7 | ~~Tolerans eşiği~~ **KARAR D6 (2026-08-30):** işletme belirliyor, varsayılan %1, `tenants` tablosunda tek sütun, yalnızca `user:manage` değiştirebilir. Tolerans neyin kaydedildiğini değil kimin sorgulandığını etkiliyor | — |
| 8 | Sapma sebebi listesi doğru mu? Eksik/fazla var mı? | T88 veri kalitesi |
| 4 | Son alış "yeterince yeni" eşiği 90 gün mü? | Yanlış yenileme maliyeti riski |
| 5 | U2 (maliyet yöntemi) — hâlâ açık, artık bloke DEĞİL | Kâr raporu (E8) |
| 6 | `unit_cost` → `unit_price` yeniden adlandırması onaylanıyor mu? | ~20 çağrı yeri |

## Başarı ölçütü

- Bir hafta sonra, uygulamadan girilen `SALE` hareketlerinin **≥ %80**'inde
  `unit_price` dolu. (Doluluk düşükse alan yanlış yerde ya da fazladan iş
  yaratıyor demektir.)
- Kullanıcı "geçen ay bu maldan kaça satmışız" sorusunu Excel çıktısından
  cevaplayabiliyor.
- 5 yıllık ürünü girerken formda takılmıyor — **gözlemle doğrulanacak,
  anketle değil.**

## Bağımlılıklar

- Adım 3, Adım 1'in ürettiği veriye bağlı. Sıra teknik olarak zorunlu.
- Adım 1 ve 2 bağımsız, paralel yazılabilir.
- U2 artık bu üç adımı bloke etmiyor (Premise 4).
- Dağıtım: mevcut web dağıtım hattı kapsıyor, ek iş yok.

## Görev

Kod yazmadan önce, bunu size söyleyen kullanıcıya geri dönün ve **A4 kağıdı
işlemini bizzat yaptırın, izleyin, karışmayın.** Üç şeyi öğrenin:

1. **10 ₺ farkı bugün ne yapıyor?** Kâğıda mı yazıyor, aklında mı tutuyor,
   patrona mı söylüyor, hiçbir şey mi yapmıyor? Bugün yaptığı şey rakibimiz;
   yeni alan onu yenmek zorunda.
2. **5 yıllık ürün neydi ve eski faturası var mıydı?** Faturası varsa Adım 2
   yeter, endeks yoluna (Adım 3'ün pahalı yarısı) hiç gerek kalmayabilir.
3. **Enflasyon zararını ne zaman fark etti — satarken mi, sonradan mı?**
   Satarken fark ettiyse uyarı doğru yerdedir; sonradan fark ettiyse asıl
   ihtiyaç rapordur, uyarı değil.

## İnceleme notları

Skill bağımsız bir inceleme ajanı öngörüyor; bu oturumda ajan çağırma kapalı
olduğu için inceleme aynı oturumda yapıldı — yani **bağımsız değil.** Kendi
tasarımıma karşı bulduklarım:

- **Talep kanıtı zayıf.** Üç senaryonun hangisinin gerçekten yaşandığı
  ayrıştırılmadı; kullanıcı "hepsi" dedi. Görev bölümü bu açığı kapatmak için.
- **Status quo hiç sorulmadı.** Bugünkü çözümü bilmeden yeni özelliğin daha
  iyi olduğu iddia edilemez.
- **Premise 4 tek dayanak noktası.** Yanlışsa (örneğin müşteri gerçekte kâr
  raporu istiyorsa) yaklaşım B'ye dönmek gerekir. Ucuz test: müşteriye
  "kâr raporu mu istiyorsun, yoksa kaça satacağını mı bilmek istiyorsun" diye
  sormak.
- **Yİ-ÜFE iddiası doğrulanmadı.** Açık soru 2 olarak kaydedildi.

## Sizin düşünme biçiminizde dikkatimi çeken

- Üç sorunu ayrı ayrı yazdınız ama üçü de aynı boşluktan çıkıyor. Sorunları
  yaşandıkları yerden anlatıyorsunuz, kategoriden değil — "bir top A4
  kağıdından 5 adet, liste 110, sattı 100" cümlesinde uydurulacak bir şey yok.
  Bu, gerçek kullanımı izleyen birinin dili.
- *"özellikle türkiye şartlarında"* dediniz. Ürününüzün nerede çalıştığını
  biliyorsunuz ve bu, genel bir stok yazılımının hiç düşünmeyeceği bir kısıt.
- *"hepsini yapacağız sırası önemli değil"* — kapsamı savundunuz. Doğru
  yaptınız, ben daraltmaya çalışıyordum. Ama sıra teknik olarak zorunlu çıktı
  ve onu kapsam daraltması olarak değil bağımlılık olarak kabul ettiniz.
- Tasarım tartışmasını ertelediniz ("şimdilik tasarım işini erteleyelim") ve
  doğrudan gerçek kullanıcı sorunlarına geçtiniz. Bitmiş bir arayüzün üstünde
  cila yapmak yerine eksik olan veriyi konuşmayı seçmek doğru sıralamaydı.
