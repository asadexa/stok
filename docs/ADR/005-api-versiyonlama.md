# ADR-005: API versiyonlama ve zorunlu güncelleme

- **Tarih:** 2026-08-12
- **Durum:** Kabul edildi (uygulanmadı — T53, T33)
- **İlgili:** PLAN.md Bölüm 9, T33, T53

## Bağlam

Mobil uygulama **geri alınamaz**. Web'de hatalı bir sürüm yayınlarsan geri
alırsın ve kullanıcı bir sonraki sayfa yenilemesinde düzelmiş sürümü görür.
Mağazadan dağıtılan bir uygulamada öyle değil: eski sürüm kullanıcının
telefonunda kalıyor ve yeni API'ye vurmaya devam ediyor.

Bu, dağıtımda en sık unutulan şey: sunucu ilerliyor, istemcilerin bir kısmı
ilerlemiyor.

## Karar

1. **`/api/v1` yol versiyonlaması.** Kırıcı değişiklik yeni yolla gelir; eski
   yol en az **iki sürüm** boyunca çalışmaya devam eder.
2. Her istek **`X-Client-Version`** başlığı taşır.
3. Sunucu kabul ettiği **en düşük istemci sürümünü** biliyor
   (`MIN_CLIENT_VERSION`). Altındaki istemci **`426 CLIENT_TOO_OLD`** alıyor
   ve uygulama zorunlu güncelleme ekranı gösteriyor.
4. Migration'lar **geriye uyumlu**: kolon silme, tip değiştirme ve
   `NOT NULL` ekleme iki aşamaya bölünüyor ve ayrı sürümlerde yayınlanıyor —
   dağıtım anında eski ve yeni kod aynı anda çalışıyor.

## Elenen yollar

**Versiyonlamamak.** Tek müşteri, tek uygulama varken cazip. İlk kırıcı
değişiklikte, güncellemeyi yapmamış her telefon **sessizce yanlış veri
göndermeye** başlar — 400 alsa fark edilirdi, ama alan adı değişikliği gibi
durumlarda istek geçerli görünür.

**Yalnızca `Accept` başlığıyla içerik anlaşması.** Standart ama hata ayıklaması
zor: bir isteğin hangi sürüme gittiği URL'e bakınca anlaşılmıyor, log ve destek
konuşması zorlaşıyor.

**Zorunlu güncelleme yerine "yumuşak uyarı".** Kullanıcı kapatabilirse
kapatır. Depoda çalışan biri için güncelleme, işini yapmasını engelleyen bir
kesinti; ertelenebilir olduğu sürece ertelenir ve eski sürüm aylarca kalır.

**Sunucuda eski alan adlarını sonsuza kadar desteklemek.** Kırıcı değişiklik
yapmamak gibi görünüyor ama şema iki katına çıkıyor ve hangi alanın kim
tarafından kullanıldığı bilinmiyor — silinemeyen kod birikiyor.

## Sonuçlar

**İyi:** Eski istemci sessizce yanlış çalışmıyor; net bir ekran görüyor.

**Bedel:** `MIN_CLIENT_VERSION` bir **operasyon kararı**. Çok erken
yükseltmek, mağaza onayını bekleyen kullanıcıları dışarıda bırakır (iOS'ta
1-3 gün). Bu yüzden yükseltme, yeni sürümün yayınlanmasından **sonra** ve
kullanım oranına bakılarak yapılmalı.

**Bedel:** İki aşamalı migration disiplini yavaş. Karşılığı, dağıtım anında
"eski kod yeni şemaya çarptı" arızasının hiç yaşanmaması.

## Bugünkü durum

`MIN_CLIENT_VERSION` ortam değişkeni ve `CLIENT_TOO_OLD` (426) hata kodu
**tanımlı**. `/api/v1` uçları ve başlık kontrolü **yazılmadı** — T53, ve
mobilin tamamı ona bağlı.
