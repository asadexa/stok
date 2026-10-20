import 'server-only'
import { pgConstraint, pgErrorCode } from '@stok/db'

/**
 * ============================================================================
 * BEKLENMEYEN HATAYI İÇERİĞİNİ DÖKMEDEN LOGLAMA (T204, tehdit S7)
 *
 * Drizzle'ın sorgu hatası mesajında sorgunun PARAMETRELERİ de var
 * ("Failed query: … params: [...]"). Tedarikçi yenilemesinde o parametreler
 * fiyat ve barkod: `console.error(err)` yazan bir eylem, hata anında bir
 * tedarikçinin bütün fiyat listesini log toplayıcıya dökerdi. T200 1a'da
 * `dogrula` sırasında görüldü.
 *
 * Burada yalnız hata SINIFI, SQLSTATE ve constraint adı yazılıyor. Bedeli:
 * yığın izi ve mesaj yok. Teşhis için SQLSTATE + constraint çoğu zaman yetiyor;
 * yetmezse hata yerelde, parametreler loga gitmeden yeniden üretilir.
 * ============================================================================
 */

export interface UnexpectedErrorSummary {
  name: string
  sqlstate?: string
  constraint?: string
}

export function unexpectedErrorSummary(err: unknown): UnexpectedErrorSummary {
  return {
    name: err instanceof Error ? err.name : typeof err,
    sqlstate: pgErrorCode(err),
    constraint: pgConstraint(err),
  }
}

export function logUnexpected(scope: string, err: unknown): void {
  console.error(`[${scope}]`, unexpectedErrorSummary(err))
}
