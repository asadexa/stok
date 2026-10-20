'use client'

import type { FeedRowIssue, RefreshSampleRow } from '@stok/core'
import { SUPPLIER_MATCH_STATES } from '@stok/shared'
import { useActionState, useState } from 'react'
import { CountTile } from '@/components/count-tile'
import { SupplierPrice, conditionLabel, priceQtyLabel } from '@/components/supplier-price'
import { formatCount } from '@/lib/format'
import type { ClientSummary, RefreshState } from './actions'

/**
 * "Verileri Getir": dosya seç → önizle → kaydet (T200 1b, PRD-15).
 *
 * ÖNİZLEME FİYAT ONAYI DEĞİL. Fiyat ve stok değişimleri tek tek onaylanmıyor
 * (PRD-14); bu adım dosyanın DOĞRU OKUNDUĞUNU gösteriyor: hangi sütun okundu,
 * hangisi okunmadı, ilk satırların fiyatı nasıl okundu. "1.234"ün bin mi bir
 * virgül iki mi okunduğu (T205) ancak burada görülür.
 *
 * DOSYA BOYUTU TARAYICIDA DA KONTROL EDİLİYOR. Sunucunun gövde sınırı bütün
 * isteğe uygulanıyor; sınırı aşan bir dosya eyleme hiç ulaşmadan reddedilir
 * ve kullanıcı Türkçe bir neden göremezdi. Asıl kontrol yine sunucuda.
 */
export function RefreshWizard({
  supplierId,
  maxUploadBytes,
  uploadLabel,
  preview,
  save,
}: {
  supplierId: string
  maxUploadBytes: number
  uploadLabel: string
  preview: (prev: RefreshState, form: FormData) => Promise<RefreshState>
  save: (prev: RefreshState, form: FormData) => Promise<RefreshState>
}) {
  const [state, previewAction, previewing] = useActionState(preview, {} as RefreshState)
  const [saved, saveAction, saving] = useActionState(save, {} as RefreshState)
  const [sizeError, setSizeError] = useState<string | null>(null)

  const error = sizeError ?? saved.error ?? state.error

  if (saved.saved) {
    return (
      <div className="space-y-4">
        <p role="status" className="flex gap-2 rounded-control border border-ok bg-ok-soft p-3 text-sm text-ok-soft-ink">
          <span aria-hidden>✓</span>
          <span>
            {saved.fileName ? `“${saved.fileName}” kaydedildi.` : 'Kaydedildi.'} Aşağıdaki listeler
            güncellendi.
          </span>
        </p>
        <SummaryPanel summary={saved.saved} mode="kayıt" />
        <a
          href={`/tedarikciler/${supplierId}#verileri-getir`}
          className="inline-flex h-13 items-center rounded-control border border-line-control bg-surface px-5 text-base font-semibold hover:bg-surface-2"
        >
          Yeni dosya yükle
        </a>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {error ? (
        <p role="alert" className="flex gap-2 rounded-control border border-crit bg-crit-soft p-3 text-sm text-crit-soft-ink">
          <span aria-hidden>⚠</span>
          <span>{error}</span>
        </p>
      ) : null}

      <form action={previewAction} className="space-y-4">
        <input type="hidden" name="tedarikciId" value={supplierId} />
        <label className="block">
          <span className="text-[13px] font-semibold">Fiyat listesi (.xlsx, .csv ya da .json)</span>
          <input
            type="file"
            name="dosya"
            accept=".xlsx,.csv,.json,text/csv,application/json"
            required
            onChange={(event) => {
              const picked = event.currentTarget.files?.[0]
              setSizeError(
                picked && picked.size > maxUploadBytes
                  ? `Dosya çok büyük (${(picked.size / (1024 * 1024)).toFixed(1)} MB). En fazla ${uploadLabel} yükleyebilirsiniz — dosyayı bölüp parçaları ayrı ayrı yükleyin.`
                  : null,
              )
            }}
            className="mt-1.5 block w-full rounded-control border border-line-control bg-surface p-3 text-base file:mr-3 file:rounded file:border-0 file:bg-accent file:px-4 file:py-2 file:text-accent-ink"
          />
          <span className="mt-1.5 block text-xs text-ink-2">
            Zorunlu sütunlar: Ürün Adı, Fiyat ve Tedarikçi Kodu ya da Barkod. En fazla {uploadLabel}, 5.000 satır.
          </span>
        </label>
        <button
          type="submit"
          disabled={previewing || sizeError !== null}
          className="h-13 rounded-control bg-accent px-6 text-base font-semibold text-accent-ink hover:brightness-110 disabled:opacity-60"
        >
          {previewing ? 'Okunuyor…' : 'Dosyayı oku ve önizle'}
        </button>
      </form>

      {state.preview && state.fileJson ? (
        <section aria-label="Önizleme" className="space-y-4">
          <p className="text-sm text-ink-2">
            Bu adım dosyanın doğru okunduğunu gösterir. Fiyat ve stok değişimleri tek tek onaylanmaz;
            kaydettiğinizde hepsi yazılır. Ürün kartının fiyatı ve stoğunuz değişmez.
          </p>

          <ColumnsPanel
            columns={state.columns ?? []}
            ignored={state.ignoredColumns ?? []}
            omitted={state.ignoredColumnsOmitted ?? 0}
          />
          <SummaryPanel summary={state.preview} mode="önizleme" />

          {state.saveBlocked ? (
            <p role="alert" className="flex gap-2 rounded-control border border-crit bg-crit-soft p-3 text-sm text-crit-soft-ink">
              <span aria-hidden>⚠</span>
              <span>
                Dosya okundu ama kaydetmek için çok büyük. Dosyayı bölüp parçaları ayrı ayrı yükleyin.
              </span>
            </p>
          ) : null}

          <form action={saveAction} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="tedarikciId" value={supplierId} />
            <input type="hidden" name="dosyaJson" value={state.fileJson} />
            <input type="hidden" name="dosyaAdi" value={state.fileName ?? ''} />
            <button
              type="submit"
              disabled={saving || state.preview.valid === 0 || state.saveBlocked}
              className="h-13 rounded-control bg-accent px-6 text-base font-semibold text-accent-ink hover:brightness-110 disabled:opacity-60"
            >
              {saving ? 'Kaydediliyor…' : `${formatCount(state.preview.valid)} kalemi kaydet`}
            </button>
            {state.preview.errorCount > 0 ? (
              <span className="text-sm text-ink-2">
                {formatCount(state.preview.errorCount)} hatalı satır atlanacak. Önce düzeltmek isterseniz dosyayı
                düzeltip yeniden önizleyin.
              </span>
            ) : null}
          </form>
        </section>
      ) : null}
    </div>
  )
}

function ColumnsPanel({
  columns,
  ignored,
  omitted,
}: {
  columns: { label: string; header: string }[]
  ignored: string[]
  /** Listeye sığmayan okunmayan sütunlar; ad yok, yalnız sayı. */
  omitted: number
}) {
  return (
    <div className="space-y-2 rounded-card border border-line bg-surface p-4 text-sm">
      <p>
        <span className="font-semibold">Okunan sütunlar: </span>
        {columns.map((c) => `${c.label} ← “${c.header}”`).join(' · ')}
      </p>
      {ignored.length > 0 ? (
        <p role="status" className="rounded-control border border-warn bg-warn-soft p-2 text-warn-soft-ink">
          ⚠ Okunmayan sütunlar: {ignored.join(', ')}
          {omitted > 0 ? ` …ve ${formatCount(omitted)} sütun daha` : ''}. Bu sütunlar kaydedilmez.
        </p>
      ) : null}
    </div>
  )
}

/** Önizleme ve kayıt aynı özeti gösteriyor; kayıtta sayılar kaydın kendisinden. */
function SummaryPanel({ summary, mode }: { summary: ClientSummary; mode: 'önizleme' | 'kayıt' }) {
  const future = mode === 'önizleme'
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CountTile label={future ? 'Kaydedilecek satır' : 'Kaydedilen satır'} value={summary.valid} tone="giris" />
        <CountTile
          label="Hatalı (atlanan)"
          value={summary.errorCount}
          tone={summary.errorCount > 0 ? 'kritik' : undefined}
        />
        <CountTile label="Yeni kalem" value={summary.created} />
        <CountTile label="Güncellenen kalem" value={summary.updated} />
      </div>

      <dl className="grid gap-x-6 gap-y-1 rounded-card border border-line bg-surface p-4 text-sm sm:grid-cols-2">
        <Stat label="Fiyatı artan" value={summary.priceUp} />
        <Stat label="Fiyatı azalan" value={summary.priceDown} />
        <Stat label="Koşulu değişen (para birimi, KDV, tür, miktar)" value={summary.conditionChanged} />
        <Stat label="Fiyatı değişen, miktarı belirsiz" value={summary.qtyUnknownChanged} />
        <Stat label="Değişmeyen" value={summary.unchanged} />
        <Stat label="Barkodla yeni eşleşen" value={summary.autoMatched} />
        <Stat label="Eşleşme bekleyen" value={summary.unmatched} />
        <Stat label="Fiyat miktarı belirsiz (karşılaştırmaya girmez)" value={summary.priceQtyUnknown} />
      </dl>

      {summary.sample.length > 0 ? <SampleTable rows={summary.sample} /> : null}
      {summary.errors.length > 0 ? (
        <IssueTable title="Hatalı satırlar (atlanır)" rows={summary.errors} total={summary.errorCount} tone="crit" />
      ) : null}
      {summary.warnings.length > 0 ? (
        <IssueTable title="Uyarılar (satır kaydedilir)" rows={summary.warnings} total={summary.warningCount} tone="warn" />
      ) : null}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-3 py-1">
      <dt className="text-ink-2">{label}</dt>
      <dd className="tabular font-semibold">{formatCount(value)}</dd>
    </div>
  )
}

function SampleTable({ rows }: { rows: RefreshSampleRow[] }) {
  return (
    <div className="rounded-card border border-line bg-surface">
      <h3 className="border-b border-line px-4 py-3 font-semibold">İlk satırlar, okunduğu hâliyle</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="text-left text-ink-3">
            <tr>
              <th className="px-4 py-2 font-medium">Satır</th>
              <th className="px-4 py-2 font-medium">Kalem</th>
              <th className="px-4 py-2 font-medium">Okunan fiyat</th>
              <th className="px-4 py-2 font-medium">Tedarikçi stoğu</th>
              <th className="px-4 py-2 font-medium">Eşleşme</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rowNumber} className="border-t border-line align-top">
                <td className="tabular px-4 py-2">{r.rowNumber}</td>
                <td className="px-4 py-2">
                  <span className="font-medium">{r.name}</span>
                  <span className="block text-xs text-ink-2">
                    {r.supplierCode}
                    {r.barcode && r.barcode !== r.supplierCode ? ` · ${r.barcode}` : ''}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <SupplierPrice price={r.price} currency={r.currency} />
                  <span className="block text-xs text-ink-2">
                    {conditionLabel(r)} · {priceQtyLabel(r.priceQty)}
                  </span>
                </td>
                <td className="tabular px-4 py-2">{r.stockQty === null ? 'Bildirilmedi' : formatStock(r.stockQty)}</td>
                <td className="px-4 py-2">
                  {r.productName ? (
                    <>
                      <span className="font-medium">{r.productName}</span>
                      <span className="block text-xs text-ink-2">
                        {r.productSku} · {SUPPLIER_MATCH_STATES[r.matchState].tr}
                      </span>
                    </>
                  ) : (
                    <span className="text-ink-2">{SUPPLIER_MATCH_STATES[r.matchState].tr}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const stockFmt = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 3 })

function formatStock(value: string): string {
  return stockFmt.format(Number(value))
}

function IssueTable({
  title,
  rows,
  total,
  tone,
}: {
  title: string
  rows: FeedRowIssue[]
  total: number
  tone: 'crit' | 'warn'
}) {
  return (
    <div className={`rounded-card border bg-surface ${tone === 'crit' ? 'border-crit' : 'border-warn'}`}>
      <h3 className="border-b border-line px-4 py-3 font-semibold">
        {title}: {formatCount(total)}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-left text-ink-3">
            <tr>
              <th className="px-4 py-2 font-medium">Satır</th>
              <th className="px-4 py-2 font-medium">Kod</th>
              <th className="px-4 py-2 font-medium">Ad</th>
              <th className="px-4 py-2 font-medium">Sorun</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rowNumber} className="border-t border-line align-top">
                <td className="tabular px-4 py-2">{r.rowNumber}</td>
                <td className="tabular px-4 py-2">{r.supplierCode || '—'}</td>
                <td className="px-4 py-2">{r.name || '—'}</td>
                <td className="px-4 py-2 text-ink-2">{r.messages.join('; ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > rows.length ? (
        <p className="border-t border-line px-4 py-2 text-sm text-ink-2">
          …ve {formatCount(total - rows.length)} satır daha. Dosyayı düzeltip yeniden önizleyin.
        </p>
      ) : null}
    </div>
  )
}
