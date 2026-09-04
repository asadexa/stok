# Stok Takip

Küçük ve orta ölçekli depolar için barkod tabanlı stok takip sistemi.
Türkçe arayüz, çok kiracılı (multi-tenant), append-only stok defteri.

Ürün kararları ve gerekçeleri **[PLAN.md](PLAN.md)** içinde; bu dosya
sadece "nasıl çalıştırırım" sorusunu cevaplıyor.

---

## Demo

Tek komut:

```bash
pnpm demo
```

Veritabanını ayağa kaldırır, şemayı uygular, örnek veriyi yükler ve
`http://localhost:3000` adresinde sunucuyu başlatır. Her adımda ne yaptığını
yazar; bir şey eksikse ne yapmanız gerektiğini söyler.

Windows, macOS ve Linux'ta aynı komut. Windows'ta CMD veya PowerShell yeter —
Git Bash veya WSL gerekmiyor.

Veritabanını sıfırlayıp örnek veriyi yeniden yüklemek için:

```bash
pnpm demo --seed
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
- **Gün sonu raporu kendiliğinden çıkmaz.** Kod hazır (T34) ama demoda
  zamanlayıcı yok. Elle tetiklemek için `.env` içine `CRON_SECRET` yazın
  (`openssl rand -base64 32`) ve şunu çalıştırın:

  ```bash
  curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
       http://localhost:3000/api/cron
  ```

  Aynı tur kuyruktaki export işlerini de işler ve stok invariant'ını
  denetler. Turun cevabı JSON; invariant kırıksa ya da bir işin deneme
  hakkı bittiyse HTTP 500 döner.
- **E-posta gönderilmiyor.** SMTP ayarlanmadı, yani yukarıdaki tur çalışır
  ama rapor teslim edilemez ve iş "başarısız" olarak Sistem Sağlığı
  kartında görünür — bu bilerek: gönderilemeyen rapor sessiz kalmamalı.

---

## Geliştirme

`.env` yoksa önce `.env.example` dosyasını `.env` adıyla kopyalayın
(`pnpm demo` bunu kendisi yapar).

```bash
pnpm install
docker compose up -d              # veya 5433 portunda kendi Postgres'iniz
pnpm --filter @stok/db run init   # pg_trgm eklentisi + stok_app rolü
pnpm --filter @stok/db run migrate
pnpm --filter @stok/db run seed
pnpm --filter @stok/web run dev
```

**Docker zorunlu değil.** Kendi PostgreSQL kurulumunuz 5433 portunda
çalışıyorsa `docker compose up -d` adımını atlayın; `init` adımı eklentiyi
ve rolü oraya da uygular. Docker kullanıyorsanız bu adım zaten uygulanmış
olanı tekrar uygular — üç ifade de idempotent, zararı yok.

Sunucu, `DATABASE_URL` veya `AUTH_SECRET` eksikse **açılmıyor** ve neyin
eksik olduğunu konsola yazıyor. Bunlar olmadan uygulama açılıp ilk giriş
denemesinde düşerdi ve ekranda sadece "SERVER_ERROR" görünürdü.

`--filter` ile çağırırken **`run` kelimesi zorunlu**: pnpm onsuz ilk kelimeyi
script değil çalıştırılabilir sayıyor ve Windows'ta
`'migrate' is not recognized` hatası veriyor.

| Komut | Ne yapar |
|---|---|
| `pnpm db:up` | Veritabanını açar ve **hazır olana kadar bekler** |
| `pnpm db:reset` | Veriyi silip veritabanını sıfırdan kurar |
| `pnpm test` | Tüm testler (gerçek PostgreSQL gerekir) |
| `pnpm typecheck` | Dört paketin tip kontrolü |
| `pnpm --filter @stok/db run generate` | Şema değişikliğinden migration üretir |
| `pnpm --filter @stok/web run build` | Üretim derlemesi |

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
