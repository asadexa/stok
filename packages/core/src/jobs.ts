import {
  AppError,
  type ErrorCode,
  type JobKind,
  type JobStatus,
  jobMaxAttempts,
} from '@stok/shared'
import { type Db, type Tx, backgroundJobs, isUniqueViolation, users, withTenant } from '@stok/db'
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { type Actor, requirePermission } from './authz'

/**
 * ============================================================================
 * ARKA PLAN İŞ KUYRUĞU (T14 + T17 ortak temeli)
 *
 * İki KRİTİK AÇIĞI birden kapatıyor:
 *
 *   G1  Büyük Excel raporu serverless zaman sınırını aşıyor → kuyruğa alınır
 *   G4  Cron e-posta hatası sessiz kalıyor → hata KALICI satır olarak durur
 *
 * G4 için kritik nokta: hatayı log'a yazmak YETMEZ. G4'ün tanımı zaten
 * "kimse fark etmez" ve log tam olarak kimsenin bakmadığı yerdir. Hata,
 * admin panelinin açtığı ilk ekranda görünmek zorunda; bu yüzden sorgulanabilir
 * bir tabloda ve tenant kapsamlı.
 *
 * NEDEN REDIS / SQS DEĞİL: kuyruk hacmi günde onlarca iş. Postgres
 * `FOR UPDATE SKIP LOCKED` bu ölçekte fazlasıyla yeterli ve dağıtımı
 * basitleştiriyor — tek bir veri deposu, tek bir yedek, tek bir bağımlılık.
 * Ölçek büyürse burası değişir, çağıran kod değişmez.
 * ============================================================================
 */

export interface JobRecord {
  id: string
  tenantId: string
  kind: JobKind
  status: JobStatus
  params: Record<string, unknown>
  requestedBy: string | null
  notifyEmail: string | null
  attempts: number
  maxAttempts: number
  lastErrorCode: string | null
  lastErrorMessage: string | null
  result: Record<string, unknown> | null
  nextAttemptAt: Date | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

export interface JobOptions {
  db?: Db
  now?: () => number
}

/**
 * Başarısız bir işin yeniden denenmeden önce bekleyeceği süre.
 *
 * Sıfır olsaydı `runQueuedJobs` aynı turda işi tekrar alır ve iki denemeyi
 * saniyeler içinde tüketirdi — SMTP sunucusu hâlâ aynı durumda olduğu için
 * tekrar hakkı hiçbir şey değişmeden harcanmış olurdu. Gecikme, bir sonraki
 * cron turunu bekletiyor.
 */
export const RETRY_DELAY_SECONDS = 60

const JOB_COLUMNS = {
  id: backgroundJobs.id,
  tenantId: backgroundJobs.tenantId,
  kind: backgroundJobs.kind,
  status: backgroundJobs.status,
  params: backgroundJobs.params,
  requestedBy: backgroundJobs.requestedBy,
  notifyEmail: backgroundJobs.notifyEmail,
  attempts: backgroundJobs.attempts,
  maxAttempts: backgroundJobs.maxAttempts,
  lastErrorCode: backgroundJobs.lastErrorCode,
  lastErrorMessage: backgroundJobs.lastErrorMessage,
  result: backgroundJobs.result,
  nextAttemptAt: backgroundJobs.nextAttemptAt,
  createdAt: backgroundJobs.createdAt,
  startedAt: backgroundJobs.startedAt,
  finishedAt: backgroundJobs.finishedAt,
}

function toRecord(row: Record<string, unknown>): JobRecord {
  return { ...row, kind: row.kind as JobKind, status: row.status as JobStatus } as JobRecord
}

export interface EnqueueInput {
  kind: JobKind
  params?: Record<string, unknown>
  notifyEmail?: string | null
  /**
   * Aynı anahtarla ikinci bir iş oluşturulamaz. "Cron iki kez çalıştı"
   * uç durumu (PLAN.md Bölüm 5) buradan kapanıyor: gün sonu raporu
   * `DAILY_REPORT:2026-08-22` anahtarıyla kuyruğa giriyor.
   */
  dedupeKey?: string | null
}

export interface EnqueueResult {
  job: JobRecord
  /** Aynı anahtarla iş zaten vardı; yenisi OLUŞTURULMADI. */
  duplicate: boolean
}

/**
 * İşi kuyruğa alır.
 *
 * `actor` cron için de gerekli: iş tenant kapsamlı ve RLS bağlamı olmadan
 * satır yazılamaz. Cron çağrılarında `requestedBy` null bırakılır —
 * "bunu kim istedi" sorusunun dürüst cevabı "sistem".
 */
export async function enqueueJob(
  actor: Actor,
  input: EnqueueInput,
  options: JobOptions = {},
): Promise<EnqueueResult> {
  const insert = (tx: Tx) =>
    tx
      .insert(backgroundJobs)
      .values({
        tenantId: actor.tenantId,
        kind: input.kind,
        status: 'QUEUED',
        params: input.params ?? {},
        requestedBy: actor.userId,
        notifyEmail: input.notifyEmail ?? null,
        maxAttempts: jobMaxAttempts(input.kind),
        dedupeKey: input.dedupeKey ?? null,
      })
      .returning(JOB_COLUMNS)

  try {
    const [row] = await withTenant(actor.tenantId, insert, options.db)
    if (!row) throw new AppError('SERVER_ERROR', 'job insert returned no row')
    return { job: toRecord(row), duplicate: false }
  } catch (err) {
    if (!isUniqueViolation(err, 'jobs_tenant_dedupe_uq')) throw err
    // Yarış: iki cron aynı anda tetiklendi. Kazananın kaydını döndürüyoruz,
    // hata değil — istenen sonuç zaten "tek iş" ve o sağlandı.
    const existing = await findByDedupeKey(actor, input.dedupeKey!, options)
    if (!existing) throw new AppError('SERVER_ERROR', 'dedupe conflict without a matching job')
    return { job: existing, duplicate: true }
  }
}

async function findByDedupeKey(
  actor: Actor,
  dedupeKey: string,
  options: JobOptions,
): Promise<JobRecord | undefined> {
  const [row] = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .select(JOB_COLUMNS)
        .from(backgroundJobs)
        .where(
          and(
            eq(backgroundJobs.tenantId, actor.tenantId),
            eq(backgroundJobs.dedupeKey, dedupeKey),
          ),
        )
        .limit(1),
    options.db,
  )
  return row ? toRecord(row) : undefined
}

/**
 * Kuyruktan bir iş alır ve RUNNING'e çeker.
 *
 * `FOR UPDATE SKIP LOCKED`: iki işçi aynı anda çektiğinde ikincisi
 * beklemez, bir sonraki işi alır. Beklese kuyruk tek şeritli olurdu;
 * kilit almadan seçse aynı iş iki kez çalışır ve gün sonu raporu iki
 * kez giderdi.
 */
export async function claimNextJob(
  tenantId: string,
  options: JobOptions = {},
): Promise<JobRecord | undefined> {
  const now = new Date(options.now?.() ?? Date.now())

  return withTenant(
    tenantId,
    async (tx) => {
      const [candidate] = await tx
        .select({ id: backgroundJobs.id })
        .from(backgroundJobs)
        .where(
          and(
            eq(backgroundJobs.tenantId, tenantId),
            eq(backgroundJobs.status, 'QUEUED'),
            // Tekrar bekleyen iş, gecikmesi dolmadan alınmıyor.
            or(isNull(backgroundJobs.nextAttemptAt), lte(backgroundJobs.nextAttemptAt, now)),
          ),
        )
        .orderBy(backgroundJobs.createdAt)
        .limit(1)
        .for('update', { skipLocked: true })

      if (!candidate) return undefined

      const [row] = await tx
        .update(backgroundJobs)
        .set({
          status: 'RUNNING',
          attempts: sql`${backgroundJobs.attempts} + 1`,
          startedAt: now,
        })
        .where(eq(backgroundJobs.id, candidate.id))
        .returning(JOB_COLUMNS)

      return row ? toRecord(row) : undefined
    },
    options.db,
  )
}

export async function getJob(
  actor: Pick<Actor, 'tenantId'>,
  jobId: string,
  options: JobOptions = {},
): Promise<JobRecord | undefined> {
  const [row] = await withTenant(
    actor.tenantId,
    (tx) => tx.select(JOB_COLUMNS).from(backgroundJobs).where(eq(backgroundJobs.id, jobId)).limit(1),
    options.db,
  )
  return row ? toRecord(row) : undefined
}

async function finish(
  tenantId: string,
  jobId: string,
  patch: Record<string, unknown>,
  options: JobOptions,
): Promise<JobRecord> {
  const [row] = await withTenant(
    tenantId,
    (tx) => tx.update(backgroundJobs).set(patch).where(eq(backgroundJobs.id, jobId)).returning(JOB_COLUMNS),
    options.db,
  )
  if (!row) throw new AppError('NOT_FOUND', `job ${jobId} not found`, { jobId })
  return toRecord(row)
}

/**
 * İşi başarısız işaretler.
 *
 * Deneme hakkı kaldıysa QUEUED'a döner (bir sonraki tur yeniden çalışır);
 * kalmadıysa FAILED olur ve orada KALIR. FAILED'dan otomatik çıkış yok:
 * "sessizce tekrar denendi ve sonunda geçti" ile "hiç çalışmadı" arasındaki
 * farkı kaybetmek G4'ü geri getirmek olurdu.
 */
export async function failJob(
  job: JobRecord,
  error: unknown,
  options: JobOptions & { retryDelaySeconds?: number } = {},
): Promise<JobRecord> {
  const nowMs = options.now?.() ?? Date.now()
  const now = new Date(nowMs)
  const delay = options.retryDelaySeconds ?? RETRY_DELAY_SECONDS
  const code: ErrorCode | 'UNKNOWN' = error instanceof AppError ? error.code : 'UNKNOWN'
  const message = error instanceof Error ? error.message : String(error)
  const exhausted = job.attempts >= job.maxAttempts

  return finish(
    job.tenantId,
    job.id,
    {
      status: exhausted ? 'FAILED' : 'QUEUED',
      lastErrorCode: code,
      // Mesaj kırpılıyor: bir yığın izi bu sütuna sığmaz ve panelde
      // okunmaz. Ayrıntı log'da, burada tanı için yeterli olan kadarı.
      lastErrorMessage: message.slice(0, 500),
      finishedAt: exhausted ? now : null,
      startedAt: exhausted ? job.startedAt : null,
      nextAttemptAt: exhausted ? null : new Date(nowMs + delay * 1000),
    },
    options,
  )
}

export async function succeedJob(
  job: JobRecord,
  result: Record<string, unknown>,
  options: JobOptions = {},
): Promise<JobRecord> {
  return finish(
    job.tenantId,
    job.id,
    {
      status: 'SUCCEEDED',
      result,
      lastErrorCode: null,
      lastErrorMessage: null,
      nextAttemptAt: null,
      finishedAt: new Date(options.now?.() ?? Date.now()),
    },
    options,
  )
}

export type JobHandler = (job: JobRecord) => Promise<Record<string, unknown>>

/**
 * Kuyruktaki işleri sırayla çalıştırır. Cron bunu çağırıyor.
 *
 * `catch (e)` genel yakalama burada MEŞRU ve tek istisna: bir işleyicinin
 * fırlattığı her şey işi başarısız işaretlemeli, yoksa iş sonsuza kadar
 * RUNNING'de asılı kalır ve kuyruk sessizce durur. Hata yutulmuyor —
 * kodu ve mesajı satıra yazılıp admin paneline düşüyor.
 */
export async function runQueuedJobs(
  tenantId: string,
  handlers: Partial<Record<JobKind, JobHandler>>,
  options: JobOptions & { limit?: number } = {},
): Promise<{ ran: number; succeeded: number; failed: number; retried: number }> {
  const limit = options.limit ?? 10
  let ran = 0
  let succeeded = 0
  let failed = 0
  let retried = 0

  for (let i = 0; i < limit; i++) {
    const job = await claimNextJob(tenantId, options)
    if (!job) break
    ran++

    const handler = handlers[job.kind]
    if (!handler) {
      // İşleyicisi olmayan iş: yapılandırma hatası. Sessizce atlamak,
      // işi sonsuza kadar kuyrukta döndürürdü.
      const after = await failJob(
        job,
        new AppError('SERVER_ERROR', `no handler for job kind ${job.kind}`),
        options,
      )
      if (after.status === 'FAILED') failed++
      else retried++
      continue
    }

    try {
      const result = await handler(job)
      await succeedJob(job, result, options)
      succeeded++
    } catch (err) {
      const after = await failJob(job, err, options)
      if (after.status === 'FAILED') failed++
      else retried++
    }
  }

  return { ran, succeeded, failed, retried }
}

/**
 * Admin panelinin "Sistem Sağlığı" kartı (T25) ve G4 uyarısı bunu okuyor.
 * Sadece admin: iş kayıtları başka kullanıcıların taleplerini ve
 * e-posta adreslerini içeriyor.
 */
export async function listJobs(
  actor: Actor,
  filter: { status?: JobStatus[]; limit?: number } = {},
  options: JobOptions = {},
): Promise<JobRecord[]> {
  requirePermission(actor, 'user:manage')

  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .select(JOB_COLUMNS)
        .from(backgroundJobs)
        .where(
          and(
            eq(backgroundJobs.tenantId, actor.tenantId),
            filter.status?.length ? inArray(backgroundJobs.status, filter.status) : undefined,
          ),
        )
        .orderBy(desc(backgroundJobs.createdAt))
        .limit(filter.limit ?? 50),
    options.db,
  )
  return rows.map(toRecord)
}

/**
 * KRİTİK AÇIK G4'ün kapanış noktası: kalıcı olarak başarısız işler.
 * Admin paneli bunu boş görmüyorsa kırmızı uyarı basıyor.
 */
export async function listFailedJobs(
  actor: Actor,
  options: JobOptions = {},
): Promise<JobRecord[]> {
  return listJobs(actor, { status: ['FAILED'] }, options)
}

/** İş sahibinin e-posta adresi; talep eden yoksa (cron) undefined. */
export async function requesterEmail(
  job: JobRecord,
  options: JobOptions = {},
): Promise<string | undefined> {
  if (job.notifyEmail) return job.notifyEmail
  if (!job.requestedBy) return undefined

  const [row] = await withTenant(
    job.tenantId,
    (tx) => tx.select({ email: users.email }).from(users).where(eq(users.id, job.requestedBy!)).limit(1),
    options.db,
  )
  return row?.email
}
