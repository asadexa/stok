'use server'

import { AppError, errorText } from '@stok/shared'
import {
  type CommitResult,
  type ImportPreview,
  type ParsedFile,
  commitImport,
  parseFileBlob,
  parseProductFile,
  previewImport,
} from '@stok/core'
import { appDb } from '@stok/db'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T23 — İÇE AKTARMA SUNUCU EYLEMLERİ
 *
 * İki eylem, ikisi de veri DÖNDÜRÜYOR (yönlendirmiyor): önizleme tablosu
 * bir adres çubuğuna sığmaz ve dosyayı iki kez seçtirmek kabul edilemez.
 * Bu yüzden bu tek ekran `useActionState` ile çalışıyor, yani JavaScript
 * gerektiriyor.
 *
 * BU BİLİNÇLİ BİR İSTİSNA. Uygulamanın geri kalanı JavaScript kapalıyken
 * de çalışıyor çünkü depodaki eski Android tarayıcılarda barkod okutup
 * arama yapılıyor. Toplu içe aktarma ise kurulum günü, masa başında, gerçek
 * bir bilgisayarda yapılan tek seferlik bir iş — o ekranda JavaScript
 * beklemek makul.
 * ============================================================================
 */

export interface AnalyzeState {
  /** Çözümlenmiş ham dosya. Onay adımında sunucuya geri gönderiliyor. */
  file?: ParsedFile
  preview?: ImportPreview
  result?: CommitResult
  error?: string
  fileName?: string
}

function fail(err: unknown): AnalyzeState {
  if (err instanceof AppError) return { error: errorText(err.code, err.details) }
  console.error('[import action]', err)
  return { error: errorText('SERVER_ERROR', {}) }
}

/** 1. adım: dosyayı çözümle ve önizle. Hiçbir şey yazmaz. */
export async function analyzeAction(
  _prev: AnalyzeState,
  form: FormData,
): Promise<AnalyzeState> {
  const actor = await currentActor()
  if (!actor) return { error: errorText('TOKEN_INVALID', {}) }

  const upload = form.get('dosya')
  if (!(upload instanceof File) || upload.size === 0) {
    return { error: 'Önce bir dosya seçin.' }
  }

  try {
    const buffer = Buffer.from(await upload.arrayBuffer())
    const file = await parseProductFile(buffer, upload.name)
    const preview = await previewImport(actor, file, { db: appDb() })
    return { file, preview, fileName: upload.name }
  } catch (err) {
    return fail(err)
  }
}

/**
 * 2. adım: uygula.
 *
 * Önizleme SUNUCUDA yeniden hesaplanıyor. İstemcinin gönderdiği
 * sınıflandırmaya güvenmek, kurcalanmış bir gönderimin hangi ürünün
 * güncelleneceğini seçmesine izin vermek olurdu — ve önizlemeden sonra
 * veritabanında olan değişiklikler gözden kaçardı.
 */
export async function commitAction(_prev: AnalyzeState, form: FormData): Promise<AnalyzeState> {
  const actor = await currentActor()
  if (!actor) return { error: errorText('TOKEN_INVALID', {}) }

  try {
    const file = parseFileBlob(JSON.parse(String(form.get('dosyaJson') ?? '{}')))
    const db = appDb()
    const preview = await previewImport(actor, file, { db })
    const result = await commitImport(actor, preview, { db })
    return { result, fileName: String(form.get('dosyaAdi') ?? '') }
  } catch (err) {
    return fail(err)
  }
}
