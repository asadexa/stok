import {
  IMPORT_APPEND_MAX_ROWS,
  IMPORT_FILE_BYTES_LIMIT,
  IMPORT_ROW_LIMIT,
  type LastInventoryFile,
  actorCan,
  getLastInventoryFile,
} from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatDateTime } from '@/lib/format'
import { currentActor } from '@/server/session'
import {
  appendInventoryRowsAction,
  beginInventoryAction,
  cancelInventoryAction,
  inventoryReportAction,
  previewInventoryAction,
  processInventoryChunkAction,
  startInventoryAction,
} from './actions'
import { InventoryWizard } from './inventory-wizard'

/**
 * ============================================================================
 * T219 — ENVANTERİ GÜNCELLE EKRANI (PRD-18, F-15)
 *
 * Depo bazlı envanter dosyası: dosyadaki miktar o deponun yeni toplamı.
 * İlk kurulumda aynı dosya ürünleri ve depoları da açıyor.
 *
 * YALNIZ YÖNETİCİ (`count:approve`). Menüden gizlemek yetki kontrolü değil;
 * asıl kontrol core'da, her eylemde (`import-runs.ts`, `requireInventory`).
 *
 * SON DOSYA EN ÜSTTE (K3): kullanıcı hangi sayımın en son uygulandığını ve
 * yarıda kalıp kalmadığını dosya seçmeden görüyor.
 * ============================================================================
 */
export default async function InventoryPage() {
  const actor = await currentActor()
  if (!actor) redirect('/giris')
  if (!actorCan(actor, 'count:approve')) redirect('/stok')

  const lastFile = await getLastInventoryFile(actor, { db: appDb() })

  return (
    <>
      <h2 className="mb-4 font-display text-lg font-semibold">Envanter</h2>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Envanteri güncelle</h1>
        <Link href="/stok" className="text-sm text-ink-2 underline">
          Stok tablosuna dön
        </Link>
      </div>

      <section className="mb-6 rounded-card border border-line bg-surface shadow-card p-5 text-sm text-ink-2">
        <p className="mb-3">
          Envanter raporunuzu Excel (.xlsx) veya CSV olarak yükleyin. Dosyadaki miktar, o deponun{' '}
          <span className="font-medium">yeni toplam stoğudur</span>; mevcut stoğa eklenmez. Dosya{' '}
          <span className="font-medium">önce okunur ve size gösterilir</span>; siz onaylamadan hiçbir ürün, depo
          ya da stok kaydedilmez.
        </p>
        <ul className="mb-3 list-inside list-disc space-y-1">
          <li>
            Her satırda <span className="font-medium">Malzeme Kodu</span>,{' '}
            <span className="font-medium">Ambar</span> (depo) ve{' '}
            <span className="font-medium">Envanter Miktarı</span> zorunlu. Sistemde olmayan kod için ayrıca{' '}
            <span className="font-medium">Malzeme Açıklaması</span> ve <span className="font-medium">Birim</span>{' '}
            (Adet/AD, Kilogram/KG, Metre/MT, Litre/LT) gerekli.
          </li>
          <li>Sistemde olmayan kod yeni ürün olarak, barkodsuz ve fiyatsız açılır; yeni depolar onayda açılır.</li>
          <li>Dosyada olmayan ürünlerin ve depoların stoğu değişmez.</li>
          <li>Fiyat ve tutar sütunları (Ortalama Değer, Envanter Tutarı) okunmaz; fiyatlar değişmez.</li>
          <li>
            En fazla {IMPORT_ROW_LIMIT.toLocaleString('tr-TR')} satır ve{' '}
            {(IMPORT_FILE_BYTES_LIMIT / (1024 * 1024)).toLocaleString('tr-TR')} MB.
          </li>
          <li>
            İşlem parça parça ilerler; bitene kadar bu sekmeyi açık tutun. Yarıda kalırsa işlenen satırlar kalır;
            aynı dosyayı yeniden yükleyerek güvenle tamamlayabilirsiniz.
          </li>
        </ul>
        <p className="rounded-control border border-warn bg-warn-soft p-3 text-warn-soft-ink">
          ⚠ İşletmede birden fazla depo açıldığında, depo seçimi eklenene kadar Giriş / Çıkış ekranından el ile
          hareket girilemez; ürün aktarımı da açılış stoğu yazmaz.
        </p>
      </section>

      <LastFile file={lastFile} />

      <InventoryWizard
        actions={{
          start: startInventoryAction,
          append: appendInventoryRowsAction,
          preview: previewInventoryAction,
          begin: beginInventoryAction,
          chunk: processInventoryChunkAction,
          cancel: cancelInventoryAction,
          report: inventoryReportAction,
        }}
        fileBytesLimit={IMPORT_FILE_BYTES_LIMIT}
        appendMaxRows={IMPORT_APPEND_MAX_ROWS}
      />
    </>
  )
}

/** Yarım kalan aktarım "tamamlandı" görünmüyor: durum açıkça yazıyor. */
function LastFile({ file }: { file: LastInventoryFile | null }) {
  if (!file) {
    return <p className="mb-6 text-sm text-ink-2">Henüz bir envanter dosyası uygulanmadı.</p>
  }
  const status =
    file.status === 'DONE'
      ? 'tamamlandı'
      : file.status === 'CANCELLED'
        ? 'iptal edildi; bazı satırlar işlenmemiş olabilir'
        : 'tamamlanmadı: yarıda kalmış ya da hâlâ işleniyor'
  return (
    <section
      aria-label="Son uygulanan envanter dosyası"
      className={`mb-6 rounded-control border p-3 text-sm ${file.status === 'DONE' ? 'border-line bg-surface' : 'border-warn bg-warn-soft text-warn-soft-ink'}`}
    >
      Son uygulanan envanter dosyası: <span className="font-medium">{file.fileName}</span>,{' '}
      {formatDateTime(file.startedAt)} ({status})
    </section>
  )
}
