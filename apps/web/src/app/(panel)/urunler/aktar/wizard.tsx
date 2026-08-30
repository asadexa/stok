'use client'

import type { ImportPreview, PreviewRow } from '@stok/core'
import { useActionState } from 'react'
import type { AnalyzeState } from './actions'

/**
 * İçe aktarma sihirbazı: yükle → önizle → onayla.
 *
 * ONAY DÜĞMESİ HATALI SATIR SAYISINI GÖSTERİYOR. "Aktar" yazan bir düğme,
 * kullanıcıya 60 satırın atlanacağını söylemeden onay aldırırdı; sonra
 * eksik ürünler haftalar sonra fark edilirdi.
 */
export function ImportWizard({
  analyze,
  commit,
}: {
  analyze: (prev: AnalyzeState, form: FormData) => Promise<AnalyzeState>
  commit: (prev: AnalyzeState, form: FormData) => Promise<AnalyzeState>
}) {
  const [state, analyzeAction, analyzing] = useActionState(analyze, {} as AnalyzeState)
  const [committed, commitAction, committing] = useActionState(commit, {} as AnalyzeState)

  const result = committed.result
  const error = committed.error ?? state.error

  return (
    <div className="space-y-6">
      {error ? (
        <p
          role="alert"
          className="flex gap-2 rounded-control border border-kritik bg-kritik-bg p-3 text-sm text-kritik"
        >
          <span aria-hidden>⚠</span>
          <span>{error}</span>
        </p>
      ) : null}

      {result ? (
        <ResultPanel result={result} />
      ) : (
        <>
          <form action={analyzeAction} className="space-y-4 rounded-card border border-line bg-surface shadow-card p-5">
            <label className="block">
              <span className="text-sm font-medium">Dosya (.xlsx veya .csv)</span>
              <input
                type="file"
                name="dosya"
                accept=".xlsx,.csv,text/csv"
                required
                className="mt-1 block w-full rounded-control border border-line-control bg-surface p-3 text-base file:mr-3 file:rounded file:border-0 file:bg-accent file:px-4 file:py-2 file:text-accent-ink"
              />
            </label>
            <button
              type="submit"
              disabled={analyzing}
              className="h-14 rounded-control bg-accent px-6 text-base font-medium text-accent-ink hover:brightness-110 disabled:opacity-60"
            >
              {analyzing ? 'Okunuyor…' : 'Dosyayı oku ve önizle'}
            </button>
          </form>

          {state.preview ? (
            <PreviewPanel
              preview={state.preview}
              fileName={state.fileName ?? ''}
              fileJson={JSON.stringify(state.file)}
              commitAction={commitAction}
              committing={committing}
            />
          ) : null}
        </>
      )}
    </div>
  )
}

function PreviewPanel({
  preview,
  fileName,
  fileJson,
  commitAction,
  committing,
}: {
  preview: ImportPreview
  fileName: string
  fileJson: string
  commitAction: (form: FormData) => void
  committing: boolean
}) {
  const { create, update, error } = preview.counts
  const errorRows = preview.rows.filter((r) => r.action === 'error')

  return (
    <section aria-label="Önizleme" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Count label="Yeni eklenecek" value={create} tone="giris" />
        <Count label="Güncellenecek" value={update} />
        <Count label="Atlanacak (hatalı)" value={error} tone={error > 0 ? 'kritik' : undefined} />
      </div>

      {errorRows.length > 0 ? (
        <div className="rounded-card border border-kritik bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="font-semibold text-kritik">Hatalı satırlar</h2>
            {/* Rapor indirme DÜZ FORM POST: 60 satırlık hatayı ekrandan tek
                tek okuyup düzeltmek mümkün değil, kullanıcı iki dosyayı yan
                yana açacak. */}
            <form method="post" action="/api/rapor/aktarim-hatalari">
              <input type="hidden" name="dosyaJson" value={fileJson} />
              <button
                type="submit"
                className="rounded-control border border-line-control px-4 py-2 text-sm hover:bg-surface-2"
              >
                Hata raporunu indir
              </button>
            </form>
          </div>
          <ErrorTable rows={errorRows.slice(0, 50)} />
          {errorRows.length > 50 ? (
            <p className="border-t border-line px-4 py-2 text-sm text-ink-2">
              …ve {errorRows.length - 50} satır daha. Tamamı için raporu indirin.
            </p>
          ) : null}
        </div>
      ) : null}

      <form action={commitAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="dosyaJson" value={fileJson} />
        <input type="hidden" name="dosyaAdi" value={fileName} />
        <button
          type="submit"
          disabled={committing || create + update === 0}
          className="h-14 rounded-control bg-accent px-6 text-base font-medium text-accent-ink hover:brightness-110 disabled:opacity-60"
        >
          {committing ? 'Aktarılıyor…' : `${create + update} satırı aktar`}
        </button>
        {error > 0 ? (
          <span className="text-sm text-ink-2">
            {error} hatalı satır atlanacak. Önce düzeltmek isterseniz raporu indirin.
          </span>
        ) : null}
      </form>
    </section>
  )
}

function ResultPanel({ result }: { result: NonNullable<AnalyzeState['result']> }) {
  return (
    <section aria-label="Sonuç" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Count label="Eklendi" value={result.created} tone="giris" />
        <Count label="Güncellendi" value={result.updated} />
        <Count
          label="Aktarılamadı"
          value={result.failed}
          tone={result.failed > 0 ? 'kritik' : undefined}
        />
      </div>

      {result.errors.length > 0 ? (
        <div className="rounded-card border border-kritik bg-surface">
          <h2 className="border-b border-line px-4 py-3 font-semibold text-kritik">
            Aktarılamayan satırlar
          </h2>
          <ErrorTable rows={result.errors.slice(0, 50)} />
        </div>
      ) : null}

      <a
        href="/urunler/aktar"
        className="inline-flex h-14 items-center rounded-control border border-line-control bg-surface px-5 text-base font-medium hover:bg-surface-2"
      >
        Yeni dosya yükle
      </a>
    </section>
  )
}

function ErrorTable({ rows }: { rows: PreviewRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-ink-3">
          <tr>
            <th className="px-4 py-2 font-medium">Satır</th>
            <th className="px-4 py-2 font-medium">Stok Kodu</th>
            <th className="px-4 py-2 font-medium">Ürün</th>
            <th className="px-4 py-2 font-medium">Sorun</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.rowNumber} className="border-t border-line align-top">
              <td className="tabular px-4 py-2">{row.rowNumber}</td>
              <td className="tabular px-4 py-2">{row.sku || '—'}</td>
              <td className="px-4 py-2">{row.name || '—'}</td>
              <td className="px-4 py-2 text-ink-2">
                {row.issues.map((issue, i) => (
                  // satırın sorun listesi; önizleme boyunca sabit ve
                  // sıralanmıyor. Sorunların kararlı bir kimliği yok.
                  // biome-ignore lint/suspicious/noArrayIndexKey: tek bir
                  <div key={i}>
                    {issue.column ? (
                      <span className="font-medium">{issue.column}: </span>
                    ) : null}
                    {issue.message}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Count({
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
      <p className={`tabular mt-1 text-3xl font-semibold ${color}`}>{value}</p>
    </div>
  )
}
