import {
  buildWorkbook,
  exportFileName,
  importErrorColumns,
  importErrorRows,
  parseFileBlob,
  previewImport,
} from '@stok/core'
import { appDb } from '@stok/db'
import type { NextRequest } from 'next/server'
import { errorResponse } from '@/server/http'
import { requireActor } from '@/server/session'
import { fileResponse } from '../shared'

/**
 * İçe aktarma hata raporu.
 *
 * `POST` çünkü çözümlenmiş dosya gövdede geliyor — bir adres çubuğuna
 * sığmaz. Yan etkisi YOK: sadece önizlemeyi yeniden hesaplayıp hatalı
 * satırları Excel'e yazıyor.
 *
 * Düz form gönderimi olarak çağrılıyor, `fetch` ile değil: tarayıcının
 * kendi indirme akışı çalışsın diye.
 */
export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor()
    const form = await request.formData()
    const file = parseFileBlob(JSON.parse(String(form.get('dosyaJson') ?? '{}')))

    const preview = await previewImport(actor, file, { db: appDb() })
    const rows = importErrorRows(preview.rows.filter((r) => r.action === 'error'))

    const buffer = await buildWorkbook({
      name: 'Hatalar',
      columns: importErrorColumns(),
      rows,
    })

    return fileResponse({
      mode: 'inline',
      fileName: exportFileName('aktarim-hatalari', new Date()),
      buffer,
      rowCount: rows.length,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
