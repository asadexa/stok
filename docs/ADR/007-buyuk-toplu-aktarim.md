# ADR-007: Büyük toplu aktarım: tarayıcıda okuma, kalıcı aktarım kaydı, tarayıcının sürdüğü parçalar

- **Tarih:** 2026-10-23
- **Durum:** Kabul edildi
- **İlgili:** DECISIONS ARC-15, DAT-20, DAT-18 · TODOS T171 · `docs/TEKNIK_SARTNAME.md` F-02

## Bağlam

Toplu ürün aktarma 2.000 satır ve 4 MB'lık dosyayla sınırlıydı ve tek istekte
çalışıyordu. Kullanıcı 20.000 satır ve görsel içeren 100 MB'a kadar Excel dosyası
istedi (T171, T200 UAT). Dört kısıt mimariyi belirliyor:

1. **İstek gövdesi:** sunucu eylemi gövdesi 4 MiB (barındırma sınırı 4,5 MB, T118).
   100 MB'lık dosya sunucuya gidemez; 20.000 satırın önizleme yanıtı da on MB'larca.
2. **İstek süresi:** satırlar tek tek, her devir kendi `createMovement`
   transaction'ında yazılıyor (INV-3/5/6). 20.000 satır dakikalar sürüyor; tek
   istek barındırmanın süre sınırına takılır ve yarım aktarım bırakır.
3. **Tek yazma kapısı:** açılış stoğu yalnız `createMovement`'tan yazılabilir;
   dosyanın tamamını tek transaction'a almak bu kapıya dışarıdan transaction sokmak demek.
4. **Kesinti:** sekme kapanabilir, bağlantı kopabilir. Yanlış "başarılı" ya da
   "başarısız" demek kabul edilmiyor; iptal yapılanları geri almıyor (ürün kararı:
   duraklat/devam ve geri alma yok).

## Karar

- **Dosya tarayıcıda okunuyor** (Web Worker, `@stok/core/product-file`). XLSX'ten
  yalnız hücre verisi açılıyor (görseller hiç açılmıyor, açılan veri 64 MiB'la
  sınırlı). Sunucuya yalnız hücre metinleri, ~1,5 MB'lık parçalarla gidiyor; sunucu
  her parçayı şemayla sınırlıyor ve içeriğe hiç güvenmiyor.
- **Kalıcı aktarım kaydı** (`import_runs`, `import_run_rows`, migration 0013, FORCE
  RLS): ham satırlar, önizlemenin satır kararları, satır sonuçları. Önizleme bütün
  dosya üzerinden bir kez hesaplanıyor (dosya içi mükerrer stok kodu ancak böyle
  görülür) ve ürün/stok verisine hiçbir şey yazmıyor.
- **Arka plan işçisi yok:** aktarımı kullanıcının sekmesi ~2 sn'lik parçalarla
  sürüyor (`processImportChunk`). Bir satırın işi: ürün (kendi transaction'ı) →
  açılış stoğu (`createMovement`) → sonuç. İptal ve kesinti yalnız satırlar arasında.
- **Eşzamanlılık:** aktarımı tek işleyici işliyor: kısa kira (`lease_until`) ve
  kira kimliği (`lease_token`); satır sonucu yalnız satırı alan kimlikle yazılıyor
  (`claim_token`). Uzun süre tutulan kilit yok; iptal hiçbir kilidi beklemiyor.
- **Çakışma (iyimser):** güncelleme, önizleme anındaki ürün sürümünü (`xmin`)
  UPDATE'in kendisinde şart koşuyor. Arada değişen ürün `Çakışma` olur; "yeni"
  satırın stok kodu arada açıldıysa güncellemeye dönüşmüyor, o da `Çakışma`.
- **Kesinti doğrulaması:** sonucu yazılamamış (`IN_PROGRESS`) satır 2 dakika sonra
  veritabanına bakılarak çözülüyor: uygulanmadığı kanıtlanırsa yeniden deneniyor,
  kanıtlanamazsa `UNCERTAIN`. Yeniden denemek güvenli: devir anahtarı ürün başına
  sabit (DAT-18).
- **Saklama:** aktarım kayıtları 30 gün, yarıda kalmış yüklemeler 24 saat sonra
  siliniyor (cron bakımı ve yeni aktarım başında). Gerçek tablolara yabancı anahtar
  yok; silme yapı gereği gerçek veriye ulaşamıyor.

## Elenen yollar

**Yalnız `IMPORT_ROW_LIMIT`'i artırmak.** Tek istek süre sınırına takılır, kullanıcı
yarım aktarım görür ve neyin yazıldığını bilemez. Gövde sınırı 100 MB'ı zaten
taşımaz.

**Arka plan iş kuyruğu (mevcut `background_jobs`, cron işçisi).** Sekme kapansa da
sürerdi. Ama cron turu dakikalık değil, işçi tek ve kısa turlar için tasarlandı
(T138); dosya ya da satırlar yine bir yere yüklenmeliydi ve ilerleme/iptal ayrı bir
yoklama yolu isterdi. Ürün kapsamı duraklat/devam istemiyor; tarayıcının sürdüğü
parçalar aynı güvenceleri daha az parçayla veriyor. Sekme kapanınca aktarımın
durması bu yolun bedeli; yapılanlar kalıyor, aynı dosyayı yeniden yüklemek güvenli.

**Dosyayı sunucuda okumak (parçalı yükleme ya da nesne deposu).** 100 MB'ı parça
parça yüklemek ve sunucuda açmak hem bellek hem depolama demekti; dosyanın büyük
kısmı görsel ve hiç gerekmiyor. Tarayıcıda okumak sunucuya güveni taşımıyor:
sunucu satırları yine doğruluyor.

**Satır kilidiyle (`SELECT … FOR UPDATE`) sürüm kontrolü.** Önizleme ile yazım
arasında saniyeler-dakikalar var; kilidi o kadar tutmak satış girişini bekletirdi.
`xmin` ürün tablosuna sütun eklemeden aynı soruyu UPDATE'te soruyor.

**Her aktarımı tek transaction'da yazmak (hepsi ya da hiçbiri).** Tek yazma kapısını
bozar (INV-3) ve 20.000 satırda dakikalarca kilit tutar. Satır satır ilkesi
(F-02) zaten bilinçli.

## Sonuçlar

- Satır başına iki ek transaction (alma ve sonuç; sonuç bir sonraki satırın alma
  transaction'ında yazılıyor) ve parça başına birkaç sorgu. Ölçüm `CURRENT_STATE`'te.
- Aynı sekmenin sunucu eylemleri sırayla gidiyor: iptal en geç bir parça (~2 sn)
  sonra etkili. Başka sekmeden iptal bir sonraki satırdan önce.
- `xmin` yalnız aynı satırın sürümünü karşılaştırıyor; ürün tablosu `VACUUM FULL`
  ya da dump/restore ile yeniden yazılırsa açık önizlemeler `Çakışma` verir (veri
  bozulmaz, kullanıcı dosyayı yeniden yükler).
- Bir satır 2 dakikadan uzun veritabanında takılırsa ikinci işleyici onu yeniden
  deneyebilir. Veri bozulmaz (tek stok kodu, ürün başına tek devir), ama o satırın
  sonucu `Çakışma` görünebilir.
- Aktarım kayıtları alış fiyatı taşıyor: yalnız yönetici, kiracı kapsamlı (RLS),
  30 gün (`SECURITY_MODEL` S21).

## Nasıl doğrulanıyor

- `packages/core/src/import-runs.test.ts` (gerçek PostgreSQL): önizleme yazmıyor,
  çakışma, iptal (satırın ortasında kilitle), kesinti doğrulaması, kira ve satır
  sahipliği, RLS, temizlik kapsamı. Korumalar `dogrula` ile kırmızıya düşürüldü.
- `packages/core/src/import.test.ts`: dosya güvenliği (değerler-yalnız okuma, sıkıştırma
  bombası, 100 MB sınırı) ve belirsiz sayı kuralı (DAT-20).
- `apps/web/e2e/t171-toplu-aktarim.spec.ts`: Web Worker okuma, ilerleme, rapor, iptal.
