import {
  CURRENCIES,
  CURRENCY_VALUES,
  SUPPLIER_PRICE_TYPES,
  SUPPLIER_PRICE_TYPE_VALUES,
  TAX_MODES,
  TAX_MODE_VALUES,
} from '@stok/shared'
import { SelectField, TextField } from '@/components/field'
import { text } from '@/server/form'

/**
 * ============================================================================
 * TEDARİKÇİ AYARLARI FORMU (T200 1b) — oluşturma ve düzenleme ortak
 *
 * KDV ve fiyat türü ÖNCEDEN SEÇİLİ GELMİYOR. Dosyada bu sütunlar çoğu zaman
 * yok; varsayılan "KDV hariç" seçili gelseydi bir dahil listesi fark edilmeden
 * bütün kalemlere yanlış koşulla yazılır, yanlış gruplarda karşılaştırılırdı.
 * Para birimi TRY ile geliyor: her satırda görünüyor ve yanlışsa hemen göze batıyor.
 *
 * FİYAT MİKTARI VARSAYILANI "BELİRSİZ" (T200 B2): yalnız yönetici açıkça
 * "1 ürün birimi" derse fiyatlar karşılaştırmaya girer.
 * ============================================================================
 */

/** Hata dönüşünde formu geri doldurmak için taşınan alanlar (`preserveFields`). */
export const SUPPLIER_FORM_FIELDS = ['ad', 'paraBirimi', 'kdv', 'fiyatTuru', 'fiyatMiktari'] as const

export interface SupplierFormValues {
  ad?: string
  paraBirimi?: string
  kdv?: string
  fiyatTuru?: string
  fiyatMiktari?: string
}

/** Formu core'un beklediği girdiye çevirir. Doğrulama core'da (zod). */
export function supplierInput(form: FormData) {
  return {
    name: text(form, 'ad'),
    defaultCurrency: text(form, 'paraBirimi'),
    defaultTaxMode: text(form, 'kdv'),
    defaultPriceType: text(form, 'fiyatTuru'),
    unitPriceDeclared: text(form, 'fiyatMiktari') === '1',
  }
}

export function SupplierFormFields({ values }: { values: SupplierFormValues }) {
  return (
    <>
      <TextField name="ad" label="Tedarikçi adı" required defaultValue={values.ad} />

      <div className="grid gap-5 sm:grid-cols-3">
        <SelectField
          name="paraBirimi"
          label="Para birimi"
          defaultValue={values.paraBirimi ?? 'TRY'}
          options={CURRENCY_VALUES.map((c) => ({
            value: c,
            label: `${CURRENCIES[c].tr} (${CURRENCIES[c].short})`,
          }))}
        />
        <SelectField
          name="kdv"
          label="KDV durumu"
          emptyLabel="Seçin"
          defaultValue={values.kdv ?? ''}
          options={TAX_MODE_VALUES.map((t) => ({ value: t, label: TAX_MODES[t].tr }))}
          hint="Dosyada KDV durumu sütunu yoksa bu kullanılır."
        />
        <SelectField
          name="fiyatTuru"
          label="Fiyat türü"
          emptyLabel="Seçin"
          defaultValue={values.fiyatTuru ?? ''}
          options={SUPPLIER_PRICE_TYPE_VALUES.map((p) => ({
            value: p,
            label: SUPPLIER_PRICE_TYPES[p].tr,
          }))}
          hint="Sütun adı “Liste Fiyatı” ya da “Net Fiyat” ise o geçerli."
        />
      </div>

      <SelectField
        name="fiyatMiktari"
        label="Fiyatların ait olduğu miktar"
        defaultValue={values.fiyatMiktari ?? ''}
        options={[
          { value: '', label: 'Belirsiz' },
          { value: '1', label: '1 ürün birimi (adet, kg, metre…)' },
        ]}
        hint="Belirsiz fiyatlar karşılaştırmaya girmez. “1 ürün birimi”ni yalnız bu tedarikçinin fiyatlarının birim başına olduğundan eminseniz seçin; koli barkoduyla eşleşen kalemlerde uygulanmaz."
      />
    </>
  )
}
