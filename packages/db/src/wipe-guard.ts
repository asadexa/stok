import { createHash } from 'node:crypto'

/**
 * ============================================================================
 * SİLME KURALI — TEK KAYNAK (T125, WS-1.2a)
 *
 * Seed TRUNCATE ile defter dahil her şeyi siliyor ve append-only trigger
 * TRUNCATE'i kapsamıyor (yalnız UPDATE/DELETE). Runbook operatörden üretim
 * adresini kendi makinesinde kullanmasını istiyor; yanlış kabukta `pnpm
 * seed` ya da `pnpm demo --seed` üretimi silerdi. `db:reset` (WS-1.2b) aynı
 * kurala ihtiyaç duyuyor.
 *
 * NEDEN AYRI MODÜL: kural seed.ts'te kalsaydı reset onu kullanamazdı;
 * seed.ts import edildiği anda main() çalışıp veritabanını siliyor. Reset'e
 * ikinci bir kopya yazmak ise iki kapının zamanla farklı şeyleri "demo"
 * saymasına yol açardı. Bu yüzden modül yan etkisiz: sürücü, DB, dotenv yok.
 *
 * KURAL SAF: sorgular çağıranda kalıyor (seed sahip rolüyle sorar, reset
 * silinecek konteynerin içinden). Karar metin değil gerekçe döndürüyor;
 * mesajı komut yazıyor çünkü yeniden deneme komutu her araçta farklı.
 *
 * KAPILAR, sırayla:
 *   1. Hedef UZAKSA hiçbir koşulda. Uzak silme için belgelenmiş bir yol yok;
 *      kaçış eklemek korumayı bir bayrağa indirirdi.
 *   2. Hedefin veritabanı ADI YOKSA hiçbir koşulda. Adsız adreste
 *      PostgreSQL kullanıcı adıyla aynı adlı veritabanına bağlanıyor: silinen
 *      şey adreste yazmıyor, onay da boş adla "eşleşiyordu".
 *   3. BAĞLANILAN veritabanı adı yazılan hedef değilse (T187). Adresin
 *      ayrıştırılması sürücünün okumasından ayrışabiliyor; ayrıştırma
 *      `target.ts`'te daraltıldı ama silmeden hemen önceki gerçek ölçü bu.
 *   4. Silinecek tablolar o oturumda başka bir şemaya çözülüyorsa (T187).
 *      `search_path` veritabanı/rol ayarıyla ya da rolün adını taşıyan bir
 *      şemayla (`"$user"`) değişebiliyor; o zaman kapının saydığı `tenants`
 *      ile CASCADE'in sildiği defter farklı şemalarda olur.
 *   5. Bağlanan rol RLS'i atlamıyorsa: kiracıları göremez, 6. kapı
 *      doğrulanamaz. Boş görüp "kiracı yok" sanmak korumayı açık bırakırdı.
 *   6. Demo kiracıları dışında kiracı varsa. Yalnız "yerel" yetmiyor:
 *      dükkândaki pilot da yerel bir PostgreSQL'de gerçek veri tutabilir.
 *      Bilerek silmek için hedef veritabanının ADI yazılmalı; alışkanlıkla
 *      eklenen bir bayrak, yanlış kabuktaki yanlış veritabanını silmesin diye.
 * ============================================================================
 */

export const WIPE_FLAG = '--wipe-non-demo-data='

/**
 * Seed'in oluşturduğu kiracılar. Seed'in kiracı tanımı bu tipe bağlı: listede
 * olmayan bir kiracı eklemek derlenmez, böylece kapının "demo" saydığı ile
 * seed'in ürettiği ayrışamaz.
 */
export const DEMO_TENANT_KEYS = ['yilmaz', 'demir'] as const
export type DemoTenantKey = (typeof DEMO_TENANT_KEYS)[number]

/**
 * Tohumdan türetilmiş, kararlı UUID. Aynı girdi hep aynı kimliği verir.
 *
 * Burada duruyor çünkü demo kiracı kimliği bu türetmeden geliyor; seed de
 * kendi satırları için aynı fonksiyonu kullanıyor. İki kopya olsaydı biri
 * değişince kapı demo kiracılarını yabancı sayar ya da tersi olurdu.
 */
export function detUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex')
  const v4 = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${
    ((parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20)
  }-${h.slice(20, 32)}`
  return v4
}

export const DEMO_TENANT_IDS: readonly string[] = DEMO_TENANT_KEYS.map((key) =>
  detUuid(`tenant:${key}`),
)

export interface WipeTarget {
  isLocal: boolean
  database: string
}

export type WipeRefusal =
  | 'remote'
  | 'unnamed'
  | 'target-mismatch'
  | 'schema-shadowed'
  | 'rls-hidden'
  | 'foreign-unconfirmed'

export type WipeDecision =
  // `foreignTenants > 0` ise onayla siliniyor: çağıran bunu uyarı olarak yazar.
  | { allowed: true; foreignTenants: number }
  | { allowed: false; reason: WipeRefusal }

/**
 * Bağlantı açmadan verilebilen ret (kapı 1 ve 2). Seed bunu bağlanmadan
 * önce çağırıyor: uzak ya da adsız hedefe sürücü hiç gitmesin.
 */
export function refuseTarget(target: WipeTarget): WipeRefusal | null {
  if (!target.isLocal) return 'remote'
  if (target.database.trim() === '') return 'unnamed'
  return null
}

/**
 * Bütün kapıları sırayla uygular. 1–2 burada YİNE sınanıyor: kural tek
 * başına eksiksiz kalsın, bir çağıran ön kontrolü unutursa da silme olmasın.
 *
 * `connectedDatabase` ve `schemaShadowed`, silecek bağlantı havuzunda (aynı
 * adres, aynı oturum ayarları) ölçülmeli; başka bir bağlantının ya da
 * adresin değeri 3–4. kapıyı boşa çıkarır. `foreignTenants`, RLS'e tabi
 * rolde anlamsızdır (hep 0 görünür); 5. kapı onu okumadan reddeder.
 */
export function decideWipe(
  input: WipeTarget & {
    connectedDatabase: string
    schemaShadowed: boolean
    bypassRls: boolean
    foreignTenants: number
    args: readonly string[]
  },
): WipeDecision {
  const early = refuseTarget(input)
  if (early) return { allowed: false, reason: early }
  if (input.connectedDatabase !== input.database) return { allowed: false, reason: 'target-mismatch' }
  if (input.schemaShadowed) return { allowed: false, reason: 'schema-shadowed' }
  if (!input.bypassRls) return { allowed: false, reason: 'rls-hidden' }
  if (input.foreignTenants === 0) return { allowed: true, foreignTenants: 0 }

  const confirmed = input.args.find((a) => a.startsWith(WIPE_FLAG))?.slice(WIPE_FLAG.length)
  // Boş onay hiçbir adı onaylamaz. 2. kapı adsız hedefi zaten reddediyor;
  // bu satır kapılar yeniden düzenlense bile `--wipe-non-demo-data=`'nın
  // tek başına onay sayılmaması için.
  if (confirmed === undefined || confirmed.trim() === '') {
    return { allowed: false, reason: 'foreign-unconfirmed' }
  }
  if (confirmed !== input.database) return { allowed: false, reason: 'foreign-unconfirmed' }
  return { allowed: true, foreignTenants: input.foreignTenants }
}

/**
 * ============================================================================
 * VOLUME SIFIRLAMA (WS-1.2b) — `pnpm db:reset`
 *
 * Seed tabloları boşaltıyor; reset ise Docker volume'ünü, yani BÜTÜN
 * PostgreSQL kümesini siliyor: içindeki her veritabanı, rol ve şablon. Bu
 * yüzden `stok`'a bakmak yetmiyor; küme bir bütün olarak sınıflandırılıyor ve
 * tanınmayan her şey reddediliyor (fail closed). Bir veritabanının adı
 * (`stok_test_*` dahil) silinebilir olduğunun kanıtı sayılmıyor.
 *
 * Listeler bilerek dar ve açık: bu kurulumun bugün ürettiği küme. Yeni bir
 * tablo, rol ya da eklenti eklendiğinde reset, liste bilinçli güncellenene
 * kadar reddeder; yanlış yöndeki hata veri kaybı değil gereksiz bir ret olur.
 * ============================================================================
 */

export const CONFIRM_VOLUME_FLAG = '--confirm-volume='

/**
 * Uygulamanın `public` tabloları: `schema.ts`'tekiler ve migration 0005'in
 * SQL ile açtığı `auth_attempts` (Drizzle şemasında yok, T51). Senkronu
 * `schema-sync.test.ts` taze migrate edilmiş veritabanıyla sınıyor.
 *
 * RLS tek başına kimlik sayılmıyor: FORCE RLS ve politika yabancı bir tabloda
 * da olabilir. Ama listedeki tablonun RLS'siz bulunması da ret (INV-4).
 */
export const APP_TABLES: readonly string[] = [
  'auth_attempts',
  'background_jobs',
  'current_stock',
  'locations',
  'product_barcodes',
  'products',
  'stock_movements',
  'supplier_items',
  'supplier_price_changes',
  'suppliers',
  'tenants',
  'users',
]

/** Kümedeki veritabanları. `template0` bağlantı kabul etmiyor, incelenmiyor. */
const KNOWN_DATABASES = ['postgres', 'stok', 'template0', 'template1']
/** `docker-compose.yml`'nin süper kullanıcısı ve `db/init/01-roles.sql`'in rolü. */
const KNOWN_ROLES = ['postgres', 'stok_app']
const KNOWN_TABLESPACES = ['pg_default', 'pg_global']
/** İncelenen her veritabanı için izinli şemalar ve eklentiler. */
const ALLOWED_OBJECTS: Record<string, { schemas: string[]; extensions: string[] }> = {
  postgres: { schemas: ['public'], extensions: ['plpgsql'] },
  template1: { schemas: ['public'], extensions: ['plpgsql'] },
  // pg_trgm: db/init/00-extensions.sql; drizzle: migration günlüğü.
  stok: { schemas: ['drizzle', 'public'], extensions: ['pg_trgm', 'plpgsql'] },
}

/** Bir veritabanının içinden okunan katalog (salt okunur sorgu). */
export interface DatabaseProbe {
  database: string
  superuser: boolean
  schemas: string[]
  /** Veri taşıyan ilişkiler: tablo, bölümlü tablo, materialized view, foreign table. */
  relations: { schema: string; name: string; kind: string; forceRls: boolean; policies: number }[]
  largeObjects: number
  extensions: string[]
  /** Yalnız `stok`: `public.tenants`'ta demo dışı kiracı; tablo yoksa null. */
  foreignTenants: number | null
}

export interface VolumeProbe {
  databases: string[]
  roles: string[]
  tablespaces: string[]
  /** `postgres`, `template1` ve varsa `stok`. */
  inspected: Record<string, DatabaseProbe>
}

export type VolumeRefusal =
  | 'unknown-database'
  | 'unknown-role'
  | 'unknown-tablespace'
  | 'uninspected-database'
  | 'unknown-object'
  | 'unverifiable'
  | WipeRefusal

export type VolumeDecision =
  | { allowed: true; foreignTenants: number }
  | { allowed: false; reason: VolumeRefusal; details: string[] }

const outside = (values: readonly string[], allowed: readonly string[]) =>
  values.filter((v) => !allowed.includes(v))

function unknownObjects(name: string, probe: DatabaseProbe): string[] {
  const allowed = ALLOWED_OBJECTS[name]!
  const found = [
    ...outside(probe.schemas, allowed.schemas).map((s) => `${name}: şema ${s}`),
    ...outside(probe.extensions, allowed.extensions).map((e) => `${name}: eklenti ${e}`),
  ]
  if (probe.largeObjects > 0) found.push(`${name}: ${probe.largeObjects} large object`)
  for (const r of probe.relations) {
    const label = `${name}: ${r.schema}.${r.name} (${r.kind})`
    const isJournal = name === 'stok' && r.schema === 'drizzle' && r.name === '__drizzle_migrations'
    const isAppTable = name === 'stok' && r.schema === 'public' && APP_TABLES.includes(r.name)
    if (r.kind !== 'r' || !(isJournal || isAppTable)) found.push(label)
    else if (isAppTable && (!r.forceRls || r.policies === 0)) found.push(`${label}: RLS yok (INV-4)`)
  }
  return found
}

/**
 * Volume silinebilir mi. Sıra: kümede tanınmayan bir şey varsa hiçbir onay
 * aşamaz; ancak küme tanınırsa `stok` mevcut `decideWipe` ile, aynı onay
 * anlamıyla (`--wipe-non-demo-data=stok`) değerlendiriliyor. Volume adının
 * onayı ayrı (`volumeConfirmed`): bu karar yalnız içeriğe bakıyor.
 */
export function decideVolumeWipe(probe: VolumeProbe, args: readonly string[]): VolumeDecision {
  const refuse = (reason: VolumeRefusal, details: string[] = []): VolumeDecision => ({
    allowed: false,
    reason,
    details,
  })
  const dbs = outside(probe.databases, KNOWN_DATABASES)
  if (dbs.length) return refuse('unknown-database', dbs)
  const roles = outside(probe.roles, KNOWN_ROLES)
  if (roles.length) return refuse('unknown-role', roles)
  const spaces = outside(probe.tablespaces, KNOWN_TABLESPACES)
  if (spaces.length) return refuse('unknown-tablespace', spaces)

  const toInspect = probe.databases.filter((d) => d !== 'template0')
  const missing = toInspect.filter((d) => !probe.inspected[d])
  if (missing.length) return refuse('uninspected-database', missing)
  const objects = toInspect.flatMap((d) => unknownObjects(d, probe.inspected[d]!))
  if (objects.length) return refuse('unknown-object', objects)

  const stok = probe.inspected.stok
  if (!stok) return { allowed: true, foreignTenants: 0 }
  if (stok.foreignTenants === null) {
    // `tenants` yoksa kiracılar sayılamaz; ancak hiç tablo yoksa (migration
    // öncesi taze volume) korunacak veri de yok.
    const tables = stok.relations.filter((r) => r.schema === 'public')
    return tables.length
      ? refuse('unverifiable', tables.map((r) => r.name))
      : { allowed: true, foreignTenants: 0 }
  }
  // Şema gölgesi burada anlamsız: sayım `public.tenants` diye açık yazılıyor
  // ve bilinmeyen her şema yukarıda zaten reddedildi.
  const decision = decideWipe({
    isLocal: true,
    database: 'stok',
    connectedDatabase: stok.database,
    schemaShadowed: false,
    bypassRls: stok.superuser,
    foreignTenants: stok.foreignTenants,
    args,
  })
  return decision.allowed ? decision : refuse(decision.reason)
}

/** Silme yalnız hedef volume'ün TAM adıyla onaylanınca; boş onay hiçbir adı onaylamaz. */
export function volumeConfirmed(args: readonly string[], volumeName: string): boolean {
  const value = args
    .find((a) => a.startsWith(CONFIRM_VOLUME_FLAG))
    ?.slice(CONFIRM_VOLUME_FLAG.length)
  return value !== undefined && value.trim() !== '' && value === volumeName
}

/**
 * Docker yerel mi. `DOCKER_HOST` ya da bağlam `tcp://`/`ssh://` gösterirse
 * `docker volume rm` başka bir makinenin volume'ünü siler.
 */
export function isLocalDockerEndpoint(host: string): boolean {
  return /^(unix|npipe):\/\//.test(host)
}

/** Silmeden hemen önceki karşılaştırma için volume ve kapsayıcı durumu. */
export interface TargetState {
  volumeCreatedAt: string
  /** Volume'ü kullanan kapsayıcılar (çalışan ya da duran). */
  volumeUsers: string[]
  containerRunning: boolean
  containerFinishedAt: string
}

/**
 * İnceleme bittikten sonra hedef değişmedi mi. Volume yeniden yaratılmışsa
 * `CreatedAt`, biri kapsayıcıyı çalıştırıp durdurduysa `FinishedAt`, başka
 * bir kapsayıcı bağlandıysa kullanıcı listesi değişir; üçünde de incelenen
 * veri artık silinecek veri olmayabilir.
 *
 * Okunamayan alan eşit sayılmıyor: Docker çıktısında alan yoksa iki tarafta
 * da boş/tanımsız olur ve "değişmedi" sonucu sahte olurdu.
 */
export function sameTarget(containerId: string, inspected: TargetState, now: TargetState): boolean {
  const readable = (s: TargetState) => Boolean(s.volumeCreatedAt) && Boolean(s.containerFinishedAt)
  return (
    readable(inspected) &&
    readable(now) &&
    now.volumeCreatedAt === inspected.volumeCreatedAt &&
    now.containerFinishedAt === inspected.containerFinishedAt &&
    !now.containerRunning &&
    now.volumeUsers.length === 1 &&
    now.volumeUsers[0] === containerId
  )
}
