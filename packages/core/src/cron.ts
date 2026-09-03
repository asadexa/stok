import { AppError, type MovementReason, formatQty, reasonLabel, type Unit } from '@stok/shared'
import { type Db, appDb, withTenant } from '@stok/db'
import { sql } from 'drizzle-orm'
import type { Actor } from './authz.js'
import { XLSX_CONTENT_TYPE, type MailTransport } from './mail.js'
import { buildWorkbook, type SheetColumn } from './excel.js'
import {
  type JobHandler,
  type JobOptions,
  type JobRecord,
  enqueueJob,
  runQueuedJobs,
} from './jobs.js'
import { checkStockInvariant } from './movements.js'
import { pruneAttempts } from './rate-limit.js'

/**
 * ============================================================================
 * CRON — E6 (gün sonu raporu), E7 (kritik stok), T37 (invariant alarmı)
 *
 * `runQueuedJobs()` T14'te yazıldı ama ÇAĞIRANI YOKTU: kuyruğa giren rapor
 * sonsuza kadar QUEUED'da bekliyordu. Bu dosya o boşluğu kapatıyor ve
 * kuyruğa kendi işlerini de ekliyor.
 *
 * ÜÇ ADIM, SIRASI ÖNEMLİ:
 *
 *   1. planla   → günün işlerini kuyruğa al (dedupe anahtarıyla)
 *   2. çalıştır → kuyruktaki HER işi işle (elle istenen export'lar dahil)
 *   3. bakım    → eski kaba kuvvet sayaçlarını buda, invariant'ı denetle
 *
 * Planlama çalıştırmadan ÖNCE: aynı turda hem eklenip hem işlenmesi, cron
 * saatte bir koşsa bile raporun aynı gün içinde çıkmasını sağlıyor. Sonra
 * planlansaydı rapor bir tur (bir saat) geç giderdi.
 *
 * İDEMPOTENT — "cron iki kez çalıştı" durumu (PLAN.md Bölüm 5) `dedupeKey`
 * ile kapanıyor: `DAILY_REPORT:2026-09-03`. İkinci çağrı yeni iş
 * OLUŞTURMUYOR, var olanı döndürüyor. Bu yüzden cron'u iki kez tetiklemek
 * zararsız ve yeniden denemek güvenli.
 *
 * HATA YUTULMUYOR. Bir işleyici fırlatırsa `runQueuedJobs` işi FAILED
 * yapıyor ve admin panelindeki "Sistem Sağlığı" kartı onu gösteriyor (G4).
 * Cron'un kendisi de fırlatmıyor: tek tenant'ın raporu patladı diye
 * diğerlerinin raporu düşmemeli.
 * ============================================================================
 */

export interface CronOptions extends JobOptions {
  db?: Db
  now?: () => number
}

/** `YYYY-MM-DD`, YEREL saat diliminde. Bkz. `movements.ts` → `todayIso`. */
export function dayKey(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

// ---------------------------------------------------------------------------
// GÜN SONU RAPORU — E6 + T88.1
// ---------------------------------------------------------------------------

/** Raporun tek bir hareket satırı. */
export interface DailyMovementRow {
  createdAt: Date
  sku: string
  productName: string
  unit: Unit
  userName: string
  reason: MovementReason
  delta: number
  unitPrice: number | null
  listPrice: number | null
  priceOverrideReason: string | null
  /** `(liste − birim) × miktar`. Pozitif = kasada eksik kalan tutar. */
  gap: number | null
}

export interface DailySummary {
  day: string
  movementCount: number
  inQty: number
  outQty: number
  /** Kasa açığı olan hareket sayısı (T88.1). */
  gapCount: number
  /** Toplam açık, TL. Liste fiyatının ÜSTÜNE çıkanlar negatif katkı yapar. */
  gapTotal: number
  /** Açığı en büyük kullanıcı; eşitlikte ilk gelen. Yoksa null. */
  topGapUser: { name: string; total: number } | null
  criticalCount: number
  rows: DailyMovementRow[]
}

/**
 * Günün özeti.
 *
 * KASA AÇIĞI SORGUDA HESAPLANIYOR, TypeScript'te değil: `numeric` çarpma ve
 * çıkarma PostgreSQL'de tam ondalıkla yapılıyor. TS'e taşımak, deponun
 * miktarda yasakladığı kayan nokta hatasını paraya sokmak olurdu — 300
 * satırlık bir günde kuruşlar birikir ve toplam tutmaz.
 */
export async function dailySummary(
  tenantId: string,
  day: string,
  options: CronOptions = {},
): Promise<DailySummary> {
  return withTenant(
    tenantId,
    async (tx) => {
      const rows = await tx.execute<{
        created_at: string
        sku: string
        product_name: string
        unit: string
        user_name: string
        reason: string
        delta: string
        unit_price: string | null
        list_price: string | null
        price_override_reason: string | null
        gap: string | null
      }>(sql`
        SELECT m.created_at, p.sku, p.name AS product_name, p.unit,
               u.name AS user_name, m.reason, m.delta::text AS delta,
               m.unit_price::text, m.list_price::text, m.price_override_reason,
               CASE
                 WHEN m.unit_price IS NULL OR m.list_price IS NULL THEN NULL
                 ELSE ((m.list_price - m.unit_price) * abs(m.delta))::text
               END AS gap
          FROM stock_movements m
          JOIN products p ON p.id = m.product_id
          JOIN users u    ON u.id = m.user_id
         WHERE m.created_at::date = ${day}::date
         ORDER BY m.created_at
      `)

      const list = [...rows].map((r) => ({
        createdAt: new Date(r.created_at),
        sku: r.sku,
        productName: r.product_name,
        unit: r.unit as Unit,
        userName: r.user_name,
        reason: r.reason as MovementReason,
        delta: Number(r.delta),
        unitPrice: r.unit_price === null ? null : Number(r.unit_price),
        listPrice: r.list_price === null ? null : Number(r.list_price),
        priceOverrideReason: r.price_override_reason,
        gap: r.gap === null ? null : Number(r.gap),
      }))

      // Yalnızca SEBEBİ OLAN sapmalar açık sayılıyor. Sebepsiz sapma
      // veritabanına zaten giremiyor (T88); sebebi olmayan ama fiyatı
      // listeye eşit satırların `gap`'i 0 ve onları saymak "bugün 240
      // harekette açık var" gibi anlamsız bir sayı üretirdi.
      const gapli = list.filter((r) => r.priceOverrideReason !== null && r.gap !== null)
      const perUser = new Map<string, number>()
      for (const r of gapli) perUser.set(r.userName, (perUser.get(r.userName) ?? 0) + r.gap!)
      let topGapUser: DailySummary['topGapUser'] = null
      for (const [name, total] of perUser) {
        if (!topGapUser || total > topGapUser.total) topGapUser = { name, total }
      }

      const [critical] = await tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n
          FROM products p
          LEFT JOIN current_stock cs
                 ON cs.tenant_id = p.tenant_id AND cs.product_id = p.id
         WHERE p.archived_at IS NULL AND COALESCE(cs.qty, 0) <= p.min_stock
      `)

      return {
        day,
        movementCount: list.length,
        inQty: list.filter((r) => r.delta > 0).reduce((a, r) => a + r.delta, 0),
        outQty: list.filter((r) => r.delta < 0).reduce((a, r) => a - r.delta, 0),
        gapCount: gapli.length,
        gapTotal: Number(gapli.reduce((a, r) => a + r.gap!, 0).toFixed(2)),
        topGapUser,
        criticalCount: Number(critical?.n ?? 0),
        rows: list,
      }
    },
    options.db,
  )
}

/** Rapor e-postasının gövdesi. Ekteki Excel'i AÇMADAN okunabilmeli. */
export function dailyReportText(s: DailySummary): string {
  const satirlar = [
    `${s.day} günü özeti`,
    '',
    `Hareket: ${s.movementCount}  (giriş ${s.inQty}, çıkış ${s.outQty})`,
    `Kritik seviyedeki ürün: ${s.criticalCount}`,
  ]

  // KASA AÇIĞI E-POSTANIN GÖVDESİNDE, ekin içinde değil (T88.1).
  // "Okunmayan kayıt kontrol değildir": eki açmayan bir patron da bu üç
  // satırı görüyor. Ek, ayrıntıyı isteyen için.
  if (s.gapCount === 0) {
    satirlar.push('', 'Liste fiyatının altında satış yok.')
  } else {
    satirlar.push(
      '',
      `KASA AÇIĞI: ${s.gapCount} harekette liste fiyatından sapıldı, toplam fark ${s.gapTotal.toFixed(2)} TL.`,
    )
    if (s.topGapUser) {
      satirlar.push(`En çok: ${s.topGapUser.name} (${s.topGapUser.total.toFixed(2)} TL)`)
    }
  }
  return satirlar.join('\n')
}

const dailyColumns: SheetColumn<DailyMovementRow>[] = [
  { header: 'Saat', width: 10, value: (r) => r.createdAt, format: 'hh:mm' },
  { header: 'Stok Kodu', width: 16, value: (r) => r.sku },
  { header: 'Ürün Adı', width: 40, value: (r) => r.productName },
  { header: 'Kullanıcı', width: 22, value: (r) => r.userName },
  { header: 'İşlem', width: 20, value: (r) => reasonLabel(r.reason) },
  { header: 'Miktar', width: 12, value: (r) => r.delta, format: '#,##0.000' },
  { header: 'Birim', width: 10, value: (r) => r.unit },
  { header: 'Liste Fiyatı', width: 14, value: (r) => r.listPrice, format: '#,##0.00' },
  { header: 'Birim Fiyat', width: 14, value: (r) => r.unitPrice, format: '#,##0.00' },
  { header: 'Sapma Sebebi', width: 22, value: (r) => r.priceOverrideReason },
  { header: 'Kasa Farkı', width: 14, value: (r) => r.gap, format: '#,##0.00' },
]

/**
 * Gün sonu raporu işleyicisi (E6).
 *
 * Alıcı yoksa FIRLATIYOR. Sessizce başarılı saymak, G4'ün tam olarak
 * kapatmaya çalıştığı "rapor gitmedi ama kimse bilmiyor" durumunu geri
 * getirirdi; iş FAILED olarak duruyor ve admin panelinde görünüyor.
 */
export function createDailyReportHandler(
  mail: MailTransport,
  options: CronOptions = {},
): JobHandler {
  return async (job: JobRecord): Promise<Record<string, unknown>> => {
    const day = String((job.params as Record<string, unknown>).day ?? '')
    if (!day) throw new AppError('SERVER_ERROR', `job ${job.id} has no day param`)

    const summary = await dailySummary(job.tenantId, day, options)
    const to = job.notifyEmail
    if (!to) throw new AppError('NOT_FOUND', `job ${job.id} has no delivery address`)

    const buffer = await buildWorkbook({
      name: 'Gün sonu',
      columns: dailyColumns,
      rows: summary.rows,
    })

    await mail.send({
      to,
      subject: `Gün sonu raporu — ${day}`,
      text: dailyReportText(summary),
      attachments: [
        { filename: `gun-sonu-${day}.xlsx`, content: buffer, contentType: XLSX_CONTENT_TYPE },
      ],
    })

    return {
      day,
      movementCount: summary.movementCount,
      gapCount: summary.gapCount,
      gapTotal: summary.gapTotal,
      deliveredTo: to,
    }
  }
}

// ---------------------------------------------------------------------------
// KRİTİK STOK TARAMASI — E7
// ---------------------------------------------------------------------------

export interface LowStockRow {
  sku: string
  name: string
  unit: Unit
  qty: number
  minStock: number
}

export async function lowStockProducts(
  tenantId: string,
  options: CronOptions = {},
): Promise<LowStockRow[]> {
  const rows = await withTenant(
    tenantId,
    (tx) =>
      tx.execute<{ sku: string; name: string; unit: string; qty: string; min_stock: string }>(sql`
        SELECT p.sku, p.name, p.unit,
               COALESCE(cs.qty, 0)::text AS qty, p.min_stock::text
          FROM products p
          LEFT JOIN current_stock cs
                 ON cs.tenant_id = p.tenant_id AND cs.product_id = p.id
         WHERE p.archived_at IS NULL AND COALESCE(cs.qty, 0) <= p.min_stock
         ORDER BY (COALESCE(cs.qty, 0) - p.min_stock), p.name
      `),
    options.db,
  )
  return [...rows].map((r) => ({
    sku: r.sku,
    name: r.name,
    unit: r.unit as Unit,
    qty: Number(r.qty),
    minStock: Number(r.min_stock),
  }))
}

/**
 * Kritik stok taraması (E7).
 *
 * KRİTİK ÜRÜN YOKSA E-POSTA GÖNDERİLMİYOR. Her gün "her şey yolunda" maili
 * atmak, birkaç hafta içinde okunmadan silinen bir maile dönüşür ve gerçek
 * uyarı da onunla birlikte silinir. Sessizlik burada iyi haber.
 */
export function createLowStockHandler(mail: MailTransport, options: CronOptions = {}): JobHandler {
  return async (job: JobRecord): Promise<Record<string, unknown>> => {
    const kritik = await lowStockProducts(job.tenantId, options)
    if (kritik.length === 0) return { criticalCount: 0, sent: false }

    const to = job.notifyEmail
    if (!to) throw new AppError('NOT_FOUND', `job ${job.id} has no delivery address`)

    // En fazla 20 satır: uyarı maili bir liste değil bir DÜRTME. Tamamı
    // panelde ve Excel'de zaten var.
    const gosterilen = kritik.slice(0, 20)
    const govde = [
      `${kritik.length} ürün kritik seviyede:`,
      '',
      ...gosterilen.map((r) => `${r.name} (${r.sku}): ${formatQty(r.qty, r.unit)}`),
      ...(kritik.length > gosterilen.length
        ? ['', `… ve ${kritik.length - gosterilen.length} ürün daha. Tamamı panelde.`]
        : []),
    ].join('\n')

    await mail.send({ to, subject: `Kritik stok: ${kritik.length} ürün`, text: govde })
    return { criticalCount: kritik.length, sent: true, deliveredTo: to }
  }
}

// ---------------------------------------------------------------------------
// PLANLAMA VE ÇALIŞTIRMA
// ---------------------------------------------------------------------------

/** Raporun gideceği adres: tenant'ın EN ESKİ aktif yöneticisi. */
async function reportRecipient(
  tenantId: string,
  options: CronOptions,
): Promise<string | undefined> {
  const [row] = await withTenant(
    tenantId,
    (tx) =>
      tx.execute<{ email: string }>(sql`
        SELECT email FROM users
         WHERE role = 'ADMIN' AND active = true
         ORDER BY created_at
         LIMIT 1
      `),
    options.db,
  )
  return row?.email
}

export interface CronResult {
  day: string
  scheduled: { kind: string; duplicate: boolean }[]
  ran: number
  succeeded: number
  failed: number
  retried: number
  prunedAuthAttempts: number
  /** Boş değilse invariant kırılmış — KIRMIZI alarm (T37). */
  invariantBreaches: { productId: string; ledgerSum: string; projection: string }[]
}

/**
 * Cron girişi. Tek tenant için: planla → çalıştır → bakım.
 *
 * `actor` gerekiyor çünkü kuyruk tenant kapsamlı ve RLS bağlamsız satır
 * yazılmıyor. Cron'un kendi kullanıcısı yok; çağıran tenant'ın bir
 * yöneticisini veriyor ve `requestedBy` o kullanıcıya yazılıyor.
 */
export async function runCron(
  actor: Actor,
  handlers: { mail: MailTransport },
  options: CronOptions = {},
): Promise<CronResult> {
  const now = new Date(options.now?.() ?? Date.now())
  const day = dayKey(now)
  const to = await reportRecipient(actor.tenantId, options)

  // 1. PLANLA. Dedupe anahtarı günü içeriyor: aynı gün ikinci çağrı yeni
  //    iş üretmiyor, cron'u tekrar tetiklemek zararsız.
  const scheduled: CronResult['scheduled'] = []
  for (const kind of ['DAILY_REPORT', 'LOW_STOCK_SCAN'] as const) {
    const { duplicate } = await enqueueJob(
      actor,
      { kind, params: { day }, notifyEmail: to ?? null, dedupeKey: `${kind}:${day}` },
      options,
    )
    scheduled.push({ kind, duplicate })
  }

  // 2. ÇALIŞTIR. Elle istenen export'lar da bu turda işleniyor — kuyruk tek,
  //    işçi tek. Ayrı bir işçi yazmak ikinci bir "iş asılı kaldı" yolu açardı.
  const sonuc = await runQueuedJobs(
    actor.tenantId,
    {
      DAILY_REPORT: createDailyReportHandler(handlers.mail, options),
      LOW_STOCK_SCAN: createLowStockHandler(handlers.mail, options),
    },
    options,
  )

  // 3. BAKIM. `auth_attempts` TENANT KAPSAMLI DEĞİL (kimlik doğrulamadan
  //    ÖNCE yazılıyor, tenant henüz bilinmiyor) — bu yüzden `withTenant`
  //    değil düz bağlantı alıyor. 7 günden eski sayaçlar siliniyor:
  //    kilit penceresi en fazla 15 dk, daha eskisi yalnızca yer kaplıyor.
  const prunedAuthAttempts = await pruneAttempts(
    options.db ?? appDb(),
    7 * 24 * 60 * 60,
    now.getTime(),
  )

  /**
   * INVARIANT DENETİMİ — T37.
   *
   * `SUM(delta) == current_stock.qty` her turda kontrol ediliyor. Kırılırsa
   * gösterilen stok defterle uyuşmuyor demektir ve bu, kullanıcının fark
   * etmeden yanlış sayıya bakması anlamına gelir — sessiz kalabilecek en
   * pahalı hata. Sonuç çağırana dönüyor; route onu 500 ile bildiriyor ki
   * izleme aracı görsün.
   */
  const invariantBreaches = await checkStockInvariant(actor.tenantId, options)

  return { day, ...sonuc, scheduled, prunedAuthAttempts, invariantBreaches }
}

// ---------------------------------------------------------------------------
// ÇOK KİRACILI GİRİŞ
// ---------------------------------------------------------------------------

export interface TenantCronResult {
  tenantId: string
  /** Tur tamamlandıysa sonuç; tenant'ın turu düştüyse `undefined`. */
  result?: CronResult
  /** Tur düştüyse sebebi. Yutulmuyor, çağırana çıkıyor. */
  error?: string
}

export interface CronRunResult {
  day: string
  tenants: TenantCronResult[]
  /** Herhangi bir tenant'ta iş başarısız oldu ya da tur düştü. */
  failed: boolean
  /** Herhangi bir tenant'ta `SUM(delta) != current_stock.qty` (T37). */
  invariantBroken: boolean
}

/**
 * BÜTÜN tenant'lar için cron turu. Zamanlayıcının çağırdığı fonksiyon bu.
 *
 * Tenant listesi `cron_tenants()` SECURITY DEFINER fonksiyonundan geliyor
 * (migration 0010): cron'un oturumu yok, RLS bağlamı kurulmadan hiçbir
 * satır görünmüyor. Listeyi ortam değişkeninden okumak, yeni müşteri
 * eklendiğinde raporun SESSİZCE çıkmaması demekti.
 *
 * HER TENANT AYRI TRY/CATCH içinde. Bir tenant'ın veritabanı hatası
 * diğerlerinin raporunu düşürmemeli — aksi halde listenin başındaki tek
 * bozuk kayıt bütün müşterilerin gün sonu raporunu sessizce yok ederdi.
 * Hata yutulmuyor, `error` alanında çağırana dönüyor ve route onu 500 ile
 * bildiriyor.
 */
export async function runCronAllTenants(
  handlers: { mail: MailTransport },
  options: CronOptions = {},
): Promise<CronRunResult> {
  const db = options.db ?? appDb()
  const day = dayKey(new Date(options.now?.() ?? Date.now()))

  const rows = await db.execute<{ tenant_id: string; user_id: string }>(
    sql`SELECT tenant_id, user_id FROM cron_tenants()`,
  )

  const tenants: TenantCronResult[] = []
  for (const row of rows) {
    // Cron'un kendi kullanıcısı yok; tenant'ın en eski aktif yöneticisi
    // adına çalışıyor. Rol ADMIN sabit yazılıyor çünkü `cron_tenants()`
    // zaten yalnızca ADMIN satırı döndürüyor — ikinci bir sorgu atıp aynı
    // bilgiyi tekrar okumak, arada rol değişirse iki farklı cevap üretirdi.
    const actor: Actor = { tenantId: row.tenant_id, userId: row.user_id, role: 'ADMIN' }
    try {
      tenants.push({ tenantId: row.tenant_id, result: await runCron(actor, handlers, options) })
    } catch (err) {
      tenants.push({
        tenantId: row.tenant_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    day,
    tenants,
    failed: tenants.some((t) => t.error !== undefined || (t.result?.failed ?? 0) > 0),
    invariantBroken: tenants.some((t) => (t.result?.invariantBreaches.length ?? 0) > 0),
  }
}
