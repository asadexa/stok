# Tasarım tuvali — Stok Takip

Arayüz tasarım kuralları. Yedi artboard:

| Dosya | Ne |
|---|---|
| `Main.dc.html` | Kurallar: referans görselden ne alındı/alınmadı, dokuz kural, bugünkü koddan değişecekler |
| `Renk.dc.html` | Renk belirteçleri + ölçülmüş kontrast oranları |
| `Tipografi.dc.html` | Kademeler, tabular rakam, boşluk/kenarlık/yarıçap ölçüleri |
| `Bilesenler.dc.html` | Kontrol yükseklikleri, form alanı, düğme, rozet, şerit, tablo satırı, boş durum, gezinme |
| `Panel.dc.html` | Uygulanmış: yönetici paneli |
| `Stok.dc.html` | Uygulanmış: stok tablosu |
| `Hareket.dc.html` | Uygulanmış: giriş/çıkış — üç adım |

`canvas.json` yerleşimi ve notları tutuyor.

## Değerler nereden geldi

Renk, ölçü ve tipografi değerleri uydurulmadı; uygulamadan alındı:

- `apps/web/src/app/globals.css` — `--color-kritik`, `--color-kritik-bg`, `--color-giris`, `--color-cikis`
- `apps/web/src/components/field.tsx` — 56 px kontrol yüksekliği, `rounded-md`, kenarlıklar
- `apps/web/src/app/hareket/page.tsx` — 64 px barkod/miktar alanı
- `PLAN.md` Bölüm 11 — bilgi hiyerarşisi, 3 dokunuş kuralı, AI slop yasağı

Kontrast oranları hesaplandı (oklch → sRGB → WCAG). Kurallar tuvalinin C bölümündeki
dört madde, bu hesabın ortaya çıkardığı açıkları kapatan **değişiklik önerileri** —
henüz koda uygulanmadı.

## Yeniden üretme

Tuval `.dc.html` dosyalarından üretiliyor; yayınlanmış sayfa elle düzenlenmez.
Bir şey değişecekse önce buradaki dosya değişir, sonra tuval yeniden tohumlanır:

```
node "<design skill dizini>/seed-canvas.mjs" \
  --template "<design skill dizini>/payload.template.html" \
  --out stok-takip-tasarim-kurallari.html \
  --title "Stok Takip Tasarım Kuralları" \
  --artboard Main.dc.html --artboard Renk.dc.html --artboard Tipografi.dc.html \
  --artboard Bilesenler.dc.html --artboard Panel.dc.html --artboard Stok.dc.html \
  --artboard Hareket.dc.html --canvas canvas.json
```

Tohumlanan `stok-takip-tasarim-kurallari.html` bir ÇIKTI: sürüm kontrolüne girmiyor
(`.gitignore`), çünkü 2 MB'lık editör yükünü taşıyor ve her tohumlamada baştan üretiliyor.
