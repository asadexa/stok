# ADR-006: Tedarikçi verisi: güncel durum + yalnız değişimde append-only fiyat geçmişi

- **Tarih:** 2026-10-19
- **Durum:** Kabul edildi
- **İlgili:** DECISIONS DAT-19, PRD-14, PRD-15 · TODOS T200 · `docs/TEKNIK_SARTNAME.md` F-12

## Bağlam

B2B V1 (PRD-14) tedarikçinin ürün, fiyat ve stok bilgisini "Verileri Getir" ile
çekiyor; fiyat değiştiyse eski ve yeni değer saklanıyor, değişmeyen fiyat geçmiş
üretmiyor. Çekilen veri onaysız kaydediliyor, yani yanlış okunmuş ya da yanlış
tedarikçiye yüklenmiş bir dosya doğrudan veri olur.

Üç soru veri modelini belirliyor:

1. Ne saklanır: her yenilemenin tam kopyası mı, yoksa güncel hâl ve değişimler mi?
2. İki fiyat ne zaman "karşılaştırılabilir": para birimi, KDV durumu, fiyat türü
   ve fiyatın ait olduğu miktar farklıysa artış/azalış yüzdesi yanlış bir kıyastır.
3. Dosyada olmayan kalem ne demek: kaynağın tam liste mi kısmi liste mi
   gönderdiği bilinmiyor (gerçek sağlayıcı seçilmedi).

Tedarikçi verisi stok defterinden (ADR-001) tamamen ayrı: tedarikçinin "elimde 500
var"ı bizim stoğumuz değil, hareket üretmez (INV-3, PRD-14). Bu ayrılık zaten
PRD-14'ün kararı; bu ADR yalnız tedarikçi verisinin kendi modelini kaydediyor.

## Karar

Üç tablo (migration 0012):

- `suppliers`: tedarikçi ve varsayılan fiyat koşulları. "Fiyatlar 1 ürün birimi
  içindir" beyanı (`unit_price_declared`) varsayılan olarak YOK.
- `supplier_items`: kalemin **güncel** hâli, tedarikçi içinde tedarikçi koduyla tekil.
  `price_qty` (fiyatın ait olduğu miktar) `NULL` olabilir: belirsiz.
- `supplier_price_changes`: yalnız fiyat ya da koşul **değiştiğinde** bir satır;
  eski ve yeni değerin beşi de (fiyat, para birimi, KDV, fiyat türü, miktar) saklanır.
  **Append-only:** `stok_app`'ten UPDATE/DELETE geri alındı.

Kurallar veritabanında:

- `supplier_price_changes_distinct_ck`: eski ve yeni değer grubu aynıysa satır
  reddedilir. Değişmeyen fiyat geçmiş üretmez, satırı kim yazarsa yazsın.
- `is_comparable` ve `change_pct` **üretilen sütunlar**: dört koşul aynı ve miktar
  iki tarafta da biliniyorsa karşılaştırılabilir, yalnız o zaman yüzde var.
  Uygulama hesaplamıyor, okuyor.
- Fiyat `NUMERIC(14,4)`; fark `numeric` ile, PostgreSQL'de bulunuyor.

Yenileme tek transaction: tedarikçi satırı `FOR UPDATE`, fark ve upsert tek SQL'de.
Hata olursa hiçbir şey yazılmaz. **Dosyada olmayan kalem değişmez ve işaretlenmez:**
yokluk bilgi sayılmıyor. Her kalemin "son alındı" zamanı (`fetched_at`) yalnız
onu taşıyan başarılı bir yenilemede ilerliyor.

## Elenen yollar

**Her yenilemenin tam kopyası (append-only besleme günlüğü).** En çok bilgiyi
saklar: stok geçmişi ve "kalem o gün listede var mıydı" da sonradan sorulabilir.
Ama PRD-14 stok geçmişi istemiyor; günde birkaç yenileme × binlerce kalem, değişmeyen
fiyatı binlerce kez yazar ve "değişmeyen fiyat geçmiş üretmez" kuralı bir sorguya
dönüşür. Seçilen modelin bedeli tam da bu yolun bıraktığı bilgi: yenileme kopyaları
ve stok geçmişi **sonradan geri üretilemez**. İhtiyaç doğarsa yeni bir tablo
gerekir ve geçmişe dönük dolmaz.

**Geçmişi kalem satırında JSON olarak tutmak.** Sorgulanamaz, CHECK ve append-only
uygulanamaz; bir UPDATE geçmişi sessizce silebilir.

**Yüzdeyi ve karşılaştırılabilirliği uygulamada hesaplamak.** Ekranda gösterilen
yüzde ile kaydedilen tür ayrışabilirdi; seed ya da elle SQL kuralı atlardı.

**Dosyada olmayan kalemi "listeden çıktı" diye işaretlemek.** Kısmi liste gönderen
bir kaynakta bütün katalog yanlışlıkla eskimiş görünürdü. Tam/kısmi ayrımı gerçek
kaynak bilindiğinde, kaynak beyanıyla (T201) gelebilir.

**Fiyat miktarını koli barkodunun çarpanından türetmek.** Koli barkoduyla eşleşmek,
fiyatın koliye ait olduğunu kanıtlamaz; adet fiyatı koli fiyatı gibi okunurdu.

## Sonuçlar

**İyi:** "Değişmeyen fiyat geçmiş üretmez" ve "karşılaştırılamayan iki fiyat arasında
yüzde yok" kuralları koddan bağımsız. Önizleme aynı kodu çalıştırıp transaction'ı
geri aldığı için önizleme ile kayıt ayrışamıyor.

**Bedel:** Stok geçmişi ve yenileme kopyaları yok (yukarıda). Fiyat geçmişi uygulamadan
silinemez; saklama süresi kararı (T200 PLAN K6) verildiğinde silme sahip rolüyle,
ayrı bir iş olarak yapılmalı.

**Bedel:** Fiyat miktarı belirsiz kalemler karşılaştırmaya girmez. Yönetici birim
beyanı vermezse ve dosyada "Fiyat Miktarı" yoksa karşılaştırma boş kalır; bu
yanlış bir karşılaştırmadan iyidir.

## Nasıl doğrulanıyor

- `packages/db/src/schema-sync.test.ts`: üretilen sütunlar (yüzde, koşul
  değişimi, belirsiz miktar, taşma), eşitlik CHECK'i, sözlük CHECK'leri
- `packages/db/src/rls.test.ts`: kiracı izolasyonu, append-only geçmiş
- `packages/core/src/suppliers.test.ts`: yenileme, önizleme, kısmi ve hatalı
  yenileme, eşzamanlı yenileme (kilit), stok defterine dokunmama
- `dogrula` ile kaldırılıp kırmızısı görülen korumalar: `FOR UPDATE`, fark filtresi,
  eşitlik CHECK'i, `REVOKE`, karşılaştırılabilirlik koşulu, yetki ve kiracı
  içi ürün kontrolü
