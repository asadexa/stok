---
name: gorev-kaydet
description: Yol boyunca bulunan bir hatayı, plan boşluğunu veya ertelenen düzeltmeyi TODOS.md'ye numaralı görev olarak yazar ve o anki işe devam eder. Bir bulgu düzeltilmeden bırakıldığında, görev dışı bir ihtiyaç ortaya çıktığında veya kullanıcı testinde bir engel çıktığında kullan.
---

# Bulguyu TODOS'a yaz, sohbette bırakma, işi bölme

Sohbette anlatılan bulgu sohbet bitince kaybolur. Bu projede kaydedilen her
bulgu sonradan gerçek işe dönüştü: T52 (plan boşluğu), T53 (numarası olmayan
mimari iş), T55 (ölçülen kontrast açığı), T57–T61 (kullanıcı testindeki
kurulum engelleri).

## Ne zaman

- Bir hata ya da risk buldun ama **şu anki görevin kapsamında değil**.
- Bir düzeltmeyi bilerek erteliyorsun.
- Kullanıcı testinde ya da tarayıcı turunda bir engel çıktı.

Görev kapsamındaysa kaydetme, düzelt. **Kaydettikten sonra o anki işe devam
et**: bulguyu düzeltmek için mevcut işi bölme, yeni bir workstream açma.
Kullanıcıya rapor ederken tek satırla söyle ("T1xx olarak kaydedildi").

## Nereye, nasıl

`TODOS.md`'de doğru öncelik bölümüne (P0 / P1 / P2 / P3 / Product-Future).
Numara: dosyanın başındaki **"sıradaki boş numara"**yı kullan, sonra onu bir
artır. Numara yeniden kullanılmaz.

```
- [ ] **T<n> (P0–P3)** - <alan> - **<Başlık>**
  - Neden: hangi somut arıza, kim ne zaman fark eder
  - Kanıt: dosya:satır, komut çıktısı, commit
  - Bağlı: diğer T'ler, DECISIONS ID'leri (karar bekliyorsa "BLOKE: <ID>")
  - Doğrula: nasıl sınanacak
  - Kaynak: hangi görev / inceleme / tarih
```

Alan: `db`, `core`, `web`, `api`, `mobil`, `cron`, `auth`, `güvenlik`, `ci`,
`altyapı`, `tasarım`, `doküman`, `operasyon`. Öncelik tanımları `TODOS.md`'nin başında.

Bulgu bir güvenlik açığıysa `docs/SECURITY_MODEL.md`'deki ilgili S satırının
"Açık" kısmına da görev numarasını ekle.

## Kurallar

- **Sebebi yaz, sonucu değil.** "Kenarlık kontrastı düşük" yetmez; "1,48:1,
  WCAG 1.4.11 3:1 istiyor, kötü ışıkta kutunun nerede bittiği görünmüyor" karar
  verilebilir.
- **Kanıt koy.** Doğrulanmadıysa "doğrulanmadı" yaz; tahmini bulgu olarak işaretle.
- **Karar gerektiriyorsa kararı TODOS'a yazma.** `DECISIONS.md`'ye `Open` satırı
  ekle, görevde `BLOKE: <ID>` ile referans ver.
- **Bilerek yapılmayanı da yaz.** Gerekçesiz boş bırakılan iş "unutulmuş" sanılır.
- **Durumu CURRENT_STATE'e kopyalama.** Yalnız yeni bir P0/P1 blocker doğduysa
  CURRENT_STATE'in blocker tablosuna ID + tek satır eklenir.
- **Kapanınca** `[x]` + tek satır kanıt (commit, test adı) ile "Kapananlar"a taşı.
