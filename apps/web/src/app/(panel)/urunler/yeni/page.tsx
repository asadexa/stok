import { UNITS, UNIT_VALUES } from '@stok/shared'
import { actorCan, createProduct, listLocations } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert, SelectField, SubmitButton, TextField } from '@/components/field'
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
  searchParams: Promise<FormParams & { ad?: string }>
}) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')
  /**
   * ÇALIŞAN BU EKRANI HİÇ GÖRMEMELİ (T38 tarayıcı turunda bulundu).
   *
   * Kardeş ekranda (`urunler/aktar`) bu satır vardı, burada YOKTU: çalışan
   * adresi elle yazınca ürün oluşturma formunun tamamını görüyordu.
   * Veri sızıntısı değil — `createProduct` sunucuda `product:create`
   * arıyor ve kaydetme 403 dönüyordu. Ama form doldurup "Kaydet"e basıp
   * anlamadığı bir hata almak, çalışan için kırık bir üründür.
   *
   * Asıl tehlikesi ise ilerisi: "sayfa render oldu, demek ki yetkisi var"
   * varsayımıyla yazılacak bir sonraki kod yolu, bu kez gerçekten
   * sızdırırdı. Ekranlar arası tutarsızlık, o varsayımı davet ediyor.
   */
  if (!actorCan(actor, 'product:create')) redirect('/stok')

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
          imageUrl: optionalText(form, 'gorsel'),
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
    <>
      <h2 className="mb-4 font-display text-lg font-semibold">Yeni ürün</h2>
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-semibold">Yeni ürün</h1>
        <Link href="/stok" className="text-sm text-ink-2 underline">
          Stok tablosuna dön
        </Link>
      </div>

      <form action={submit} className="max-w-2xl space-y-5 rounded-card border border-line bg-surface shadow-card p-5">
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
          {/*
            Ad adres çubuğundan ÖN DOLDURULABİLİYOR (T86). Komut paletinde
            aranan bulunamayınca "yeni ürün ekle" satırı çıkıyor ve aranan
            metni buraya taşıyor — kullanıcı aynı şeyi iki kez yazmasın.
          */}
          <TextField name="ad" label="Ürün adı" required defaultValue={params.ad} />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <TextField name="kategori" label="Kategori" />
          <TextField name="marka" label="Marka" />
        </div>

        {/*
          GÖRSEL ADRES, DOSYA YÜKLEME DEĞİL (T82-T84). Dosya deposu seçimi
          PLAN.md ÇÖZÜLMEMİŞ KARAR U3'e (hosting) bağlı; karar verilmeden bir
          yükleme yolu gömmek U3'ü sessizce karara bağlamak olurdu. Adres
          modeli bugün çalışan yolu açıyor ve asıl doldurma yolu zaten toplu
          aktarma: 800 kalemi tek tek fotoğraflamak gerçekçi değil.
        */}
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            name="gorsel"
            label="Görsel adresi"
            placeholder="https://..."
            hint="Tedarikçi kataloğundaki adres. Boş bırakırsanız ürün adının baş harfleri gösterilir."
          />
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
            className="h-14 rounded-control border border-line-control px-6 text-base font-medium leading-[3.5rem]"
          >
            Vazgeç
          </Link>
        </div>
      </form>
    </>
  )
}
