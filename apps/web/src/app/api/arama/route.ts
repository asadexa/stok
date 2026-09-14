import { searchAll } from '@stok/core'
import { appDb } from '@stok/db'
import type { NextRequest } from 'next/server'
import { errorResponse } from '@/server/http'
import { requireActor } from '@/server/session'

/**
 * ============================================================================
 * BİRLEŞİK ARAMA UCU — T85
 *
 * Ctrl+K paletinin (T86) veri kaynağı. Salt okunur `GET`, yan etkisiz.
 *
 * ARAMA UCU JSON DÖNÜYOR, SAYFA DEĞİL. Palet her tuş vuruşunda sonuç
 * güncelliyor; her seferinde bir sayfa render etmek hem yavaş olur hem de
 * kullanıcının bulunduğu ekranı değiştirirdi.
 *
 * `no-store`: stok miktarı sonuçların içinde. Önbelleğe alınmış bir cevap,
 * kullanıcıya bir dakika önceki stoğu gösterip "elimde 12 var" dedirtirdi.
 *
 * OTURUM ZORUNLU. `requireActor` fırlatıyor, `errorResponse` hata
 * sözleşmesindeki kodu döndürüyor (D-2.2) — palet o kodu görünce sessizce
 * kapanıyor, kullanıcının önüne teknik bir metin çıkarmıyor.
 * ============================================================================
 */
export async function GET(request: NextRequest) {
  try {
    const actor = await requireActor()
    const query = request.nextUrl.searchParams.get('q') ?? ''

    // Tek harfte arama YAPILMIYOR: 1.248 üründe "a" neredeyse hepsini
    // döndürür ve kullanıcıya hiçbir şey söylemez. İki harften itibaren
    // sonuç anlamlı olmaya başlıyor.
    if (query.trim().length < 2) {
      return Response.json(
        { barcode: null, products: [] },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const result = await searchAll(actor, query, { db: appDb() })
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return errorResponse(err)
  }
}
