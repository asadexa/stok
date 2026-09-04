import { type Db, withTenant } from '@stok/db'
import { sql } from 'drizzle-orm'
import { type Actor, requirePermission } from './authz'
import { checkStockInvariant } from './movements'

/**
 * ============================================================================
 * T25 — SİSTEM SAĞLIĞI
 *
 * Bu kart bir gösterge paneli süsü değil, "sessizce bozulduysa nereden
 * anlarım" sorusunun cevabı. Bu üründe sessiz bozulma üç yerden gelebilir
 * ve üçü de burada:
 *
 *   1. DEFTER İLE PROJEKSİYON AYRIŞMASI. `SUM(delta) == current_stock.qty`
 *      invariant'ı ürünün en temel garantisi. Bozulursa ekrandaki her stok
 *      sayısı yalan olur ve kimse hata almaz.
 *   2. KUYRUKTA ÇÜRÜYEN İŞ. Rapor kuyruğa girdi ama işçi çalışmıyorsa
 *      kullanıcı beklediği e-postayı hiç almaz (G4'ün kardeşi).
 *   3. HAREKETSİZLİK. Depo çalışıyor ama kayıt gelmiyorsa ya mobil
 *      bağlanamıyor ya da kimse okutmuyor. İkisi de yöneticinin bilmesi
 *      gereken şeyler.
 *
 * Rakam değil DURUM gösteriliyor: "3 bekleyen iş" yöneticiye bir şey
 * söylemez, "3 iş kuyrukta ve en eskisi 2 saattir bekliyor" söyler.
 * ============================================================================
 */

export type HealthLevel = 'ok' | 'warn' | 'error'

export interface HealthCheck {
  key: 'invariant' | 'queue' | 'activity'
  level: HealthLevel
  /** Kullanıcıya gösterilecek tek satır. */
  summary: string
  /** Varsa ne yapılacağı. Sorun yoksa boş. */
  hint?: string
}

export interface SystemHealth {
  level: HealthLevel
  checks: HealthCheck[]
  checkedAt: Date
}

export interface HealthOptions {
  db?: Db
  now?: () => number
  /** Bu kadar süredir hareket yoksa uyarı. Varsayılan 24 saat. */
  quietHours?: number
  /** Kuyrukta bu kadar beklemiş iş varsa uyarı. Varsayılan 1 saat. */
  stuckJobHours?: number
}

const LEVEL_RANK: Record<HealthLevel, number> = { ok: 0, warn: 1, error: 2 }

/**
 * `user:manage` yetkisi arıyor, `stock:read` değil.
 *
 * Bu kart işletmenin altyapı durumu; çalışanın göreceği bir şey değil ve
 * göstermek "bir şeyler bozuk" paniği dışında işine yaramaz. Yönetici
 * yetkisiyle aynı kapıdan geçiyor.
 */
export async function systemHealth(
  actor: Actor,
  options: HealthOptions = {},
): Promise<SystemHealth> {
  requirePermission(actor, 'user:manage')

  const now = new Date(options.now?.() ?? Date.now())
  const quietHours = options.quietHours ?? 24
  const stuckJobHours = options.stuckJobHours ?? 1

  const [invariant, queue, activity] = await Promise.all([
    invariantCheck(actor, options),
    queueCheck(actor, now, stuckJobHours, options),
    activityCheck(actor, now, quietHours, options),
  ])

  const checks = [invariant, queue, activity]
  const level = checks.reduce<HealthLevel>(
    (worst, c) => (LEVEL_RANK[c.level] > LEVEL_RANK[worst] ? c.level : worst),
    'ok',
  )

  return { level, checks, checkedAt: now }
}

/**
 * Defter ile projeksiyon uyuşuyor mu.
 *
 * Bu sorgu tüm hareketleri gruplayarak tarıyor, yani ucuz DEĞİL. Panelde
 * her yenilemede koşturmak yerine bu kartın kendi sayfasında çalışıyor
 * (bkz. /panel yerine /saglik). Milyon satırlık bir defterde saniyeler
 * sürebilir ve dashboard'u bekletmek kabul edilemez.
 */
async function invariantCheck(actor: Actor, options: HealthOptions): Promise<HealthCheck> {
  const breaches = await checkStockInvariant(actor.tenantId, { db: options.db })

  if (breaches.length === 0) {
    return { key: 'invariant', level: 'ok', summary: 'Defter ile stok tablosu birebir uyuşuyor' }
  }
  return {
    key: 'invariant',
    level: 'error',
    summary: `${breaches.length} üründe defter ile stok tablosu AYRIŞMIŞ`,
    // Bu durumda ekrandaki her stok sayısı şüpheli. Kullanıcıya
    // "yenilemeyi deneyin" demek yanlış olurdu; bu bir veri hatası.
    hint: 'Bu bir veri tutarsızlığı. Hareket girmeyi durdurun ve kayıtları inceleyin.',
  }
}

async function queueCheck(
  actor: Actor,
  now: Date,
  stuckJobHours: number,
  options: HealthOptions,
): Promise<HealthCheck> {
  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx.execute<{ status: string; n: string; oldest: string | null }>(sql`
        SELECT status,
               count(*)::text                    AS n,
               min(created_at)::text             AS oldest
          FROM background_jobs
         WHERE status IN ('QUEUED', 'FAILED')
         GROUP BY status
      `),
    options.db,
  )

  const byStatus = new Map([...rows].map((r) => [r.status, r]))
  const failed = Number(byStatus.get('FAILED')?.n ?? 0)
  const queued = Number(byStatus.get('QUEUED')?.n ?? 0)

  if (failed > 0) {
    return {
      key: 'queue',
      level: 'error',
      summary: `${failed} arka plan işi kalıcı olarak başarısız`,
      hint: 'Rapor e-postaları gitmemiş olabilir. Ayarları kontrol edin.',
    }
  }

  if (queued > 0) {
    const oldest = byStatus.get('QUEUED')?.oldest
    const waitedHours = oldest ? (now.getTime() - new Date(oldest).getTime()) / 3_600_000 : 0

    // Kuyrukta iş olması normal; UZUN SÜRE beklemesi değil. İşçi hiç
    // çalışmıyorsa iş sonsuza kadar durur ve kullanıcı beklediği
    // e-postayı hiç almaz.
    if (waitedHours >= stuckJobHours) {
      return {
        key: 'queue',
        level: 'warn',
        summary: `${queued} iş kuyrukta, en eskisi ${Math.floor(waitedHours)} saattir bekliyor`,
        hint: 'Arka plan işçisi çalışmıyor olabilir.',
      }
    }
    return { key: 'queue', level: 'ok', summary: `${queued} iş kuyrukta, işleniyor` }
  }

  return { key: 'queue', level: 'ok', summary: 'Bekleyen veya başarısız arka plan işi yok' }
}

async function activityCheck(
  actor: Actor,
  now: Date,
  quietHours: number,
  options: HealthOptions,
): Promise<HealthCheck> {
  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx.execute<{ last_at: string | null; users_today: string }>(sql`
        SELECT max(created_at)::text AS last_at,
               count(DISTINCT user_id) FILTER (
                 WHERE created_at >= ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz
               )::text AS users_today
          FROM stock_movements
      `),
    options.db,
  )

  const row = [...rows][0]
  const lastAt = row?.last_at ? new Date(row.last_at) : null
  const activeUsers = Number(row?.users_today ?? 0)

  if (!lastAt) {
    // Kurulum günü bu normal: henüz hiç hareket yok. Hata değil.
    return { key: 'activity', level: 'ok', summary: 'Henüz hiç stok hareketi yok' }
  }

  const quietFor = (now.getTime() - lastAt.getTime()) / 3_600_000
  if (quietFor >= quietHours) {
    return {
      key: 'activity',
      level: 'warn',
      summary: `${Math.floor(quietFor)} saattir hiç hareket kaydedilmedi`,
      hint: 'Mobil cihazlar bağlanamıyor olabilir.',
    }
  }

  return {
    key: 'activity',
    level: 'ok',
    summary: `Son 24 saatte ${activeUsers} kullanıcı hareket kaydetti`,
  }
}
