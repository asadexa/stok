/**
 * ============================================================================
 * ARKA PLAN İŞLERİ. TEK KAYNAK.
 *
 * İki KRİTİK AÇIK aynı altyapıya dayanıyor:
 *
 *   G1  Büyük Excel raporu serverless zaman sınırını aşıyor (D-4.2)
 *       → eşik üstü istek kuyruğa alınır, bitince e-posta ile gönderilir
 *
 *   G4  Cron e-posta hatası sessiz kalıyor
 *       → hata KALICI bir satır olarak duruyor ve admin panelinde görünüyor
 *
 * Ortak olan şey: "bu iş arka planda çalıştı mı, çalıştıysa ne oldu"
 * sorusunun cevabının bir yerde YAZILI olması. Log yeterli değil; log
 * kimsenin bakmadığı yerdir ve G4'ün tanımı zaten "kimse fark etmez".
 *
 * DURUM MAKİNESİ:
 *
 *   [QUEUED] ──claim──▶ [RUNNING] ──başarı──▶ [SUCCEEDED]
 *       ▲                    │
 *       │                    ├── hata, deneme hakkı var ──┐
 *       └────────────────────┘                            │
 *                            │                            │
 *                            └── hata, hak bitti ──▶ [FAILED]
 *                                                      │
 *                                            admin panelinde kalıcı uyarı
 *
 * [SUCCEEDED] ve [FAILED] son durum. FAILED'dan çıkış yok çünkü
 * "sessizce tekrar denendi ve sonunda geçti" ile "hiç çalışmadı" arasındaki
 * farkı kaybetmek, G4'ü geri getirmek olurdu. Yeniden denemek yeni bir iş.
 * ============================================================================
 */

export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

export const JOB_STATUS_VALUES: JobStatus[] = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']

/** Son durumlar: bu işler bir daha çalışmaz. */
export const TERMINAL_JOB_STATUSES: JobStatus[] = ['SUCCEEDED', 'FAILED']

export interface JobKindMeta {
  tr: string
  /**
   * Kaç kez denenir. 1 = tekrar yok.
   *
   * Rapor gönderimi 2: geçici SMTP hataları yaygın ve bir tekrar bunların
   * çoğunu çözer (PLAN.md G4: "1 kez tekrar"). Daha fazlası, gerçekten
   * bozuk bir yapılandırmayı saatlerce gizlerdi.
   */
  maxAttempts: number
}

export const JOB_KINDS = {
  /** T14: eşik üstü stok raporu. */
  STOCK_EXPORT: { tr: 'Stok raporu', maxAttempts: 2 },
  /** T14: eşik üstü hareket raporu. */
  MOVEMENT_EXPORT: { tr: 'Hareket raporu', maxAttempts: 2 },
  /** T34: gün sonu raporu. */
  DAILY_REPORT: { tr: 'Gün sonu raporu', maxAttempts: 2 },
  /** T35: kritik stok taraması. */
  LOW_STOCK_SCAN: { tr: 'Kritik stok taraması', maxAttempts: 2 },
} as const satisfies Record<string, JobKindMeta>

export type JobKind = keyof typeof JOB_KINDS

export const JOB_KIND_VALUES = Object.keys(JOB_KINDS) as JobKind[]

export function jobKindLabel(kind: JobKind): string {
  return JOB_KINDS[kind].tr
}

export function jobMaxAttempts(kind: JobKind): number {
  return JOB_KINDS[kind].maxAttempts
}

export function jobKindsCheckConstraint(column = 'kind'): string {
  return `${column} IN (${JOB_KIND_VALUES.map((k) => `'${k}'`).join(', ')})`
}

export function jobStatusesCheckConstraint(column = 'status'): string {
  return `${column} IN (${JOB_STATUS_VALUES.map((s) => `'${s}'`).join(', ')})`
}
