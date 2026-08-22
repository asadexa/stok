/**
 * PostgreSQL hata kodları. Genel `catch (e)` yasak (PLAN.md Bölüm 3):
 * her istisna adıyla yakalanır, tanınmayan hata yukarı fırlar.
 *
 * İKİ TUZAK VAR, ikisi de sessiz:
 *
 * 1. `instanceof PostgresError` çalışmaz. postgres.js'in iç sınıfına
 *    bağımlılık yaratır ve aynı sınıfın iki kopyası yüklendiğinde
 *    (pnpm, farklı sürümler) her zaman false döner. Sözleşme SQLSTATE
 *    kodudur, sınıf değil.
 *
 * 2. Drizzle sürücü hatasını KENDİ hatasına SARAR:
 *
 *      Error: Failed query: insert into ...
 *        └─ cause: PostgresError { code: '23505', ... }
 *
 *    Yani `err.code` undefined'dır. Bunu bilmeden yazılan
 *    `if (err.code === '23505')` kontrolü HİÇBİR ZAMAN çalışmaz ve
 *    idempotency yarışı 500 hatası olarak kullanıcıya döner. Aşağıdaki
 *    fonksiyonlar `cause` zincirini yürüyor.
 */

interface PgErrorShape {
  code?: unknown
  constraint_name?: unknown
  table_name?: unknown
  cause?: unknown
}

/** `cause` zincirini yürüyerek SQLSTATE taşıyan ilk hatayı bulur. */
function findPgError(err: unknown, depth = 0): PgErrorShape | undefined {
  if (depth > 5 || typeof err !== 'object' || err === null) return undefined
  const candidate = err as PgErrorShape
  if (typeof candidate.code === 'string') return candidate
  return findPgError(candidate.cause, depth + 1)
}

export function pgErrorCode(err: unknown): string | undefined {
  return findPgError(err)?.code as string | undefined
}

export function pgConstraint(err: unknown): string | undefined {
  const name = findPgError(err)?.constraint_name
  return typeof name === 'string' ? name : undefined
}

/**
 * 23505 unique_violation. `constraint` verilirse SADECE o index için true
 * döner: "herhangi bir UNIQUE ihlali" ile "aynı idempotency anahtarı"
 * çok farklı iki durum ve ikincisini birincisiyle karıştırmak, gerçek
 * bir veri hatasını başarı gibi göstermek olurdu.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (pgErrorCode(err) !== '23505') return false
  return constraint === undefined || pgConstraint(err) === constraint
}

/** 40P01 deadlock_detected, 40001 serialization_failure. Tekrar denenebilir. */
export function isDeadlock(err: unknown): boolean {
  const code = pgErrorCode(err)
  return code === '40P01' || code === '40001'
}

/** 23514 check_violation. Şema kısıtı: veri hatası, tekrar denemek işe yaramaz. */
export function isCheckViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23514'
}

/**
 * Değiştirilemez defter tetikleyicisi (`raise_immutable_ledger`).
 * ERRCODE `restrict_violation` = 23001.
 */
export function isImmutableLedgerViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23001'
}

/** 42501 insufficient_privilege. REVOKE edilmiş bir işlem denendi. */
export function isPrivilegeError(err: unknown): boolean {
  return pgErrorCode(err) === '42501'
}
