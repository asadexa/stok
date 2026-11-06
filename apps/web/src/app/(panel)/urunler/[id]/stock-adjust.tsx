'use client'

import { type Unit, formatQty } from '@stok/shared'
import { useState } from 'react'

/**
 * ============================================================================
 * TEK ÜRÜN STOK DÜZELTMESİ (T232) — yalnız yönetici (`count:approve`)
 *
 * Kullanıcı SAYDIĞI miktarı girer; fark sunucuda, ölçekli tamsayıyla
 * hesaplanır (DAT-24, INV-8). Buradaki fark yalnız GÖSTERİM: kaydetmeden önce
 * "10 → 7, fark −3" görünsün diye (K4). Gösterim de binde birlik tamsayıyla
 * yapılıyor; kayan nokta çıkarması "0,30000000000000004" gösterebilirdi.
 *
 * Beklenen miktar seçilen deponun sayfa açıldığındaki miktarı. Sunucu kilit
 * altında gerçek miktarla karşılaştırıyor; arada stok değiştiyse düzeltme
 * yazılmıyor (STOCK_CHANGED). Yani bu değer bir güvenlik girdisi değil,
 * "kullanıcı neyi gördü" bilgisi.
 * ============================================================================
 */

export interface AdjustOption {
  /** Depo kimliği; deposuz işletmede boş metin (hedef toplam stok). */
  value: string
  label: string
  qty: number
}

/** "7", "7,5", "7.250" → binde bir tamsayı; geçersizse null. Atama formu da kullanıyor. */
export function toThousandths(raw: string): bigint | null {
  const match = /^(\d{1,7})(?:[.,](\d{1,3}))?$/.exec(raw.trim())
  if (!match) return null
  return BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0'))
}

export function thousandthsOf(qty: number): bigint {
  return toThousandths(String(qty)) ?? 0n
}

export function StockAdjustForm({
  action,
  options,
  unit,
  idempotencyKey,
  noteMax,
}: {
  action: (form: FormData) => Promise<void>
  options: AdjustOption[]
  unit: Unit
  idempotencyKey: string
  noteMax: number
}) {
  const single = options.length === 1 ? options[0]! : null
  const [selected, setSelected] = useState(single?.value ?? '')
  const [target, setTarget] = useState('')

  const current = options.find((o) => o.value === selected) ?? null
  const targetScaled = toThousandths(target)
  const diff = current && targetScaled !== null ? targetScaled - thousandthsOf(current.qty) : null
  const show = (scaled: bigint) => formatQty(Number(scaled) / 1000, unit)
  const deposuz = single !== null && single.value === ''

  return (
    <form action={action} className="space-y-4 p-4">
      <input type="hidden" name="anahtar" value={idempotencyKey} />
      <input type="hidden" name="beklenen" value={current ? String(current.qty) : ''} />

      {single ? (
        <>
          <input type="hidden" name="depo" value={single.value} />
          <p className="text-sm">
            {deposuz ? 'Toplam stok' : single.label}: <span className="tabular font-semibold">{formatQty(single.qty, unit)}</span>
          </p>
        </>
      ) : (
        <label className="block">
          <span className="text-[13px] font-semibold">Depo</span>
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
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} — {formatQty(o.qty, unit)}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="block">
        <span className="text-[13px] font-semibold">Sayılan miktar</span>
        <input
          name="hedef"
          inputMode="decimal"
          autoComplete="off"
          required
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="tabular mt-1 block h-13 w-full rounded-control border border-line-control bg-surface px-3 text-base"
        />
      </label>

      <p role="status" aria-live="polite" className="min-h-6 text-sm">
        {current && targetScaled !== null && diff !== null
          ? diff === 0n
            ? 'Fark yok; kaydedilecek hareket yok.'
            : `${show(thousandthsOf(current.qty))} → ${show(targetScaled)}, fark ${diff > 0n ? '+' : '−'}${show(diff > 0n ? diff : -diff)}`
          : target.trim() !== '' && targetScaled === null
            ? 'Miktar sıfır ya da pozitif bir sayı olmalı (en fazla 3 ondalık).'
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
        <span className="mt-1 block text-[13px] text-ink-3">En fazla {noteMax} karakter.</span>
      </label>

      <button
        type="submit"
        disabled={diff === null || diff === 0n}
        className="h-13 rounded-control bg-accent px-6 text-base font-semibold text-accent-ink hover:brightness-110 disabled:opacity-60"
      >
        Düzeltmeyi uygula
      </button>
    </form>
  )
}
