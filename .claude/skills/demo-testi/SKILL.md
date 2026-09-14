---
name: demo-testi
description: Bir arayüz değişikliğini gerçek tarayıcıda sürerek doğrular ve demo kurulum yolunun her platformda çalıştığını kontrol eder. Ekran, form, sunucu eylemi veya kurulum adımı değiştiğinde kullan. "demoyu dene", "tarayıcıda kontrol et", "kurulum çalışıyor mu" gibi isteklerde de tetiklenir.
---

# Tarayıcıda sür, sonra "çalışıyor" de

Bu projede birim testlerin göremediği DÖRT kullanıcıya görünen hata
yalnızca gerçek tarayıcıda sürülerek bulundu:

1. Kayıttan sonra odak kayboluyordu — sunucu eylemi yönlendirmesi
   App Router'da yumuşak gezinme, `autoFocus` yalnız ilk montajda ateşlenir
2. Başarı yönlendirmesi kendi `catch`'ine düşüyordu — Next'in `redirect()`
   akış kontrolü için fırlatıyor
3. `type="number"` Türkçe ondalık ayırıcıyı reddediyor, alan boş gidiyor
4. Hata ayrıntısı beyaz listesi "Elde undefined adet var" üretiyordu

Hiçbiri tipte, testte veya derlemede görünmez.

## Tarayıcıda sürme

Chromium kurulu ve Playwright onu bulacak şekilde yapılandırılmış
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). `playwright install`
ÇALIŞTIRMA.

```js
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
```

Dikkat edilecekler:

- **`waitForURL` yumuşak gezinmede ateşlenmiyor.** Adresi döngüyle yokla.
- Zaten eşleşen bir adreste bekleme anında döner — önce durumu değiştir,
  sonra bekle.
- Giriş alan adları: `email` ve `parola` (`eposta` değil).
- Doğru düğmeye bas: üst şeritteki "Çıkış" ile formdaki "Kaydet" farklı.

## Demo kurulum yolu

`pnpm demo` Windows, macOS ve Linux'ta aynı çalışmalı. Kurulum adımına
dokunduysan üçünü de düşün:

- **bash varsayma.** Windows'ta CMD `./script.sh` tanımıyor, Git Bash
  PATH'te olmayabiliyor, WSL'de dağıtım kurulu olmayabiliyor.
- **`pg_isready` varsayma.** Postgres istemci paketiyle geliyor; Docker
  kullanan bir Windows makinesinde yok.
- **`pnpm --filter X <script>` yazma, `run` ekle.** pnpm ilk kelimeyi
  çalıştırılabilir sayıyor ve Windows'ta `'migrate' is not recognized`
  veriyor.
- **Açık port "hazır" demek değil.** Docker portu konteyner başlar
  başlamaz yayınlıyor; arkadaki Postgres hâlâ `initdb` ile uğraşıyor
  olabiliyor. `scripts/wait-for-db.mjs` kullan.
- **Ortamı hazırlamak scriptin değil uygulamanın işi.** Kurulum scripti
  `.env`'i export ederse, uygulamanın onsuz çalışmadığı fark edilmez.

## Bitmiş sayılma ölçütü

Bunların hepsi yeşil olmadan "çalışıyor" deme:

```
pnpm typecheck
pnpm test
pnpm --filter @stok/db exec drizzle-kit generate   # migration üretmemeli
pnpm --filter @stok/web run build
```

Sonra demoyu sıfırdan koştur ve tarayıcıdan gerçekten giriş yap.
