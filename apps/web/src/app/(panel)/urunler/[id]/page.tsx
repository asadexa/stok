import {
  BARCODE_KINDS,
  BARCODE_KIND_VALUES,
  UNITS,
  UNIT_VALUES,
  type Unit,
  formatQty,
} from '@stok/shared'
import {
  addBarcode,
  archiveBarcode,
  archiveProduct,
  getProductDetail,
  listLocations,
  restoreProduct,
  updateProduct,
} from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Alert, Notice, SelectField, SubmitButton, TextField } from '@/components/field'
import { formatDate, formatMoney } from '@/lib/format'
import {
  errorQuery,
  messageFrom,
  nullableNumber,
  nullableText,
  numberOr,
  text,
  type FormParams,
} from '@/server/form'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T21 — ÜRÜN DÜZENLEME + BARKOD PANELİ
 *
 * ÜÇ AYRI FORM, tek dev form değil. Barkod ekleme ile ürün bilgisi
 * kaydetme aynı gönderime bağlansaydı, "gönderilen listede olmayan barkodu
 * sil" anlamına gelirdi ve tarayıcıda açık kalmış eski bir sekmeden gelen
 * kaydetme, aradaki eklemeleri sessizce silerdi.
 *
 * "SİL" DEĞİL "ARŞİVLE" yazıyor — hem üründe hem barkodda. Kullanıcıya
 * sildiğini söyleyip arşivlemek de bir hatadır: geri almak isteyen kişi
 * aramaya bile kalkışmaz.
 *
 * Çalışan bu ekranı GÖREBİLİR (barkodları, rafı, kritik eşiği okumak
 * işine yarar) ama düzenleme formları hiç basılmaz. Asıl kontrol yine
 * servis katmanında: menüden gizlemek adresi elle yazanı durdurmaz (S6).
 * ============================================================================
 */

/** Bu ekranın kendi bildirim parametreleri + ortak hata alanları. */
interface UrunParams extends FormParams {
  yeni?: string
  kaydedildi?: string
  barkod?: string
  arsiv?: string
}

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<UrunParams>
}) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')

  const { id } = await params
  const query = await searchParams
  const message = messageFrom(query)

  const db = appDb()
  const product = await getProductDetail(actor, id, { db }).catch(() => null)
  if (!product) notFound()

  const canEdit = actor.role === 'ADMIN'
  const locations = canEdit ? await listLocations(actor, { db }) : []
  const activeBarcodes = product.barcodes.filter((b) => b.archivedAt === null)

  // -------------------------------------------------------------------------
  // Sunucu eylemleri. Yetki kontrolü servislerde; buradaki `canEdit` sadece
  // ekranı sadeleştiriyor.
  // -------------------------------------------------------------------------

  async function saveDetails(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    try {
      await updateProduct(
        owner,
        id,
        {
          sku: text(form, 'sku'),
          name: text(form, 'ad'),
          unit: text(form, 'birim'),
          // Boş alan burada "temizle" demek, "dokunma" değil.
          category: nullableText(form, 'kategori'),
          brand: nullableText(form, 'marka'),
          imageUrl: nullableText(form, 'gorsel'),
          purchasePrice: nullableNumber(form, 'alis'),
          salePrice: nullableNumber(form, 'satis'),
          minStock: numberOr(form, 'minStok', 0),
          locationId: nullableText(form, 'konum'),
        },
        { db: appDb() },
      )
    } catch (err) {
      redirect(`/urunler/${id}?${errorQuery(err)}`)
    }
    redirect(`/urunler/${id}?kaydedildi=1`)
  }

  async function attachBarcode(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    const kind = text(form, 'tur')
    try {
      await addBarcode(
        owner,
        id,
        {
          barcode: text(form, 'barkod'),
          kind,
          // Koli dışındaki türlerde çarpan her zaman 1 (D7). Formdaki
          // alanı yok saymak yerine burada sabitliyoruz: kullanıcı türü
          // "Tekli"ye çevirip çarpanı 12 bırakırsa niyeti tekli barkoddur.
          qtyMultiplier: kind === 'CASE' ? numberOr(form, 'carpan', 0) : 1,
        },
        { db: appDb() },
      )
    } catch (err) {
      redirect(`/urunler/${id}?${errorQuery(err)}`)
    }
    redirect(`/urunler/${id}?barkod=eklendi`)
  }

  async function detachBarcode(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    try {
      await archiveBarcode(owner, text(form, 'barkodId'), { db: appDb() })
    } catch (err) {
      redirect(`/urunler/${id}?${errorQuery(err)}`)
    }
    redirect(`/urunler/${id}?barkod=kaldirildi`)
  }

  async function toggleArchive(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    const restore = text(form, 'islem') === 'geri'
    try {
      if (restore) await restoreProduct(owner, id, { db: appDb() })
      else await archiveProduct(owner, id, { db: appDb() })
    } catch (err) {
      redirect(`/urunler/${id}?${errorQuery(err)}`)
    }
    redirect(`/urunler/${id}?arsiv=${restore ? 'geri' : 'alindi'}`)
  }

  return (
    <>
      <h2 className="mb-4 font-display text-lg font-semibold">Ürün</h2>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">{product.name}</h1>
        <span className="tabular text-sm text-ink-3">{product.sku}</span>
        <Link href={`/hareketler?urun=${product.productId}`} className="text-sm underline">
          Hareketleri
        </Link>
        <Link href="/stok" className="text-sm text-ink-2 underline">
          Stok tablosuna dön
        </Link>
      </div>

      <div className="mb-4 space-y-3">
        {message ? <Alert>{message}</Alert> : null}
        {query.yeni ? <Notice>Ürün oluşturuldu. İsterseniz koli barkodu ekleyin.</Notice> : null}
        {query.kaydedildi ? <Notice>Değişiklikler kaydedildi.</Notice> : null}
        {query.barkod === 'eklendi' ? <Notice>Barkod eklendi.</Notice> : null}
        {query.barkod === 'kaldirildi' ? <Notice>Barkod kaldırıldı.</Notice> : null}
        {query.arsiv === 'alindi' ? <Notice>Ürün arşive alındı.</Notice> : null}
        {query.arsiv === 'geri' ? <Notice>Ürün arşivden çıkarıldı.</Notice> : null}

        {product.archivedAt ? (
          <p className="flex gap-2 rounded-md border border-line-control bg-surface-2 p-3 text-sm text-ink-2">
            <span aria-hidden>📦</span>
            <span>
              Bu ürün {formatDate(product.archivedAt)} tarihinde arşive alındı. Hareket
              yazılamaz; geçmişi ve stoğu duruyor.
            </span>
          </p>
        ) : null}
      </div>

      {/* MEVCUT DURUM — düzenleme formundan önce, çünkü ekrana bakan kişinin
          ilk sorusu "bu üründen kaç tane var". */}
      <section
        aria-label="Mevcut durum"
        className="mb-6 grid gap-3 rounded-md border border-line bg-surface p-4 sm:grid-cols-3"
      >
        <Stat
          label="Eldeki stok"
          value={formatQty(product.qty, product.unit as Unit)}
          tone={product.critical ? 'kritik' : 'normal'}
          suffix={product.critical ? '⚠ kritik' : undefined}
        />
        <Stat label="Kritik eşik" value={formatQty(product.minStock, product.unit as Unit)} />
        <Stat
          label="Son hareket"
          value={product.lastMovementAt ? formatDate(product.lastMovementAt) : 'Hiç'}
        />
      </section>

      {canEdit ? (
        <form
          action={saveDetails}
          className="mb-6 max-w-2xl space-y-5 rounded-md border border-line bg-surface p-5"
        >
          <h2 className="font-semibold">Ürün bilgileri</h2>

          <div className="grid gap-5 sm:grid-cols-2">
            <TextField name="sku" label="Stok kodu" required defaultValue={product.sku} />
            <TextField name="ad" label="Ürün adı" required defaultValue={product.name} />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <TextField name="kategori" label="Kategori" defaultValue={product.category} />
            <TextField name="marka" label="Marka" defaultValue={product.brand} />
            <TextField
              name="gorsel"
              label="Görsel adresi"
              defaultValue={product.imageUrl}
              placeholder="https://..."
              hint="Tedarikçi kataloğundaki adres. Boş bırakırsanız ürün adının baş harfleri gösterilir."
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-3">
            <SelectField
              name="birim"
              label="Birim"
              defaultValue={product.unit}
              options={UNIT_VALUES.map((u) => ({ value: u, label: UNITS[u].tr }))}
            />
            <TextField
              name="minStok"
              label="Kritik eşik"
              type="number"
              defaultValue={String(product.minStock)}
            />
            <SelectField
              name="konum"
              label="Raf / konum"
              emptyLabel="Belirtilmedi"
              defaultValue={locations.find((l) => l.code === product.locationCode)?.id ?? ''}
              options={locations.map((l) => ({ value: l.id, label: `${l.code} — ${l.name}` }))}
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              name="alis"
              label="Alış fiyatı (₺)"
              type="number"
              defaultValue={product.purchasePrice == null ? '' : formatMoney(product.purchasePrice)}
              hint="Boş bırakırsanız temizlenir."
            />
            <TextField
              name="satis"
              label="Satış fiyatı (₺)"
              type="number"
              defaultValue={product.salePrice == null ? '' : formatMoney(product.salePrice)}
            />
          </div>

          <SubmitButton>Kaydet</SubmitButton>
        </form>
      ) : null}

      {/* BARKODLAR */}
      <section
        aria-label="Barkodlar"
        className="mb-6 max-w-2xl rounded-md border border-line bg-surface"
      >
        <h2 className="border-b border-line px-4 py-3 font-semibold">Barkodlar</h2>

        <ul>
          {product.barcodes.map((b) => (
            <li
              key={b.id}
              className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 text-sm"
            >
              <span
                className={`tabular font-medium ${b.archivedAt ? 'text-ink-3 line-through' : ''}`}
              >
                {b.barcode}
              </span>
              <span className="text-ink-2">{BARCODE_KINDS[b.kind].tr}</span>
              {b.qtyMultiplier !== 1 ? (
                <span className="tabular rounded-md bg-surface-2 px-2 py-1 text-xs">
                  ×{b.qtyMultiplier}
                </span>
              ) : null}
              {b.archivedAt ? (
                <span className="text-xs text-ink-3">
                  {formatDate(b.archivedAt)} tarihinde kaldırıldı
                </span>
              ) : null}

              {canEdit && !b.archivedAt ? (
                <form action={detachBarcode} className="ml-auto">
                  <input type="hidden" name="barkodId" value={b.id} />
                  <button
                    type="submit"
                    // "Sil" demiyor: barkod arşivleniyor, geçmişteki
                    // hareketler hangi barkodun okutulduğunu göstermeye
                    // devam ediyor.
                    className="rounded-md border border-line-control px-3 py-2 text-sm hover:bg-surface-2"
                    disabled={activeBarcodes.length <= 1}
                    title={
                      activeBarcodes.length <= 1
                        ? 'Son barkod kaldırılamaz. Önce yenisini ekleyin.'
                        : undefined
                    }
                  >
                    Kaldır
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>

        {canEdit ? (
          <form action={attachBarcode} className="space-y-4 p-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField name="barkod" label="Yeni barkod" required placeholder="Okutun" />
              <SelectField
                name="tur"
                label="Tür"
                defaultValue="UNIT"
                options={BARCODE_KIND_VALUES.map((k) => ({
                  value: k,
                  label: BARCODE_KINDS[k].tr,
                }))}
              />
              <TextField
                name="carpan"
                label="Koli içi adet"
                type="number"
                hint="Sadece koli barkodunda. 12'li koli için 12."
              />
            </div>
            <SubmitButton tone="secondary">Barkod ekle</SubmitButton>
          </form>
        ) : null}
      </section>

      {canEdit ? (
        <form action={toggleArchive} className="max-w-2xl">
          <input type="hidden" name="islem" value={product.archivedAt ? 'geri' : 'al'} />
          <SubmitButton tone={product.archivedAt ? 'secondary' : 'danger'}>
            {product.archivedAt ? 'Arşivden çıkar' : 'Ürünü arşivle'}
          </SubmitButton>
          <p className="mt-2 text-xs text-ink-3">
            {product.archivedAt
              ? 'Ürün yeniden okutulabilir hale gelir.'
              : 'Arşivlenen ürüne hareket yazılamaz. Geçmişi ve stoğu silinmez, listede "arşiv dahil" filtresiyle görünür.'}
          </p>
        </form>
      ) : null}
    </>
  )
}

function Stat({
  label,
  value,
  tone = 'normal',
  suffix,
}: {
  label: string
  value: string
  tone?: 'normal' | 'kritik'
  suffix?: string
}) {
  return (
    <div>
      <p className="text-sm text-ink-2">{label}</p>
      <p className={`tabular mt-1 text-2xl font-semibold ${tone === 'kritik' ? 'text-kritik' : ''}`}>
        {value}
      </p>
      {suffix ? <p className="text-sm text-kritik">{suffix}</p> : null}
    </div>
  )
}
