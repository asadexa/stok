import { buildWorkbook, exportFileName, templateRows } from '@stok/core'
import { errorResponse } from '@/server/http'
import { requireActor } from '@/server/session'
import { fileResponse } from '../shared'

/**
 * İçe aktarma şablonu. Yan etkisiz `GET`.
 *
 * Sütunlar `templateRows()`'dan geliyor, elle yazılmıyor: şablonun
 * başlıkları ile çözümleyicinin tanıdığı başlıklar ayrı düşerse,
 * şablonu indirip dolduran kullanıcı "sütun bulunamadı" hatası alır.
 */
export async function GET() {
  try {
    // Oturum ZORUNLU ama içerik kişiye özel değil: şablon sabit. Yine de
    // açık bırakmıyoruz — sütun adları ürünün iç yapısını anlatıyor.
    await requireActor()
    const rows = templateRows()
    const headers = Object.keys(rows[0]!)

    const buffer = await buildWorkbook({
      name: 'Ürünler',
      columns: headers.map((header) => ({
        header,
        width: header.length < 12 ? 16 : 28,
        value: (row: Record<string, string | number>) => row[header] ?? null,
      })),
      rows,
    })

    return fileResponse({
      mode: 'inline',
      fileName: exportFileName('urun-sablonu', new Date()),
      buffer,
      rowCount: rows.length,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
