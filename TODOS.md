# TODOS

`/plan-ceo-review` (2026-08-22) sonucunda v1 kapsamı dışına ertelenen işler.
Her madde, 3 ay sonra bakan birinin bağlamı anlayacağı kadar detay içerir.

---

## P1 - E2: Sayım (Stocktake) akışı

**Ne:** Fiziksel sayım oturumu. Çalışan mobil "sayım modu"na girer, rafı barkodla tarar,
saydığı miktarı girer. Oturum bitince admin farkları görür ve onaylar. Onay anında fark
kadar hareket yazılır (`reason = sayim_duzeltme_arti / sayim_duzeltme_eksi`).

**Neden:** Envanter er ya da geç gerçekle uyuşmaz. Fire, kırılma, hatalı okutma, hırsızlık.
Sayım akışı olmadan tek çare tek tek manuel düzeltme hareketi yazmak, o da neyin neden
düzeltildiğini kaybettirir. Sayım oturumu farkın toplu ve izlenebilir olmasını sağlar.

**Artı:** Sistemin gerçekle senkron kalmasını sağlayan tek mekanizma. Muhasebeye dönem sonu
sayım raporu çıkarılabilir hale gelir.
**Eksi:** Yeni ekran (mobil sayım modu + admin onay ekranı) ve yeni durum makinesi.
Yanlış tasarlanırsa çalışan yarım kalmış sayımla sistemi kilitler.

**Bağlam:** Mühendislik incelemesi kararı D4 ile `stock_count_sessions` ve
`stock_count_lines` tabloları v1 şemasından ÇIKARILDI. Gerekçe: kullanılmayan şema
hazırlık değil bakım borcudur, ve özellik gerçekten yazılırken tasarım büyük ihtimalle
değişecek (kısmi sayım? raf bazlı? iki kişi aynı anda?). `stock_movements.count_session_id`
nullable sütunu v1'de kaldı, yani hareketleri geriye dönük bağlama kapısı açık.

Düşünülmüş durum makinesi (başlangıç noktası olarak, taş değil):

```
   [sayiliyor] ──bitir──▶ [onay_bekliyor] ──admin onay──▶ [kapandi]
        ▲                         │
        └────── admin reddet ─────┘

   [kapandi] değişmez. Onay anında fark kadar hareket yazılır:
   reason = COUNT_ADJUST_UP / COUNT_ADJUST_DOWN, count_session_id dolu.
```

Başlangıç noktası: iki tablonun migration'ı + `stock_count_sessions` üzerinde CRUD
+ mobil sayım ekranı.

**Efor:** M (human ~4 gün / CC ~4 saat). Şema migration'ı dahil, +15 dk.
**Bağımlılık:** T3 (şema), T9 (createMovement) tamamlanmış olmalı.

---

## P2 - E5: Barkod üretme ve etiket yazdırma

**Ne:** Barkodu olmayan ürün için sistem Code128 iç kod üretir (`bwip-js`), etiket olarak
bastırır. İki çıktı yolu: A4 sticker sayfası (PDF) ve termal etiket yazıcısı (Zebra/TSC, ZPL).

**Neden:** Depoya barkodsuz mal girer (üretici etiketlememiş, etiket yırtılmış, iç üretim).
Barkodsuz ürün sisteme giremez, sisteme girmeyen ürün stokta görünmez.

**Artı:** "Barkodsuz mal" istisnasını tamamen ortadan kaldırır, sistemin kapsama oranı %100 olur.
**Eksi:** Yazıcı entegrasyonu donanıma bağımlı ve test edilmesi zor. ZPL öğrenme eğrisi var.
Üretilen iç kodun GS1 standardı olmadığını, dışarıya satılan üründe kullanılamayacağını
kullanıcıya anlatmak gerek.

**Bağlam:** PLAN.md KRİTİK AÇIK G3 (yazıcı hatası sessiz) bu işle birlikte kapanır.
**T16 (timeout + PDF'e düşme) BİLEREK bu maddeye bağlandı ve v1'de yapılmadı:** G3'ün
kullanıcıya görünen hali "buton takılı kalır", ama o buton henüz yok. Var olmayan bir
taşıyıcının etrafına timeout sarmalayıcısı yazmak test edilemeyen ve bu iş geldiğinde
büyük ihtimalle değişecek kod üretirdi. İkisi birlikte yapılmalı.
Başlangıç noktası: önce sadece A4 PDF (donanımsız, test edilebilir), termal yazıcı sonra.

**Efor:** M (human ~3 gün / CC ~3 saat)
**Bağımlılık:** T21 (ürün yönetimi).

---

## P2 - E8: Maliyet takibi ve kâr raporu

**Ne:** Girişte `unit_cost` zaten kaydediliyor. Bu madde, ağırlıklı ortalama maliyet
hesabını, çıkışta maliyet atamasını ve "bu ay ne kazandık" raporunu ekliyor.

**Neden:** Brief'te "gelen giden ürün maliyeti" isteği var. Patronun asıl merak ettiği stok
adedi değil, stokta bağlı para ve satılan malın kârı.

**Artı:** Ürünü "stok sayacı"ndan "iş zekası aracı"na çıkarır. Fiyatlandırma gücü verir.
**Eksi:** **Tek yönlü kapı.** Ağırlıklı ortalama mı FIFO mu kararı sonradan değiştirilemez,
çünkü geçmiş tüm raporları değiştirir. Ayrıca KDV, iskonto, navlun gibi kavramlar açılır ve
kapsam hızla ERP'ye kayar. Sınır çizmek şart.

**Bağlam:** PLAN.md ÇÖZÜLMEMİŞ KARAR U2. Varsayılan öneri: ağırlıklı ortalama (Türkiye'de
KOBİ muhasebesinde yaygın, hesabı basit). FIFO'yu v3'e bırak. Karar öncesi muhasebeciye sor.
`stock_movements.unit_cost` alanı v1'de var AMA **VERİ TOPLANMIYOR** (ölçüldü, 2026-08-30):
arayüz bu alanı hiç göndermiyor, uygulamadan girilen her hareketin değeri NULL; yalnızca
`seed.ts` dolduruyor. Bu maddenin "geçmiş veri hazır olur" varsayımı bugün geçersiz ve
aşağıdaki efor tahmini ona dayanıyordu. **Faz 10 / T88 bu açığı kapatıyor**; E8 ancak T88
canlıya çıktıktan SONRA anlamlı veriyle başlayabilir.

**Efor:** M (human ~4 gün / CC ~4 saat)
**Bağımlılık:** U2 kararı verilmiş olmalı.

---

## P3 - E9: Raf / konum yönetimi arayüzü

**Ne:** `locations` tablosu ve `products.location_id`, `stock_movements.location_id` v1
şemasında var ama arayüzü yok. Bu madde: konum tanımlama, ürüne konum atama, "hangi rafta"
araması, konum bazlı sayım.

**Neden:** Depo büyüdükçe "ürün var ama bulamıyoruz" problemi çıkar. Stok doğru, konum
bilinmiyor.

**Artı:** Toplama süresini belirgin kısaltır. Konum bazlı sayım mümkün olur.
**Eksi:** Küçük depoda gereksiz veri girişi yükü. Konum güncel tutulmazsa yanlış bilgi
hiç bilgi olmamasından kötüdür.

**Bağlam:** Sütunlar v1'de geliyor, bu yüzden migration gerekmez, sadece UI. Bu bilinçli
bir karar: bugün bedava olan sütunu bugün ekle, arayüzü ihtiyaç doğunca yaz.

**Efor:** S (human ~2 gün / CC ~2 saat)
**Bağımlılık:** Yok.

---

---

## P2 - Mobilde tam ürün katalog senkronu

**Ne:** Telefonda tüm ürün kataloğunun (barkod, ad, birim, koli çarpanı, son bilinen stok)
bir kopyasını tutmak. Açılışta tam çekim, sonra saatte bir sadece değişenler.

**Neden:** v1'de seçilen yaklaşım (D9) sadece daha önce okutulan ürünleri önbelleklemek.
Bu, tam olarak en çok ihtiyaç duyulan anda boş çıkıyor: **yeni gelen mal**. Mal kabulü
deponun en çok çevrimdışı yapılan işi ve ilk kez okutulan ürün önbellekte olmuyor, yani
çalışan ürün adını göremiyor ve doğrulama yapamıyor. Yeni işe başlayan çalışanın telefonu
da tamamen boş önbellekle başlıyor.

**Artı:** "Depoda WiFi kesikken çalışır" iddiası koşulsuz doğru olur. Tanımsız barkod
çevrimdışıyken de anında tespit edilir, senkron beklenmez.
**Eksi:** Bayatlama yüzeyi büyür (son bilinen stok gerçek olmayabilir, ekranda "son
güncelleme 14:20" notu şart). Senkron mantığı artımlı çekim gerektirdiği için karmaşıklaşır.
10 bin ürün birkaç megabayt, telefon için sorun değil ama veri kullanımına dikkat gerekir.

**Bağlam:** Mühendislik incelemesi D9'da bu seçenek sunuldu ve bilinçli olarak ertelendi.
v1'de T49 çevrimdışı tanınmayan barkodu reddetmiyor, `unresolved=true` ile kaydedip
senkronda çözüyor; yani veri kaybı yok, sadece anlık doğrulama yok. Bu TODO, o eksiği
kapatıyor. **Tetikleyici:** sahada "ürün adını göremiyorum" şikayeti gelirse veya mal
kabulü ağırlıklı olarak çevrimdışı yapılıyorsa hemen yap.

**Efor:** S (human ~1 gün / CC ~1 saat)
**Bağımlılık:** T49 (mevcut önbellek altyapısı) tamamlanmış olmalı.

---

## P3 - Mobil cihaz test otomasyonu (Maestro)

**Ne:** Gerçek telefon üstünde otomatik test: uçak modu, uygulamayı arka plana atma,
işletim sisteminin uygulamayı öldürmesi, düşük pil modu.

**Neden:** D8'de saf mantık testleri + yazılı elle kontrol listesi seçildi. Elle liste
insan disiplinine bağlı ve acelede atlanabilir.

**Artı:** Cihaza özgü gerilemeler her sürümde otomatik yakalanır.
**Eksi:** Kurulum ve bakım pahalı, cihaz testleri doğası gereği kırılgan. Yanlış alarmlar
zamanla güveni aşındırır ve testler devre dışı bırakılır.

**Bağlam:** T48 elle kontrol listesini `docs/mobil-cihaz-kontrol-listesi.md` olarak
üretiyor. **Tetikleyici:** liste 4 maddeden fazlaya çıkarsa veya bir sürümde atlanıp
saha hatasına yol açarsa otomasyona geç.

**Efor:** M (human ~3 gün / CC ~4 saat)
**Bağımlılık:** T48.

---

## P3 - Tam paketleme hiyerarşisi (adet / kutu / koli / palet)

**Ne:** D7'de tek bir `qty_multiplier` sütunu seçildi (koli barkodu x çarpan). Bu TODO,
çok katmanlı paketleme ağacını modelliyor.

**Neden:** Bazı müşterilerde adet, kutu, koli ve palet birlikte kullanılır ve tek çarpan
yetmez.

**Artı:** Palet bazlı sayım ve sevkiyat gibi özelliklerin temeli kurulur.
**Eksi:** Şema, arayüz ve iş mantığı belirgin şekilde şişer. Kullanıcı her ürün için
paketleme ağacı tanımlamak zorunda kalır, ilk kurulum süresi uzar.

**Bağlam:** `qty_multiplier` v1'de yeterli çünkü tek seviyeli (birim ↔ koli) durumu
kapsıyor. **Tetikleyici:** bir müşteri ikiden fazla paketleme seviyesi isterse.

**Efor:** M (human ~3 gün / CC ~3 saat)
**Bağımlılık:** Yok.

---

## Faz 2 / Faz 3 (henüz madde değil, yön)

- Çok depo / çok konum arası transfer
- Tedarikçi ve satın alma siparişi takibi
- e-Fatura / e-Arşiv entegrasyonu
- Logo / Mikro / Paraşüt köprüsü
- SaaS: kiracı kaydı, abonelik, faturalama (şema hazır, ekran yok)
- FIFO maliyet yöntemi
