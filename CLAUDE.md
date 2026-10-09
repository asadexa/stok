# Stok Takip — Claude çalışma protokolü

Barkod tabanlı, çok kiracılı, append-only defterli Türkçe stok takip sistemi.
Bu dosya bir **yönlendirici ve protokoldür**: tarihçe ya da güncel durum burada
tutulmaz. Her görevde bütün MD'leri baştan okuma; ihtiyacın olanı aç.

## Hangi soruda hangi dosya

| İhtiyaç | Dosya |
|---|---|
| Ürünün amacı, mimari, katmanlar, veri akışları, invariant'lar | `PROJECT_BRAIN.md` |
| Bugün ne çalışıyor, ne bozuk, baseline, aktif iş | `CURRENT_STATE.md` |
| Hâlâ geçerli bir karar (ID'siyle) ya da açık (`Open`) karar | `DECISIONS.md` |
| Bir kararın neden öyle olduğu, elenen yollar | `docs/ADR/` (DECISIONS'taki referanstan) |
| **Güvenlik, kiracı izolasyonu, auth, fiyat gizliliği, yönetim uçları** üzerinde çalışırken | `docs/SECURITY_MODEL.md` (S1–S17; kod yorumlarındaki "tehdit S7") |
| Henüz uygulanmamış bir özelliğin aktif tasarımı | `docs/designs/` |
| Ertelenen işler ve yol boyunca bulunan sorunlar | `TODOS.md` |
| Kurulum, komutlar, ortam değişkenleri | `README.md` |
| Üretime alma adımları | `docs/uretim-runbook.md` |
| Tarihsel gerekçe (T1–T119, eski incelemeler) | `docs/archive/` — **güncel gerçek değildir** |

Kod yorumlarındaki `PLAN.md …` referansları kökteki `PLAN.md` yönlendiricisi
üzerinden arşive gider. Kökteki `PLAN.md`'ye içerik ekleme. Arşivi güncel kaynak
sayma; çelişkide kod ve yaşayan MD'ler kazanır.

## Kırmızı çizgiler

Aşağıdakilere dokunan değişiklikten önce `PROJECT_BRAIN.md` §6–§9 ve §11'i
(INV-1…INV-10) oku; güvenlik/kiracı/auth işiyse `docs/SECURITY_MODEL.md`'yi de.
İhlal gerektiren bir istek gelirse dur ve kullanıcıya sor.

- Defter, projeksiyon ve tek yazma kapısı (INV-1/2/3)
- RLS, `stok_app` ve `withTenant` (INV-4)
- Kilit ve idempotency (INV-5/6)
- Fiyat sapması ve fiyat gizliliği (INV-7/10)
- Kayan nokta yasağı (INV-8)
- Tek kaynaktan üretilen listeler (INV-9)

## Dil

Kod yorumları, commit mesajları, PR gövdeleri ve arayüz metinleri **Türkçe**;
değişken ve fonksiyon adları İngilizce. Yorum ne yapıldığını değil **neden öyle
olduğunu** ve tercih edilmeyen yolun neyi bozacağını anlatır. "Kilidi kontrol
eder" türünden yorum yazılmaz.

## Görev ölçekleme

| Ölçek | Bağlam | Süreç |
|---|---|---|
| **Küçük** (tek dosya, belirgin düzeltme) | Minimum: ilgili dosya + gerekirse CURRENT_STATE | Hedefli test, minimum değişiklik, refactor yok, gstack yok |
| **Orta** (birkaç dosya, bir akış) | İlgili MD bölümleri + ilgili DECISIONS | Kısa Plan Mode; gerekirse Graphify ile etki analizi; gerekirse gstack Engineering Review |
| **Büyük / mimari** (yeni katman, şema, güvenlik modeli, workstream) | PROJECT_BRAIN + ilgili DECISIONS/ADR | Plan Mode; gerekirse Graphify; gstack CEO/Product Review + Engineering Review; UI ağırlıklıysa Design Review |
| **Milestone** (deploy, yayın öncesi) | CURRENT_STATE + runbook | Uygun olduğunda gstack Production / QA / CI review |

- **gstack proje hafızası değildir.** İnceleme çıktısı TODOS'a (iş) ve
  DECISIONS/ADR'ye (karar) işlenir; ayrı bir rapor dosyası birikmez.
- **Graphify proje hafızası değildir.** Yalnız kod keşfi ve etki analizi içindir.

## Doğrulama standardı

Varsayılan akış:

```
anla → ölç / yeniden üret → planla → minimum implementasyon → hedefli doğrulama
→ gereken geniş testler → doküman senkronu → diff incelemesi → KULLANICI ONAYI
→ commit / push → CI
```

- Güvenlik, auth, kiracı izolasyonu, invariant, para ya da kritik doğrulama
  koruması eklendiyse **`dogrula`**: korumayı kaldır, kırmızıyı gör, geri koy.
- UI değiştiyse **gerçek tarayıcı**: `demo-testi` (Playwright ya da ajan tarayıcısı).
- DB davranışıysa mümkün olduğunca **gerçek PostgreSQL**; DB mock'lanmaz.
- Test yeşil diye korumanın çalıştığını varsayma.
- Kararsız görünen bir testi kapı dışına almadan önce arızanın kendisinin
  olasılıksal olabileceğini araştır: bu projede "kararsız test" bir ürün hatası
  çıktı (T109). E2E'de `retries: 0` bilinçli.
- Fırsatçı refactor yapma; görev dışı bulguyu `gorev-kaydet` ile TODOS'a yaz ve devam et.
- **Commit ve push için kullanıcı onayı bekle.** Onay bir eyleme özgüdür, sonrakilere taşınmaz.

**"Bitti" demeden önce** (hepsi yeşil olmalı):

```bash
pnpm lint
pnpm typecheck
pnpm test                                          # gerçek PG; stok_test_* DB'lerini yeniden kurar
pnpm --filter @stok/db exec drizzle-kit generate   # "No schema changes" yazmalı, dosya üretmemeli
pnpm --filter @stok/web run build
pnpm --filter @stok/web run test:e2e               # UI değiştiyse; önce build, port 3000 boş olmalı
```

- Drift kontrolü fail-closed: yalnız çıkış koduna güvenme; "No schema changes" satırına ve `git status`'a birlikte bak, CI da böyle yapıyor. Hatada 0 dönme gözlemi 2026-10-09'da yeniden üretilemedi (T131).
- E2E demo veritabanına yazar (T150).

## Doküman senkronu

Değişiklik bitince yalnız etkilenen dosyayı güncelle:

- **CURRENT_STATE**: durum, baseline ya da blocker değiştiyse.
- **TODOS**: iş kapandıysa `[x]` + kanıt; yeni iş bulunduysa `gorev-kaydet`.
- **DECISIONS**: bir karar verildiyse ya da değiştiyse. Eski satır `Superseded`
  olur, silinmez.
- **DECISIONS ölçütü**: yalnız yokluğunda pahalı bir yanlış karar verilebilecek
  uzun ömürlü kararlar. Kodda gerekçesiyle yazılı düşük seviyeli tercihler oraya
  girmez.
- **ADR**: yalnız uzun ömürlü, mimariyi etkileyen, değiştirmesi pahalı ve gerçek
  alternatifi olan kararlar için (`docs/ADR/README.md`).
- **SECURITY_MODEL**: bir koruma eklendiyse ya da bir açık kapandıysa ilgili S satırı.
- **docs/designs/**: tasarımı uygulanıp ilgili görevler kapanınca `docs/archive/`'a taşınır.
- **PROJECT_BRAIN**: yalnız model değiştiğinde.

Aynı bilgiyi iki yaşayan dosyaya kopyalama; ID ile referans ver.

## Skill'ler (`.claude/skills/`)

- **`dogrula`**: bir korumanın gerçekten iş yaptığını kanıtlar.
- **`demo-testi`**: UI ve kurulum yolunu gerçek tarayıcıda sürer.
- **`gorev-kaydet`**: bulguyu `TODOS.md`'ye numaralı görev olarak yazar.

## Windows tuzakları (yaşandı, tekrar etmesin)

- `pnpm --filter X <script>` değil, **`pnpm --filter X run <script>`**: `run`
  olmadan pnpm ilk kelimeyi çalıştırılabilir sayıyor (CI'da
  `scripts/check-pnpm-filter.mjs` tarıyor).
- Kurulum adımı yazacaksan **bash varsayma**; `scripts/*.mjs` kullan. Doküman
  komutlarında `VAR=… komut` söz dizimi PowerShell'de çalışmaz.
- **Açık port "hazır" demek değil**: `scripts/wait-for-db.mjs` kullan.
- Ortamı hazırlamak **scriptin değil uygulamanın işi**; `apps/web` kök `.env`'i
  kendisi yüklüyor (`next.config.ts`).

## gstack

Kuruluysa: web'de gezinme için `/browse` kullan, `mcp__claude-in-chrome__*`
araçlarını kullanma. Kurulum makineye yapılır (`~/.claude/skills/gstack` +
`./setup`), depoya dosya kopyalanarak DEĞİL: o yol yüklenmiyor.
