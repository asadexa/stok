# Tasarım tuvali — Stok Takip

Arayüz tasarım kuralları. Beş artboard:

| Dosya | Ne |
|---|---|
| `Main.dc.html` | Kurallar: referans görselden ne alındı/alınmadı, dokuz kural |
| `Renk.dc.html` | Renk belirteçleri + ölçülmüş kontrast oranları (açık ve koyu tema) |
| `Tipografi.dc.html` | Yüzler, kademeler, boşluk/yarıçap/kontrol ölçüleri |
| `Bilesenler.dc.html` | 13 bileşen, dosya karşılıkları, kontrol yükseklikleri |
| `Uygulanmis.dc.html` | Hangi ekranın hangi kuralı gösterdiği — çalışan uygulamaya işaretçi |

`canvas.json` yerleşimi ve notları tutuyor.

## Değerler nereden geldi

Renk, ölçü ve tipografi değerleri uydurulmadı; kontrast oranları
hesaplandı (sRGB relative luminance, WCAG 2.1) ve eşiklere göre
işaretlendi. Kaynak dosyalar:

- `apps/web/src/app/globals.css` — 28 token × 2 tema, yarıçap ölçeği
- `apps/web/src/app/layout.tsx` — yazı tipleri (`next/font`, `latin-ext`)
- `apps/web/src/components/` — bileşenlerin gerçek ölçüleri
- `PLAN.md` Bölüm 11 ve Faz 9 — bilgi hiyerarşisi, 3 dokunuş kuralı

## Statik ekran kopyası neden yok

Önceki sürümde Panel, Stok ve Giriş/Çıkış ekranlarının çizilmiş kopyaları
vardı (`Panel.dc.html`, `Stok.dc.html`, `Hareket.dc.html`). Kaldırıldılar.

O kopyalar planlama aşamasında mantıklıydı: gösterilecek çalışan bir
uygulama yoktu. Artık var, ve statik kopya senkronda tutulması gereken
**üçüncü** bir şey demek. Üç şeyi birden bozuyordu:

1. **Kodla ayrışıyor.** Ekran değişince kimse tuvali güncellemeyi
   hatırlamıyor ve tuval sessizce yalan söylemeye başlıyor.
2. **Ölçülemiyor.** Kontrast ve dokunma hedefi gerçek DOM'da ölçülür;
   çizilmiş bir kopyada ölçülen şey çizimin kendisidir.
3. **Etkileşimi gösteremiyor.** Odak halkası, açılır liste, iskelet
   ekran, sesli geri bildirim — hiçbiri statik bir görüntüde yok.

Kurallar ve belirteçler burada, uygulanmış hâli çalışan uygulamada.
`Uygulanmis.dc.html` hangi adresin hangi kuralı gösterdiğini listeliyor.

## Yeniden üretme

Tuval `.dc.html` dosyalarından üretiliyor; yayınlanmış sayfa elle
düzenlenmez. Bir şey değişecekse önce buradaki dosya değişir, sonra tuval
yeniden tohumlanır:

```
node "<design skill dizini>/seed-canvas.mjs" \
  --template "<design skill dizini>/payload.template.html" \
  --out stok-takip-tasarim-kurallari.html \
  --title "Stok Takip Tasarım Kuralları" \
  --artboard Main.dc.html --artboard Renk.dc.html --artboard Tipografi.dc.html \
  --artboard Bilesenler.dc.html --artboard Uygulanmis.dc.html \
  --canvas canvas.json
```

Tohumlanan `stok-takip-tasarim-kurallari.html` bir ÇIKTI: sürüm
kontrolüne girmiyor (`.gitignore`), çünkü 2 MB'lık editör yükünü taşıyor
ve her tohumlamada baştan üretiliyor.

## Tasarım incelemesi kayıtları

Kararların gerekçeleri ve mockup'lar PLAN.md Faz 9'da (TD1–TD6) ve ayrı
bir belgede:
<https://claude.ai/code/artifact/5579f41a-2794-4146-862b-114c9469c7a8>
