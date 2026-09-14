# Karar Kayıtları (ADR)

Bu klasördeki her dosya **bir karar** ve **o kararın neden verildiği**.

## PLAN.md varken bunlar neden var

`PLAN.md` çalışan bir belge: görevler kapanıyor, gerekçeler güncelleniyor,
ölçümler ekleniyor. Bir kararın *bugünkü* halini anlatıyor.

ADR'ler farklı bir soruyu cevaplıyor: **"bu neden böyle?"** — hem de burada
olmayan birine. Yeni bir geliştirici, müşterinin bir sonraki tedarikçisi, ya
da altı ay sonra kendimiz.

İki kural:

- **ADR'ler tarihli ve DEĞİŞMEZ.** Karar değiştiyse eskisi silinmez;
  "Değiştirildi: ADR-00X" notu düşülüp yenisi yazılır. Kararın kendisi kadar
  kararın nasıl evrildiği de bilgi.
- **Elenen yol yazılır.** Bir ADR'nin en değerli kısmı seçilen çözüm değil,
  seçilmeyenlerin neyi bozacağı. Onu yazmayan ADR, kodun kendisinin
  söylemediği hiçbir şeyi söylemiyor demektir.

## Durum etiketleri

| Etiket | Anlamı |
|---|---|
| `Kabul edildi` | Karar verildi ve kodda uygulandı |
| `Kabul edildi (uygulanmadı)` | Karar verildi, kod henüz yazılmadı |
| `Açık` | Karar VERİLMEDİ. Varsayılan yazılı ama bağlayıcı değil |
| `Değiştirildi` | Yerine geçen ADR'nin numarası yazılı |

## Kayıtlar

| # | Konu | Durum |
|---|---|---|
| [001](001-append-only-defter.md) | Stok bir sayı değil, defterin sonucu | Kabul edildi |
| [002](002-tenant-izolasyonu-rls.md) | Tenant izolasyonu veritabanında (RLS) | Kabul edildi |
| [003](003-mobil-offline-outbox.md) | Mobil çevrimdışı yazma: outbox + idempotency | Kabul edildi (uygulanmadı) |
| [004](004-maliyet-yontemi.md) | Maliyet yöntemi: FIFO mu ağırlıklı ortalama mı | **Açık** |
| [005](005-api-versiyonlama.md) | API versiyonlama ve zorunlu güncelleme | Kabul edildi (uygulanmadı) |
