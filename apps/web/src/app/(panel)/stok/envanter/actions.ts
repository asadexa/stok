'use server'

import {
  type ImportRunProgress,
  type ImportRunReportRow,
  type InventoryRunPreview,
  appendInventoryRows,
  beginInventoryRun,
  cancelInventoryRun,
  finalizeInventoryPreview,
  inventoryRunReport,
  processInventoryChunk,
  startInventoryRun,
} from '@stok/core'
import { type ActionResult, guarded } from '@/server/import-action'

/**
 * ============================================================================
 * T219 — ENVANTERİ GÜNCELLE: SUNUCU EYLEMLERİ
 *
 * Ürün aktarımının eylemleriyle aynı ince kapı (`urunler/aktar/actions.ts`):
 * dosya sunucuya gelmiyor, yalnız tanınan beş sütunun hücreleri parça parça
 * geliyor. Yetki core'da (`count:approve`, yeni ürün varsa onayda ayrıca
 * `product:create`); burada yalnız oturum aktöre çevriliyor.
 *
 * "YENİ SAYIM" ONAYI SUNUCUDA. Aynı içerik daha önce uygulandıysa
 * `beginInventoryRun` `confirmNewCount` olmadan başlamıyor; ekrandaki onay
 * kutusu yalnız bu bayrağı taşıyor. Kutu atlanarak doğrudan istek
 * gönderilse de kural aynı.
 * ============================================================================
 */

export async function startInventoryAction(meta: unknown): Promise<ActionResult<{ runId: string }>> {
  return guarded('inventory start', (actor, db) => startInventoryRun(actor, meta, { db }))
}

export async function appendInventoryRowsAction(
  runId: string,
  rows: unknown,
): Promise<ActionResult<{ received: number; total: number }>> {
  return guarded('inventory append', (actor, db) => appendInventoryRows(actor, runId, { rows }, { db }))
}

/** Önizleme: ürün, depo ve stok verisine HİÇBİR ŞEY yazılmıyor. */
export async function previewInventoryAction(runId: string): Promise<ActionResult<InventoryRunPreview>> {
  return guarded('inventory preview', (actor, db) => finalizeInventoryPreview(actor, runId, { db }))
}

/** Onay. Depolar ve yeni ürünler ancak buradan sonra açılıyor. */
export async function beginInventoryAction(
  runId: string,
  confirmNewCount?: boolean,
): Promise<ActionResult<ImportRunProgress>> {
  return guarded('inventory begin', (actor, db) => beginInventoryRun(actor, runId, { confirmNewCount }, { db }))
}

export async function processInventoryChunkAction(runId: string): Promise<ActionResult<ImportRunProgress>> {
  return guarded('inventory chunk', (actor, db) => processInventoryChunk(actor, runId, { db }))
}

export async function cancelInventoryAction(runId: string): Promise<ActionResult<ImportRunProgress>> {
  return guarded('inventory cancel', (actor, db) => cancelInventoryRun(actor, runId, { db }))
}

/** Sonuç ekranındaki ilk sorunlu satırlar; tamamı rapor dosyasında. */
export async function inventoryReportAction(runId: string): Promise<ActionResult<ImportRunReportRow[]>> {
  return guarded('inventory report', (actor, db) => inventoryRunReport(actor, runId, { db, limit: 50 }))
}
