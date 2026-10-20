import { actorCan, createSupplier, listSuppliers } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Badge } from '@/components/badge'
import { EmptyState } from '@/components/empty-state'
import { Alert, SubmitButton } from '@/components/field'
import { conditionLabel } from '@/components/supplier-price'
import { formatCount, formatDateTime } from '@/lib/format'
import { type FormParams, messageFrom, preserveFields, safeErrorQuery } from '@/server/form'
import { currentActor } from '@/server/session'
import {
  SUPPLIER_FORM_FIELDS,
  SupplierFormFields,
  type SupplierFormValues,
  supplierInput,
} from './supplier-form'

/**
 * ============================================================================
 * T200 — TEDARİKÇİLER (B2B V1, PRD-14)
 *
 * YALNIZ YÖNETİCİ. Tedarikçi fiyatı alış fiyatı niteliğinde (INV-10); çalışan
 * bu adrese gelirse panele gönderiliyor. Asıl kontrol core'da: her tedarikçi
 * fonksiyonu `supplier:read` / `supplier:manage` istiyor, buradaki
 * yönlendirme yalnız ekranı sadeleştiriyor (tehdit S6).
 * ============================================================================
 */

interface TedarikcilerParams extends FormParams, SupplierFormValues {}

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<TedarikcilerParams>
}) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')
  if (!actorCan(actor, 'supplier:read')) redirect('/panel')

  const params = await searchParams
  const message = messageFrom(params)
  const suppliers = await listSuppliers(actor, { db: appDb() })

  async function addSupplier(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    // Yönlendirme `try` DIŞINDA (server/form.ts: rethrowControlFlow).
    let target: string
    try {
      const created = await createSupplier(owner, supplierInput(form), { db: appDb() })
      target = `/tedarikciler/${created.id}?yeni=1`
    } catch (err) {
      target = `/tedarikciler?${safeErrorQuery('supplier create', err)}&${preserveFields(form, SUPPLIER_FORM_FIELDS)}#yeni-tedarikci`
    }
    redirect(target)
  }

  return (
    <>
      <h2 className="mb-4 font-display text-lg font-semibold">Tedarikçiler</h2>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Tedarikçi fiyat ve stok verisi</h1>
        <Link href="/panel" className="text-sm text-ink-2 underline">
          Panele dön
        </Link>
      </div>

      <p className="mb-4 max-w-3xl text-sm text-ink-2">
        Tedarikçinin fiyat listesini yükleyin; aynı ürünün tedarikçilerdeki fiyatını ve stoğunu
        ürün sayfasında karşılaştırın. Tedarikçi verisi ürün kartının fiyatını ve stoğunuzu
        değiştirmez.
      </p>

      {message ? (
        <div className="mb-4">
          <Alert>{message}</Alert>
        </div>
      ) : null}

      <section
        aria-label="Tedarikçi listesi"
        className="mb-6 rounded-card border border-line bg-surface shadow-card"
      >
        <h2 className="border-b border-line px-4 py-3 font-semibold">
          {formatCount(suppliers.length)} tedarikçi
        </h2>
        {suppliers.length === 0 ? (
          <EmptyState
            title="Henüz tedarikçi yok"
            description="Bir tedarikçi ekleyin, ardından fiyat listesini Excel, CSV ya da JSON olarak yükleyin."
            action={{ href: '#yeni-tedarikci', label: 'Yeni tedarikçi ekle' }}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-ink-3">
                <tr>
                  <th className="px-4 py-2 font-medium">Tedarikçi</th>
                  <th className="px-4 py-2 text-right font-medium">Kalem</th>
                  <th className="px-4 py-2 font-medium">Eşleşme bekleyen</th>
                  <th className="px-4 py-2 font-medium">Son veri alma</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr key={s.id} className="border-t border-line align-top">
                    <td className="px-4 py-3">
                      <Link href={`/tedarikciler/${s.id}`} className="font-medium underline">
                        {s.name}
                      </Link>
                      <span className="mt-0.5 block text-xs text-ink-2">
                        {conditionLabel({
                          currency: s.defaultCurrency,
                          taxMode: s.defaultTaxMode,
                          priceType: s.defaultPriceType,
                        })}{' '}
                        · Fiyat miktarı: {s.unitPriceDeclared ? '1 ürün birimi' : 'belirsiz'}
                      </span>
                    </td>
                    <td className="tabular px-4 py-3 text-right">{formatCount(s.itemCount)}</td>
                    <td className="px-4 py-3">
                      {s.unmatchedCount > 0 ? (
                        <Badge tone="warn">{formatCount(s.unmatchedCount)} kalem</Badge>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {s.lastRefreshedAt ? formatDateTime(s.lastRefreshedAt) : 'Henüz veri alınmadı'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form
        id="yeni-tedarikci"
        action={addSupplier}
        className="max-w-2xl space-y-5 rounded-card border border-line bg-surface shadow-card p-5"
      >
        <h2 className="font-semibold">Yeni tedarikçi</h2>
        <SupplierFormFields values={params} />
        <SubmitButton>Tedarikçiyi ekle</SubmitButton>
      </form>
    </>
  )
}
