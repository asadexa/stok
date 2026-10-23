'use client'

import type { ImportRunPreview, ImportRunProgress, ImportRunReportRow, RawRow } from '@stok/core'
import { errorText } from '@stok/shared'
import { useEffect, useRef, useState } from 'react'
import { CountTile } from '@/components/count-tile'
import { formatCount } from '@/lib/format'
import type { ActionResult } from './actions'
import type { ParseResult } from './parse.worker'

/**
 * ============================================================================
 * TOPLU AKTARMA SİHİRBAZI (T23, T171): yükle → önizle → aktar → sonuç
 *
 * Dosya TARAYICIDA bir Web Worker'da çözümleniyor; sayfa donmuyor. Hücreler
 * küçük parçalarla sunucuya gidiyor, önizleme sunucuda hesaplanıyor. Aktarım
 * kısa parçalarla ilerliyor: ilerleme çubuğu gerçek sayılardan, iptal yeni
 * satır başlatmıyor, yapılanlar geri alınmıyor.
 *
 * ONAY DÜĞMESİ HATALI SATIR SAYISINI GÖSTERİYOR. "Aktar" yazan bir düğme,
 * kullanıcıya 60 satırın atlanacağını söylemeden onay aldırırdı; eksik
 * ürünler haftalar sonra fark edilirdi.
 * ============================================================================
 */

interface ImportActions {
  start: (meta: unknown) => Promise<ActionResult<{ runId: string }>>
  append: (runId: string, rows: unknown) => Promise<ActionResult<{ received: number; total: number }>>
  preview: (runId: string) => Promise<ActionResult<ImportRunPreview>>
  begin: (runId: string) => Promise<ActionResult<ImportRunProgress>>
  chunk: (runId: string) => Promise<ActionResult<ImportRunProgress>>
  cancel: (runId: string) => Promise<ActionResult<ImportRunProgress>>
  report: (runId: string) => Promise<ActionResult<ImportRunReportRow[]>>
}

type Phase =
  | { step: 'select' }
  | { step: 'reading'; fileName: string }
  | { step: 'uploading'; fileName: string; sent: number; total: number }
  | { step: 'preview'; fileName: string; runId: string; preview: ImportRunPreview }
  | { step: 'running'; fileName: string; runId: string; progress: ImportRunProgress; cancelling: boolean; stalled: boolean }
  | { step: 'result'; fileName: string; runId: string; progress: ImportRunProgress; report: ImportRunReportRow[] }

/**
 * Bir ekleme isteğinin en fazla kodlanmış boyutu. Sunucu eyleminin gövde
 * sınırının (4 MiB, T118) yarısının altında: zarf ve Türkçe karakterlerin
 * iki baytlık kodlaması payı kalsın.
 */
const APPEND_BYTES = 1_500_000
const UNREACHABLE = 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Yalnız TEKRARI ZARARSIZ istekler için: parça işleme, iptal, rapor. Kesinti
 * ya da "işleniyor" yanıtında birkaç kez, artan beklemeyle deneniyor; ağ
 * kopması bir yanıtı kaybettiyse sonraki çağrı gerçek durumu getiriyor.
 */
async function retrying<T>(call: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  for (let attempt = 0; ; attempt += 1) {
    let result: ActionResult<T>
    try {
      result = await call()
    } catch {
      result = { ok: false, error: UNREACHABLE, retryable: true }
    }
    if (result.ok || !result.retryable || attempt >= 4) return result
    await sleep(1_000 * 2 ** attempt)
  }
}

/** Tek seferlik istekler (başlat, ekle, önizle, onayla): kopma hata olarak gösteriliyor. */
async function once<T>(call: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await call()
  } catch {
    return { ok: false, error: UNREACHABLE, retryable: false }
  }
}

function parseInWorker(file: File): Promise<ParseResult | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<ParseResult>) => {
      worker.terminate()
      resolve(event.data)
    }
    // İşçi yüklenemedi ya da çöktü (ör. bellek): dosyanın suçu olmayabilir.
    worker.onerror = () => {
      worker.terminate()
      resolve(null)
    }
    worker.postMessage(file)
  })
}

/** Satırları bayt ve satır sınırına göre ekleme parçalarına böler. */
function appendBatches(rows: RawRow[], maxRows: number): RawRow[][] {
  const encoder = new TextEncoder()
  const batches: RawRow[][] = []
  let batch: RawRow[] = []
  let bytes = 0
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify(row)).byteLength
    if (batch.length > 0 && (bytes + size > APPEND_BYTES || batch.length >= maxRows)) {
      batches.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(row)
    bytes += size
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

export function ImportWizard({
  actions,
  fileBytesLimit,
  appendMaxRows,
}: {
  actions: ImportActions
  fileBytesLimit: number
  appendMaxRows: number
}) {
  const [phase, setPhase] = useState<Phase>({ step: 'select' })
  const [error, setError] = useState<string | null>(null)
  const cancelRequested = useRef(false)

  // Okuma, yükleme ya da aktarım sürerken sekme kapatılırsa tarayıcı soruyor.
  // Aktarım yarıda kalırsa yapılan satırlar korunuyor; uyarı kullanıcının
  // bilmeden durdurmasını önlemek için.
  const busy = phase.step === 'reading' || phase.step === 'uploading' || phase.step === 'running'
  useEffect(() => {
    if (!busy) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [busy])

  async function readAndPreview(form: FormData) {
    setError(null)
    const upload = form.get('dosya')
    if (!(upload instanceof File) || upload.size === 0) {
      setError('Önce bir dosya seçin.')
      return
    }
    // Okumadan ÖNCE: sınırın çok üstündeki dosya tarayıcı belleğine hiç alınmasın.
    if (upload.size > fileBytesLimit) {
      setError(errorText('IMPORT_FILE_TOO_LARGE', { limitMb: fileBytesLimit / (1024 * 1024) }))
      return
    }

    const fileName = upload.name
    setPhase({ step: 'reading', fileName })
    const parsed = await parseInWorker(upload)
    if (!parsed) {
      setPhase({ step: 'select' })
      setError('Dosya bu tarayıcıda okunamadı. Sayfayı yenileyip tekrar deneyin.')
      return
    }
    if (!parsed.ok) {
      setPhase({ step: 'select' })
      setError(errorText(parsed.code, parsed.details))
      return
    }
    const { rows, columns, ignoredQtyColumns } = parsed.file
    if (rows.length === 0) {
      setPhase({ step: 'select' })
      setError('Dosyada başlık satırından sonra ürün satırı bulunamadı.')
      return
    }

    const started = await once(() =>
      actions.start({ fileName, fileBytes: upload.size, totalRows: rows.length, columns, ignoredQtyColumns }),
    )
    if (!started.ok) return failUpload(started.error)
    const { runId } = started.value

    let sent = 0
    setPhase({ step: 'uploading', fileName, sent, total: rows.length })
    for (const batch of appendBatches(rows, appendMaxRows)) {
      const appended = await once(() => actions.append(runId, batch))
      if (!appended.ok) return failUpload(appended.error)
      sent = appended.value.received
      setPhase({ step: 'uploading', fileName, sent, total: rows.length })
    }

    const previewed = await once(() => actions.preview(runId))
    if (!previewed.ok) return failUpload(previewed.error)
    setPhase({ step: 'preview', fileName, runId, preview: previewed.value })
  }

  function failUpload(message: string) {
    // Yarım yüklenmiş kayıt 24 saat sonra temizleniyor; kullanıcı dosyayı yeniden seçiyor.
    setPhase({ step: 'select' })
    setError(`${message} Dosyayı yeniden seçip tekrar deneyin.`)
  }

  async function begin(fileName: string, runId: string) {
    setError(null)
    const begun = await once(() => actions.begin(runId))
    if (!begun.ok) {
      setError(begun.error)
      return
    }
    cancelRequested.current = false
    await drive(fileName, runId, begun.value)
  }

  /** Aktarım kapanana kadar parça iste. */
  async function drive(fileName: string, runId: string, initial: ImportRunProgress) {
    let progress = initial
    setPhase({ step: 'running', fileName, runId, progress, cancelling: false, stalled: false })

    while (progress.status === 'RUNNING' && !cancelRequested.current) {
      const result = await retrying(() => actions.chunk(runId))
      if (!result.ok) {
        // Durum sunucuda; yapılan satırlar kayıtlı. Kullanıcı tekrar deneyebilir ya da iptal edebilir.
        setError(result.error)
        setPhase({ step: 'running', fileName, runId, progress, cancelling: false, stalled: true })
        return
      }
      const before = progress.processed
      progress = result.value
      setPhase((p) => (p.step === 'running' ? { ...p, progress } : p))
      // Hiç satır işlenmediyse başka bir işleyicinin yarım satırı bekleniyor.
      if (progress.status === 'RUNNING' && progress.processed === before) await sleep(2_000)
    }

    if (cancelRequested.current && progress.status === 'RUNNING') {
      progress = await closeByCancel(runId, progress)
    }
    await finish(fileName, runId, progress)
  }

  /**
   * İptal: işleyici satır arasında duruyor. Kirası başka bir istekte (ör. ikinci
   * sekme) olabilir; o zaman sunucu yalnız iptal bayrağını yazıyor ve o işleyici
   * bir sonraki satırdan önce kapatıyor. Kapanana kadar kısa aralıklarla soruluyor.
   */
  async function closeByCancel(runId: string, last: ImportRunProgress): Promise<ImportRunProgress> {
    let progress = last
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const result = await retrying(() => actions.cancel(runId))
      if (!result.ok) {
        setError(result.error)
        return progress
      }
      progress = result.value
      if (progress.status !== 'RUNNING') return progress
      await sleep(2_000)
    }
    return progress
  }

  async function finish(fileName: string, runId: string, progress: ImportRunProgress) {
    const report = await retrying(() => actions.report(runId))
    if (!report.ok) setError(report.error)
    setPhase({ step: 'result', fileName, runId, progress, report: report.ok ? report.value : [] })
  }

  async function requestCancel() {
    if (phase.step !== 'running') return
    cancelRequested.current = true
    setPhase({ ...phase, cancelling: true })
    // Döngü çalışmıyorsa (takıldıysa) iptali burada tamamla; çalışıyorsa
    // döngü mevcut parça dönünce iptali gönderiyor.
    if (phase.stalled) {
      setError(null)
      const progress = await closeByCancel(phase.runId, phase.progress)
      await finish(phase.fileName, phase.runId, progress)
    }
  }

  async function retry() {
    if (phase.step !== 'running') return
    setError(null)
    cancelRequested.current = false
    await drive(phase.fileName, phase.runId, phase.progress)
  }

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

      {phase.step === 'select' || phase.step === 'reading' || phase.step === 'uploading' ? (
        <form action={readAndPreview} className="space-y-4 rounded-card border border-line bg-surface shadow-card p-5">
          <label className="block">
            <span className="text-sm font-medium">Dosya (.xlsx veya .csv)</span>
            <input
              type="file"
              name="dosya"
              accept=".xlsx,.csv,text/csv"
              required
              disabled={phase.step !== 'select'}
              className="mt-1 block w-full rounded-control border border-line-control bg-surface p-3 text-base file:mr-3 file:rounded file:border-0 file:bg-accent file:px-4 file:py-2 file:text-accent-ink"
            />
          </label>
          <button
            type="submit"
            disabled={phase.step !== 'select'}
            className="h-14 rounded-control bg-accent px-6 text-base font-medium text-accent-ink hover:brightness-110 disabled:opacity-60"
          >
            {phase.step === 'reading'
              ? 'Dosya okunuyor…'
              : phase.step === 'uploading'
                ? `Gönderiliyor… ${formatCount(phase.sent)} / ${formatCount(phase.total)} satır`
                : 'Dosyayı oku ve önizle'}
          </button>
        </form>
      ) : null}

      {phase.step === 'preview' ? (
        <PreviewPanel
          preview={phase.preview}
          runId={phase.runId}
          onBegin={() => begin(phase.fileName, phase.runId)}
        />
      ) : null}

      {phase.step === 'running' ? (
        <ProgressPanel
          fileName={phase.fileName}
          progress={phase.progress}
          cancelling={phase.cancelling}
          stalled={phase.stalled}
          onCancel={requestCancel}
          onRetry={retry}
        />
      ) : null}

      {phase.step === 'result' ? (
        <ResultPanel progress={phase.progress} report={phase.report} runId={phase.runId} />
      ) : null}
    </div>
  )
}

const reportHref = (runId: string) => `/api/rapor/aktarim?kayit=${encodeURIComponent(runId)}`

function PreviewPanel({
  preview,
  runId,
  onBegin,
}: {
  preview: ImportRunPreview
  runId: string
  onBegin: () => Promise<void>
}) {
  const [starting, setStarting] = useState(false)
  const { create, update, error } = preview.counts

  return (
    <section aria-label="Önizleme" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <CountTile label="Yeni eklenecek" value={create} tone="giris" />
        <CountTile label="Güncellenecek" value={update} />
        <CountTile label="Atlanacak (hatalı)" value={error} tone={error > 0 ? 'kritik' : undefined} />
      </div>

      {preview.notices.length > 0 ? (
        <div role="status" className="space-y-1 rounded-control border border-warn bg-warn-soft p-3 text-sm text-warn-soft-ink">
          {preview.notices.map((notice) => (
            <p key={notice}>⚠ {notice}</p>
          ))}
        </div>
      ) : null}

      {preview.openings > 0 || preview.skippedOpenings > 0 ? (
        <p className="text-sm">
          Açılış stoğu: <span className="font-semibold">{formatCount(preview.openings)}</span> üründe yazılacak
          {preview.skippedOpenings > 0 ? `, ${formatCount(preview.skippedOpenings)} üründe atlanacak` : ''}. Her
          devir ayrı bir “Devir / açılış” hareketi olarak, alış fiyatıyla yazılır.
        </p>
      ) : null}

      {preview.warnings.length > 0 ? (
        <NoteTable
          title="Devri atlanacak satırlar"
          rows={preview.warnings}
          more={preview.skippedOpenings - preview.warnings.length}
        />
      ) : null}

      {preview.errors.length > 0 ? (
        <div className="rounded-card border border-kritik bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="font-semibold text-kritik">Hatalı satırlar</h2>
            {/* Düz bağlantı: tarayıcının kendi indirme akışı. 60 satırlık hatayı
                ekrandan okuyup düzeltmek mümkün değil, iki dosya yan yana açılıyor. */}
            <a
              href={reportHref(runId)}
              className="rounded-control border border-line-control px-4 py-2 text-sm hover:bg-surface-2"
            >
              Hata raporunu indir
            </a>
          </div>
          <IssueTable rows={preview.errors} />
          {error > preview.errors.length ? (
            <p className="border-t border-line px-4 py-2 text-sm text-ink-2">
              …ve {formatCount(error - preview.errors.length)} satır daha. Tamamı için raporu indirin.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={starting || create + update === 0}
          onClick={async () => {
            setStarting(true)
            await onBegin()
            setStarting(false)
          }}
          className="h-14 rounded-control bg-accent px-6 text-base font-medium text-accent-ink hover:brightness-110 disabled:opacity-60"
        >
          {starting ? 'Başlatılıyor…' : `${formatCount(create + update)} satırı aktar`}
        </button>
        {error > 0 ? (
          <span className="text-sm text-ink-2">
            {formatCount(error)} hatalı satır atlanacak. Önce düzeltmek isterseniz raporu indirin.
          </span>
        ) : null}
        <a href="/urunler/aktar" className="text-sm text-ink-2 underline">
          Başka dosya seç
        </a>
      </div>
    </section>
  )
}

function ProgressPanel({
  fileName,
  progress,
  cancelling,
  stalled,
  onCancel,
  onRetry,
}: {
  fileName: string
  progress: ImportRunProgress
  cancelling: boolean
  stalled: boolean
  onCancel: () => void
  onRetry: () => void
}) {
  const { processed, toProcess, rows } = progress
  const percent = toProcess === 0 ? 100 : Math.floor((processed / toProcess) * 100)

  return (
    <section aria-label="Aktarım" className="space-y-4 rounded-card border border-line bg-surface shadow-card p-5">
      <p className="text-sm">
        <span className="font-medium">{fileName}</span>: {formatCount(processed)} / {formatCount(toProcess)} satır
        işlendi
      </p>
      <div
        role="progressbar"
        aria-label="Aktarım ilerlemesi"
        aria-valuemin={0}
        aria-valuemax={toProcess}
        aria-valuenow={processed}
        aria-valuetext={`%${percent}`}
        className="h-3 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <CountTile label="Eklendi" value={rows.created} tone="giris" />
        <CountTile label="Güncellendi" value={rows.updated} />
        <CountTile
          label="Aktarılamadı"
          value={rows.failed + rows.conflict + rows.uncertain}
          tone={rows.failed + rows.conflict + rows.uncertain > 0 ? 'kritik' : undefined}
        />
      </div>
      <p className="text-sm text-ink-2">
        {cancelling
          ? 'İptal ediliyor… Aktarım birkaç saniye içinde durur; o ana kadar işlenen satırlar kayıtlı kalır.'
          : 'Bu sekmeyi açık tutun. Kapatırsanız aktarım durur; işlenen satırlar kayıtlı kalır.'}
      </p>
      <div className="flex flex-wrap gap-3">
        {stalled && !cancelling ? (
          <button
            type="button"
            onClick={onRetry}
            className="h-12 rounded-control bg-accent px-5 text-base font-medium text-accent-ink hover:brightness-110"
          >
            Tekrar dene
          </button>
        ) : null}
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="h-12 rounded-control border border-line-control bg-surface px-5 text-base font-medium hover:bg-surface-2 disabled:opacity-60"
        >
          {cancelling ? 'İptal ediliyor…' : 'İptal et'}
        </button>
      </div>
    </section>
  )
}

function ResultPanel({
  progress,
  report,
  runId,
}: {
  progress: ImportRunProgress
  report: ImportRunReportRow[]
  runId: string
}) {
  const { rows, openings } = progress
  const cancelled = progress.status === 'CANCELLED'

  return (
    <section aria-label="Sonuç" className="space-y-4">
      <p role="status" className="text-base font-medium">
        {cancelled
          ? `Aktarım iptal edildi. İşlenen satırlar kaydedildi${rows.pending > 0 ? `; ${formatCount(rows.pending)} satır işlenmedi` : ''}.`
          : 'Aktarım tamamlandı.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <CountTile label="Eklendi" value={rows.created} tone="giris" />
        <CountTile label="Güncellendi" value={rows.updated} />
        <CountTile
          label="Aktarılamadı"
          value={rows.failed + rows.conflict}
          tone={rows.failed + rows.conflict > 0 ? 'kritik' : undefined}
        />
        <CountTile label="Atlandı (hatalı)" value={rows.invalid} tone={rows.invalid > 0 ? 'kritik' : undefined} />
        {rows.uncertain > 0 ? <CountTile label="Belirsiz (kontrol edin)" value={rows.uncertain} tone="kritik" /> : null}
        {rows.pending > 0 ? <CountTile label="İşlenmedi" value={rows.pending} /> : null}
      </div>

      {openings.written + openings.skipped + openings.failed > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <CountTile label="Devir yazıldı" value={openings.written} tone="giris" />
          <CountTile label="Devir atlandı" value={openings.skipped} />
          <CountTile
            label="Devir yazılamadı"
            value={openings.failed}
            tone={openings.failed > 0 ? 'kritik' : undefined}
          />
        </div>
      ) : null}

      {report.length > 0 ? (
        <div className="rounded-card border border-kritik bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="font-semibold">Kontrol edilecek satırlar</h2>
            <a
              href={reportHref(runId)}
              className="rounded-control border border-line-control px-4 py-2 text-sm hover:bg-surface-2"
            >
              Raporu indir
            </a>
          </div>
          <ReportTable rows={report} />
          {report.length >= 50 ? (
            <p className="border-t border-line px-4 py-2 text-sm text-ink-2">
              İlk 50 satır gösteriliyor. Tamamı için raporu indirin.
            </p>
          ) : null}
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

interface NoteRow {
  rowNumber: number
  sku: string
  name: string
  message: string
}

/** Hata olmayan satır notları: ürün işlenecek ama devir yazılmayacak. */
function NoteTable({ title, rows, more }: { title: string; rows: NoteRow[]; more: number }) {
  return (
    <div className="rounded-card border border-warn bg-surface">
      <h2 className="border-b border-line px-4 py-3 font-semibold">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-ink-3">
            <tr>
              <th className="px-4 py-2 font-medium">Satır</th>
              <th className="px-4 py-2 font-medium">Stok Kodu</th>
              <th className="px-4 py-2 font-medium">Ürün</th>
              <th className="px-4 py-2 font-medium">Not</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.rowNumber}-${row.message}`} className="border-t border-line align-top">
                <td className="tabular px-4 py-2">{row.rowNumber}</td>
                <td className="tabular px-4 py-2">{row.sku || '—'}</td>
                <td className="px-4 py-2">{row.name || '—'}</td>
                <td className="px-4 py-2 text-ink-2">{row.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 ? (
        <p className="border-t border-line px-4 py-2 text-sm text-ink-2">…ve {formatCount(more)} satır daha.</p>
      ) : null}
    </div>
  )
}

function IssueTable({ rows }: { rows: ImportRunPreview['errors'] }) {
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
                    {issue.column ? <span className="font-medium">{issue.column}: </span> : null}
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

/** Sonuç ekranı: raporun ilk satırları; durum sütunu satırın neden burada olduğunu söylüyor. */
function ReportTable({ rows }: { rows: ImportRunReportRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-ink-3">
          <tr>
            <th className="px-4 py-2 font-medium">Satır</th>
            <th className="px-4 py-2 font-medium">Stok Kodu</th>
            <th className="px-4 py-2 font-medium">Ürün</th>
            <th className="px-4 py-2 font-medium">Durum</th>
            <th className="px-4 py-2 font-medium">Açıklama</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // Aynı satırın birden çok sorunu olabiliyor; sıra raporda sabit.
            // biome-ignore lint/suspicious/noArrayIndexKey: satır numarası tek başına benzersiz değil
            <tr key={`${row.rowNumber}-${i}`} className="border-t border-line align-top">
              <td className="tabular px-4 py-2">{row.rowNumber}</td>
              <td className="tabular px-4 py-2">{row.sku || '—'}</td>
              <td className="px-4 py-2">{row.name || '—'}</td>
              <td className="px-4 py-2">{row.status}</td>
              <td className="px-4 py-2 text-ink-2">
                {row.column ? <span className="font-medium">{row.column}: </span> : null}
                {row.message}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
