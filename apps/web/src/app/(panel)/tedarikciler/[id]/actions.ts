'use server'

import { AppError, errorText } from '@stok/shared'
import {
  FEED_FIELD_LABELS,
  type FeedRowIssue,
  type RefreshSummary,
  actorCan,
  parseSupplierFile,
  parseSupplierFileBlob,
  previewSupplierRefresh,
  refreshSupplier,
} from '@stok/core'
import { appDb } from '@stok/db'
import { revalidatePath } from 'next/cache'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, SUPPLIER_SAVE_BLOB_LIMIT } from '@/server/config'
import { logServerFault } from '@/server/form'
import { logUnexpected } from '@/server/safe-log'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T200 1b — "VERİLERİ GETİR" EYLEMLERİ: önizle → kaydet
 *
 * İki eylem de veri DÖNDÜRÜYOR, yönlendirmiyor (toplu ürün aktarmadaki
 * gerekçe: önizleme tablosu adres çubuğuna sığmaz). Bu bölüm bu yüzden
 * JavaScript istiyor; tedarikçi sayfasının geri kalanı (bağlama, yok sayma,
 * ayarlar) JavaScript'siz çalışıyor.
 *
 * KAYIT İSTEMCİYE GÜVENMİYOR. Önizlemenin çözümlediği dosya (blob) istemciden
 * geri geliyor; sunucu onu zod ile doğruluyor ve sayıların, eşleşmenin,
 * fiyat miktarının HEPSİNİ kilit altında yeniden hesaplıyor (`refreshSupplier`).
 * Dosya yeniden okunmuyor: kullanıcı önizlemeden sonra Excel'de dosyayı
 * değiştirse bile kaydedilen, önizlenen içerik oluyor.
 *
 * LOG İÇERİK DÖKMÜYOR (T204). Beklenmeyen hatada Drizzle'ın mesajı sorgu
 * parametrelerini, yani fiyat ve barkodu taşıyor; burada yalnız hata sınıfı,
 * SQLSTATE ve constraint yazılıyor (`server/safe-log.ts`).
 * ============================================================================
 */

/** İstemciye gönderilen hata ve uyarı listelerinin üst sınırı; toplamlar ayrıca gidiyor. */
const LIST_LIMIT = 50

export interface ClientSummary extends Omit<RefreshSummary, 'errors' | 'warnings'> {
  errors: FeedRowIssue[]
  errorCount: number
  warnings: FeedRowIssue[]
  warningCount: number
}

export interface RefreshState {
  /** Önizlenen çözümlenmiş dosya, JSON. Kayıtta olduğu gibi geri gönderiliyor. */
  fileJson?: string
  fileName?: string
  /** Okunan sütunlar: alanın Türkçe adı ve dosyadaki başlık. */
  columns?: { label: string; header: string }[]
  ignoredColumns?: string[]
  /** Listeye sığmayan okunmayan sütun sayısı. */
  ignoredColumnsOmitted?: number
  preview?: ClientSummary
  /** Blob kayıt isteğine sığmıyor: kayıt kapalı, dosya bölünmeli. */
  saveBlocked?: boolean
  saved?: ClientSummary
  error?: string
}

function clientSummary(summary: RefreshSummary): ClientSummary {
  const { errors, warnings, ...rest } = summary
  return {
    ...rest,
    errors: errors.slice(0, LIST_LIMIT),
    errorCount: errors.length,
    warnings: warnings.slice(0, LIST_LIMIT),
    warningCount: warnings.length,
  }
}

function fail(err: unknown): RefreshState {
  if (err instanceof AppError) {
    logServerFault('supplier refresh', err)
    return { error: errorText(err.code, err.details) }
  }
  logUnexpected('supplier refresh', err)
  return { error: errorText('SERVER_ERROR', {}) }
}

function tooLarge(bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1)
  return `Dosya çok büyük (${mb} MB). En fazla ${MAX_UPLOAD_LABEL} yükleyebilirsiniz — dosyayı daha küçük parçalara bölüp sırayla yükleyin.`
}

/** 1. adım: dosyayı oku ve önizle. Kalıcı hiçbir şey yazmaz. */
export async function previewRefreshAction(
  _prev: RefreshState,
  form: FormData,
): Promise<RefreshState> {
  const actor = await currentActor()
  if (!actor) return { error: errorText('TOKEN_INVALID', {}) }
  // Dosya okunmadan ÖNCE: yetkisiz biri sunucuya dosya çözümletemesin.
  // Asıl kontrol core'da da var.
  if (!actorCan(actor, 'supplier:manage')) return { error: errorText('FORBIDDEN', {}) }

  const upload = form.get('dosya')
  if (!(upload instanceof File) || upload.size === 0) return { error: 'Önce bir dosya seçin.' }
  if (upload.size > MAX_UPLOAD_BYTES) return { error: tooLarge(upload.size) }

  try {
    const buffer = Buffer.from(await upload.arrayBuffer())
    const file = await parseSupplierFile(buffer, upload.name)
    const summary = await previewSupplierRefresh(actor, String(form.get('tedarikciId') ?? ''), file, {
      db: appDb(),
    })
    const fileJson = JSON.stringify(file)
    return {
      fileJson,
      fileName: upload.name,
      columns: file.columns.map((c) => ({ label: FEED_FIELD_LABELS[c.field], header: c.header })),
      ignoredColumns: file.ignoredColumns,
      ignoredColumnsOmitted: file.ignoredColumnsOmitted,
      preview: clientSummary(summary),
      saveBlocked: Buffer.byteLength(fileJson, 'utf8') > SUPPLIER_SAVE_BLOB_LIMIT,
    }
  } catch (err) {
    return fail(err)
  }
}

/** 2. adım: önizlenen içeriği kaydet. */
export async function saveRefreshAction(
  _prev: RefreshState,
  form: FormData,
): Promise<RefreshState> {
  const actor = await currentActor()
  if (!actor) return { error: errorText('TOKEN_INVALID', {}) }
  if (!actorCan(actor, 'supplier:manage')) return { error: errorText('FORBIDDEN', {}) }

  const supplierId = String(form.get('tedarikciId') ?? '')
  const fileJson = String(form.get('dosyaJson') ?? '')
  // İkinci savunma: önizleme bu boyutta kaydı zaten kapatıyor.
  if (Buffer.byteLength(fileJson, 'utf8') > SUPPLIER_SAVE_BLOB_LIMIT) {
    return { error: 'Dosya kaydetmek için çok büyük. Dosyayı bölüp parçaları ayrı ayrı yükleyin.' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(fileJson)
  } catch (err) {
    if (err instanceof SyntaxError) return { error: errorText('VALIDATION_FAILED', {}) }
    throw err
  }

  try {
    const file = parseSupplierFileBlob(raw)
    const summary = await refreshSupplier(actor, supplierId, file, { db: appDb() })
    // Kimlik `refreshSupplier`'dan geçti: geçerli bir uuid ve bu kiracının.
    revalidatePath(`/tedarikciler/${supplierId}`)
    return { saved: clientSummary(summary), fileName: String(form.get('dosyaAdi') ?? '') }
  } catch (err) {
    return fail(err)
  }
}
