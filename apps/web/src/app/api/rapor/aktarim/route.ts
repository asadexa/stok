import { buildWorkbook, exportFileName, importRunReport, importRunReportColumns } from '@stok/core'
import { appDb } from '@stok/db'
import type { NextRequest } from 'next/server'
import { errorResponse } from '@/server/http'
import { requireActor } from '@/server/session'
import { fileResponse } from '../shared'

/**
 * Toplu aktarım raporu (T171, T172): hatalı, yazılamayan, çakışan, belirsiz,
 * işlenmeyen satırlar ve devir notları.
 *
 * Rapor aktarım kaydından okunuyor (`?kayit=<id>`); eskiden çözümlenmiş dosya
 * POST gövdesinde geri gönderiliyordu. 20.000 satırlık bir dosyada o gövde
 * istek sınırını aşardı. Yetki ve kiracı sınırı core'da (`importRunReport`:
 * yönetici yetkisi, RLS): başka işletmenin kaydı NOT_FOUND.
 *
 * Yan etkisi yok. Düz bağlantı olarak açılıyor: tarayıcının kendi indirme akışı.
 */
export async function GET(request: NextRequest) {
  try {
    const actor = await requireActor()
    const runId = request.nextUrl.searchParams.get('kayit') ?? ''
    const rows = await importRunReport(actor, runId, { db: appDb() })

    const buffer = await buildWorkbook({
      name: 'Aktarım raporu',
      columns: importRunReportColumns(),
      rows,
    })

    return fileResponse({
      mode: 'inline',
      fileName: exportFileName('aktarim-raporu', new Date()),
      buffer,
      rowCount: rows.length,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
