# Üretim runbook'u — Vercel + Supabase

Bu dosya deneme yanılmayla bulunacak şeyleri yazıyor. Yanlış rolle **bir
kez** bağlanmak tenant izolasyonunu kapatıyor ve kimse fark etmiyor; o
yüzden sıra ve gerekçeler burada.

Kaynak: `PLAN.md` Bölüm 9 (dağıtım) ve "T42 ÜRETİME HAZIRLIK DENETİMİ".

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

---

## 3. Vercel ortam değişkenleri

| Değişken | Zorunlu | Not |
|---|---|---|
| `DATABASE_URL` | evet | `stok_app` rolü, **port 6543** (transaction pooler) |
| `AUTH_SECRET` | evet | en az 32 karakter, `openssl rand -base64 32` |
| `APP_URL` | evet | `https://` ile; çerez `Secure` bayrağı buradan türüyor |
| `CRON_SECRET` | evet | en az 32 karakter; adı TAM böyle olmalı (Bölüm 5) |
| `SMTP_URL` | rapor için | yoksa tur çalışır, e-posta gönderim anında hata verir |
| `REPORT_FROM_EMAIL` | rapor için | |
| `DB_POOL_MAX` | önerilir | `1`–`3`. Varsayılan 10 ve her fonksiyon örneği kendi havuzunu açıyor |
| `DB_IDLE_TIMEOUT` | önerilir | saniye, örn. `20`. Varsayılan 0 = hiç kapatma |
| `MIGRATION_DATABASE_URL` | **HAYIR** | **Vercel'e KOYMA.** O rol RLS'i atlıyor; runtime'da bulunması, uygulama kodunun yanlışlıkla sahip rolüne bağlanabilmesi demek |

`DATABASE_URL` neden 6543: pgbouncer transaction modu. Sürücü zaten
`prepare: false` ile açılıyor (PLAN D-1.4).

Eksik `DATABASE_URL` ya da `AUTH_SECRET` ile deploy **açılışta** patlıyor
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
