'use client'

import type { InventoryRunPreview } from '@stok/core'
import { formatQty } from '@stok/shared'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { CountTile } from '@/components/count-tile'
import { formatCount, formatDateTime } from '@/lib/format'
import {
  type ImportActions,
  IssueTable,
  NoteTable,
  type PreviewSlot,
  ReportTable,
  type ResultSlot,
  RunWizard,
} from '../../urunler/aktar/wizard'

/**
 * ============================================================================
 * T219 — ENVANTERİ GÜNCELLE SİHİRBAZI: yükle → önizle → onayla → işle → sonuç
 *
 * Akış ürün aktarımıyla aynı motordan (`RunWizard`); burada yalnız envantere
 * özgü önizleme ve sonuç var.
 *
 * "YENİ TOPLAM" AÇIKÇA YAZIYOR ve her satırda eski → yeni miktar görünüyor
 * (PRD-18). Kullanıcı dosyadaki sayıyı "eklenecek" sanarsa stok iki katına
 * çıktı sanır ya da tersine, eksik saydığı ürünü sıfırladığını fark etmez.
 *
 * AYNI İÇERİK İÇİN ONAY KUTUSU (K3). Kutu yalnız `confirmNewCount`'u taşıyor;
 * kural sunucuda (`beginInventoryRun`). Kutu kaldırılsa ya da istek elle
 * gönderilse de onaysız tekrar başlamıyor.
 *
 * YARIM KALAN AKTARIM BAŞARILI GÖRÜNMÜYOR. Yazılamayan, çakışan, belirsiz ya
 * da iptal yüzünden işlenmeyen satır varsa sonuç "güncellendi" demiyor.
 * ============================================================================
 */

const PAGE = '/stok/envanter'
const reportHref = (runId: string) => `/api/rapor/aktarim?kayit=${encodeURIComponent(runId)}&tur=envanter`

export function InventoryWizard({
  actions,
  fileBytesLimit,
  appendMaxRows,
}: {
  actions: ImportActions<InventoryRunPreview>
  fileBytesLimit: number
  appendMaxRows: number
}) {
  return (
    <RunWizard
      kind="INVENTORY"
      actions={actions}
      fileBytesLimit={fileBytesLimit}
      appendMaxRows={appendMaxRows}
      renderPreview={(slot) => <InventoryPreviewPanel {...slot} />}
      renderResult={(slot) => <InventoryResultPanel {...slot} />}
    />
  )
}

function InventoryPreviewPanel({ preview, runId, onBegin }: PreviewSlot<InventoryRunPreview>) {
  const [starting, setStarting] = useState(false)
  const [newCount, setNewCount] = useState(false)
  const { counts } = preview
  const toWrite = counts.create + counts.update
  const blockedByRepeat = preview.repeatOf !== null && !newCount

  return (
    <section aria-label="Önizleme" className="space-y-4">
      <div
        role="note"
        className="space-y-1 rounded-control border border-line-control bg-surface-2 p-3 text-sm"
      >
        <p className="font-medium">
          Dosyadaki miktar, o deponun YENİ TOPLAM stoğudur; mevcut stoğa eklenmez.
        </p>
        <p className="text-ink-2">
          Her satırda deponun bugünkü miktarı dosyadaki miktara getirilir; aradaki fark kadar sayım düzeltmesi
          yazılır. Fiyatlar değişmez.
        </p>
      </div>

      {/* Mobilde iki sütun: altı kart alt alta, önizlemenin kendisini ekranın dışına itiyordu. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <CountTile label="Yeni ürün" value={counts.newProducts} tone="giris" />
        <CountTile label="Stoğu artacak" value={counts.increase} />
        <CountTile label="Stoğu azalacak" value={counts.decrease} />
        <CountTile label="Değişmeyecek" value={counts.unchanged} />
        <CountTile
          label="Depoya atama bekliyor"
          value={counts.unassigned}
          tone={counts.unassigned > 0 ? 'kritik' : undefined}
        />
        <CountTile label="Hatalı (atlanacak)" value={counts.error} tone={counts.error > 0 ? 'kritik' : undefined} />
      </div>

      {preview.notices.length > 0 ? (
        <div role="status" className="space-y-1 rounded-control border border-warn bg-warn-soft p-3 text-sm text-warn-soft-ink">
          {preview.notices.map((notice) => (
            <p key={notice}>⚠ {notice}</p>
          ))}
        </div>
      ) : null}

      <dl className="grid gap-3 rounded-card border border-line bg-surface p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium">Okunan sütunlar</dt>
          <dd className="text-ink-2">{preview.columns.join(', ')}</dd>
        </div>
        <div>
          <dt className="font-medium">Depolar</dt>
          <dd>
            {preview.depots.length === 0 ? (
              <span className="text-ink-2">Geçerli satırı olan depo yok.</span>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {preview.depots.map((d) => (
                  <li key={d.name} className="rounded-control border border-line-control px-2 py-1">
                    {d.name}{' '}
                    <span className={d.isNew ? 'text-giris' : 'text-ink-3'}>
                      {d.isNew ? '(yeni, onayda açılacak)' : '(mevcut)'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>

      {preview.changes.length > 0 ? (
        <div className="rounded-card border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-3 font-semibold">Değişecek stoklar (depo bazında)</h2>
          <ChangeTable rows={preview.changes} />
          {toWrite > preview.changes.length ? (
            <p className="border-t border-line px-4 py-2 text-sm text-ink-2">
              İlk {formatCount(preview.changes.length)} satır gösteriliyor; toplam {formatCount(toWrite)} satır
              uygulanacak.
            </p>
          ) : null}
        </div>
      ) : null}

      {preview.unassigned.length > 0 ? (
        <NoteTable
          title="Depoya atama bekleyen satırlar (yazılmayacak)"
          rows={preview.unassigned}
          more={counts.unassigned - preview.unassigned.length}
        />
      ) : null}

      {preview.errors.length > 0 ? (
        <div className="rounded-card border border-kritik bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="font-semibold text-kritik">
              Hatalı satırlar
              {counts.ambiguous > 0 ? ` (${formatCount(counts.ambiguous)} belirsiz eşleşme)` : ''}
            </h2>
            <a
              href={reportHref(runId)}
              className="rounded-control border border-line-control px-4 py-2 text-sm hover:bg-surface-2"
            >
              Hata raporunu indir
            </a>
          </div>
          <IssueTable rows={preview.errors} />
          {counts.error > preview.errors.length ? (
            <p className="border-t border-line px-4 py-2 text-sm text-ink-2">
              …ve {formatCount(counts.error - preview.errors.length)} satır daha. Tamamı için raporu indirin.
            </p>
          ) : null}
        </div>
      ) : null}

      {preview.repeatOf ? (
        <div role="alert" className="space-y-2 rounded-control border border-warn bg-warn-soft p-3 text-sm text-warn-soft-ink">
          <p className="font-medium">
            ⚠ Bu dosyanın içeriği daha önce uygulandı: {preview.repeatOf.fileName} (
            {formatDateTime(new Date(preview.repeatOf.startedAt))}).
          </p>
          <p>
            Eski bir sayımı yeniden uygulamak, o tarihten sonra girilen satışları ve mal kabullerini geri alabilir.
            Önceki aktarım yarıda kaldıysa yeniden uygulamak güvenlidir: yazılmış miktarlar “Değişmeyecek”
            görünür ve ikinci kez yazılmaz.
          </p>
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={newCount}
              onChange={(event) => setNewCount(event.target.checked)}
              className="size-4 shrink-0 accent-[var(--accent)]"
            />
            Bu yeni bir sayımdır; dosyayı yeniden uygulamak istiyorum
          </label>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={starting || toWrite === 0 || blockedByRepeat}
          onClick={async () => {
            setStarting(true)
            await onBegin(preview.repeatOf ? newCount : undefined)
            setStarting(false)
          }}
          className="h-14 rounded-control bg-accent px-6 text-base font-medium text-accent-ink hover:brightness-110 disabled:opacity-60"
        >
          {starting ? 'Başlatılıyor…' : `${formatCount(toWrite)} satırı uygula`}
        </button>
        {toWrite === 0 ? (
          <span className="text-sm text-ink-2">Uygulanacak değişiklik yok.</span>
        ) : counts.error + counts.unassigned > 0 ? (
          <span className="text-sm text-ink-2">
            {formatCount(counts.error + counts.unassigned)} satır yazılmayacak (hatalı ya da depoya atama bekliyor).
          </span>
        ) : null}
        <a href={PAGE} className="text-sm text-ink-2 underline">
          Başka dosya seç
        </a>
      </div>
    </section>
  )
}

function ChangeTable({ rows }: { rows: InventoryRunPreview['changes'] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-ink-3">
          <tr>
            <th className="px-4 py-2 font-medium">Satır</th>
            <th className="px-4 py-2 font-medium">Malzeme Kodu</th>
            <th className="px-4 py-2 font-medium">Ürün</th>
            <th className="px-4 py-2 font-medium">Depo</th>
            <th className="px-4 py-2 text-right font-medium">Şimdiki</th>
            <th className="px-4 py-2 text-right font-medium">Yeni toplam</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.rowNumber} className="border-t border-line align-top">
              <td className="tabular px-4 py-2">{row.rowNumber}</td>
              <td className="tabular px-4 py-2">{row.sku}</td>
              <td className="px-4 py-2">
                {row.name}
                {row.newProduct ? <span className="ml-2 text-giris">(yeni ürün)</span> : null}
              </td>
              <td className="px-4 py-2">
                {row.depot}
                {row.newDepot ? <span className="ml-2 text-giris">(yeni)</span> : null}
              </td>
              <td className="tabular px-4 py-2 text-right">{formatQty(row.oldQty, row.unit)}</td>
              <td className="tabular px-4 py-2 text-right font-medium">{formatQty(row.newQty, row.unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function InventoryResultPanel({ progress, report, runId }: ResultSlot) {
  const { rows } = progress
  // Sayfanın sunucu kısmı ("Son uygulanan envanter dosyası") yüklemeden önceki
  // dosyayı gösteriyor; yenilenmeseydi sonuç "güncellendi" derken üstte eski
  // dosyanın adı dururdu. `refresh` istemci durumunu (bu sonuç) koruyor.
  const router = useRouter()
  useEffect(() => {
    router.refresh()
  }, [router])
  const notWritten = rows.failed + rows.conflict + rows.uncertain
  const headline =
    progress.status === 'CANCELLED'
      ? `Envanter güncellemesi iptal edildi${rows.pending > 0 ? `; ${formatCount(rows.pending)} satır işlenmedi` : ''}. İşlenen satırlar kaydedildi, stoklar dosyadaki değerlere tam getirilmedi. Aynı dosyayı yeniden yükleyerek tamamlayabilirsiniz.`
      : progress.status !== 'DONE'
        ? 'Envanter güncellemesi tamamlanmadı. İşlenen satırlar kaydedildi; aynı dosyayı yeniden yükleyerek tamamlayabilirsiniz.'
        : notWritten > 0
          ? `Envanter güncellemesi bitti, ama ${formatCount(notWritten)} satır yazılamadı. Bu satırların stoğu dosyadaki değerde değil; aşağıdaki listeyi kontrol edin.`
          : 'Envanter güncellendi.'
  const complete = progress.status === 'DONE' && notWritten === 0

  return (
    <section aria-label="Sonuç" className="space-y-4">
      <p
        role="status"
        className={`text-base font-medium ${complete ? '' : 'rounded-control border border-kritik bg-kritik-bg p-3 text-kritik'}`}
      >
        {headline}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <CountTile label="Yeni ürün satırı yazıldı" value={rows.created} tone="giris" />
        <CountTile label="Stok güncellendi" value={rows.updated} />
        <CountTile label="Değişmedi ya da atlandı" value={rows.skipped} />
        <CountTile label="Hatalı (atlandı)" value={rows.invalid} tone={rows.invalid > 0 ? 'kritik' : undefined} />
        <CountTile label="Çakışma" value={rows.conflict} tone={rows.conflict > 0 ? 'kritik' : undefined} />
        <CountTile label="Yazılamadı" value={rows.failed} tone={rows.failed > 0 ? 'kritik' : undefined} />
        {rows.uncertain > 0 ? <CountTile label="Belirsiz (kontrol edin)" value={rows.uncertain} tone="kritik" /> : null}
        {rows.pending > 0 ? <CountTile label="İşlenmedi" value={rows.pending} tone="kritik" /> : null}
      </div>

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

      <div className="flex flex-wrap items-center gap-3">
        <a
          href={PAGE}
          className="inline-flex h-14 items-center rounded-control border border-line-control bg-surface px-5 text-base font-medium hover:bg-surface-2"
        >
          Yeni dosya yükle
        </a>
        <a href="/stok" className="text-sm text-ink-2 underline">
          Stok tablosuna dön
        </a>
      </div>
    </section>
  )
}
