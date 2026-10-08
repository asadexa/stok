---
name: demo-testi
description: Bir arayüz değişikliğini gerçek tarayıcıda sürerek doğrular ve demo kurulum yolunun her platformda çalıştığını kontrol eder. Ekran, form, sunucu eylemi veya kurulum adımı değiştiğinde kullan. "demoyu dene", "tarayıcıda kontrol et", "kurulum çalışıyor mu" gibi isteklerde de tetiklenir.
---

# Tarayıcıda sür, sonra "çalışıyor" de

Bu projede birim testlerin göremediği hatalar yalnız gerçek tarayıcıda
sürülerek bulundu. Hiçbiri tipte, testte ya da derlemede görünmüyordu:

1. Kayıttan sonra odak kayboluyordu: sunucu eylemi yönlendirmesi App Router'da
   yumuşak gezinme, `autoFocus` yalnız ilk montajda ateşlenir.
2. Başarı yönlendirmesi kendi `catch`'ine düşüyordu: Next'in `redirect()`'i akış
   kontrolü için fırlatıyor.
3. `type="number"` Türkçe ondalık ayırıcıyı reddediyor, alan boş gidiyor.
4. Hata ayrıntısı beyaz listesi "Elde undefined adet var" üretiyordu.
5. `/urunler/yeni` çalışana açıktı (T38).
6. "Kaydet"in sessizce hiçbir şey yapmadığı Next 15 yönlendirici hatası (T109).

## Ortam

Geliştirme makinesi **Windows**; komutlar PowerShell/CMD'de de çalışmalı.
Playwright projede kurulu: `apps/web/playwright.config.ts`, testler `apps/web/e2e/`.

- **Tarayıcı ikilisi**: ilk kez kuruluyorsa
  `pnpm --filter @stok/web exec playwright install chromium` gerekir. Bu bir
  **indirmedir**; kullanıcı onayı olmadan çalıştırma. Önceden kurulu bir
  Chromium'u kullanmak için `PLAYWRIGHT_CHROMIUM_PATH` ortam değişkeni.
- **Sunucuyu Playwright açar** (`next start`), yani **önce build** gerekir.
  Yerelde port 3000'de açık bir sunucu varsa (`reuseExistingServer`) testler
  ona bağlanır: üretim derlemesini değil dev sunucusunu sınamış olursun. Port
  3000'i boşalt ya da bunu bilerek yap.
- E2E **demo veritabanına yazar** (ürün, kullanıcı, hareket ekler) ve seed
  verisine bağımlıdır. Veriyi sıfırlamak (`pnpm demo --seed`) veri silen bir
  komuttur: kullanıcı onayı olmadan çalıştırma.

## Tarayıcıda sürme

**Otomatik (tercih edilen; değişiklik kalıcı korunsun diye):**

```bash
pnpm --filter @stok/web run build
pnpm --filter @stok/web run test:e2e
```

Yeni bir akış ya da hata düzeltmesi için `apps/web/e2e/` altına senaryo ekle.
Koruma ekliyorsan senaryonun korumasız kırmızı yandığını gör (`dogrula`).

**Keşif / tek seferlik bakış:** ajan tarayıcısıyla (gstack `/browse` ya da
uygulamanın tarayıcı paneli) `http://localhost:3000` üzerinde sür. Gördüğün
hatayı e2e senaryosuna çevir ya da `gorev-kaydet` ile TODOS'a yaz.

Dikkat edilecekler:

- **`waitForURL` yumuşak gezinmede ateşlenmiyor.** Adresi döngüyle yokla. Zaten
  eşleşen bir adreste bekleme anında döner: önce durumu değiştir, sonra bekle.
- Giriş alan adları `email` ve `parola` (`eposta` değil).
- **Doğru düğmeye bas.** Kenar çubuğundaki "Çıkış yap" da bir gönderme düğmesi;
  `button[type="submit"]` ilk düğmeyi seçer ve oturumu kapatır. Düğmeleri
  adlarıyla seç.
- Konsolu ve sunucu logunu oku: `error` seviyesinde satır, yeşil teste rağmen bulgudur.
- Demo hesapları README'de.

## Demo kurulum yolu

`pnpm demo` Windows, macOS ve Linux'ta aynı çalışmalı. Kurulum adımına
dokunduysan `CLAUDE.md` → "Windows tuzakları"ndaki dört kurala uy (bash
varsayma, `--filter … run`, açık port ≠ hazır, ortamı uygulama hazırlar). Ek olarak:

- **`pg_isready` varsayma.** Postgres istemci paketiyle geliyor; Docker kullanan
  bir Windows makinesinde yok. Hazırlık beklemesi `scripts/wait-for-db.mjs`'te.
- Kurulumu üç durumda düşün: Docker var; Docker yok ama 5433'te yerel PostgreSQL
  var; ikisi de yok (anlaşılır hata vermeli).

CI'daki `smoke` işi temiz checkout'tan `pnpm demo --seed --no-server` +
build + e2e koşuyor; kurulum değişikliği orada da yeşil olmalı.

"Bitti" ölçütünün tamamı `CLAUDE.md` → "Doğrulama standardı".
