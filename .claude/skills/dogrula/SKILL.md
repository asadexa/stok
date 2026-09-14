---
name: dogrula
description: Bir korumanın (guard, kilit, kontrol, yetki testi) gerçekten iş yaptığını kanıtlar — geçici olarak kaldırıp testin kırmızı yandığını görerek. Yeni bir güvenlik kontrolü, invariant, RLS politikası, rol kontrolü veya hata yolu yazıldığında kullan. "bu test bir şey ispat ediyor mu", "koruma çalışıyor mu", "testi doğrula" gibi isteklerde de tetiklenir.
---

# Korumayı kaldır, kırmızı yanmasını gör

Yeşil bir test, koruduğu şeyin çalıştığını İSPAT ETMEZ. Test hiç
çalışmıyor da olabilir, yanlış şeye bakıyor da olabilir, ya da koruma
olmadan da geçiyor olabilir.

Bu projede yeşil yanan ama hiçbir şey ispat etmeyen testlerin somut
maliyeti var: `asTenant` gibi üretimdeki `withTenant()`'ın test-özel bir
kopyası kullanılsaydı, tenant izolasyonu testlerinin tamamı geçerken
üretimdeki fonksiyon bozulabilirdi.

## Yordam

Bir koruma eklediğinde veya bir korumayı sınayan test yazdığında:

1. Testin geçtiğini gör.
2. **Korumayı geçici olarak kaldır** — satırı sil, koşulu `false` yap,
   bağlantıyı yetkilisiyle değiştir.
3. Testin **kırmızı yandığını** gör. Yanmıyorsa test yanlış şeye bakıyor;
   testi düzelt, korumayı değil.
4. Korumayı geri koy ve yerinde olduğunu **doğrula** (`git diff` veya
   dosyayı oku). Bu adımı atlama: kaldırılmış bir koruma ile commit'lenen
   kod, hiç olmayan korumadan beterdir.
5. Neyi kaldırıp ne gördüğünü commit mesajına yaz.

## Bu projede böyle doğrulanmış korumalar

- `.for('update')` satır kilidi — kaldırıldığında eşzamanlılık testi
  negatif stok üretiyor
- `pgErrorCode` cause zinciri — Drizzle hatayı sarmalıyor, `err.code`
  her zaman `undefined`
- Rol matrisinin servis yolu — boğaz kontrolü geçse bile servis
  çağrısı reddetmeli
- Fiyat gizleme, kullanıcı pasifleştirme kilitleri
- `AUTH_SECRET` açılış kontrolü — kısa anahtarla sunucu açılmamalı
- Uygulama/admin veritabanı bağlantısı ayrımı

## Ne zaman yetmez

Birim testi göremeyecek şeyler var: odak kaybı, yumuşak gezinme,
tarayıcı davranışı. Bunlar için gerçek tarayıcı gerekir — `demo-testi`
skill'ine bak. Bu projede dört kullanıcıya görünen hata yalnızca
tarayıcıda sürülerek bulundu.
