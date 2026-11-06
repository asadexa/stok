'use client'

import { type Unit, formatQty, transferNoteRoom } from '@stok/shared'
import { useState } from 'react'
import { thousandthsOf, toThousandths } from './stock-adjust'

/**
 * ============================================================================
 * DEPOLAR ARASI TRANSFER (T233) — yalnız yönetici (`count:approve`)
 *
 * Kaynak yalnız ürünün artı stoğu olan depolar; hedef kaynaktan farklı,
 * gerçek bir depo (atanmamış stoğa geri taşıma yok, PRD-17). Miktar boş
 * geliyor: kullanıcı taşıdığı miktarı kendisi giriyor. Kaydetmeden önce iki
 * depo ve değişmeyen toplam görünüyor. Kaynak yeterliliği, kaynak ≠ hedef ve
 * birim sunucuda, kilit altında sınanıyor; buradaki hesap yalnız gösterim
 * (binde birlik tamsayı, INV-8). Not payı sunucuyla aynı fonksiyondan.
 * ============================================================================
 */

export interface TransferDepot {
  id: string
  name: string
  qty: number
}

export function TransferForm({
  action,
  depots,
  total,
  unit,
  idempotencyKey,
}: {
  action: (form: FormData) => Promise<void>
  depots: TransferDepot[]
  total: number
  unit: Unit
  idempotencyKey: string
}) {
  const sources = depots.filter((d) => d.qty > 0)
  const [fromId, setFromId] = useState(sources.length === 1 ? sources[0]!.id : '')
  const [toId, setToId] = useState('')
  const [qty, setQty] = useState('')

  const from = sources.find((d) => d.id === fromId) ?? null
  const targets = depots.filter((d) => d.id !== fromId)
  const to = targets.find((d) => d.id === toId) ?? null
  const q = toThousandths(qty)
  const available = from ? thousandthsOf(from.qty) : 0n
  const valid = from !== null && q !== null && q > 0n && q <= available
  const show = (scaled: bigint) => formatQty(Number(scaled) / 1000, unit)
  const noteMax = from && to ? transferNoteRoom(from.name, to.name) : undefined

  return (
    <form action={action} className="space-y-4 p-4">
      <input type="hidden" name="anahtar" value={idempotencyKey} />

      <label className="block">
        <span className="text-[13px] font-semibold">Kaynak depo</span>
        <select
          name="kaynak"
          required
          value={fromId}
          onChange={(e) => {
            setFromId(e.target.value)
            // Hedef kaynakla aynı kaldıysa seçimi boşalt: aynı depoya transfer yok.
            if (e.target.value === toId) setToId('')
          }}
          className="mt-1 block h-13 w-full rounded-control border border-line-control bg-surface px-3 text-base"
        >
          <option value="" disabled>
            Depo seçin
          </option>
          {sources.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} — {formatQty(d.qty, unit)}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-[13px] font-semibold">Hedef depo</span>
        <select
          name="hedef"
          required
          value={toId}
          onChange={(e) => setToId(e.target.value)}
          className="mt-1 block h-13 w-full rounded-control border border-line-control bg-surface px-3 text-base"
        >
          <option value="" disabled>
            Depo seçin
          </option>
          {targets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} — {formatQty(d.qty, unit)}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-[13px] font-semibold">Taşınacak miktar</span>
        <input
          name="miktar"
          inputMode="decimal"
          autoComplete="off"
          required
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="tabular mt-1 block h-13 w-full rounded-control border border-line-control bg-surface px-3 text-base"
        />
      </label>

      <p role="status" aria-live="polite" className="min-h-6 text-sm">
        {valid && to && from
          ? `${from.name} ${show(available)} → ${show(available - q)} · ${to.name} ${show(thousandthsOf(to.qty))} → ${show(thousandthsOf(to.qty) + q)} · Toplam ${formatQty(total, unit)} (değişmez)`
          : from && qty.trim() !== '' && !valid
            ? `Miktar sıfırdan büyük ve en fazla ${show(available)} olmalı (en fazla 3 ondalık).`
            : null}
      </p>

      <label className="block">
        <span className="text-[13px] font-semibold">Not (isteğe bağlı)</span>
        <input
          name="not"
          maxLength={noteMax}
          autoComplete="off"
          className="mt-1 block h-13 w-full rounded-control border border-line-control bg-surface px-3 text-base"
        />
        {noteMax !== undefined ? <span className="mt-1 block text-[13px] text-ink-3">En fazla {noteMax} karakter.</span> : null}
      </label>

      <button
        type="submit"
        disabled={!valid || !to}
        className="h-13 rounded-control bg-accent px-6 text-base font-semibold text-accent-ink hover:brightness-110 disabled:opacity-60"
      >
        Depoya taşı
      </button>
    </form>
  )
}
