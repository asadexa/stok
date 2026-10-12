import { exportMovementsSchema } from '@stok/shared'
import { describe, expect, it } from 'vitest'
import { dayEndIso, dayStartIso } from '@/lib/format'
import { movementQuery } from './shared'

/**
 * ============================================================================
 * WS-C-lite — HAREKET RAPORU TARİH FİLTRESİ
 *
 * Kapatılan hata: hareketler ekranı sayımı `dayStartIso`/`dayEndIso` ile
 * yapıp "Excel'e aktar (N satır)" gösteriyordu, ama indirme adresi aynı
 * `YYYY-MM-DD` değerini ham taşıdığı için şema reddediyor ve dosya inmiyordu.
 *
 * Sorulan iki şey: geçerli tarih ekranla AYNI sınıra çevriliyor mu, ve
 * çevrilemeyen değer şemaya ham gidip reddediliyor mu (validation gevşemedi).
 * ============================================================================
 */

function query(search: string) {
  return movementQuery(new URLSearchParams(search))
}

describe('movementQuery tarih filtresi', () => {
  it('tarih-only değer ekranın gün sınırına çevriliyor ve şemadan geçiyor', () => {
    const q = query('baslangic=2026-10-10&bitis=2026-10-10')

    expect(q.from).toBe(dayStartIso('2026-10-10'))
    expect(q.to).toBe(dayEndIso('2026-10-10'))
    expect(exportMovementsSchema.safeParse(q).success).toBe(true)
  })

  it('çevrilemeyen değer ham kalıyor ve şema reddediyor', () => {
    const q = query('baslangic=xyz&bitis=2026-13-01')

    expect(q.from).toBe('xyz')
    expect(q.to).toBe('2026-13-01')
    expect(exportMovementsSchema.safeParse(q).success).toBe(false)
  })

  it('doğrudan ISO datetime değişmeden geçiyor', () => {
    const q = query('baslangic=2026-10-09T21:00:00.000Z')

    expect(q.from).toBe('2026-10-09T21:00:00.000Z')
    expect(exportMovementsSchema.safeParse(q).success).toBe(true)
  })

  it('filtre yoksa tarih alanı da yok', () => {
    const q = query('sebep=SALE')

    expect(q.from).toBeUndefined()
    expect(q.to).toBeUndefined()
  })
})
