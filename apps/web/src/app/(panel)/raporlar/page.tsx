import { actorCan, exportMovements, exportStock } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ExportControl } from '@/components/export-control'
import { type FormParams, errorQuery, messageFrom } from '@/server/form'
import { exportHref, exportPlanFor } from '@/server/export'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T74 — RAPORLAR (tasarım incelemesi, karar TD2)
 *
 * BU EKRAN YENİ BİR ŞEY YAPMIYOR, VAR OLANI GÖRÜNÜR KILIYOR.
 *
 * `/api/rapor/*` dört uçla aylardır çalışıyor: stok, hareket, şablon,
 * aktarım hataları. Ama hiçbirinin kendi ekranı yoktu; stok ve hareket
 * raporlarına yalnızca ilgili tablonun köşesindeki düğmeden ulaşılıyordu.
 * Sonuç: raporun var olduğunu, o tabloyu açıp köşeye bakan kişi biliyordu.
 * Referans görseldeki "Raporlar" menüsü bu boşluğa denk düşüyor.
 *
 * BURADAKİ RAPORLAR FİLTRESİZ, tablodakiler filtreli. İkisi birbirinin
 * yerine geçmiyor:
 *   - "Bu ayki satışları çıkar"      → hareket tablosunda filtrele, oradan indir
 *   - "Tüm stoğu muhasebeye gönder"  → burası
 * Bu yüzden her kartta ilgili tabloya giden bir bağlantı da var: filtre
 * gerekiyorsa kullanıcı doğru yere yönlendiriliyor.
 *
 * SATIR SAYISI DÜĞMEDEN ÖNCE YAZIYOR (ExportControl). Kullanıcı tıklamadan
 * önce dosyanın anında mı ineceğini yoksa e-posta ile mi geleceğini
 * biliyor; 45 bin satırlık bir raporu bekleyen kişi tarayıcının donmasını
 * beklemesin diye.
 * ============================================================================
 */

interface RaporParams extends FormParams {
  rapor?: string
  eposta?: string
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<RaporParams>
}) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')

  const params = await searchParams
  const message = messageFrom(params)
  const canExport = actorCan(actor, 'export:excel')

  // Filtresiz plan: tüm stok, tüm hareketler.
  const [stockPlan, movementPlan] = canExport
    ? await Promise.all([
        exportPlanFor(actor, 'STOCK_EXPORT', {}),
        exportPlanFor(actor, 'MOVEMENT_EXPORT', {}),
      ])
    : [
        { plan: null, error: null },
        { plan: null, error: null },
      ]

  async function queueStock() {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')
    // YÖNLENDİRMELER `try` DIŞINDA: `redirect()` akış kontrolü için
    // fırlatıyor, içeride bırakılırsa başarı yolu kendi catch'ine düşer ve
    // kullanıcı iş yapılmışken hata görüp tekrar dener — rapor iki kez
    // kuyruğa girer. (Stok tablosundaki kalıbın aynısı.)
    let target: string
    try {
      const result = await exportStock(owner, {}, { db: appDb() })
      target =
        result.mode === 'queued'
          ? `/raporlar?rapor=kuyrukta&eposta=${encodeURIComponent(result.notifyEmail)}`
          : '/api/rapor/stok'
    } catch (err) {
      target = `/raporlar?${errorQuery(err)}`
    }
    redirect(target)
  }

  async function queueMovements() {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')
    let target: string
    try {
      const result = await exportMovements(owner, {}, { db: appDb() })
      target =
        result.mode === 'queued'
          ? `/raporlar?rapor=kuyrukta&eposta=${encodeURIComponent(result.notifyEmail)}`
          : '/api/rapor/hareket'
    } catch (err) {
      target = `/raporlar?${errorQuery(err)}`
    }
    redirect(target)
  }

  return (
    <div className="max-w-4xl">
      {message ? (
        <p
          role="alert"
          className="mb-4 flex gap-2 rounded-[10px] border border-crit bg-crit-soft p-3 text-sm text-crit-soft-ink"
        >
          <span aria-hidden>⚠</span>
          <span>{message}</span>
        </p>
      ) : null}

      {params.rapor === 'kuyrukta' && params.eposta ? (
        <p className="mb-4 flex gap-2 rounded-[10px] border border-ok bg-ok-soft p-3 text-sm text-ok-soft-ink">
          <span aria-hidden>✓</span>
          <span>
            Rapor hazırlanıyor. Hazır olunca{' '}
            <span className="font-semibold">{params.eposta}</span> adresine gönderilecek.
          </span>
        </p>
      ) : null}

      <div className="grid gap-4">
        <ReportCard
          title="Stok raporu"
          description="Tüm ürünler, güncel stok adetleri, eşikler ve konumlar. Muhasebeye veya sayım öncesi çıktı almak için."
          filterHint="Kategori veya kritik filtresiyle almak isterseniz stok tablosundan indirin."
          filterHref="/stok"
          filterLabel="Stok tablosuna git"
        >
          {canExport ? (
            <ExportControl
              href={exportHref('/api/rapor/stok', {})}
              plan={stockPlan.plan}
              error={stockPlan.error}
              queueAction={queueStock}
            />
          ) : (
            <NoPermission />
          )}
        </ReportCard>

        <ReportCard
          title="Hareket raporu"
          description="Tüm giriş ve çıkışlar: kim, ne zaman, hangi ürüne, hangi sebeple. Defterin tamamı."
          filterHint="Tarih aralığı, kullanıcı veya sebep filtresi gerekiyorsa hareket logundan indirin."
          filterHref="/hareketler"
          filterLabel="Hareketlere git"
        >
          {canExport ? (
            <ExportControl
              href={exportHref('/api/rapor/hareket', {})}
              plan={movementPlan.plan}
              error={movementPlan.error}
              queueAction={queueMovements}
            />
          ) : (
            <NoPermission />
          )}
        </ReportCard>

        <ReportCard
          title="İçe aktarma şablonu"
          description="Toplu ürün yüklemesi için boş Excel şablonu. Sütun başlıkları çözümleyicinin tanıdığı adlarla üretiliyor."
          filterHint="Doldurduğunuz dosyayı toplu aktarma ekranından yükleyip önizleyebilirsiniz."
          filterHref="/urunler/aktar"
          filterLabel="Toplu aktarmaya git"
        >
          {/*
            Şablon her zaman küçük ve sabit: plan hesabı gerekmiyor, düz
            bağlantı yeterli. `ExportControl` kullanmak, olmayan bir kararı
            varmış gibi göstermek olurdu.
          */}
          <a
            href="/api/rapor/sablon"
            className="inline-flex h-13 items-center rounded-[10px] border border-line-control bg-surface px-5 text-base font-semibold hover:bg-surface-2"
          >
            Şablonu indir
          </a>
        </ReportCard>
      </div>

      <p className="mt-6 max-w-[68ch] text-[13px] text-ink-3">
        Büyük raporlar arka planda hazırlanıp e-posta ile gönderiliyor. Kuyruğun
        durumunu{' '}
        <Link href="/saglik" className="text-accent underline-offset-2 hover:underline">
          Sistem Sağlığı
        </Link>{' '}
        ekranından görebilirsiniz.
      </p>
    </div>
  )
}

function ReportCard({
  title,
  description,
  filterHint,
  filterHref,
  filterLabel,
  children,
}: {
  title: string
  description: string
  filterHint: string
  filterHref: string
  filterLabel: string
  children: React.ReactNode
}) {
  return (
    <section
      aria-label={title}
      className="rounded-[14px] border border-line bg-surface p-4 shadow-card sm:p-5"
    >
      <h2 className="font-display text-base font-semibold">{title}</h2>
      <p className="mt-1 max-w-[62ch] text-[13.5px] text-ink-2">{description}</p>

      <div className="mt-4 flex flex-wrap items-center gap-3">{children}</div>

      <p className="mt-3 max-w-[62ch] text-[12.5px] text-ink-3">
        {filterHint}{' '}
        <Link href={filterHref} className="text-accent underline-offset-2 hover:underline">
          {filterLabel}
        </Link>
      </p>
    </section>
  )
}

/** Yetkisi olmayan role düğme YERİNE açıklama. Tıklayıp 403 almasın. */
function NoPermission() {
  return (
    <p className="text-[13.5px] text-ink-3">
      Excel raporu indirmek için yönetici yetkisi gerekiyor.
    </p>
  )
}
