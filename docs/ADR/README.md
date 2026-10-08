# Karar Kayıtları (ADR)

Bu klasördeki her dosya **bir karar** ve **o kararın neden verildiği**.

## DECISIONS.md varken bunlar neden var

`DECISIONS.md` hâlâ geçerli kararların kısa indeksi: *ne* karar verildi, durumu ne.
ADR'ler farklı bir soruyu cevaplıyor: **"bu neden böyle?"** Hem de burada olmayan
birine: yeni bir geliştirici, müşterinin bir sonraki tedarikçisi ya da altı ay
sonra kendimiz. Her ADR'nin karşılığı DECISIONS'ta bir ya da birkaç satır olarak
durur ve oradan buraya referans verilir.

## Ne zaman ADR yazılır

Yalnız şu dördü birlikte doğruysa:

- **uzun ömürlü**: aylarca/yıllarca geçerli kalacak,
- **mimariyi etkiliyor**: veri modeli, güvenlik modeli, katmanlar, dağıtım,
- **değiştirmesi pahalı**: geri dönüşü migration, veri düzeltmesi ya da yeniden yazım ister,
- **gerçek alternatifi var**: elenen yol ciddi bir seçenekti.

Küçük UI kararları, isimlendirme ve implementasyon ayrıntıları için ADR **yazılmaz**;
gerekiyorsa `DECISIONS.md`'de tek satır olur.

## Kurallar

- **ADR'ler tarihli ve DEĞİŞMEZ.** Karar değiştiyse eskisi silinmez: durumu
  `Değiştirildi → ADR-00X` olur, yenisi yeni numarayla yazılır. DECISIONS'taki
  satır da `Superseded` olur.
- **Elenen yol yazılır.** Bir ADR'nin en değerli kısmı seçilmeyenlerin neyi
  bozacağıdır. Onu yazmayan ADR, kodun kendisinin söylemediği hiçbir şeyi söylemez.
- **Sıradaki numara: ADR-006.**

## Durum etiketleri

| Etiket | DECISIONS karşılığı | Anlamı |
|---|---|---|
| `Kabul edildi` | Active | Karar verildi ve kodda uygulandı |
| `Kabul edildi (uygulanmadı)` | Active (uygulanmadı) | Karar verildi, kod henüz yazılmadı |
| `Açık` | Open | Karar VERİLMEDİ. Varsayılan yazılı ama bağlayıcı değil |
| `Değiştirildi → ADR-00X` | Superseded | Yerine geçen ADR'nin numarası yazılı |

## Şablon

```
# ADR-00X: <Başlık>

- **Tarih:** YYYY-AA-GG
- **Durum:** Kabul edildi | Kabul edildi (uygulanmadı) | Açık | Değiştirildi → ADR-00Y
- **İlgili:** DECISIONS <ID>, TODOS <T>

## Bağlam
## Karar
## Elenen yollar
## Sonuçlar
## Nasıl doğrulanıyor
```

## Kayıtlar

| # | Konu | Durum | DECISIONS |
|---|---|---|---|
| [001](001-append-only-defter.md) | Stok bir sayı değil, defterin sonucu | Kabul edildi | DAT-01, DAT-02, DAT-10 |
| [002](002-tenant-izolasyonu-rls.md) | Tenant izolasyonu veritabanında (RLS) | Kabul edildi | SEC-01, SEC-02 |
| [003](003-mobil-offline-outbox.md) | Mobil çevrimdışı yazma: outbox + idempotency | Kabul edildi (uygulanmadı) | ARC-10 |
| [004](004-maliyet-yontemi.md) | Maliyet yöntemi: FIFO mu ağırlıklı ortalama mı | **Açık** | DAT-15 |
| [005](005-api-versiyonlama.md) | API versiyonlama ve zorunlu güncelleme | Kabul edildi (uygulanmadı) | ARC-09 |

## Notlar

- **001–005 geriye dönük yazıldı.** Hepsi 2026-09-04'te (`157f35d`) yazıldı ama
  2026-08-12 tarihini taşıyor (repo 2026-08-22'de açıldı). Kararın kendisi o
  günlere ait, metin sonradan kurulmuş gerekçe. Tarihler düzeltilmedi.
- ADR'lerdeki `PLAN.md …` referansları artık `docs/archive/PLAN-2026-09.md`'yi
  gösterir.
- **Bilinen çelişki:** ADR-005'in bağlamı "mobil uygulama geri alınamaz" diyor;
  `ARC-13` (EAS Update ile JS'in OTA geri alınması) bununla çelişiyor. Mobil
  yazılmadan önce yeni bir ADR ile netleşmeli (TODOS T143).
