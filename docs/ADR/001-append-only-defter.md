# ADR-001: Stok bir sayı değil, defterin sonucu

- **Tarih:** 2026-08-12
- **Durum:** Kabul edildi
- **İlgili:** PLAN.md Bölüm 1, D-1.1, T9, T11

## Bağlam

Depo stok takibinde en sık sorulan soru "elimde kaç tane var" değil, **"neden
bu kadar"**. Sayım tutmadığında cevaplanması gereken soru şu: 40 adet kırmızı
defter nereye gitti, ne zaman, kim tarafından.

Klasik yaklaşım `products.stock` diye bir sütun tutmak ve her işlemde
`UPDATE ... SET stock = stock - 5` yazmak. Bu, sorunun cevabını **imkansız**
kılıyor: eski değer üzerine yazıldığı için geçmiş yok.

## Karar

Stok **türetilmiş bir değer**. Kaynak, `stock_movements` tablosundaki
değiştirilemez hareket defteri.

1. Deftere yalnızca **`createMovement()`** yazar. Başka hiçbir kod yolu
   `stock_movements`'a `INSERT` etmez. (Tek istisna: test kurulumu için
   `seedOpeningStock`.)
2. Defter **append-only**. `UPDATE` ve `DELETE` yetkisi uygulama rolünden
   veritabanı seviyesinde geri alınmış — admin bile satır değiştiremez.
   Hata düzeltmesi yeni bir ters hareketle yapılır.
3. `current_stock` bir **projeksiyon**, kaynak değil. Trigger yazıyor.
4. Değişmez kural: `SUM(delta) == current_stock.qty`. Cron her turda
   denetliyor, kırılırsa alarm (T37).

## Elenen yollar

**Mutable stok sütunu.** En basit yol ve tam olarak çözmek istediğimiz sorunu
üretiyor: "40 defter nereye gitti" sorusu cevapsız kalıyor. Depo sahibinin bu
ürünü almasının sebebi bu soru.

**Projeksiyonsuz, her okumada `SUM(delta)`.** Doğru ama stok listesi ekranı
her açılışta bütün defteri tarardı. 1.248 ürünlük bir depoda bile ilk yıldan
sonra fark ediliyor. Projeksiyon bir önbellek değil, **denetlenen** bir
kopya — invariant testi tam da bu yüzden var.

**Tam event sourcing (olayları yeniden oynatma).** Defter zaten olay akışı ama
"her şeyi yeniden oynat" makinesi kurulmadı: tek projeksiyon var
(`current_stock`) ve onu trigger üretiyor. Genel bir yeniden oynatma altyapısı
bu ölçekte kullanılmayan karmaşıklık olurdu.

## Sonuçlar

**İyi:** "Kim, ne zaman, neden" sorusu tek sorguyla cevaplanıyor. Yanlış
kayıt düzeltmesi de defterde iz bırakıyor, yani düzeltmenin kendisi de
denetlenebilir.

**Bedel:** Yazma yolu tek fonksiyona sıkışıyor ve o fonksiyon karmaşık
(kilitleme, idempotency, fiyat çözümleme). Bunun alternatifi karmaşıklığı
dağıtmak olurdu — dağınık karmaşıklık daha kötü.

**Bedel:** Silme yok. "Yanlışlıkla girdim, sil" isteği ürün seviyesinde
reddediliyor ve kullanıcıya ters hareket girmesi söyleniyor. Bu bir eğitim
maliyeti ve bilerek ödeniyor.

## Nasıl doğrulanıyor

- `packages/core/src/invariant.test.ts` — 1000 rastgele hareketten sonra
  defter ile projeksiyon eşit
- Veritabanı seviyesindeki `UPDATE`/`DELETE` reddi RLS testlerinde
- Her cron turunda `checkStockInvariant` (T37)
