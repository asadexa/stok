# ADR-004: Maliyet yöntemi — FIFO mu ağırlıklı ortalama mı

- **Tarih:** 2026-08-12 (son güncelleme 2026-09-04)
- **Durum:** **AÇIK** — karar verilmedi
- **İlgili:** PLAN.md U2, E8 (kâr raporu), T88, T89

## Bağlam

Kâr raporu (E8) şu soruyu soruyor: bir ürünü sattığımda **hangi geçmiş
maliyeti** düşeceğim?

Aynı ürün farklı zamanlarda farklı fiyatlara alınmış olabilir: 100 adet 80
₺'den, sonra 100 adet 95 ₺'den. 50 adet satıldığında maliyet 80 ₺ mi (FIFO —
önce giren önce çıkar), yoksa 87,50 ₺ mi (ağırlıklı ortalama)?

Bu bir **tek yönlü kapı**. Yöntem sonradan değiştirilirse geçmiş bütün kâr
raporları değişir; muhasebeye verilmiş bir rapor ile sistemin bugün ürettiği
rapor uyuşmaz.

## Bu ADR neden "açık" durumda duruyor

Karar **müşterinin muhasebecisine** ait, geliştiriciye değil. Vergi ve
muhasebe tarafında hangisinin kullanıldığı işletmeye göre değişiyor ve yanlış
seçim, sistemin ürettiği raporu resmi kayıtlarla çelişkiye sokar.

Kararın **ertelenebilir** olmasının sebebi ölçülerek bulundu (PLAN, T88
notu): FIFO / ağırlıklı ortalama sorusu **kâr raporuna** ait. T88 (kasa açığı)
ve T89 (açılış değerlemesi) "bunu kaça satmalıyım" sorusunu cevaplıyor —
ileriye bakan bir soru, geçmiş maliyet eşleştirmesi gerektirmiyor. Dolayısıyla
E8 yazılana kadar karar açık kalabilir.

## Varsayılan (bağlayıcı DEĞİL)

**Ağırlıklı ortalama.** Gerekçe: küçük bir kırtasiyede parti takibi yok —
raftaki A4 paketlerinin hangisinin hangi faturadan geldiği fiziksel olarak
bilinmiyor. FIFO'yu doğru uygulamak parti (lot) takibi ister ve bu, ürünün
kapsamında olmayan bir özellik.

## Kararın ön şartı: veri

Yöntem seçilse bile hesaplanacak veri **bugün eksik**. `stock_movements` içinde
giriş hareketlerinin birim fiyatı ancak T88/T89'dan sonra doldurulmaya başladı;
onlardan önceki hareketlerde `unit_price` `NULL`.

Yani karar verildiği gün geçmişe dönük kâr raporu **yine çıkmayacak**. Bunu
şimdiden bilmek önemli: "yöntemi seçtik, rapor gelsin" beklentisi karşılanmaz.

## Karar verildiğinde yazılacaklar

Bu ADR **değiştirilmeyecek**; yerine ADR-006 yazılacak ve buraya
"Değiştirildi: ADR-006" notu düşülecek. İçinde şunlar olmalı:

- Seçilen yöntem ve **kimin** seçtiği (muhasebeci adı/tarihi)
- Verinin eksik olduğu dönem için ne yapılacağı: rapor o tarihten mi başlıyor,
  yoksa açılış maliyeti mi varsayılıyor
- Yöntem raporun **çıktısında yazacak mı** — yazmazsa iki farklı dönemin
  raporu sessizce farklı yöntemle hesaplanmış olabilir
