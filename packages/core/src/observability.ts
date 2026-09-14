import { AppError } from '@stok/shared'

/**
 * ============================================================================
 * YAPISAL LOG — T36 (PLAN.md Bölüm 8)
 *
 * TEK SATIR JSON, sabit alan adları. Serbest metin log DEĞİL: "15 Ağustos'ta
 * 40 adet kırmızı defter nereye gitti" sorusunun cevabı defterden çıkıyor
 * ama "neden ÇIKMADI" sorusunun cevabı yalnızca burada — reddedilen hareket
 * hiçbir tabloya yazılmıyor.
 *
 * NEDEN KÜTÜPHANE YOK (pino, winston). Üç sebep:
 *   1. Bu katman `console.log`'un üstünde iki satır. Kütüphane, taşıma ve
 *      biçimlendirme derdini de getiriyor ve ikisine de ihtiyaç yok:
 *      çalıştığı yerlerin (Vercel, systemd, docker) hepsi stdout topluyor.
 *   2. `packages/core` ileride React Native'den de çağrılacak (Faz 5).
 *      Node'a bağlı bir taşıma orada çalışmaz.
 *   3. Bağımlılık = geçişli açık. T104 tam olarak bunun bedeliydi.
 *
 * LOG TEK BAŞINA KONTROL DEĞİL. Bu depoda kural şu: "kimsenin bakmadığı
 * yere yazmak, yazmamakla aynıdır" (G4). Bu yüzden log, ALARM YERİNE
 * GEÇMİYOR — alarmlar `health.ts` + cron turundan e-postayla gidiyor.
 * Log'un işi olayı SONRADAN açıklayabilmek; alarmın işi ANINDA haber vermek.
 *
 * KİŞİSEL VERİ VE FİYAT LOG'A YAZILMIYOR. Kimlikler UUID; ad, e-posta,
 * barkod ve birim fiyat yok. Log satırları çoğu kurulumda üçüncü taraf bir
 * toplayıcıya gidiyor ve oraya fiyat göndermek, D7'nin (fiyat gizleme)
 * arkadan dolanılması olurdu.
 * ============================================================================
 */

/** Log satırının sabit iskeleti. Alan adları DEĞİŞMEZ: sorgular buna dayanır. */
export interface LogFields {
  tenantId?: string
  userId?: string
  productId?: string
  /** İşaretli miktar, ölçekli tamsayı değil okunabilir metin. */
  delta?: string
  reason?: string
  /** Şimdilik hep 'web'. Faz 5'te 'mobile' gelecek. */
  source?: 'web' | 'mobile' | 'cron'
  latencyMs?: number
  idempotencyKey?: string
  /** Reddedildiyse hata kodu. Başarılıysa yok. */
  errorCode?: string
  [key: string]: unknown
}

export type LogLevel = 'info' | 'warn' | 'error'

/**
 * Log yazıcısı DEĞİŞTİRİLEBİLİR ama varsayılanı `console`.
 *
 * Testler burayı değiştiriyor: log'a ne yazıldığını iddia edebilmek için.
 * Global bir değişken yerine parametre geçirmek daha temiz olurdu ama o
 * zaman `createMovement`'ın imzasına yalnızca log için bir alan eklemek
 * gerekirdi — çağıran her yer, umursamadığı bir şeyi taşırdı.
 */
export interface LogSink {
  write(line: string): void
}

let sink: LogSink = {
  write(line) {
    // stdout: hata seviyesi satırın İÇİNDE (`level`), stream'de değil.
    // stderr'e ayırmak, toplayıcıların bir kısmında sıralamayı bozuyor.
    console.log(line)
  },
}

/** Testler için. Üretimde çağrılmıyor. */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? {
    write(line) {
      console.log(line)
    },
  }
}

/**
 * Tek satır JSON yazar.
 *
 * `undefined` alanlar DÜŞÜYOR: `JSON.stringify` zaten atıyor ve bu doğru —
 * "alan yok" ile "alan null" farklı şeyler ve sorgularda ikisini
 * karıştırmak yanlış sayım üretir.
 *
 * Zaman damgası ISO 8601, UTC. Yerel saat yazmak, iki farklı sunucunun
 * log'unu birleştirirken sıralamayı bozardı.
 */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  sink.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }))
}

/**
 * Bir işi ölçer, sonucu log'a yazar ve HATAYI OLDUĞU GİBİ YENİDEN FIRLATIR.
 *
 * Hatayı yutmuyor: log almak için davranış değiştirmek, gözlemin kendisini
 * arızaya çevirir. Yalnızca `AppError` kodu ayrıca yazılıyor; beklenmeyen
 * hatalarda `errorCode` 'UNKNOWN' oluyor ki "kaç tanesi bizim tanıdığımız
 * hata, kaç tanesi değil" ayrı sayılabilsin.
 */
export async function logged<T>(
  event: string,
  fields: LogFields,
  fn: () => Promise<T>,
  onSuccess?: (result: T) => LogFields,
): Promise<T> {
  const started = Date.now()
  try {
    const result = await fn()
    logEvent('info', event, {
      ...fields,
      ...(onSuccess?.(result) ?? {}),
      latencyMs: Date.now() - started,
    })
    return result
  } catch (err) {
    logEvent('warn', `${event}.reddedildi`, {
      ...fields,
      errorCode: err instanceof AppError ? err.code : 'UNKNOWN',
      latencyMs: Date.now() - started,
    })
    throw err
  }
}
