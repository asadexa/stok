/**
 * ============================================================================
 * FORM ALANLARI — T68 (tasarım incelemesi, ölçülmüş erişilebilirlik düzeltmesi)
 *
 * BU DOSYADA İKİ GERİLEME KAPANDI. İkisi de tasarım tercihi değil, ölçülen
 * bir açıktı ve referans görselden bağımsız olarak düzeltilmesi gerekiyordu.
 *
 *   1. KENARLIK. Eskiden `border-slate-300`: beyaza karşı 1,48:1. WCAG 1.4.11
 *      arayüz bileşen sınırları için 3:1 istiyor, yani ölçülen değer gerekenin
 *      yarısından azdı. Kötü ışıkta kutunun nerede bittiği görünmüyordu.
 *      Şimdi `--line-control` (#848aa8), beyaza 3,40:1.
 *
 *   2. ODAK. Eskiden `outline-none focus:border-slate-900`: klavyeyle gezinen
 *      kullanıcının tek işareti 1 px'lik bir ton farkıydı ve `outline-none`
 *      tarayıcının kendi halkasını da kaldırıyordu. Admin barkod okuyucuyu
 *      klavye olarak kullanıyor ve faresi yok; hangi alana yazdığını göremezse
 *      okuttuğu barkod yanlış alana düşer ve bunu fark etmez.
 *      Şimdi halka `globals.css` içindeki genel `:focus-visible` kuralından
 *      geliyor: 3 px, 7,25:1. BU DOSYADA `outline-none` KULLANILMIYOR.
 *
 * YÜKSEKLİK 56 → 52 px. Referans görselin oranları için düştü ama WCAG 2.5.5
 * hedefi olan 44 px'in belirgin üstünde kaldı. Barkod ve miktar alanları
 * 64 px'te DEĞİŞMEDİ: deponun en sık dokunulan iki alanı onlar.
 * ============================================================================
 */

const INPUT =
  'mt-1.5 h-13 w-full rounded-[10px] border border-line-control bg-surface px-3.5 text-base text-ink placeholder:text-ink-3'

export function TextField({
  name,
  label,
  defaultValue,
  required,
  hint,
  type = 'text',
  autoFocus,
  placeholder,
}: {
  name: string
  label: string
  defaultValue?: string | null
  required?: boolean
  hint?: string
  type?: 'text' | 'number' | 'search'
  autoFocus?: boolean
  placeholder?: string
}) {
  return (
    <label className="block">
      <span className="text-[13px] font-semibold">
        {label}
        {required ? (
          <span aria-hidden className="text-crit">
            {' *'}
          </span>
        ) : null}
      </span>
      <input
        name={name}
        // SAYI ALANI DA `type="text"` OLARAK BASILIYOR.
        //
        // `type="number"` tarayıcıda Türkçe ondalık ayırıcıyı REDDEDİYOR:
        // kullanıcı "12,50" yazamıyor, yazdığı değer alanda hiç
        // görünmüyor ve gönderimde alan boş gidiyor. Fiyatın sessizce
        // kaybolması, kuruş hatasından beter.
        //
        // `inputMode="decimal"` telefonda yine ondalık klavyeyi açıyor,
        // yani mobilde kazanılan şey korunuyor. Asıl doğrulama zaten
        // sunucuda (zod) ve virgülü noktaya orada çeviriyoruz.
        type={type === 'number' ? 'text' : type}
        inputMode={type === 'number' ? 'decimal' : undefined}
        defaultValue={defaultValue ?? ''}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className={INPUT}
      />
      {/* İpucu `text-ink-3`: beyaza 4,64:1. Eskiden `text-slate-500` (4,77:1)
          idi ve 12 px'te sınırda geçiyordu; token artık her iki temada da
          ölçülü. */}
      {hint ? <span className="mt-1.5 block text-xs text-ink-3">{hint}</span> : null}
    </label>
  )
}

export function SelectField({
  name,
  label,
  defaultValue,
  options,
  hint,
  emptyLabel,
}: {
  name: string
  label: string
  defaultValue?: string | null
  options: { value: string; label: string }[]
  hint?: string
  /** Verilirse listenin başına boş seçenek eklenir. */
  emptyLabel?: string
}) {
  return (
    <label className="block">
      <span className="text-[13px] font-semibold">{label}</span>
      <select name={name} defaultValue={defaultValue ?? ''} className={INPUT}>
        {emptyLabel ? <option value="">{emptyLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <span className="mt-1.5 block text-xs text-ink-3">{hint}</span> : null}
    </label>
  )
}

/**
 * Hata şeridi. Renk tek başına anlam taşımıyor: ikon + metin de var.
 * Dolgu `--crit-soft`, metin `--crit-soft-ink`: ikisi arasında 6,31:1.
 */
export function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="flex gap-2 rounded-[10px] border border-crit bg-crit-soft p-3 text-sm text-crit-soft-ink"
    >
      <span aria-hidden>⚠</span>
      <span>{children}</span>
    </p>
  )
}

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 rounded-[10px] border border-ok bg-ok-soft p-3 text-sm text-ok-soft-ink">
      <span aria-hidden>✓</span>
      <span>{children}</span>
    </p>
  )
}

export function SubmitButton({
  children,
  tone = 'primary',
}: {
  children: React.ReactNode
  tone?: 'primary' | 'secondary' | 'danger'
}) {
  const styles = {
    primary: 'bg-accent text-accent-ink hover:brightness-110',
    secondary: 'border border-line-control bg-surface text-ink hover:bg-surface-2',
    danger: 'border border-crit bg-surface text-crit hover:bg-crit-soft',
  }[tone]

  return (
    <button
      type="submit"
      className={`h-13 rounded-[10px] px-6 text-base font-semibold ${styles}`}
    >
      {children}
    </button>
  )
}
