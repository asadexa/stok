/**
 * Form alanları.
 *
 * Hepsi 56 px yüksekliğinde: PLAN.md Bölüm 11, eldivenli elle basılabilmeli.
 * Etiket `<label>` içinde sarmalanmış — `for`/`id` eşleştirmesi unutulabilir,
 * sarmalamak unutulamaz ve ekran okuyucu ile etiketin tıklanabilirliği
 * ikisi de bedava gelir.
 */

const INPUT =
  'mt-1 h-14 w-full rounded-md border border-slate-300 bg-white px-3 text-base outline-none focus:border-slate-900'

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
      <span className="text-sm font-medium">
        {label}
        {required ? (
          <span aria-hidden className="text-kritik">
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
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
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
      <span className="text-sm font-medium">{label}</span>
      <select name={name} defaultValue={defaultValue ?? ''} className={INPUT}>
        {emptyLabel ? <option value="">{emptyLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  )
}

/** Hata şeridi. Renk tek başına anlam taşımıyor: ikon + metin de var. */
export function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="flex gap-2 rounded-md border border-kritik bg-kritik-bg p-3 text-sm text-kritik"
    >
      <span aria-hidden>⚠</span>
      <span>{children}</span>
    </p>
  )
}

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 rounded-md border border-giris bg-white p-3 text-sm text-slate-700">
      <span aria-hidden className="text-giris">
        ✓
      </span>
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
    primary: 'bg-slate-900 text-white hover:bg-slate-700',
    secondary: 'border border-slate-300 bg-white hover:bg-slate-100',
    danger: 'border border-kritik bg-white text-kritik hover:bg-kritik-bg',
  }[tone]

  return (
    <button type="submit" className={`h-14 rounded-md px-6 text-base font-medium ${styles}`}>
      {children}
    </button>
  )
}
