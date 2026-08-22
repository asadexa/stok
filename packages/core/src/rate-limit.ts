import { AppError, type AuthAttemptScope } from '@stok/shared'
import type { Db } from '@stok/db'
import { sql } from 'drizzle-orm'

/**
 * ============================================================================
 * KABA KUVVET KORUMASI (T51, tehdit S9)
 *
 * Sayma işi veritabanında (migration 0005), KARAR burada. Ayrım bilinçli:
 * giriş kilidi ile PIN kilidi farklı kurallara sahip ve ikisi de aynı
 * sayaç deposunu kullanıyor; kuralı SQL'e gömmek ikinci kural geldiğinde
 * migration yazmayı gerektirirdi.
 *
 * KİLİT EĞRİSİ (LOGIN_EMAIL):
 *
 *   hata:  1  2  3  4   5     6     7     8     9    10+
 *   kilit: -  -  -  -  1dk   2dk   4dk   8dk   15dk  15dk
 *                      └─ eşik            tavan ─┘
 *
 * İlk dördü serbest: depoda eldiven takan, telefonu ıslak elle tutan
 * çalışan parolayı yanlış yazar ve her seferinde bir dakika beklemesi
 * onu sisteme düşman eder. Beşinciden sonra maliyet üstel olarak artıyor.
 *
 * Tavan neden var: sınırsız artış, saldırganın MEŞRU kullanıcıyı kalıcı
 * olarak dışarıda bırakmasına izin verirdi (hesap kilitleme, bir hizmet
 * reddi biçimidir). 15 dakika, kaba kuvveti anlamsız kılmaya yetiyor:
 * saatte dört deneme.
 *
 * PENCERE: son hatanın üzerinden bir saat geçtiyse sayaç sıfırlanıyor.
 * Olmasaydı yılda beş kez yanlış yazan kullanıcı kalıcı cezalı olurdu.
 * Saldırgan pencereyi bekleyerek saatte dört deneme yapabilir; makul bir
 * parolaya karşı bu hız anlamsız.
 *
 * KULLANICI SAYIMI SIZMIYOR: sayaç, e-posta KAYITLI OLMASA DA artıyor.
 * Sadece var olan hesaplar kilitlenseydi, "kilitlendim" cevabı hesabın
 * varlığını ele verirdi ve giriş hatalarını tek kod altında toplama
 * çabamız (INVALID_CREDENTIALS) boşa giderdi.
 * ============================================================================
 */

export interface AttemptPolicy {
  /** Kaçıncı başarısız denemeden itibaren kilit uygulanır. */
  threshold: number
  /** Bu süre boyunca yeni hata gelmezse sayaç sıfırlanır. */
  windowSeconds: number
  /** Eşiğe ulaşıldığında ilk kilit süresi. */
  baseLockSeconds: number
  /** Kilit süresi üst sınırı. */
  maxLockSeconds: number
}

export const LOGIN_EMAIL_POLICY: AttemptPolicy = {
  threshold: 5,
  windowSeconds: 60 * 60,
  baseLockSeconds: 60,
  maxLockSeconds: 15 * 60,
}

/**
 * Adres bazlı sınır. Eşik BİLEREK çok daha yüksek: depodaki bütün
 * telefonlar tek bir NAT arkasından çıkıyor ve vardiya başında on kişi
 * aynı anda giriş yapıyor. Düşük bir eşik, saldırganı değil müşteriyi
 * engellerdi.
 *
 * Bu sınır tek bir adresin ÇOK SAYIDA HESABA deneme yapmasını kesiyor;
 * tek hesaba yapılan denemeyi zaten LOGIN_EMAIL kesiyor.
 */
export const LOGIN_IP_POLICY: AttemptPolicy = {
  threshold: 50,
  windowSeconds: 60 * 60,
  baseLockSeconds: 60,
  maxLockSeconds: 15 * 60,
}

export interface AttemptState {
  failures: number
  lastFailureAt: Date | undefined
  /** Kilit bitiş anı (ms). Kilitli değilse undefined. */
  lockedUntil: number | undefined
}

/**
 * Eşiği aşan her hata için kilit süresi. Eşiğin altında sıfır.
 *
 * `2 ** (failures - threshold)`: eşikteki hata `baseLockSeconds`,
 * sonraki her hata iki katı, `maxLockSeconds` ile sınırlı.
 */
export function lockSecondsFor(policy: AttemptPolicy, failures: number): number {
  if (failures < policy.threshold) return 0
  const doublings = failures - policy.threshold
  // 2 ** 40 gibi bir üs Infinity üretip Math.min'i bozardı; üssü de sınırlıyoruz.
  const capped = Math.min(doublings, 32)
  return Math.min(policy.baseLockSeconds * 2 ** capped, policy.maxLockSeconds)
}

/**
 * Zaman damgası ISO metni olarak ve AÇIK cast ile gönderiliyor.
 * Ham `Date` nesnesi `sql` şablonuna konduğunda sürücü onu
 * seri hale getiremiyor ("Received an instance of Date"); Drizzle sütun
 * tipini bildiği için insert'lerde sorun çıkmıyor ama fonksiyon
 * çağrısında tip bilgisi yok.
 */
function ts(ms: number): string {
  return new Date(ms).toISOString()
}

interface AttemptRow extends Record<string, unknown> {
  failures: number
  last_failure_at: string
}

function toState(row: AttemptRow | undefined, policy: AttemptPolicy): AttemptState {
  if (!row) return { failures: 0, lastFailureAt: undefined, lockedUntil: undefined }
  const lastFailureAt = new Date(row.last_failure_at)
  const lockSeconds = lockSecondsFor(policy, row.failures)
  return {
    failures: row.failures,
    lastFailureAt,
    lockedUntil: lockSeconds > 0 ? lastFailureAt.getTime() + lockSeconds * 1000 : undefined,
  }
}

/** Sayacı okur. Yazma yapmaz; pencere dışındaki kayıt sıfır sayılır. */
export async function readAttempts(
  db: Db,
  scope: AuthAttemptScope,
  subject: string,
  policy: AttemptPolicy,
  now: number,
): Promise<AttemptState> {
  const rows = await db.execute<AttemptRow>(sql`
    SELECT failures, last_failure_at
      FROM auth_read_attempts(${scope}, ${subject}, ${policy.windowSeconds}, ${ts(now)}::timestamptz)
  `)
  return toState([...rows][0], policy)
}

/** Başarısız denemeyi sayar ve güncel durumu döner. */
export async function recordFailure(
  db: Db,
  scope: AuthAttemptScope,
  subject: string,
  policy: AttemptPolicy,
  now: number,
): Promise<AttemptState> {
  const rows = await db.execute<AttemptRow>(sql`
    SELECT failures, last_failure_at
      FROM auth_record_failure(${scope}, ${subject}, ${policy.windowSeconds}, ${ts(now)}::timestamptz)
  `)
  return toState([...rows][0], policy)
}

/** Başarılı doğrulamadan sonra sayacı siler. */
export async function clearAttempts(
  db: Db,
  scope: AuthAttemptScope,
  subject: string,
): Promise<void> {
  await db.execute(sql`SELECT auth_clear_attempts(${scope}, ${subject})`)
}

/** Eskimiş sayaç satırlarını siler; gün sonu cron'u (T34) çağıracak. */
export async function pruneAttempts(
  db: Db,
  olderThanSeconds: number,
  now: number = Date.now(),
): Promise<number> {
  const rows = await db.execute<{ auth_prune_attempts: number }>(sql`
    SELECT auth_prune_attempts(${olderThanSeconds}, ${ts(now)}::timestamptz)
  `)
  return [...rows][0]?.auth_prune_attempts ?? 0
}

/**
 * Kilitliyse `TOO_MANY_ATTEMPTS` fırlatır.
 *
 * Bu kontrol parola doğrulamasından ÖNCE çağrılmalı: scrypt her denemede
 * ~100 ms CPU yiyor ve sayaç sonradan bakılsaydı kilitli bir hesap bile
 * saldırganın sunucuyu yormasına izin verirdi.
 */
export async function assertNotLocked(
  db: Db,
  scope: AuthAttemptScope,
  subject: string,
  policy: AttemptPolicy,
  now: number,
): Promise<void> {
  const state = await readAttempts(db, scope, subject, policy, now)
  throwIfLocked(state, scope, now)
}

/** Sayacı artırdıktan sonra: yeni durum kilit gerektiriyorsa fırlatır. */
export function throwIfLocked(state: AttemptState, scope: AuthAttemptScope, now: number): void {
  if (state.lockedUntil === undefined || state.lockedUntil <= now) return

  const retryAfterSeconds = Math.ceil((state.lockedUntil - now) / 1000)
  throw new AppError(
    'TOO_MANY_ATTEMPTS',
    `${scope} locked for ${retryAfterSeconds}s after ${state.failures} failures`,
    { retryAfterSeconds, scope, failures: state.failures },
  )
}
