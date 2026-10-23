'use server'

import {
  type Actor,
  type ImportRunPreview,
  type ImportRunProgress,
  type ImportRunReportRow,
  appendImportRows,
  beginImportRun,
  cancelImportRun,
  finalizeImportPreview,
  importRunReport,
  processImportChunk,
  startImportRun,
} from '@stok/core'
import { type Db, appDb } from '@stok/db'
import { AppError, errorText, isRetryable } from '@stok/shared'
import { logUnexpected } from '@/server/safe-log'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T23 / T171 — TOPLU AKTARIM SUNUCU EYLEMLERİ
 *
 * DOSYA SUNUCUYA GELMİYOR (T171, T1-A). Tarayıcı dosyayı kendi içinde
 * çözümlüyor ve yalnız hücre metinlerini küçük parçalar halinde gönderiyor:
 * 100 MB'lık bir Excel dosyası (çoğu görsel) ne istek gövdesi sınırına ne de
 * sunucu belleğine sığar. Sunucu her parçayı şemayla sınırlıyor; önizleme ve
 * yazma kararlarını istemciye hiç sormadan kendisi veriyor.
 *
 * Akış: başlat → satır ekle (parça parça) → önizle → onayla → parça işle
 * (tekrar tekrar) → iptal ya da tamam → rapor. Aktarımın durumu
 * veritabanındaki kayıtta (`import_runs`); bu eylemler yalnız ince bir kapı.
 *
 * BU EKRAN JAVASCRIPT GEREKTİRİYOR. Bilinçli istisna: uygulamanın geri kalanı
 * JavaScript kapalıyken de çalışıyor çünkü depodaki eski Android tarayıcılarda
 * barkod okutuluyor. Toplu aktarma ise kurulum günü, masa başında, gerçek bir
 * bilgisayarda yapılan bir iş.
 * ============================================================================
 */

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string; retryable: boolean }

/**
 * Yetki ve hata sözleşmesi tek yerde. Hata metni kullanıcıya gidiyor;
 * `retryable` istemcinin kendiliğinden tekrar deneyip denemeyeceğini söylüyor
 * (ör. aynı aktarım başka bir istekte işleniyor). Beklenmeyen hata günlüğe
 * içeriksiz yazılıyor: satırlar alış fiyatı taşıyor (T204, INV-10).
 */
async function guarded<T>(scope: string, fn: (actor: Actor, db: Db) => Promise<T>): Promise<ActionResult<T>> {
  const actor = await currentActor()
  if (!actor) return { ok: false, error: errorText('TOKEN_INVALID', {}), retryable: false }
  try {
    return { ok: true, value: await fn(actor, appDb()) }
  } catch (err) {
    if (err instanceof AppError) {
      return { ok: false, error: errorText(err.code, err.details), retryable: isRetryable(err.code) }
    }
    logUnexpected(scope, err)
    return { ok: false, error: errorText('SERVER_ERROR', {}), retryable: true }
  }
}

/** Aktarım kaydını açar. Dosyanın kendisi değil, tarayıcının okuduğu özet geliyor. */
export async function startImportAction(meta: unknown): Promise<ActionResult<{ runId: string }>> {
  return guarded('import start', (actor, db) => startImportRun(actor, meta, { db }))
}

export async function appendImportRowsAction(
  runId: string,
  rows: unknown,
): Promise<ActionResult<{ received: number; total: number }>> {
  return guarded('import append', (actor, db) => appendImportRows(actor, runId, { rows }, { db }))
}

/** Önizleme: ürün ve stok verisine HİÇBİR ŞEY yazılmıyor. */
export async function previewImportAction(runId: string): Promise<ActionResult<ImportRunPreview>> {
  return guarded('import preview', (actor, db) => finalizeImportPreview(actor, runId, { db }))
}

export async function beginImportAction(runId: string): Promise<ActionResult<ImportRunProgress>> {
  return guarded('import begin', (actor, db) => beginImportRun(actor, runId, { db }))
}

/** Birkaç saniyelik satır grubu; istemci aktarım kapanana kadar çağırıyor. */
export async function processImportChunkAction(runId: string): Promise<ActionResult<ImportRunProgress>> {
  return guarded('import chunk', (actor, db) => processImportChunk(actor, runId, { db }))
}

export async function cancelImportAction(runId: string): Promise<ActionResult<ImportRunProgress>> {
  return guarded('import cancel', (actor, db) => cancelImportRun(actor, runId, { db }))
}

/** Sonuç ekranındaki ilk sorunlu satırlar; tamamı rapor dosyasında. */
export async function importReportAction(runId: string): Promise<ActionResult<ImportRunReportRow[]>> {
  return guarded('import report', (actor, db) => importRunReport(actor, runId, { db, limit: 50 }))
}
