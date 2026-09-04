# Stok Takip — Claude için proje notları

Depo stok takip sistemi. Türkçe arayüz, çok kiracılı, **append-only stok
defteri**. Ürün kararları ve gerekçeleri `PLAN.md` içinde — kod hakkında
bir karar vermeden önce oraya bak.

## Çalıştırma

```bash
pnpm demo          # her şeyi kurar ve sunucuyu açar
pnpm demo --seed   # veriyi sıfırlayıp yeniden yükler
```

Windows, macOS ve Linux'ta aynı komut. Docker zorunlu değil: 5433
portunda kendi PostgreSQL'in varsa o kullanılır.

Hesaplar ve neyin **henüz denenemeyeceği** README.md → "Demo".

## Dil

**Kod yorumları, commit mesajları, PR gövdeleri ve arayüz metinleri
Türkçe.** Değişken ve fonksiyon adları İngilizce kalıyor.

Yorum **ne yaptığını değil neden öyle olduğunu** anlatır — ve tercih
edilmeyen yolun neyi bozacağını söyler. Örnek:

```ts
// Kilit kontrolü EN BAŞTA: scrypt her denemede ~100 ms CPU yiyor ve
// sayaç sonradan bakılsaydı kilitli bir hesap bile saldırganın
// sunucuyu yormasına izin verirdi (T51, tehdit S9).
```

"Kilidi kontrol eder" yazan bir yorum silinmeli.

## Mimarinin değişmeyen kuralları

- **`createMovement()` stoğu değiştiren TEK fonksiyon.** Başka hiçbir yer
  `stock_movements` tablosuna yazmaz. Test kurulumu için istisna:
  `seedOpeningStock`.
- **Defter append-only.** `UPDATE`/`DELETE` veritabanı seviyesinde geri
  alınmış; admin bile değiştiremez.
- **`current_stock` bir projeksiyon**, kaynak değil. Trigger yazıyor.
  Invariant: `SUM(delta) == current_stock.qty`.
- **RLS'e `stok_app` rolüyle bağlanılıyor** — sahip değil, superuser
  değil, BYPASSRLS yok. `postgres` rolü yalnızca migration çalıştırır.
- **Miktar `NUMERIC(14,3)`, ölçekli `bigint` aritmetiğiyle.** Kayan nokta
  yok: `0.1 + 0.2 !== 0.3` invariant'ı kırar.
- **Yetki kararı sunucuda.** Fiyat gizleme rolden değil CEVAPTAN türüyor;
  ekran rolü ikinci kez yorumlamaz.

## Tasarım

`PLAN.md` Bölüm 11 bağlayıcı. Özet: **grafik yok**, okunaklı tablo ve
büyük net sayı var. Minimum 56 px dokunma hedefi (eldiven var). Renk tek
başına anlam taşımaz — renk + ikon + metin.

Tasarım belirteçleri ve bileşen ölçüleri `design/` altında; değerler
`apps/web/src/app/globals.css` ve `components/field.tsx` dosyalarından
alınmış, uydurulmamış.

## Çalışma disiplini

`.claude/skills/` altında üç skill var, işi yaparken onları kullan:

- **`dogrula`** — koruma yazdıysan geçici olarak kaldır, testin kırmızı
  yandığını gör, geri koy. Yeşil test tek başına hiçbir şey ispat etmez.
- **`demo-testi`** — arayüz değiştiyse gerçek tarayıcıda sür. Bu projede
  kullanıcıya görünen dört hata yalnızca böyle bulundu.
- **`gorev-kaydet`** — bulguyu sohbette bırakma, `PLAN.md`'ye numaralı
  görev yaz.

## Bitmiş sayılma ölçütü

Hepsi yeşil olmadan "çalışıyor" deme:

```bash
pnpm typecheck
pnpm test
pnpm --filter @stok/db exec drizzle-kit generate   # migration üretmemeli
pnpm --filter @stok/web run build
```

Testlerin çoğu **gerçek PostgreSQL** istiyor; bu bilinçli, doğruluğun
büyük kısmı veritabanında duruyor.

## Windows tuzakları (yaşandı, tekrar etmesin)

- `pnpm --filter X <script>` değil, **`pnpm --filter X run <script>`** —
  `run` olmadan pnpm ilk kelimeyi çalıştırılabilir sayıyor.
- Kurulum adımı yazacaksan **bash varsayma**; `scripts/*.mjs` kullan.
- **Açık port "hazır" demek değil** — Docker portu konteyner başlar
  başlamaz yayınlıyor. `scripts/wait-for-db.mjs` kullan.
- Ortamı hazırlamak **scriptin değil uygulamanın işi**; `apps/web` kök
  `.env`'i kendisi yüklüyor (`next.config.ts`).

## Nerede kaldık

Faz 0–4 bitti (T1–T25), artı T34/T35/T36/T37/T38/T39/T40/T41/T44/T46/T47/
T50/T51/T52/T54/T55/T56/T88/T88.1/T89/T93/T94/T105/T107/T109/T111/T113 ve
CI. **663 birim testi + 21 tarayıcı testi yeşil.**

Cron turu (T34) `POST /api/cron` ucundan çalışıyor: `CRON_SECRET` sırrıyla,
her tenant için planla → kuyruğu işle → bakım. **Ucu VURAN zamanlayıcı
henüz yok** (T112, T42'ye bağlı) — kurulmadan gün sonu raporu çıkmaz.

**T42 üretime hazırlık denetimi yapıldı (deploy YAPILMADI):** 5 BLOCKER,
4 WARNING, 1 READY. Sonuçlar ve en küçük değişiklik seti PLAN.md →
"T42 ÜRETİME HAZIRLIK DENETİMİ" ve T114-T119'da. Öne çıkanlar:
`vercel.json` yok, `/api/v1/health` yok, Vercel Cron GET atıyor ama uç
POST-only, `assertServerConfig()` Vercel'de hiç koşmuyor.

**Next 16 + Turbopack** (T105). Paket içi importlar uzantısız; `next.config.ts`
içinde `webpack()` kancası YOK, geri koyma. `agentRules: false` bilerek:
`apps/web/CLAUDE.md` üretilmesini engelliyor.

Sıradaki işler `PLAN.md`'de numaralı duruyor:

**Mobil dışı, engelsiz iş KALMADI.** Açık duran her şey ya kullanıcının
kararını ya başka bir görevi bekliyor:

| Görev | Neyi bekliyor |
|---|---|
| **T42/T43** | Kullanıcı "bir sonraki adım" dedi — deploy hattı |
| **T114-T119** | T42 denetiminden çıktı; deploy'u bloke ediyorlar |
| **T112** | T42 (zamanlayıcı kurulmadan gün sonu raporu çıkmaz) |
| **T106** | Kullanıcı kararı: 56 px kuralı mı kod mu düzelecek |
| **T108** | Ölçüm: fire girişinde fiyat alanı gerçekten sorun mu |
| **T110** | Kullanıcı cevabı: depodaki Android'ler gerçekten JS'siz mi |
| **T90/T91** | Kullanıcı gözlemi + Yİ-ÜFE verisi |
| **T78** | U2 (maliyet yöntemi) kararı — bkz. `docs/ADR/004` |
| **T16** | E5 (etiket basma), v1 kapsamı dışında |
| **T53 + T26–T33, T48, T49** | Mobil — kullanıcı EN SON dedi |

## gstack

Kurulduysa: web'de gezinme için `/browse` kullan, `mcp__claude-in-chrome__*`
araçlarını kullanma. Skill'ler: /office-hours, /plan-ceo-review,
/plan-eng-review, /plan-design-review, /design-consultation,
/design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary,
/benchmark, /browse, /qa, /qa-only, /design-review, /setup-browser-cookies,
/setup-deploy, /retro, /investigate, /document-release, /document-generate,
/codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful,
/freeze, /guard, /unfreeze, /gstack-upgrade, /learn.

Kurulum makineye yapılır (`~/.claude/skills/gstack` + `./setup`), depoya
dosya kopyalanarak DEĞİL — o yol yüklenmiyor.
