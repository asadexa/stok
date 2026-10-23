import { IMPORT_APPEND_MAX_ROWS, IMPORT_FILE_BYTES_LIMIT, IMPORT_ROW_LIMIT, actorCan } from '@stok/core'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentActor } from '@/server/session'
import {
  appendImportRowsAction,
  beginImportAction,
  cancelImportAction,
  importReportAction,
  previewImportAction,
  processImportChunkAction,
  startImportAction,
} from './actions'
import { ImportWizard } from './wizard'

/**
 * ============================================================================
 * T23 / E1 / T171 — TOPLU ÜRÜN İÇE AKTARMA EKRANI
 *
 * PLAN.md: "Bu olmadan sistem ilk gün kurulamaz." 800 kalemlik bir depoyu
 * tek tek forma girmek kimsenin yapmayacağı bir iş; yapılmadığı için sistem
 * hiç kullanılmaya başlanmaz.
 *
 * ŞABLON EN ÜSTTE ve içi DOLU. Boş bir şablon, "Koli İçi Adet" sütununun ne
 * beklediğini göstermez; iki örnek satır o soruyu sormadan cevaplıyor.
 *
 * Sınırlar core'daki sabitlerden: ekranda yazan sayı ile reddedilen sayı
 * ayrı yazılsaydı biri unutulurdu.
 * ============================================================================
 */
export default async function ImportPage() {
  const actor = await currentActor()
  if (!actor) redirect('/giris')
  // Menüden gizlemek yetki kontrolü değil; asıl kontrol core'da
  // (`import-runs.ts`, her eylemde `product:create` + `barcode:create`).
  if (!actorCan(actor, 'product:create')) redirect('/stok')

  return (
    <>
      <h2 className="mb-4 font-display text-lg font-semibold">Toplu aktarma</h2>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Toplu ürün aktarma</h1>
        <Link href="/stok" className="text-sm text-ink-2 underline">
          Stok tablosuna dön
        </Link>
      </div>

      <section className="mb-6 rounded-card border border-line bg-surface shadow-card p-5 text-sm text-ink-2">
        <p className="mb-3">
          Elinizdeki listeyi Excel (.xlsx) veya CSV olarak yükleyin. Dosya{' '}
          <span className="font-medium">önce okunur ve size gösterilir</span>; hiçbir şey siz
          onaylamadan kaydedilmez.
        </p>
        <ul className="mb-3 list-inside list-disc space-y-1">
          <li>
            <span className="font-medium">Stok Kodu</span> ve{' '}
            <span className="font-medium">Ürün Adı</span> zorunlu.
          </li>
          <li>Yeni ürünler için <span className="font-medium">Barkod</span> da zorunlu.</li>
          <li>
            {/* Noktalama açık bir ifade içinde: JSX artığı bir noktalı virgülle
                karışmasın, hem okuyan hem linter niyeti görsün. */}
            Stok kodu sistemde varsa o ürün <span className="font-medium">güncellenir</span>{";"}
            dosyada olmayan sütunlara dokunulmaz.
          </li>
          <li>
            Fiyatlar Türkçe biçimde yazılabilir: 1.234,56. Binlik noktasını kuruşla birlikte yazın:
            &quot;1.234&quot; hem 1234 hem 1,234 okunabildiği için hatalı sayılır.
          </li>
          <li>
            En fazla {IMPORT_ROW_LIMIT.toLocaleString('tr-TR')} satır ve{' '}
            {(IMPORT_FILE_BYTES_LIMIT / (1024 * 1024)).toLocaleString('tr-TR')} MB.
          </li>
          <li>
            Aktarım parça parça ilerler; bitene kadar bu sekmeyi açık tutun. İptal ederseniz işlenen
            satırlar kalır, kalanlar işlenmez.
          </li>
        </ul>
        <a href="/api/rapor/sablon" className="inline-block underline">
          Örnek şablonu indir
        </a>
      </section>

      <ImportWizard
        actions={{
          start: startImportAction,
          append: appendImportRowsAction,
          preview: previewImportAction,
          begin: beginImportAction,
          chunk: processImportChunkAction,
          cancel: cancelImportAction,
          report: importReportAction,
        }}
        fileBytesLimit={IMPORT_FILE_BYTES_LIMIT}
        appendMaxRows={IMPORT_APPEND_MAX_ROWS}
      />
    </>
  )
}
