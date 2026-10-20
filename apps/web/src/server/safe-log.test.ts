import { inspect } from 'node:util'
import { AppError } from '@stok/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeErrorQuery } from './form'
import { logUnexpected } from './safe-log'

/**
 * `console.error`'ın YAZDIĞI metin. `JSON.stringify` KULLANILMIYOR: bir
 * `Error`'ın mesajı ve `cause`'u numaralandırılamaz, JSON'a `{}` olarak
 * giriyor. İlk sürüm öyleydi ve `dogrula` ile ham hata geri konduğunda testin
 * YEŞİL kaldığı görüldü: sızıntıyı göremiyordu. `inspect` konsolun kendi biçimi.
 */
function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .map((args) => args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '))
    .join('\n')
}

/**
 * T204: tedarikçi eylemlerinin beklenmeyen hata logu fiyat ve barkod taşımamalı.
 *
 * Hata, Drizzle'ın gerçek biçimini taklit ediyor: mesajda sorgu ve
 * parametreler, SQLSTATE `cause` zincirinde (pg-errors.ts). Veritabanı
 * sahte değil, yalnız hata nesnesi elle kuruluyor; sınanan şey loglayıcının
 * ne yazdığı.
 */
function drizzleLikeError(): Error {
  const pgError = Object.assign(new Error('new row violates check constraint'), {
    code: '23514',
    constraint_name: 'supplier_items_price_ck',
    detail: 'Failing row contains (…, 8691234567890, Kalem, 9.8765, TRY, …).',
  })
  return new Error(
    'Failed query: insert into supplier_items ...\nparams: [{"price":"9.8765","barcode":"8691234567890"}]',
    { cause: pgError },
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('logUnexpected (T204)', () => {
  it('fiyat ve barkod loga gitmez; SQLSTATE ve constraint gider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logUnexpected('supplier refresh', drizzleLikeError())

    const written = logged(spy)
    expect(written).not.toContain('9.8765')
    expect(written).not.toContain('8691234567890')
    expect(written).not.toContain('params')
    expect(written).toContain('23514')
    expect(written).toContain('supplier_items_price_ck')
    expect(written).toContain('supplier refresh')
  })

  it('Error olmayan değer de güvenle yazılır', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logUnexpected('supplier refresh', 'fiyat 9.8765')
    expect(logged(spy)).not.toContain('9.8765')
  })
})

describe('safeErrorQuery (T204, tedarikçi sayfa eylemleri)', () => {
  it('beklenmeyen hata: kullanıcıya genel kod, loga fiyat ve barkod gitmez', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const query = safeErrorQuery('supplier bind', drizzleLikeError())

    expect(new URLSearchParams(query).get('hata')).toBe('SERVER_ERROR')
    const written = logged(spy)
    expect(written).not.toContain('9.8765')
    expect(written).not.toContain('8691234567890')
    expect(written).toContain('23514')
  })

  it('iş kuralı hatası olduğu gibi geçer', () => {
    const query = safeErrorQuery('supplier create', new AppError('SUPPLIER_NAME_EXISTS', 'var'))
    expect(new URLSearchParams(query).get('hata')).toBe('SUPPLIER_NAME_EXISTS')
  })

  it('Next yönlendirmesi yutulmaz', () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/x;303;' })
    expect(() => safeErrorQuery('supplier bind', redirect)).toThrow(redirect)
  })
})
