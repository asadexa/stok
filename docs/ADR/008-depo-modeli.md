# ADR-008: Depo modeli: depo miktarı hareket defterinden türetilir

- **Tarih:** 2026-10-27
- **Durum:** Kabul edildi
- **İlgili:** DECISIONS PRD-17, DAT-21, DAT-22, DAT-23, DAT-24, DAT-25 · TODOS T217 (Dilim 1),
  T218–T226 · `docs/TEKNIK_SARTNAME.md` F-03, F-15

## Bağlam

Ürün kararı (`PRD-17`): bir işletmenin birden çok deposu olabilir. Toplam stok
gösterilmeye devam eder, depolara dağılımı da izlenir. Bir deponun envanter dosyası
yalnız o depoyu değiştirir. Örnek: Depo 1 = 10, Depo 2 = 20, toplam 30; Depo 1 için
dosyada 5 yazınca Depo 1 = 5, Depo 2 = 20, toplam 25.

Mevcut model buna hazır değildi:

1. **`current_stock` ürün başına tek toplam.** Depo kırılımı yok; tetikleyici her
   hareketle yalnız toplamı güncelliyor (ADR-001, INV-1).
2. **`locations` depo değil, raf.** Seed "A-01 Rafı" açıyor, ürün formunda "Konum"
   olarak görünüyor ve eski hareketler raf kimliği taşıyor.
3. **Eski stoğun deposu bilinmiyor.** Depo kavramı gelmeden yazılmış hareketlerin
   hangi depoya ait olduğu tahmin edilemez; ürün kararı tahmin etmeyi ve sessizce
   taşımayı yasaklıyor.
4. **Defter append-only (INV-2).** Eski satırlara sonradan depo yazılamaz.
5. **Yabancı anahtar RLS'i atlıyor** (`PROJECT_BRAIN` §8): bir hareketin başka
   kiracının deposuna bağlanmasını FK tek başına engellemez.

## Karar

- **Ayrı `depots` tablosu** (migration 0014): kiracıya özel, ENABLE + FORCE RLS,
  `tenant_isolation` politikası. Adın karşılaştırma anahtarı üretilmiş sütun:
  `name_key = tr_norm(regexp_replace(btrim(name), '\s+', ' ', 'g'))`, tekil
  `(tenant_id, name_key)`. "Merkez Depo", "MERKEZ  DEPO " aynı depodur. Ad 1–100
  karakter, kontrol karakteri yok (CHECK).
- **Hareket satırında depo:** `stock_movements.depot_id`, boş olabilir. Boş değer
  "depoya atanmamış" demektir. Migration eski hareketlere dokunmaz: hepsi boş kalır.
- **Depo miktarı ayrı tutulmaz, defterden türetilir:** ürün ve depo için
  `SUM(delta)`. Atanmamış miktar, deposu boş hareketlerin toplamıdır. Depoların ve
  atanmamış miktarın toplamı tanım gereği `current_stock`'a eşittir; aynı satırlardan
  hesaplanır. Yeni projeksiyon, yeni tetikleyici ya da yeni invariant yok.
- **Kontroller tek yazma kapısında** (`createMovement`, INV-3), mevcut ürün kilidinin
  (`current_stock FOR UPDATE`) altında. Ürünün bütün hareketleri bu kilitten geçtiği
  için depo bazında ayrı kilit gerekmiyor. READ COMMITTED altında kilitten sonra
  okunan toplam, kilidi bırakan transaction'ın hareketini görüyor.
- **Depo kuralı** (`DAT-23`): deposu olmayan işletmede bugünkü davranış aynen sürer;
  tek depo varsa depo verilmeyen hareket o depoya yazılır; iki ve daha fazla depo
  varsa depo zorunludur (`DEPOT_REQUIRED`). Depo kimliği kapıda kiracı içinde
  doğrulanır (FK RLS'i atlıyor); ayrıca `depots` FORCE RLS.
- **Aktarım bağlantısı ayrı sütun** (`DAT-25`): `stock_movements.import_run_id`,
  kiracıyla birleşik FK ile `import_runs(tenant_id, id)`'ye. `count_session_id`
  sayım oturumlarına (T155) ayrılmış kalır.

## Elenen yollar

**`locations` tablosunu depoya çevirmek.** Tablo bugün raf anlamında kullanılıyor ve
eski hareketler raf kimliği taşıyor. Anlamı değiştirmek eski satırları sessizce
"depoda" gösterirdi; defter append-only olduğu için düzeltilemezdi.

**Depo adını hareket satırına metin olarak yazmak.** Tekillik olmazdı: dosyadaki bir
yazım farkı ("Merkez Depo" / "Merkez  Depo") sessizce yeni bir depo açardı. Depo adı
değişince geçmiş satırlar eski adı taşırdı.

**Depo bazlı ayrı projeksiyon tablosu** (ürün × depo × miktar, tetikleyiciyle). İkinci
bir projeksiyon ve tetikleyici demek; `current_stock` ile ayrışabilecek ikinci bir
kaynak doğar ve INV-1'in bir eşi gerekir. Bugün ürün başına hareket sayısı küçük;
toplam sorgusu mevcut (kiracı, ürün, zaman) indeksini kullanıyor. Ancak ölçüm
gerektirirse eklenir.

**Eski stoğu bir "varsayılan depoya" taşımak ya da migration'da dağıtmak.** Ürün
kararı tahmin etmeyi yasaklıyor; append-only defterde yanlış atama geri alınamaz.
Atanmamış miktar açıkça ayrı tutulur, depoya atama sonraki dilimde (T223) iki satırlı
ve toplamı değiştirmeyen bir hareketle yapılır.

**Aktarım kimliğini `count_session_id`'ye yazmak.** Sayım oturumu tablosu (T155)
geldiğinde sütuna FK eklenemezdi; defterde UPDATE yasak olduğu için eski satırlar da
düzeltilemezdi. 30 günlük aktarım temizliği de bağlantıyı sessizce boşa düşürürdü.

**`depot_id` için kiracıyla birleşik FK.** Değerlendirildi, seçilmedi: kodda bu kalıp
`import_run_id` dışında yok; mevcut kalıp kapıda kiracı kontrolü + FORCE RLS +
`dogrula`. Tek yazma kapısı korunduğu sürece yeterli. `import_run_id`'de birleşik FK
seçildi, çünkü aktarım kaydı silinebilen bir tablo ve FK aynı zamanda saklama
kuralını zorluyor.

## Sonuçlar

- Her çıkış hareketinde bir ek depo toplamı sorgusu, depo verilmeyen harekette bir
  depo sayısı sorgusu çalışıyor. Süre ölçülmedi.
- Deposu olmayan işletmeler (bugünkü bütün kiracılar) etkilenmiyor. Bir işletmede ilk
  depo açıldığında deposu bilinmeyen eski stok "atanmamış" kalır: depo bazlı çıkışta
  sayılmaz, toplamda sayılır. Depoya atama (T223) ve atanmamış stoktan açık seçimle
  çıkış (A1, T220) gelene kadar bu stok o işletmede satılamaz; hata metni atanmamış
  miktarı söyler.
- Envanter düzeltmesi, ürünün atanmamış miktarı sıfır değilse satır yazmaz
  (`STOCK_CHANGED`): atanmamış miktar dosyadaki depo miktarıyla iki kez sayılırdı.
- Defter artık `import_runs`'a FK ile bağlı. ADR-007'deki "gerçek tablolara yabancı
  anahtar yok" sonucu değişti: deftere bağlı aktarım kaydı silinemez ve 30 günlük
  temizlik onu atlar. Bugün bu sütuna yazan kod yok; ilk yazan Dilim 2 (T218).
- Depo silme, arşivleme ve yeniden adlandırma yok; yanlış açılan depo kalır (T226).
- Migration büyük bir defterde FK doğrulaması ve kısmi indeks için tabloyu kilit
  altında tarar. Bugün canlı ortam yok; ilk deploy boş veritabanına yapılacak.

## Nasıl doğrulanıyor

- `packages/core/src/depots.test.ts` (gerçek PostgreSQL, 28 test): depo kuralı (0 / 1 /
  2+ depo), başka kiracının depo ve ürün kimliği, depo bazlı yetersiz stok, aynı
  depodan eşzamanlı iki çıkış, K1 örneği, artış, fiyatsız ilk `COUNT_ADJUST_UP`,
  `STOCK_CHANGED` (kilit altında araya giren satış dahil, deterministik), atanmamış
  stok, idempotency, çalışan reddi, ad normalizasyonu ve CHECK, RLS görünürlüğü,
  kiracılar arası `import_run_id` FK reddi, defter = projeksiyon.
- `import-runs.test.ts`: deftere bağlı aktarım kaydı süresi dolsa da silinmiyor.
- `rls.test.ts` yeni tabloyu FORCE RLS ve politika taramasına otomatik alıyor.
- `dogrula` (yalnız `stok_test_*`): `count:approve`, depo kiracı filtresi + RLS, depo
  bazlı yetersiz stok, beklenen depo miktarı, atanmamış stok, `DEPOT_REQUIRED`, işaret
  ve temizlik korumaları kaldırılınca testler kırmızı yandı. Commit `50b6dd9`, CI #88.
