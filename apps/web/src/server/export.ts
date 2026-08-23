import 'server-only'
import { AppError, errorText } from '@stok/shared'
import type { Actor, ExportKind, ExportPlan } from '@stok/core'
import { planExport } from '@stok/core'
import { appDb } from '@stok/db'

/**
 * Sayfa çizilirken export planını hesaplar.
 *
 * FIRLATMIYOR: rapor çok büyükse bu, sayfanın çökmesi gereken bir durum
 * değil — tablo yine gösterilmeli, sadece indirme düğmesinin yerinde
 * açıklama olmalı. Hata metni burada üretiliyor çünkü çağıran bir sunucu
 * bileşeni ve bu yolda istemci tarafı yok.
 */
export async function exportPlanFor(
  actor: Actor,
  kind: ExportKind,
  params: Record<string, unknown>,
): Promise<{ plan: ExportPlan | null; error: string | null }> {
  try {
    return { plan: await planExport(actor, kind, params, { db: appDb() }), error: null }
  } catch (err) {
    if (err instanceof AppError) return { plan: null, error: errorText(err.code, err.details) }
    // Beklenmeyen hata sayfayı düşürmesin: ayrıntı log'a, kullanıcıya
    // düğme yerine genel bir not.
    console.error('[export plan]', err)
    return { plan: null, error: errorText('SERVER_ERROR', {}) }
  }
}

/** Filtreleri indirme adresine çeviren yardımcı. Boş değerler düşüyor. */
export function exportHref(base: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const query = search.toString()
  return query ? `${base}?${query}` : base
}
