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
 *   3. Bağlanan rol RLS'i atlamıyorsa: kiracıları göremez, 4. kapı
 *      doğrulanamaz. Boş görüp "kiracı yok" sanmak korumayı açık bırakırdı.
 *   4. Demo kiracıları dışında kiracı varsa. Yalnız "yerel" yetmiyor:
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

export type WipeRefusal = 'remote' | 'unnamed' | 'rls-hidden' | 'foreign-unconfirmed'

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
 * `foreignTenants`, RLS'e tabi rolde anlamsızdır (hep 0 görünür); 3. kapı
 * onu okumadan reddeder.
 */
export function decideWipe(
  input: WipeTarget & { bypassRls: boolean; foreignTenants: number; args: readonly string[] },
): WipeDecision {
  const early = refuseTarget(input)
  if (early) return { allowed: false, reason: early }
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
