# Stok Takip

Küçük ve orta ölçekli depolar için barkod tabanlı stok takip sistemi.
Türkçe arayüz, çok kiracılı (multi-tenant), append-only stok defteri.

Ürün kararları ve gerekçeleri **[PLAN.md](PLAN.md)** içinde; bu dosya
sadece "nasıl çalıştırırım" sorusunu cevaplıyor.

---

## Demo

Tek komut:

```bash
./scripts/demo.sh
```

Script veritabanını ayağa kaldırır, şemayı uygular, örnek veriyi yükler ve
`http://localhost:3000` adresinde sunucuyu başlatır. Her adımda ne yaptığını
yazar; bir şey eksikse ne yapmanız gerektiğini söyler.

Veritabanını sıfırlayıp örnek veriyi yeniden yüklemek için:

```bash
./scripts/demo.sh --seed
```

### Giriş bilgileri

| Rol | E-posta | Parola |
|---|---|---|
| Yönetici | `admin@yilmaz.example` | `admin123` |
| Çalışan | `ahmet@yilmazkirtasiye.example` | `calisan123` |
| Başka işletme | `admin@demir.example` | `admin123` |

Örnek veri: 2 işletme, 240 ürün, ~5000 stok hareketi.

### Neyi deneyebilirsiniz

- **Giriş/Çıkış** — barkod okutup mal kabulü veya satış girin; ürün adı ve
  mevcut stok onaydan önce görünür, kayıttan sonra "439 → 446" gösterilir
- **Panel** — kritik stok uyarısı, günün giriş/çıkış özeti, son hareketler
- **Stok tablosu** — Türkçe arama (`ısıtıcı` yazın, `Isıtıcı Şerit` gelsin),
  kategori/kritik/arşiv filtreleri, sayfalama
- **Ürün yönetimi** — ekleme, düzenleme, arşivleme, çoklu barkod, koli çarpanı
- **Toplu aktarma** — Excel/CSV yükleyip önizleyip onaylama, hata raporu
- **Excel export** — stok ve hareket raporu, ekrandaki filtreyle birebir
- **Hareket logu** — kullanıcı/tarih/ürün/sebep filtreleri
- **Kullanıcı yönetimi** — ekleme, rol verme, pasifleştirme, parola sıfırlama
- **Sistem sağlığı** — defter tutarlılığı, kuyruk durumu, hareketsizlik

Rol farkını görmek için çalışan hesabıyla girin: fiyatlar kaybolur, ürün
düzenleme ve kullanıcı yönetimi ekranları görünmez, hareket logunda yalnızca
kendi kayıtları listelenir.

İşletme izolasyonunu görmek için `admin@demir.example` ile girin: diğer
işletmenin tek bir ürününü bile göremezsiniz (veritabanı seviyesinde RLS).

### Neyi DENEYEMEZSİNİZ — bilerek

- **Barkod okuyucu ile okutamazsınız** — kamera mobilde (Faz 5). Web'deki
  Giriş/Çıkış ekranı barkodu elle yazmayı veya USB okuyucu (klavye
  emülasyonu) kullanmayı bekliyor.
- **Mobil uygulama yok.** Barkod okutma, offline kuyruk, PIN ile hızlı
  kullanıcı geçişi — hepsi Faz 5.
- **Arka plan işçisi çalışmıyor.** 20.000 satırın üstündeki bir export
  kuyruğa girer ama kimse işlemez (cron T34'e bağlı). Örnek veride bu eşiğe
  ulaşılmıyor.
- **E-posta gönderilmiyor.** SMTP ayarlanmadı.

---

## Geliştirme

```bash
pnpm install
cp .env.example .env
docker compose up -d              # veya 5433 portunda kendi Postgres'iniz
pnpm --filter @stok/db migrate
pnpm --filter @stok/db seed
pnpm --filter @stok/web dev
```

| Komut | Ne yapar |
|---|---|
| `pnpm test` | Tüm testler (gerçek PostgreSQL gerekir) |
| `pnpm typecheck` | Dört paketin tip kontrolü |
| `pnpm --filter @stok/db generate` | Şema değişikliğinden migration üretir |
| `pnpm --filter @stok/web build` | Üretim derlemesi |

### Paketler

```
packages/shared   Tek kaynak: roller, sebep kodları, birimler, hata sözleşmesi,
                  zod şemaları. DB CHECK constraint metinleri buradan ÜRETİLİR.
packages/db       Drizzle şeması, migration'lar, RLS, bağlantı havuzu, test fixture'ı
packages/core     İş mantığı: tek yazma kapısı, auth, yetki, export, import, sağlık
apps/web          Next.js 15 App Router arayüzü
```

### Bilmeniz gereken üç kural

1. **Stok defteri append-only.** `stock_movements` üzerinde `UPDATE`/`DELETE`
   yok — veritabanı seviyesinde engelli. Düzeltme, ters kayıt yazarak yapılır.
2. **`current_stock` türetilmiş veri.** Gerçeğin kaynağı defter; projeksiyon
   trigger ile güncelleniyor. `SUM(delta) == qty` invariant'ı testlerle ve
   Sistem Sağlığı sayfasıyla sürekli doğrulanıyor.
3. **Her sorgu `withTenant()` içinden geçer.** RLS `app.tenant_id` ayarına
   bakıyor; ayarı kurmadan yapılan sorgu sıfır satır döndürür.

### Ortam değişkenleri

`.env.example` her satırın neden orada olduğunu açıklıyor. İki tanesi
kolayca yanlış anlaşılıyor:

- **`DATABASE_URL` ile `MIGRATION_DATABASE_URL` farklı roller.** İlki RLS'e
  tabi uygulama rolü, ikincisi tabloların sahibi. Uygulama kodundan asla
  ikincisi kullanılmaz.
- **`APP_URL` sadece bağlantı üretmiyor.** Oturum çerezinin `Secure` bayrağı
  bu adresin şemasından türüyor. Üretimde `https://` olmalı.

`NODE_ENV` bilerek tanımlı değil: Next kendisi ayarlıyor ve dışarıdan
verilen değer `next build`'i bozuyor.
