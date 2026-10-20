import { formatCount } from '@/lib/format'

/**
 * Sayı kartı: önizleme ve sonuç panellerinin "Yeni eklenecek 12" kutusu.
 *
 * Toplu ürün aktarma sihirbazından TAŞINDI (T200 1b): tedarikçi verisinin
 * önizlemesi de aynı kartları gösteriyor. İki kopya olsaydı iki ekranın
 * aynı sayıyı farklı biçimde göstermesi zaman meselesiydi.
 */
export function CountTile({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'giris' | 'kritik'
}) {
  const color = tone === 'giris' ? 'text-giris' : tone === 'kritik' ? 'text-kritik' : ''
  return (
    <div className="rounded-card border border-line bg-surface shadow-card p-4">
      <p className="text-sm text-ink-2">{label}</p>
      <p className={`tabular mt-1 text-3xl font-semibold ${color}`}>{formatCount(value)}</p>
    </div>
  )
}
