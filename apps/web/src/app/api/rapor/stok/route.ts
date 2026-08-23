import { exportStock } from '@stok/core'
import { appDb } from '@stok/db'
import type { NextRequest } from 'next/server'
import { errorResponse } from '@/server/http'
import { requireActor } from '@/server/session'
import { fileResponse, stockQuery } from '../shared'

/**
 * Stok raporu indirme.
 *
 * `GET` ve YAN ETKİSİZ: karar (anında indir / kuyruğa al / reddet) daha
 * önce `planExport` ile verildi ve buraya sadece "anında indir" yolu
 * geliyor. Yenilenebilir, yer imine eklenebilir; tarayıcı önceden çekse
 * bile zarar yok.
 *
 * Kuyruğa alınması gereken bir istek yine de buraya gelirse (kullanıcı eski
 * bir bağlantıyı açtı, aradan yeni ürünler girdi) `exportStock` kendi
 * eşiğini uygular ve işi kuyruğa alır — o durumda dosya yerine JSON
 * dönüyoruz, yarım bir dosya indirmektense.
 */
export async function GET(request: NextRequest) {
  try {
    const actor = await requireActor()
    const result = await exportStock(actor, stockQuery(request.nextUrl.searchParams), {
      db: appDb(),
    })
    return fileResponse(result)
  } catch (err) {
    return errorResponse(err)
  }
}
