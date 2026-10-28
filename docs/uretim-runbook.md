# Üretim runbook'u — Vercel + Supabase

Bu dosya deneme yanılmayla bulunacak şeyleri yazıyor. Yanlış rolle **bir
kez** bağlanmak tenant izolasyonunu kapatıyor ve kimse fark etmiyor; o
yüzden sıra ve gerekçeler burada.

Kaynak (tarihsel): `docs/archive/PLAN-2026-09.md` Bölüm 9 (dağıtım) ve "T42
ÜRETİME HAZIRLIK DENETİMİ". Bu dosyadaki "PLAN" göndermeleri o arşivi gösterir.

> **Üretime çıkmadan önce:** `TODOS.md` → T42'nin önkoşulları kapanmalı. Bu
> runbook'ta henüz yazılı olmayan bilinen eksikler:
> - Supabase'te `anon`/`authenticated` fonksiyon yetkileri ve pooler kullanıcı adı biçimi (T124)
> - Saat dilimi (T122)
> - Komutlar POSIX `VAR=… komut` söz dizimiyle yazılı; PowerShell'de
>   `$env:VAR="…"; pnpm …` (T143)

**İki yol var.** Aşağıdaki "L" bölümü kendi sunucumuzda Docker Compose (AWS
Lightsail staging, T144 / `OPS-12`; S1). §0–§7 Vercel + Supabase yolu. Barındırma
kararı `OPS-01` hâlâ Open; L bölümü yalnız **sentetik veriyle staging** için
doğrulandı, gerçek müşteri verisi için değil (önkoşullar T42, T129).

---

## L. Lightsail + Docker Compose (staging)

Dosyalar: `Dockerfile` (hedefler `runtime` ve `tools`), `compose.production.yml`,
`db/production/005-app-role.sh`, `.env.production.example`. Sunucuda dizin
`/opt/citech/stok`; Caddy/HTTPS ayrı iş (S4).

### L.0 Nasıl çalışıyor

| Servis | Ne | Ağ | Dışarı port |
|---|---|---|---|
| `db` | PostgreSQL 17.11 (alpine), volume `stok-prod_pgdata` | `internal` (internete çıkışı yok) | yok |
| `web` | `next start`, `node` kullanıcısı, yalnız üretim bağımlılıkları | `internal` + `citech-proxy` (takma ad `stok-web`) | yok; Caddy `stok-web:3000`'e gider |
| `tools` | migration, `db:init`, `tenant:create`; `up` ile başlamaz (profil) | `internal` | yok |

- **Roller:** `web` yalnız `stok_app` parolasını görür (`DATABASE_URL`). Sahip
  rolünün (`postgres`) parolası yalnız `tools`'a gider (`MIGRATION_DATABASE_URL`).
  Migration açılışta OTOMATİK KOŞMAZ: her açılışta RLS'i atlayan rolün parolası
  uygulamada olurdu, aynı anda açılan iki konteyner aynı migration'ı iki kez
  denerdi (§2'deki gerekçe).
- **`stok_app` parolası:** veri dizini boşken `005-app-role.sh` rolü
  `.env.production`'daki parolayla yaratır; ardından `01-roles.sql` yalnız
  yetkileri uygular (§1'in konteyner hali). Kurulum betiği yarıda kalırsa
  volume yarım kalır: o yeni ve boş volume'ü silip baştan kurmak gerekir.
- **Kapalı olanlar:** telefon tarayıcısı compose'da sabit `false` (T167,
  `ARC-14`); cron zamanlayıcısı kurulmadı (T112, L.4).
- **Saat dilimi:** konteynerler UTC. Ekran saatleri ve gün sınırları UTC'ye
  göre (T122, `DAT-16` Open); S1 doğrulamasında stok listesindeki saat UTC göründü.
- **Konteyner içi `trust`:** postgres imajı konteynerin İÇİNDEN (`127.0.0.1`,
  soket) parolasız girişe izin veriyor; ağdan gelen bağlantı `scram-sha-256`
  ister. `docker exec` yetkisi olan zaten sunucuda root'tur.

### L.1 Kaynak sınırları (4 GB / 2 vCPU, Dosya Sistemi ve Caddy ile ortak)

| Servis | Sınır | Gerekçe |
|---|---|---|
| `web` | `mem_limit: 1g`, `cpus: 1.5`, V8 yığını 640 MB | Ölçülen (S1, yerel konteyner): boşta 108 MiB, 400 `/giris` isteğinden sonra 126 MiB. Referans: 20.000 satırlık devirli aktarımda ölçüm sürecinin tepe belleği 417 MiB (T171, 2026-10-23; konteyner değil, core doğrudan). Yığın sınırı konteyner sınırının altında: aşılırsa açık "heap out of memory" hatası verir; konteyner sınırı aşılırsa çekirdek süreci iz bırakmadan öldürür |
| `db` | `mem_limit: 768m`, `cpus: 1.0` | Ölçülen: boşta 45 MiB. Varsayılan `shared_buffers` 128 MB ve en çok 10 uygulama bağlantısı (`DB_POOL_MAX` varsayılanı); ayar değiştirilmedi |
| `tools` | `mem_limit: 1g` | Yalnız bakım sırasında kısa süre çalışır |

Bütçe (tahmin, sunucuda ölçülmedi): Stok 1,75 GiB + Dosya Sistemi (S2) ~1,25 GiB +
Caddy ~0,1 GiB + işletim sistemi ~0,6 GiB ≈ 3,7 GiB. Sunucuda **2 GB swap** açılması
önerilir. 20.000 satırlık aktarımın konteyner sınırları içindeki belleği ve CPU
süresi ölçülmedi: ilk staging'de `docker stats` ile izlenir.

### L.2 İlk kurulum

Önkoşullar: Docker Engine + Compose v2, `git`, `openssl`; DNS ve Caddy (S4) bu
adımlar için gerekmiyor.

```bash
# 1) Ortak proxy ağı (sunucuda bir kez; Caddy de buna bağlanacak)
docker network create citech-proxy

# 2) Kaynak: dağıtılacak commit'i açıkça seç
git clone https://github.com/asadexa/stok.git /opt/citech/stok
cd /opt/citech/stok
git checkout <commit>

# 3) Gizli değerler
cp .env.production.example .env.production
chmod 600 .env.production
#    POSTGRES_PASSWORD ve STOK_APP_DB_PASSWORD: openssl rand -hex 32
#    AUTH_SECRET: openssl rand -base64 32 · APP_URL: https://<alan-adi>

# 4) Kısaltma (aşağıdaki bütün komutlar bununla)
alias stokc='docker compose -f compose.production.yml --env-file .env.production'

# 5) İmajlar
stokc --profile tools build

# 6) Veritabanı (boş volume'de rol ve eklentiler kendiliğinden kurulur)
stokc up -d db
stokc ps db                     # "healthy" olmalı

# 7) Migration (sahip rolüyle, tek seferlik konteynerde)
stokc run --rm tools pnpm --filter @stok/db run migrate

# 8) Rolü doğrula: üçü de f
stokc exec db psql -U postgres -d stok -Atc \
  "select rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname='stok_app'"

# 9) Uygulama
stokc up -d web
stokc ps web                    # "healthy" olmalı (sağlık ucu veritabanına dokunur)

# 10) İlk işletme ve yönetici: ETKİLEŞİMLİ terminal gerekir (-it)
stokc run --rm -it tools pnpm --filter @stok/db run tenant:create
```

- **`tenant:create` ancak `-it` ile çalışır.** Girdi boru ile verilirse
  (`printf … |`) readline kapanıp `ERR_USE_AFTER_CLOSE` ile düşüyor (S1'de ölçüldü).
  Hedef `db:5432/stok (UZAK)` olarak görünür; bu beklenen davranış.
- **Sunucuda derleme yerine** (bellek dar ya da ağ kısıtlıysa): imajları başka
  makinede `linux/amd64` için derleyip taşı. `build` adımı atlanır; compose imaj
  varsa onu kullanır.

```bash
docker save stok-web:<etiket> stok-tools:<etiket> | gzip > stok-<etiket>.tar.gz
# sunucuda:
gunzip -c stok-<etiket>.tar.gz | docker load    # .env.production'da STOK_IMAGE_TAG=<etiket>
```

### L.3 Sürüm güncellemesi

```bash
cd /opt/citech/stok
git fetch && git checkout <yeni-commit>
# STOK_IMAGE_TAG'ı yeni commit'e çek: eski imaj geri dönüş için yerinde kalır
stokc --profile tools build
# Önce yedek (S6 zamanlanmış yedeği kurulana kadar elle; dizin repo dışında):
stokc exec -T db pg_dump -U postgres -Fc stok > /opt/citech/yedek/stok-$(date +%Y%m%d-%H%M).dump
stokc run --rm tools pnpm --filter @stok/db run migrate
stokc up -d web
```

- §2'deki geriye uyumluluk kuralı geçerli: migration'lar yalnız ekleme yapar; eski
  `web` imajı yeni şemayla çalışabilmeli.
- **Web'i geri alma:** `.env.production`'da `STOK_IMAGE_TAG`'ı önceki etikete
  çevir, `stokc up -d web`. Şema geri alınmaz (§7).
- `db/init` değişirse (nadir): `stokc run --rm tools pnpm --filter @stok/db run init`
  (idempotent).
- **Elle alınan döküm, doğrulanmış yedek değildir.** Geri yükleme tatbikatı yapılmadı
  (T129, WS-1.4); gerçek veriden önce zorunlu.

### L.4 Henüz yok (sonraki işler)

- Caddy ve HTTPS (S4): `citech-proxy` ağı üzerinden `stok-web:3000`'e ters vekil. Servis
  adı `web` değil takma ad kullanılır: ortak ağda başka bir projenin `web` servisi olursa
  `web` iki konteynere çözülür. Diğer projeler de bu ağda benzersiz bir takma ad
  kullanmalı (ör. Dosya Sistemi için `dosya-api`). Dışarıdan
  yalnız 80/443. Caddy güvenmediği istemcinin `X-Forwarded-For` başlığını eziyor; giriş
  sayacı bu başlığın ilk değerine bakıyor (`giris/page.tsx`). Bu yüzden `web`'in portu
  hiçbir zaman dışarı yayınlanmaz. Gövde sınırı: Server Action sınırı 4 MiB
  (`MAX_UPLOAD_BYTES`). Caddy'nin sınırı bundan küçük olmamalı.
- Cron (T112): saatlik `POST /api/cron`, `CRON_SECRET` ile (§5'teki `curl` örneği),
  Caddy kurulduktan sonra host crontab'ından.
- Zamanlanmış ve sunucu dışına kopyalanan yedek ve geri yükleme tatbikatı (S6, T129).
- Harici uptime izleme (T129).

---

## 0. Önce bilinmesi gerekenler

| Şey | Değer | Neden |
|---|---|---|
| Node | `.nvmrc` → 22 | CI de 22; geliştirme makinesi 24'te olabilir |
| Paket yöneticisi | pnpm 11 (`packageManager` alanı) | corepack otomatik seçer |
| Vercel Root Directory | `apps/web` | Next uygulaması orada, `vercel.json` da |
| Cron planı | **Vercel Pro gerekiyor** | Hobby günde bir cron veriyor; bkz. Bölüm 5 |

---

## 1. Supabase: `stok_app` rolü (İLK ADIM, migration'dan ÖNCE)

`db/init/01-roles.sql` yalnızca yerel Docker konteynerinin ilk açılışında
ve test veritabanı kurulurken çalışıyor. **Supabase'de otomatik koşan
hiçbir şey yok.**

Neden önemli: uygulama `postgres` rolüyle bağlanırsa o rol tabloların
SAHİBİ olur ve kendi tablolarında RLS'i atlar. Tek kiracıyla test ederken
bu asla fark edilmez; ikinci müşteri geldiğinde A müşterisi B'nin verisini
görür (D5, `docs/ADR/002`).

**Sıra önemli.** `01-roles.sql` rolü `IF NOT EXISTS` ile koruyor ve yerel
geliştirme şifresiyle (`stok_app_dev`) yaratıyor. Rolü önce KENDİN güçlü
bir şifreyle yarat ki script onu atlasın ve yalnızca yetkileri uygulasın:

```sql
-- Supabase SQL Editor'de, postgres rolüyle:
CREATE ROLE stok_app LOGIN PASSWORD '<openssl rand -base64 24 çıktısı>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
```

Sonra yetkileri uygula (uzak veritabanına karşı, sahip bağlantısıyla):

```bash
MIGRATION_DATABASE_URL="postgresql://postgres:...@...supabase.co:5432/postgres" \
  pnpm --filter @stok/db run init
```

Bu komut `00-extensions.sql` ve `01-roles.sql` dosyalarını uyguluyor;
üçü de idempotent, tekrar koşturmak güvenli.

**Doğrula** — rol gerçekten kısıtlı mı:

```sql
SELECT rolsuper, rolbypassrls, rolcreatedb FROM pg_roles WHERE rolname = 'stok_app';
-- üçü de false olmalı
```

---

## 2. Migration

**Vercel build adımında ÇALIŞTIRMA.** İki sebep: build'in veritabanına
erişimi olmayabilir, ve eşzamanlı iki build aynı migration'ı iki kez
dener.

Kendi makinenden, web deploy'undan **önce**:

```bash
MIGRATION_DATABASE_URL="postgresql://postgres:...@...supabase.co:5432/postgres" \
  pnpm --filter @stok/db run migrate
```

Bağlantı **5432** (doğrudan), 6543 değil: pooler transaction modunda DDL
sorunlu.

PLAN Bölüm 9'daki sıra: **1.** DB migration (sadece additive) → **2.** web
deploy → **3.** mobil sürüm.

### Geriye uyumluluk kuralı

Deploy anında eski ve yeni kod **aynı anda** çalışıyor. Kolon silme, tip
değiştirme ve `NOT NULL` ekleme ayrı sürümde ve iki aşamada.

Bu bir tercih değil zorunluluk: drizzle-kit `down` migration üretmiyor,
yani şema geri alınamıyor (Bölüm 6).

> `0009_price_ledger.sql` bu kuralı çiğniyor (`RENAME COLUMN`). İlk
> deploy'da zararsız — boş veritabanına hepsi birden koşuyor — ama kuralın
> çiğnenebildiğini gösteriyor ve bunu yakalayan otomatik bir kontrol yok.

### İlk işletme ve yöneticisi (T162)

Migration'daki aynı `MIGRATION_DATABASE_URL` tanımlıyken, kendi makinenden:

```bash
pnpm tenant:create
```

Yazmadan önce hedefi (`host:port/veritabanı`, YEREL/UZAK) ve mevcut işletme
sayısını gösterir; **hedefi kontrol et**, "evet" yazılmadan hiçbir şey yazılmaz.
Parola üretilir ve yalnız bir kez gösterilir; yöneticiye güvenli bir yoldan ilet,
ilk girişten sonra Ayarlar → Parola'dan değiştirsin. Başka işletmede kayıtlı bir
e-posta reddedilir (geçici kural, `SEC-14`).

`pnpm seed` / `pnpm demo --seed` uzak hedefte hiçbir bayrakla çalışmaz (T125);
üretime örnek veri yüklemenin yolu yok, olmamalı.

---

## 3. Vercel ortam değişkenleri

| Değişken | Zorunlu | Not |
|---|---|---|
| `DATABASE_URL` | evet | `stok_app` rolü, **port 6543** (transaction pooler) |
| `AUTH_SECRET` | evet | en az 32 karakter; üretme komutu `.env.example`'da. `.env.example` ve CI'daki örnek değerlerle açılmaz (T133) |
| `APP_URL` | evet | `https://` ile; çerez `Secure` bayrağı buradan türüyor |
| `CRON_SECRET` | evet | en az 32 karakter; adı TAM böyle olmalı (Bölüm 5) |
| `SMTP_URL` | rapor için | yoksa tur çalışır, e-posta gönderim anında hata verir |
| `REPORT_FROM_EMAIL` | rapor için | |
| `DB_POOL_MAX` | önerilir | `1`–`3`. Varsayılan 10 ve her fonksiyon örneği kendi havuzunu açıyor |
| `DB_IDLE_TIMEOUT` | önerilir | saniye, örn. `20`. Varsayılan 0 = hiç kapatma |
| `MIGRATION_DATABASE_URL` | **HAYIR** | **Vercel'e KOYMA.** O rol RLS'i atlıyor; runtime'da bulunması, uygulama kodunun yanlışlıkla sahip rolüne bağlanabilmesi demek |

`DATABASE_URL` neden 6543: pgbouncer transaction modu. Sürücü zaten
`prepare: false` ile açılıyor (PLAN D-1.4).

Eksik `DATABASE_URL` ya da eksik / örnek `AUTH_SECRET` ile deploy **açılışta** patlıyor
ve ne eksik olduğunu Vercel loglarına yazıyor (T116). Sessizce ilk giriş
denemesine ertelenmiyor.

---

## 4. Vercel proje ayarları

- **Root Directory:** `apps/web`
- **Framework Preset:** Next.js
- Build ve install komutlarına dokunma: pnpm workspace'i Vercel kendi
  algılıyor.
- `apps/web/vercel.json` cron girdisini ve `maxDuration`'ı taşıyor; panodan
  ayrıca cron tanımlama.

---

## 5. Cron (T112)

`vercel.json` `/api/cron` yolunu **saatlik** çağırıyor.

- **Vercel GET atıyor** ve metot seçilemiyor; uç bu yüzden hem `GET` hem
  `POST` kabul ediyor (T115).
- **`CRON_SECRET` adı tam böyle olmalı:** Vercel bu adda bir değişken
  varsa isteğe `Authorization: Bearer <değer>` başlığını **kendisi**
  ekliyor. Uçtaki doğrulama olduğu gibi çalışıyor.
- **Saatlik, çünkü** `HEALTH_ALARM` dedupe anahtarı saat içeriyor. Günlük
  bir zamanlayıcıda alarm sınıfı ölü doğar: sabah bakılır, gün içinde bir
  daha bakılmaz.
- **Hobby planı yetmiyor** (günde bir cron). Seçenekler: Vercel Pro, ya da
  Vercel Cron'u kullanmayıp harici bir zamanlayıcı:

```bash
# systemd timer ya da crontab, saat başı:
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://<alan-adi>/api/cron
```

Elle tetiklerken `POST` kullan: tur yan etkili ve doğru metot o.

---

## 6. Deploy sonrası ilk 5 dakika

PLAN Bölüm 9'daki liste, çalıştırılabilir hali:

1. **Sağlık** — `curl -i https://<alan-adi>/api/v1/health` → `200` ve
   `{"status":"ok"}`. `503` gelirse uygulama ayakta ama veritabanına
   ulaşamıyor: önce `DATABASE_URL`, sonra Supabase bağlantı sınırı.
2. **Bir test hareketi** — panelden giriş yap, `/hareket` ekranından bir
   giriş yaz, `/hareketler`de defterde gör, `/stok`ta projeksiyonun
   değiştiğini doğrula. Üçü birden olmalı: yalnızca defter yazıldıysa
   trigger çalışmıyor demektir.
3. **Excel export** — `/raporlar`dan indir, aç, **Türkçe karakterlere bak**
   (ş, ğ, İ, ı). Bozulma burada görünür (G2).
4. **Mobil okutma** — *henüz yapılamıyor*, mobil yazılmadı (Faz 5).
5. **Hata oranı** — Vercel panelinde fonksiyon hata grafiği düz mü.

Ek: `CRON_SECRET` kuruluysa bir sonraki saat başını bekleyip
`/saglik` kartında kuyruğun işlendiğini gör. Gün sonu raporunun
gelmemesi hiçbir yerde alarm üretmiyor (G4), tek kontrol bu.

---

## 7. Geri alma

### Web — çalışıyor

Vercel panelinde önceki deployment → **Promote to Production**. Saniyeler
içinde, ek bir hazırlık gerekmiyor.

### Veritabanı — YOK

drizzle-kit `down` migration üretmiyor. Şemayı geri almanın desteklenen
bir yolu yok.

Pratik sonucu: **migration'lar ileri uyumlu olmak zorunda.** Web'i geri
alınca şema ileride kalıyor ve eski kodun onunla çalışabilmesi gerekiyor.
Additive kuralı (Bölüm 2) bunu garanti eden tek şey.

Gerçekten geri alınması gereken bir şema değişikliği olursa: **ileri
giden** yeni bir migration yaz (eklediğini geri ekleyen), aşağı inen
değil.

### Yedek

Supabase otomatik yedek alıyor; plan seviyesine göre saklama süresi
değişiyor. **Geri yükleme tatbikatı yapılmadı** — ilk gerçek müşteriden
önce bir kez denenmeli, yoksa yedeğin çalıştığı yalnızca varsayım.
