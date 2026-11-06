'use client'

import { type ReactNode, useEffect, useRef, useState } from 'react'

/**
 * ============================================================================
 * "ATANMAMIŞ STOK" DEPO SEÇENEĞİ — yalnız çıkışta seçilebilir (A1, PRD-17)
 *
 * Girişte seçenek gizli ve `disabled`: tarayıcı onu göndermiyor, zorunlu depo
 * grubu gerçek bir depo seçilmesini istiyor. Çıkışta seçilmişken girişe
 * geçilirse seçim temizleniyor; yalnız gizlenseydi seçili kalır, gönderilir ve
 * kullanıcı sunucu hatasıyla karşılaşırdı. Sunucu reddi (`UNASSIGNED_OUT_ONLY`)
 * yerinde: bu bileşen yalnız geçersiz seçimi baştan önlüyor, korumanın yerini
 * tutmuyor. İlk durum sunucuda hesaplanıyor; sayfa açılırken seçenek bir an
 * görünüp kaybolmuyor.
 * ============================================================================
 */
export function UnassignedOption({
  outReasons,
  initialOut,
  defaultChecked,
  children,
}: {
  /** Çıkış sebepleri; tek kaynak `selectableReasons('OUT')` (INV-9). */
  outReasons: readonly string[]
  /** Sayfa açılırken seçili sebep çıkış mı. */
  initialOut: boolean
  defaultChecked: boolean
  children: ReactNode
}) {
  const [out, setOut] = useState(initialOut)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const form = input.current?.form
    if (!form) return
    const onChange = (event: Event) => {
      const target = event.target as HTMLInputElement
      if (target.name !== 'sebep') return
      const isOut = outReasons.includes(target.value)
      if (!isOut && input.current) input.current.checked = false
      setOut(isOut)
    }
    form.addEventListener('change', onChange)
    return () => form.removeEventListener('change', onChange)
  }, [outReasons])

  return (
    <label
      hidden={!out}
      className={`${out ? 'flex' : 'hidden'} min-h-[2.75rem] items-center gap-2 border-t border-line pt-1`}
    >
      <input
        ref={input}
        type="radio"
        name="depo"
        value="atanmamis"
        required
        disabled={!out}
        defaultChecked={defaultChecked && initialOut}
        className="size-5 shrink-0"
      />
      {children}
    </label>
  )
}
