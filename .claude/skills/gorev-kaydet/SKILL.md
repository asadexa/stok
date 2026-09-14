---
name: gorev-kaydet
description: Yol boyunca bulunan bir hatayı, plan boşluğunu veya ertelenen düzeltmeyi PLAN.md'ye numaralı görev olarak yazar. Bir bulgu düzeltilmeden bırakıldığında, plan dışı bir ihtiyaç ortaya çıktığında veya kullanıcı testinde bir engel çıktığında kullan.
---

# Bulguyu plana yaz, sohbette bırakma

Sohbette anlatılan bir bulgu, sohbet bitince kaybolur. Bu projede
kaydedilmiş her görev, sonradan gerçekten yapılacak işe dönüştü:

- T52 (web'de hareket girişi) bir **plan boşluğuydu** — fark edilmeseydi
  kullanıcı testi kurulum ekranlarının testine inecekti
- T53 (`/api/v1`) mimari metinde vardı ama numaralı görevi yoktu
- T55 kontrast açıkları **ölçüldü**, düzeltilmedi, yazıldı
- T57–T61 kullanıcı testinde çıkan kurulum engelleri

## Nasıl yazılır

`PLAN.md` → `## UYGULAMA GÖREVLERİ` altına, ilgili fazın sonuna:

```
- [ ] **T<n> (P1|P2|P3, human: ~Xsa / CC: ~Ydk)** - <alan> - **<Başlık>**
  - Neden gerekli: hangi somut arıza, kim ne zaman fark eder
  - Alternatif neden seçilmedi
  - Doğrula: nasıl sınanacak
  - Kaynak: hangi inceleme / hangi tur
```

Alan: `db`, `core`, `web`, `api`, `mobil`, `altyapı`, `güvenlik`,
`tasarım`.

## Kurallar

- **Sebebi yaz, sonucu değil.** "Kenarlık kontrastı düşük" yetmez;
  "1,48:1, WCAG 1.4.11 3:1 istiyor, kötü ışıkta kutunun nerede bittiği
  görünmüyor" karar verilebilir.
- **Plan boşluğunu açıkça işaretle.** "PLAN BOŞLUĞU, sonradan fark
  edildi" satırı, planın nerede yanıldığını gizlemez.
- **Bilerek yapılmayanı da yaz.** G3 (yazıcı hatası) yapılmadı ve
  gerekçesi planda duruyor; boş bırakılsa "unutulmuş" sanılırdı.
- **Yapılanı `[x]` ile işaretle ve ne doğrulandığını yaz.**
- Numarayı mevcut en büyükten devam ettir, yeniden kullanma.
