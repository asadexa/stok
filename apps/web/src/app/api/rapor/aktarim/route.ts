import { buildWorkbook, exportFileName, importRunReport, importRunReportColumns, inventoryRunReport } from '@stok/core'
import { appDb } from '@stok/db'
import type { NextRequest } from 'next/server'
import { errorResponse } from '@/server/http'
import { requireActor } from '@/server/session'
import { fileResponse } from '../shared'

/**
 * Toplu aktarım raporu (T171, T172): hatalı, yazılamayan, çakışan, belirsiz,
 * işlenmeyen satırlar ve devir notları. `?tur=envanter` envanter dosyasının
 * raporu (T219): ek olarak depoya atama bekleyen satırlar.
 *
 * Rapor aktarım kaydından okunuyor (`?kayit=<id>`); eskiden çözümlenmiş dosya
 * POST gövdesinde geri gönderiliyordu. 20.000 satırlık bir dosyada o gövde
 * istek sınırını aşardı. Yetki ve kiracı sınırı core'da (`importRunReport`:
 * ürün aktarım yetkisi; `inventoryRunReport`: `count:approve`; RLS): başka
 * işletmenin kaydı da, yanlış türdeki kayıt da NOT_FOUND.
 *
 * Yan etkisi yok. Düz bağlantı olarak açılıyor: tarayıcının kendi indirme akışı.
 */
export async function GET(request: NextRequest) {
  try {
    const actor = await requireActor()
    const runId = request.nextUrl.searchParams.get('kayit') ?? ''
    const inventory = request.nextUrl.searchParams.get('tur') === 'envanter'
    const rows = inventory
      ? await inventoryRunReport(actor, runId, { db: appDb() })
      : await importRunReport(actor, runId, { db: appDb() })

    const buffer = await buildWorkbook({
      name: inventory ? 'Envanter raporu' : 'Aktarım raporu',
      columns: importRunReportColumns(),
      rows,
    })

    return fileResponse({
      mode: 'inline',
      fileName: exportFileName(inventory ? 'envanter-raporu' : 'aktarim-raporu', new Date()),
      buffer,
      rowCount: rows.length,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
