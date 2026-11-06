'use client'

import { type Unit, formatQty } from '@stok/shared'
import { useState } from 'react'
import { thousandthsOf, toThousandths } from './stock-adjust'

/**
 * ============================================================================
 * ATANMAMIŞ STOĞU DEPOYA ATAMA (T223) — yalnız yönetici (`count:approve`)
 *
 * Miktar atanmamış stoğun tamamıyla dolu geliyor; kullanıcı küçültüp kısmi
 * atama yapabiliyor (K4). Kaydetmeden önce iki kova ve değişmeyen toplam
 * görünüyor. Kaynak yeterliliği ve birim sunucuda, kilit altında sınanıyor;
 * buradaki hesap yalnız gösterim (binde birlik tamsayı, INV-8).
 * ============================================================================
 */

export interface AssignDepot {
  id: string
  name: string
  qty: number
  /** Sabit açıklama bu deponun adını içeriyor; kalan not uzunluğu depoya göre (K6). */
  noteMax: number
}

export function AssignForm({
  action,
  depots,
  unassigned,
  total,
  unit,
  idempotencyKey,
}: {
  action: (form: FormData) => Promise<void>
  depots: AssignDepot[]
  unassigned: number
  total: number
  unit: Unit
  idempotencyKey: string
}) {
  const [selected, setSelected] = useState(depots.length === 1 ? depots[0]!.id : '')
  const [qty, setQty] = useState(String(unassigned).replace('.', ','))

  const depot = depots.find((d) => d.id === selected) ?? null
  const q = toThousandths(qty)
  const source = thousandthsOf(unassigned)
  const valid = q !== null && q > 0n && q <= source
  const show = (scaled: bigint) => formatQty(Number(scaled) / 1000, unit)

  return (
    <form action={action} className="space-y-4 p-4">
      <input type="hidden" name="anahtar" value={idempotencyKey} />

      <label className="block">
        <span className="text-[13px] font-semibold">Hedef depo</span>
        <select
          name="depo"
          required
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="mt-1 block h-13 w-full rounded-control border border-line-control bg-surface px-3 text-base"
        >
          <option value="" disabled>
            Depo seçin
          </option>
          {depots.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} — {formatQty(d.qty, unit)}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-[13px] font-semibold">Atanacak miktar</span>
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
        {valid && depot
          ? `Atanmamış ${show(source)} → ${show(source - q)} · ${depot.name} ${show(thousandthsOf(depot.qty))} → ${show(thousandthsOf(depot.qty) + q)} · Toplam ${formatQty(total, unit)} (değişmez)`
          : qty.trim() !== '' && !valid
            ? `Miktar sıfırdan büyük ve en fazla ${show(source)} olmalı (en fazla 3 ondalık).`
            : null}
      </p>

      <label className="block">
        <span className="text-[13px] font-semibold">Not (isteğe bağlı)</span>
        <input
          name="not"
          maxLength={depot?.noteMax}
          autoComplete="off"
          className="mt-1 block h-13 w-full rounded-control border border-line-control bg-surface px-3 text-base"
        />
        {depot ? <span className="mt-1 block text-[13px] text-ink-3">En fazla {depot.noteMax} karakter.</span> : null}
      </label>

      <button
        type="submit"
        disabled={!valid || !depot}
        className="h-13 rounded-control bg-accent px-6 text-base font-semibold text-accent-ink hover:brightness-110 disabled:opacity-60"
      >
        Depoya ata
      </button>
    </form>
  )
}
