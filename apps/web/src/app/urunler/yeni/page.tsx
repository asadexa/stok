import { UNITS, UNIT_VALUES } from '@stok/shared'
import { createProduct, listLocations } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert, SelectField, SubmitButton, TextField } from '@/components/field'
import { Shell } from '@/components/shell'
import {
  errorQuery,
  messageFrom,
  numberOr,
  optionalNumber,
  optionalText,
  text,
  type FormParams,
} from '@/server/form'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T21 — YENİ ÜRÜN
 *
 * BARKOD ZORUNLU ve formda ilk sırada. Barkodsuz bir ürün depoda
 * okutulamaz, yani pratikte hiç eklenmemiş gibidir; alanı en alta koyup
 * "isterse doldurur" demek, kullanıcıya çalışmayan bir ürün yaratma imkanı
 * vermek olurdu.
 *
 * Ek barkodlar bu ekranda YOK. Ürün oluşturulduktan sonra düzenleme
 * ekranındaki barkod paneline ekleniyorlar: iki adıma bölmek, "koli
 * çarpanı" gibi kafa karıştırıcı bir kavramı ilk kayıt anından çıkarıyor.
 * ============================================================================
 */

export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<FormParams>
}) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')

  const params = await searchParams
  const message = messageFrom(params)

  const db = appDb()
  const locations = await listLocations(actor, { db })

  async function submit(form: FormData) {
    'use server'

    const owner = await currentActor()
    if (!owner) redirect('/giris')

    let productId: string
    try {
      const product = await createProduct(
        owner,
        {
          sku: text(form, 'sku'),
          name: text(form, 'ad'),
          unit: text(form, 'birim'),
          category: optionalText(form, 'kategori'),
          brand: optionalText(form, 'marka'),
          purchasePrice: optionalNumber(form, 'alis'),
          salePrice: optionalNumber(form, 'satis'),
          minStock: numberOr(form, 'minStok', 0),
          locationId: optionalText(form, 'konum'),
          barcodes: [{ barcode: text(form, 'barkod'), kind: 'UNIT' }],
        },
        { db: appDb() },
      )
      productId = product.productId
    } catch (err) {
      redirect(`/urunler/yeni?${errorQuery(err)}`)
    }

    // Düzenleme ekranına gidiyoruz, stok tablosuna değil: kullanıcının
    // sıradaki işi büyük ihtimalle ek barkod veya açılış stoğu girmek.
    redirect(`/urunler/${productId}?yeni=1`)
  }

  return (
    <Shell role={actor.role} active="/stok">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-semibold">Yeni ürün</h1>
        <Link href="/stok" className="text-sm text-slate-600 underline">
          Stok tablosuna dön
        </Link>
      </div>

      <form action={submit} className="max-w-2xl space-y-5 rounded-md border border-slate-200 bg-white p-5">
        {message ? <Alert>{message}</Alert> : null}

        <TextField
          name="barkod"
          label="Barkod"
          required
          autoFocus
          placeholder="Okutun veya elle yazın"
          hint="Ürünün kendi barkodu. Koli barkodunu ürünü kaydettikten sonra ekleyebilirsiniz."
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <TextField name="sku" label="Stok kodu" required hint="İşletme içinde tekil." />
          <TextField name="ad" label="Ürün adı" required />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <TextField name="kategori" label="Kategori" />
          <TextField name="marka" label="Marka" />
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          <SelectField
            name="birim"
            label="Birim"
            defaultValue="ADET"
            options={UNIT_VALUES.map((u) => ({ value: u, label: UNITS[u].tr }))}
          />
          <TextField
            name="minStok"
            label="Kritik eşik"
            type="number"
            defaultValue="0"
            hint="Bu sayının altına düşünce panelde uyarı çıkar."
          />
          <SelectField
            name="konum"
            label="Raf / konum"
            emptyLabel="Belirtilmedi"
            options={locations.map((l) => ({ value: l.id, label: `${l.code} — ${l.name}` }))}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <TextField name="alis" label="Alış fiyatı (₺)" type="number" hint="Boş bırakılabilir." />
          <TextField name="satis" label="Satış fiyatı (₺)" type="number" />
        </div>

        <div className="flex gap-3">
          <SubmitButton>Kaydet</SubmitButton>
          <Link
            href="/stok"
            className="h-14 rounded-md border border-slate-300 px-6 text-base font-medium leading-[3.5rem]"
          >
            Vazgeç
          </Link>
        </div>
      </form>
    </Shell>
  )
}
