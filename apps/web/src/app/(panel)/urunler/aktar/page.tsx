import { IMPORT_ROW_LIMIT, actorCan } from '@stok/core'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentActor } from '@/server/session'
import { analyzeAction, commitAction } from './actions'
import { ImportWizard } from './wizard'

/**
 * ============================================================================
 * T23 / E1 — TOPLU ÜRÜN İÇE AKTARMA EKRANI
 *
 * PLAN.md: "Bu olmadan sistem ilk gün kurulamaz." 800 kalemlik bir depoyu
 * tek tek forma girmek kimsenin yapmayacağı bir iş; yapılmadığı için sistem
 * hiç kullanılmaya başlanmaz.
 *
 * ŞABLON EN ÜSTTE ve içi DOLU. Boş bir şablon, "Koli İçi Adet" sütununun ne
 * beklediğini göstermez; iki örnek satır o soruyu sormadan cevaplıyor.
 * ============================================================================
 */
export default async function ImportPage() {
  const actor = await currentActor()
  if (!actor) redirect('/giris')
  // Menüden gizlemek yetki kontrolü değil; asıl kontrol sunucu
  // eylemlerinde (`previewImport`/`commitImport`) ve orada da var.
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

      <section className="mb-6 rounded-md border border-line bg-surface p-5 text-sm text-ink-2">
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
            Stok kodu sistemde varsa o ürün <span className="font-medium">güncellenir</span>;
            dosyada olmayan sütunlara dokunulmaz.
          </li>
          <li>Fiyatlar Türkçe biçimde yazılabilir: 1.234,56</li>
          <li>En fazla {IMPORT_ROW_LIMIT.toLocaleString('tr-TR')} satır.</li>
        </ul>
        <a href="/api/rapor/sablon" className="inline-block underline">
          Örnek şablonu indir
        </a>
      </section>

      <ImportWizard analyze={analyzeAction} commit={commitAction} />
    </>
  )
}
