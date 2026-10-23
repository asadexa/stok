# Teknik şartname — özellik kataloğu

Her özelliğin tek noktadan anlaşıldığı yaşayan katalog: hangi ihtiyacı çözüyor,
nasıl çalışıyor, hangi katmanda ne kullanılıyor, kabul kriterleri ve bilinen
sınırları. Ayrıntıyı tekrar etmez, kaynağı gösterir:

| Ne | Nerede |
|---|---|
| Model, katmanlar, invariant'lar (INV-1…INV-10) | `PROJECT_BRAIN.md` (katmanlar §5) |
| Kararın kendisi ve durumu | `DECISIONS.md` (ID ile) |
| Bugün ne çalışıyor, ne bozuk | `CURRENT_STATE.md` |
| Yapılacak işler | `TODOS.md` (T numarasıyla) |
| Tehdit ve korumalar | `docs/SECURITY_MODEL.md` (S numarasıyla) |

**Durum:** `Planlandı` (karar var, kod yok) · `Geliştiriliyor` · `Uygulandı`.
Uygulanmış bir özelliğin eksikleri "Sınırlar" satırında T numarasıyla durur.
Güncelleme kuralı: `CLAUDE.md` → "Doküman senkronu".

## Ortak teknoloji

| Teknoloji | Nerede | Neden |
|---|---|---|
| TypeScript, pnpm monorepo | `packages/shared`, `db`, `core`, `apps/web` | Web ve planlanan mobil aynı şemaları ve sözlükleri paylaşır |
| Next.js App Router, Server Action | `apps/web` | Tek uygulama, ayrı API sunucusu yok; dış REST yalnız gerektiğinde (`ARC-07`) |
| PostgreSQL 17 | veri | Kural veritabanında da durur: RLS, append-only tetikleyici, CHECK, NUMERIC |
| Drizzle + elle yazılmış SQL migration | `packages/db` | Tipli sorgu; RLS ve tetikleyici gibi ORM'in ifade etmediği kurallar SQL'de |
| zod | `packages/shared` | Aynı doğrulama formda ve sunucuda |
| Vitest (gerçek PostgreSQL), Playwright | testler | Doğruluk veritabanında olduğu için DB mock'lanmaz; arayüz gerçek tarayıcıda |
| Biome | lint | Katman sınırları import kuralıyla zorlanır |
| Docker compose | geliştirme veritabanı | CI ile aynı PostgreSQL sürümü |

Katman kuralları `PROJECT_BRAIN` §5, ilkeler §12. Kayıtlarda yalnız özelliğe özgü teknoloji yazılır.

## Katalog

| ID | Özellik | Durum |
|---|---|---|
| F-01 | Ürün, barkod ve kategori yönetimi | Uygulandı |
| F-02 | Excel/CSV toplu ürün aktarma | Geliştiriliyor (T171: 20.000 satır, UAT bekliyor) |
| F-03 | Stok hareketleri ve append-only defter | Uygulandı |
| F-04 | Fiyat defteri ve kasa açığı | Uygulandı (kısmi) |
| F-05 | Çok kiracılılık ve RLS | Uygulandı |
| F-06 | Giriş, oturum, roller ve kullanıcı yönetimi | Uygulandı |
| F-07 | Panel, stok listesi, kritik stok ve bildirim | Uygulandı |
| F-08 | Raporlar ve Excel dışa aktarma | Uygulandı |
| F-09 | Arka plan işleri, cron, e-posta ve sistem sağlığı | Uygulandı (kısmi) |
| F-10 | Telefonla barkod okutma köprüsü (pilot) | Uygulandı (pilot, varsayılan kapalı) |
| F-11 | Yerel yedek ve güvenli veritabanı sıfırlama | Uygulandı |
| F-14 | Windows tek tıkla başlatma (`BASLAT.bat`) | Uygulandı |
| F-12 | B2B tedarikçi verisi V1 | **Geliştiriliyor** (Dilim 1 bitti, UAT kabul 2026-10-22; Dilim 2 T201'den sonra) |
| F-13 | İnternetten erişilebilir test ortamı | **Planlandı** |

---

## Uygulanan özellikler

### F-01 — Ürün, barkod ve kategori yönetimi
- **İhtiyaç:** ürünü barkodla tanımak; koli ve adet gibi birden çok barkodu tek ürüne bağlamak.
- **Akış:** ürün formu → `core/products.ts` (doğrulama `shared/schemas.ts`) → `withTenant` içinde yazma.
  Barkod türü ve koli çarpanı, harekette miktarı ürünün birimine çevirir.
- **Neden böyle:** USB barkod okuyucu klavye gibi yazar, ürünü barkodla bulmak girişi hızlandırır;
  koli barkodu çarpanla adede çevrildiği için stok tek birimde tutulur.
- **Kararlar:** `DAT-17` (birim hassasiyeti, koli çarpanı); listeler tek kaynaktan (INV-9).
- **Dosyalar:** `packages/core/src/products.ts`, `packages/db/src/schema.ts`, `apps/web/src/app/(panel)/urunler/`.
- **Sınırlar:** yeni üründe barkod zorunlu (T177); görsel yalnız URL (T136); birim değişimi sonrası eski veri denetlenmiyor (T170).

### F-02 — Excel/CSV toplu ürün aktarma (Geliştiriliyor: T171 BUILD bitti, kullanıcı kabul testi bekliyor)
- **İhtiyaç:** ilk kurulumda yüzlerce, büyük işletmede 20.000'e kadar ürünü tek tek girmemek.
- **Akış:** yükle → önizle → aktar (ilerleme, iptal) → sonuç ve rapor.
  - Tarayıcı dosyayı Web Worker'da `parseProductFile` ile okur; dosya sunucuya gitmez.
  - Hücreler parça parça aktarım kaydına gider (`startImportRun`, `appendImportRows`).
  - `finalizeImportPreview` bütün dosya üzerinden `previewImport`'u bir kez çalıştırır: satır
    başına karar, Türkçe sebep, güncellenecek ürünün sürümü. Ürün ve stok verisi yazılmaz.
  - Onaydan sonra (`beginImportRun`) sekme `processImportChunk`'ı ~2 sn'lik parçalarla çağırır;
    her satır `applyRow`: ürün ve barkod, sonra açılış stoğu tek yazma kapısından (`createMovement`).
  - İptal `cancelImportRun`; sonuç ve rapor kayıttan (`importRunReport`,
    `GET /api/rapor/aktarim?kayit=`): hatalı, yazılamayan, çakışan, belirsiz, işlenmeyen satırlar
    ve devir notları.
  - Satır bazlı hata; güncellemede dosyada olmayan sütuna dokunulmaz.
- **Neden böyle:** dosyalar çoğu zaman sütunları kayık ve birimleri karışık gelir; önizleme
  zorunlu, hatalar satır bazlı (tek bozuk satır yüzlerce doğru satırı düşürmesin). Eksik sütun
  "temizle" değil "dokunma": yalnız ad ve kod içeren düzeltme dosyası fiyatları silmesin.
  20.000 satır ve 100 MB tek isteğin gövde ve süre sınırına sığmaz (ADR-007).
- **Kurallar:**
  - En fazla 20.000 veri satırı ve 100 MB; hücre en fazla 1.000 karakter. XLSX'ten yalnız hücre
    verisi açılır (görseller açılmaz); açılan veri 64 MiB'ı aşarsa dosya reddedilir.
  - Belirsiz Türkçe sayı ("1.234") satır hatasıdır; Excel'in sayı hücresi belirsiz değildir (`DAT-20`).
  - Önizlemeden sonra başkası ürünü değiştirdiyse ya da "yeni" satırın stok kodu açıldıysa satır
    `Çakışma` olur; dosyadaki değer yazılmaz.
  - İptal: yeni satır başlamaz, işlenenler geri alınmaz. Aynı sekmeden iptal en geç bir parça sonra.
  - Kesinti: sonucu yazılamamış satır 2 dakika sonra veritabanına bakılarak çözülür; uygulanmadığı
    kanıtlanırsa yeniden denenir, kanıtlanamazsa `Belirsiz`. Aynı dosyayı yeniden yüklemek güvenli
    (`DAT-18`).
  - Aynı aktarımı aynı anda tek işleyici işler; ikinci sekme "işleniyor" yanıtı alır.
  - Aktarım kayıtları 30 gün, yarıda kalmış yüklemeler 24 saat sonra silinir.
- **Teknoloji:** ExcelJS ve JSZip (tarayıcıda; değerler-yalnız çalışma kitabı), kendi CSV
  ayrıştırıcısı, Web Worker; sütun eş adları `COLUMN_ALIASES`. ExcelJS önekli SpreadsheetML'i
  (`<x:workbook>`, .NET Open XML SDK ve ChatGPT çıktısı) okuyamıyor; bu parçaların öneki ExcelJS'ten
  önce JSZip ile atılıyor.
- **Kararlar:** `ARC-15` (ADR-007), `DAT-18` (açılış stoğu), `DAT-20` (belirsiz sayı), `PRC-05`
  (devirde fiyat zorunlu).
- **Dosyalar:** `packages/core/src/product-file.ts`, `sheet.ts` (tarayıcıda da çalışır),
  `import.ts` (önizleme, `applyRow`), `import-runs.ts`; `packages/shared/src/import-runs.ts`;
  `packages/db/migrations/0013_import_runs.sql`; `apps/web/src/app/(panel)/urunler/aktar/`
  (`parse.worker.ts`, `actions.ts`, `wizard.tsx`), `apps/web/src/app/api/rapor/aktarim/route.ts`.
- **Kabul:** önizleme ürün ve stok verisini değiştirmez; bozuk satır diğerlerini düşürmez;
  ≤20.000 satır, ≤100 MB; okuma sırasında sayfa donmaz; ilerleme ve iptal çalışır; tekrar yükleme
  ikinci devri yazmaz; defter = projeksiyon. Ölçümler `CURRENT_STATE`'te.
- **Sınırlar:** sekme kapanırsa aktarım durur, kaldığı yerden devam ekranı yok (ürün kapsamı);
  devirde geçmiş tarihli fiyat yok (T172). Bir satır veritabanında 2 dakikadan uzun takılırsa
  ikinci işleyici onu yeniden deneyebilir: veri bozulmaz, sonucu `Çakışma` görünebilir (ADR-007).

### F-03 — Stok hareketleri ve append-only defter
- **İhtiyaç:** "elimde kaç tane var"dan çok "neden bu kadar": kim, ne zaman, hangi sebeple.
- **Akış:** barkod okuyucu (klavye) → hareket formu → `createMovement` (tek yazma kapısı):
  kilit altında stok kontrolü, idempotency, defter satırı; `current_stock` tetikleyiciyle güncellenir.
- **Neden böyle:** stok bir sayı değil, değiştirilemez defterin toplamı; geçmiş ancak böyle
  sorgulanabilir. Tek yazma kapısı ve DB tetikleyicisi defter ile stoğun ayrışmasını önler;
  satır kilidi eşzamanlı çıkışların stoğu yetkisiz eksiye düşürmesini engeller.
- **Kararlar:** ADR-001; INV-1…INV-6 (`PROJECT_BRAIN` §6, §11).
- **Dosyalar:** `packages/core/src/movements.ts`, `packages/shared/src/reasons.ts`, `apps/web/src/app/(panel)/hareket/`, `hareketler/`.
- **Sınırlar:** düzeltme / ters hareket akışı yok (T127); sayım yok (T155).

### F-04 — Fiyat defteri ve kasa açığı
- **İhtiyaç:** liste fiyatından sapmayı engellemek değil, gizlenemez yapmak.
- **Akış:** liste fiyatı sunucuda üründen okunup harekete dondurulur; sapma sebebi zorunlu
  (DB CHECK); gün sonu raporu açığı kullanıcı bazında toplar. Alış fiyatı çalışana gitmez.
- **Neden böyle:** liste fiyatı istemciden alınmaz ki değiştirilemesin; dondurulur ki ürün sonradan
  zamlansa da geçmiş fark değişmesin. Kural DB'de de durduğu için uygulama hatası atlatamaz.
- **Kararlar:** `PRC-03`, `PRC-05`; INV-7, INV-10; tasarım `docs/designs/fiyat-defteri.md`.
- **Sınırlar:** yenileme maliyeti yok (T90, `PRC-11` Open); fiyat düzenlemesi audit'lenmiyor (T141).

### F-05 — Çok kiracılılık ve RLS
- **İhtiyaç:** bir işletmenin verisi başka işletmeye hiçbir yoldan görünmesin.
- **Akış:** uygulama `stok_app` rolüyle bağlanır; her tabloda FORCE RLS; kiracı bağlamı yalnız `withTenant`.
- **Neden böyle:** kiracı filtresi yalnız uygulama kodunda olsaydı tek unutulan `WHERE` veriyi
  sızdırırdı; RLS'te ayarsız bağlam boş sonuç döner (güvenli varsayılan kapalı taraf).
- **Kararlar:** ADR-002, `PRD-01`, INV-4; tehditler S1, S2, S12.
- **Dosyalar:** `packages/db/src/client.ts`, `packages/db/migrations/`, `db/init/`.
- **Sınırlar:** Supabase fonksiyon yetkileri doğrulanmadı (T124, deploy öncesi).

### F-06 — Giriş, oturum, roller ve kullanıcı yönetimi
- **İhtiyaç:** iki rol (`ADMIN`, `STAFF`); çalışan alış fiyatını ve başkasının hareketini görmez.
- **Akış:** e-posta + parola → scrypt → JWT çifti (httpOnly çerez); yetki sunucuda `requirePermission`.
- **Neden böyle:** 15 dakikalık access token yalnız imzadan doğrulanır (her istekte DB yok);
  refresh her kullanımda DB'den denetlenir: hız ile oturum iptali arasında bilinçli takas.
  Yetki istemciden değil token'dan; arayüzde düğme gizlemek yetki sayılmaz.
- **Kararlar:** `PRD-06`, `SEC-14` (Open); ayrıntı `PROJECT_BRAIN` §9; S5, S6, S9.
- **Dosyalar:** `packages/core/src/auth.ts`, `authz.ts`, `users.ts`, `packages/shared/src/roles.ts`, `apps/web/src/server/session.ts`.
- **Sınırlar:** aynı e-posta birden çok kiracıda (T123); parola kurtarma yok (T163); refresh rotasyonu yok (T134).

### F-07 — Panel, stok listesi, kritik stok ve bildirim
- **İhtiyaç:** "bir sorun var mı?" sorusuna tek bakışta cevap.
- **Akış:** panel uyarılar → bugün → son hareketler; ürün bazlı `min_stock` eşiği; bildirim zili ve e-posta.
- **Neden böyle:** yönetici önce sorunu görmeli, sonra tabloyu; tasarım ilkeleri `PROJECT_BRAIN` §13.
- **Dosyalar:** `apps/web/src/app/(panel)/panel/`, `stok/`, `apps/web/src/components/alert-bell.tsx`.
- **Sınırlar:** push bildirimi yok; tükenme tahmini ertelendi (T179).

### F-08 — Raporlar ve Excel dışa aktarma
- **İhtiyaç:** muhasebeciye ve yöneticiye Excel.
- **Akış:** `core/excel.ts`, `exports.ts`; büyük dışa aktarma iş kuyruğunda. Excel saatleri Europe/Istanbul.
- **Neden böyle:** muhasebeci Excel ile çalışır; hücre saatleri sabit Europe/Istanbul çünkü sunucu UTC
  olabilir. Stok raporunun başlıkları içe aktarmayla uyumlu: rapor düzenlenip geri yüklenebilir.
- **Dosyalar:** `packages/core/src/excel.ts`, `exports.ts`, `apps/web/src/app/(panel)/raporlar/`.
- **Sınırlar:** saat dilimi politikası yok (T122, `DAT-16` Open); büyük export bellekte (T138).

### F-09 — Arka plan işleri, cron, e-posta ve sistem sağlığı
- **İhtiyaç:** sessiz arızayı (defter ayrışması, çürüyen iş, hareketsizlik) görünür kılmak.
- **Akış:** `/api/cron` (`CRON_SECRET`) kiracı başına işleri planlar ve kuyruğu işler; `/api/v1/health`.
- **Neden böyle:** ayrı işçi süreci yok (monolit); iş kuyruğu tabloda, başarısız iş satır olarak
  görünür kalır. Sorun yoksa e-posta gitmez: gürültü yapan alarm, alarmı öldürür.
- **Kararlar:** `OPS-09`, `OPS-02` (Open); `PROJECT_BRAIN` §10; S16.
- **Dosyalar:** `packages/core/src/cron.ts`, `jobs.ts`, `mail.ts`, `health.ts`, `apps/web/src/app/api/cron/`.
- **Sınırlar:** gün sonu raporu yanlış gün (T121); kalıcı FAILED alarmı (T126); harici izleme yok (T129).

### F-10 — Telefonla barkod okutma köprüsü (pilot)
- **İhtiyaç:** USB okuyucu yokken telefon kamerasıyla okutmak.
- **Akış:** QR ile eşleşme; telefon yalnız barkod metnini laptoptaki `/hareket` akışına taşır;
  stok yalnız laptopta Kaydet'le değişir. Oturum süreç belleğinde.
- **Neden böyle:** telefon giriş yapmadan eşleşiyor, bu yüzden yetkisi en dar tutuldu: yalnız barkod
  metni taşır, ürün/fiyat/stok almaz. Süreç belleği ve polling, pilot için DB tablosu ya da
  WebSocket açmadan en basit çalışan yol.
- **Teknoloji:** barcode-detector + zxing-wasm (tarayıcıda); laptop salt okunur polling.
- **Kararlar:** `PRD-12`, `ARC-14`; S18. `ENABLE_PHONE_SCANNER` varsayılan kapalı.
- **Dosyalar:** `apps/web/src/server/scan-sessions.ts`, `apps/web/src/app/api/tara/`, `apps/web/src/app/tara/`.
- **Sınırlar:** yalnız tek süreçli `next start`; çok örnekli dağıtımda kapalı kalmalı (`ARC-14`); tünel bütün uygulamayı açıyor (T167).

### F-11 — Yerel yedek ve güvenli veritabanı sıfırlama
- **İhtiyaç:** geliştirme ve pilot laptopunda veriyi kaybetmeden yedek almak ve sıfırlamak.
- **Akış:** `pnpm db:backup` → doğrulanmış döküm (içindekiler + tam okuma + SHA-256), son 14;
  `--status` durum. `pnpm db:reset` volume adıyla onay ve izole inceleme ister.
- **Neden böyle:** döküm yalnız doğrulamadan sonra son adını alır, yarım döküm "yedek var"
  yanılgısı doğurmasın; `pg_restore --list` kesik arşivi geçirdiği için tam okuma şart. Silme
  geri alınamaz olduğu için reset önce durdurur, sonra izole inceler.
- **Teknoloji:** Docker CLI kabuksuz çağrılır, döküm akışla yazılır (ikili veri bozulmasın).
- **Kararlar:** `OPS-10`, `OPS-11`; S12, S20.
- **Dosyalar:** `packages/db/src/backup.ts`, `backup-policy.ts`, `db-reset.ts`, `docker.ts`, `cli-entry.ts`.
- **Sınırlar:** yalnız yerel Docker; bulut veritabanının yedeği değildir. Geri yükleme tatbikatı (WS-1.4)
  ve zamanlama (WS-1.3b) yok; T190, T197–T199.

### F-14 — Windows tek tıkla başlatma (`BASLAT.bat`)
- **İhtiyaç:** yerel uygulamayı terminal açmadan, çift tıklayarak başlatmak.
- **Akış:** kendi klasörüne geçer → Node 22–24 denetimi → `packageManager`'daki pnpm sürümü yoksa
  `npm install -g` ile kullanıcı hesabına kurar → `pnpm demo` (F-02/F-03'ün veritabanını hazırlar,
  sunucuyu açar) → adres `http://localhost:3000`. Hata olursa Türkçe mesaj, pencere açık kalır,
  çıkış kodu korunur.
- **Neden böyle:** kurulum adımları tek yerde (`scripts/demo.mjs`); başlatıcı yalnız onun
  çalışacağı ortamı denetler. `--seed` ve `db:reset` bilerek yok, ikisi de veri siler. Demo, `.env`
  uzak bir veritabanını gösterirse hiçbir adımı uygulamadan durur.
- **Dosyalar:** `BASLAT.bat`, `scripts/demo.mjs`, `.gitattributes` (`.bat` her checkout'ta CRLF).
- **Sınırlar:** yalnız geliştirme ve demo; gerçek işletme verisi olan bir bilgisayarda yerel
  veritabanına migration uygular (pilot için `OPS-11` geçerli). Docker Desktop ve Node.js
  otomatik kurulmaz; açık değilse demo nedeni yazar.

---

## Planlanan özellikler

### F-12 — B2B tedarikçi verisi V1 (Geliştiriliyor: Dilim 1 bitti ve kabul edildi, Dilim 2 bekliyor)
- **İhtiyaç:** tedarikçilerin ürün, fiyat ve stok bilgisini elle yeniden yazmadan görmek;
  aynı ürün için tedarikçileri güncel fiyat ve stokla karşılaştırmak.
- **Onaylı ürün kararları:** `PRD-14`, `PRD-15`. Özetle: bir ürün birden çok tedarikçiye
  bağlanabilir; yenileme "Verileri Getir" (Önizle → Kaydet) ile; fiyat ve stok değişimleri tek
  tek onaylanmaz; tedarikçi verisi ürün kartının fiyatlarını ve fiziksel stoğu değiştirmez,
  hareket üretmez; V1'de sipariş ve otomatik periyodik senkron yok.
- **Akış:** dosya (.xlsx/.csv ya da JSON sözleşmesi = "örnek API verisi") → `parseSupplierFile`
  (dosya düzeyi kontrol, ham hücreler) → `normalizeSupplierRows` (tedarikçinin varsayılan
  koşulları, satır doğrulaması) → `previewSupplierRefresh` (yenilemenin aynısı, transaction geri
  alınır) → `refreshSupplier` (tedarikçi satırı `FOR UPDATE`; barkodla eşleşme; tek SQL'de fark
  → `supplier_price_changes`, sonra `supplier_items` upsert). Elle eşleştirme `bindSupplierItem` /
  `ignoreSupplierItem`; karşılaştırma `listProductOffers`; ayarlar `updateSupplier`.
- **Ekranlar (yalnız yönetici):** `/tedarikciler` liste ve ekleme. `/tedarikciler/[id]`: ayarlar,
  "Verileri Getir" (dosya → önizleme: okunan ve okunmayan sütunlar, sayılar, ilk 10 satır, hatalı
  satırlar → kaydet), eşleşme bekleyenler (ürün ara → bağla, yok say), son fiyat değişimleri,
  süzgeçli kalem tablosu. Ürün sayfasında "Tedarikçi fiyatları" bölümü: koşul gruplarına göre
  teklifler, belirsiz miktarlılar ayrı.
- **Kurallar:**
  - Dosyanın tamamı reddedilir: başlık yok, zorunlu sütun yok (Ürün Adı, Fiyat ve Tedarikçi
    Kodu ya da Barkod), aynı alana iki sütun, en fazla 5.000 satır aşıldı, veri satırı yok.
    Geçersiz satır yalnız kendisi atlanır ve listelenir. Metin stok satırı reddetmez.
  - Belirsiz Türkçe sayı ("1.234", `DAT-20`): fiyat ya da fiyat miktarında satır hatası, stokta
    satır kalır ve stok boş bırakılıp "belirsiz" notu düşülür. Excel'in sayı hücresi belirsiz değil.
  - Değerler kesilmez: uzun kod, ad, marka ya da barkod o satırda Türkçe hata olur; önizleme ve
    kayıt aynı kuralı (`supplierFeedItemSchema`) kullanır. Okunmayan sütunlardan en fazla 200 ad
    listelenir, 200 karakteri aşan ad "…" ile kısaltılır, kalanın sayısı söylenir
    (`SUPPLIER_IGNORED_COLUMN_LIMIT`, `SUPPLIER_HEADER_LIMIT`; ayrıştırıcı ve kayıt şeması ortak).
  - "Koli İçi Adet" ve "KDV" (oran) sütunları okunmaz; tablo dosyasında tarih okunmaz (`DAT-16`).
  - Otomatik eşleşme yalnız aktif barkod ve arşivlenmemiş ürünle; elle bağlama ve yok sayma
    yenilemede korunur. Fiyat miktarı yalnız açık beyandan; koli barkodu miktar üretmez (`PRD-15`).
  - Dosyada olmayan kalem değişmez ve işaretlenmez; hata olursa hiçbir şey yazılmaz (`DAT-19`).
  - Geçmişte üç tür: fiyat değişimi (yön ve yüzde), koşul değişimi ve miktar belirsiz (ikisinde
    yön ve yüzde yok). Kural veritabanında, üretilen sütunla (ADR-006).
  - Karşılaştırma grubu: para birimi + KDV + fiyat türü + bilinen miktar; "en düşük" yalnız
    birden çok teklifli grupta. Belirsiz miktar ayrı ve sırasız.
  - Göstergelerin zaman sınırı yok: "En düşük fiyat" teklif grubun en ucuzu olduğu sürece görünür;
    artış/azalış rozeti kalemin son değişimini gösterir ve sonraki değişimde güncellenir (kullanıcı
    onayı, UAT 2026-10-22). Ürün sayfasında son değişimin tarihi yok (T215).
  - Tedarikçi ayarlarını düzenlemek yalnız sonraki yenilemeleri etkiler; kalemler ve fiyat
    geçmişi geriye dönük değişmez (`PRD-16`).
  - Önizlenen dosya kayıtta tarayıcıdan geri gönderiliyor. Çözümlenmiş hâli
    `SUPPLIER_SAVE_BLOB_LIMIT`'i (3,5 MB) aşarsa kayıt düğmesi kapanır ve "dosyayı bölün" denir;
    sunucu da aynı sınırı uygular. Ölçüm `CURRENT_STATE`'te.
  - Tedarikçi eylemlerinde beklenmeyen hata içeriği dökülmeden loglanır (`logUnexpected`,
    `safeErrorQuery`; T204).
- **Teknoloji:** F-02'nin dosya okuyucusu (`readSheet`, `normalizeHeader`, `parseTurkishNumber`);
  ayrı sütun eş ad tablosu. Yeni bağımlılık yok. Tedarikçi fiyatı NUMERIC(14,4), metin olarak döner.
- **Kararlar:** `PRD-14`, `PRD-15`, `DAT-19`, ADR-006.
- **Dosyalar:** `packages/shared/src/suppliers.ts`, `schemas.ts`, `roles.ts`
  (`supplier:read`, `supplier:manage`: yalnız yönetici); `packages/db/src/schema.ts`,
  `migrations/0012_suppliers.sql`; `packages/core/src/supplier-feed.ts`, `suppliers.ts`.
  `apps/web`: `app/(panel)/tedarikciler/` (`page.tsx`, `supplier-form.tsx`, `[id]/page.tsx`,
  `[id]/actions.ts`, `[id]/refresh-wizard.tsx`), `app/(panel)/urunler/[id]/supplier-offers.tsx`,
  `components/supplier-price.tsx`, `components/count-tile.tsx`, `server/safe-log.ts`,
  `server/config.ts` (`SUPPLIER_SAVE_BLOB_LIMIT`).
- **Kabul kriterleri:**
  - "Verileri Getir" sonrası tedarikçi fiyatı ve stoğu güncel; değişmeyen fiyat geçmiş satırı üretmez.
  - Değişen fiyatta önceki ve yeni değer ile artış/azalış görünür.
  - Ürün kartının alış/satış fiyatı, `current_stock` ve hareket sayısı değişmez.
  - Para birimi, vergi ya da fiyat türü farklı fiyatlar doğrudan karşılaştırılmaz, ayrı gösterilir.
  - Kiracı izolasyonu (INV-4) korunur; tedarikçi fiyatı alış fiyatı niteliğinde olduğu için
    varsayılan olarak çalışana gitmez (INV-10; aksi ürün kararı ister).
  - Sağlayıcıdan bağımsız model, dosya kaynağı ve örnek API verisiyle doğrulanır.
  - 1a kanıtı: `suppliers.test.ts`, `supplier-feed.test.ts`, `schema-sync.test.ts`,
    `rls.test.ts` (gerçek PostgreSQL, `stok_app`).
  - REVIEW B1/B2 kanıtı: `supplier-feed.test.ts` (CSV, XLSX, JSON: önizleme ile kayıt aynı
    sınıflandırır), `actions.test.ts` (uzun değerli dosya kaydediliyor), e2e "uzun adlı kalemde
    ürün arama" (150 ve 300 karakterlik adda hata ekranı yok).
  - 1b kanıtı: `tedarikciler/[id]/actions.test.ts` (önizleme yazmaz, kayıt, bozuk ya da büyük
    blob, çalışan reddi), `safe-log.test.ts`, `e2e/b2b-tedarikci.spec.ts` (yönetici akışı;
    çalışanın menüsünde, adresinde ve ürün sayfasının HTML'inde tedarikçi fiyatı yok; 390 px'te
    yatay kayma yok).
  - Kullanıcı kabul testi (Dilim 1, 2026-10-20…22, yerel demo kiracısı, kullanıcı elle + salt okunur
    DB doğrulaması): 10/10 senaryo geçti, kanıtlanmış yeni teknik hata yok; Dilim 1 kabul edildi.
    Yukarıdaki kriterler elle sınandı; kiracı izolasyonunda başka kiracının tedarikçi adresi 404, boş
    liste veri katmanında (`stok_app` + RLS) doğrulandı. UAT'de elle denenmeyenler: JSON kaynağı,
    `PRD-16` koşul değişimi, 390 px mobil; kanıtları yukarıdaki otomatik testler. Özet `CURRENT_STATE`.
- **Sınırlar:** tedarikçi arşivleme ve silme yok. Fiyat geçmişinin saklama süresi kararsız.
  Noktalı ama virgülsüz sayı ("1.234") ondalık okunur (F-02 ile aynı `parseTurkishNumber`;
  T205). Önizleme yanıtı ve kayıt isteği blob kadar veri taşıyor (5.000 uzun satırda ~3,6 MB).
  Tam 4 MB'lık dosya genel hata ekranına düşüyor (T208).
- **Açık sorular:** ilk gerçek sağlayıcı (seçilmedi); tedarikçi kataloğundan işletmeye yeni ürün
  açılıp açılmayacağı (V1'de yok); fiyat geçmişinin saklama süresi.
- **İşler ve sıra:** T200 Dilim 1a (çekirdek, `9d4bc8c`) ve 1b (ekranlar, eylemler, e2e,
  `667512a`) bitti, UAT'de kabul edildi (2026-10-22). Sıra (kullanıcı kararı 2026-10-22): T171,
  sonra T201 (gerçek tedarikçi API'si, gizli bilgi; gerçek sağlayıcı seçilmeden genel entegrasyon
  iddia edilmez), sonra Dilim 2 (kod eşitliğinden kullanıcı onaylı eşleşme önerisi, genel
  karşılaştırma listesi, tedarikçi dosyası şablonu indirmenin kapsam değerlendirmesi). UX
  iyileştirmeleri: T210, T212–T215. Sonraki sürüm T202 (B2B sipariş), T203 (otomatik
  periyodik senkron). T53 (bizim sunduğumuz REST) ayrı iştir.

### F-13 — İnternetten erişilebilir test ortamı (Planlandı)
- **İhtiyaç:** uygulamayı localhost dışında, HTTPS ve gerçek bir alan adıyla denemek.
- **Kapsam:** ilk hedef giriş, ürün yükleme (F-02) ve stok hareketlerinin (F-03) çevrim içi çalışması.
- **Kararlar:** `OPS-12` (test ve üretim ayrı; teste gerçek müşteri verisi girmez); barındırma
  seçimi `OPS-01` (Open; aday Vercel + Supabase); kurulum adımları `docs/uretim-runbook.md`.
- **Kabul kriterleri:** HTTPS alan adından giriş, ürün aktarma ve hareket; uygulama `stok_app`
  rolüyle ve RLS altında; yalnız sentetik veri; sağlık ucu 200.
- **Sınırlar ve önkoşullar:** internete açılmadan önce Supabase fonksiyon yetkileri (T124);
  telefon köprüsü çok örnekli dağıtımda kapalı (`ARC-14`); cron planı (`OPS-02`); UTC sunucuda
  gün sınırı kayar (T122); bulut veritabanının yedeği sağlayıcının yedeğidir, yerel `db:backup`
  değildir, tatbikat T129.
- **İşler ve sıra:** T144, B2B V1'in ilk BUILD diliminden sonraki yakın adım (B2B'yi geciktirmez);
  üretim ayrı iş T42.
