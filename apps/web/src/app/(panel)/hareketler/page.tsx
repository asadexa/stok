import {
  MOVEMENT_REASONS,
  MOVEMENT_REASON_VALUES,
  type MovementReason,
  type PriceOverrideReason,
  priceOverrideReasonLabel,
  reasonLabel,
  reasonPriceBasis,
} from '@stok/shared'
import { actorCan, exportMovements, getProduct, listMovements, listTenantUsers } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ExportControl } from '@/components/export-control'
import { EmptyState } from '@/components/empty-state'
import { Pagination } from '@/components/pagination'
import { dayEndIso, dayStartIso, formatDateTime, formatMoney } from '@/lib/format'
import { type FormParams, errorQuery, messageFrom } from '@/server/form'
import { exportHref, exportPlanFor } from '@/server/export'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T20 — HAREKET LOGU
 *
 * "Kim, ne zaman, hangi ürüne, ne yaptı" — denetim sorusu bu ve ekranın
 * sütun sırası da bu. Defter append-only; burada silme/düzeltme yok, olamaz.
 *
 * ÇALIŞAN SADECE KENDİ HAREKETLERİNİ GÖRÜR. Bunu bu ekran değil,
 * `listMovements` içindeki `movementUserScope` zorluyor. Buradaki bilgi
 * notu sadece kullanıcıya "eksik liste görüyorsun" demek için — filtreyi
 * arayüzde uygulamak, adresi elle yazan kullanıcıyı durdurmazdı (tehdit S6).
 *
 * SAYFALAMA `limit + 1` İLE: `listMovements` toplam sayı döndürmüyor ve
 * her sayfa için ikinci bir `count(*)` çalıştırmak, milyon satırlık bir
 * defterde sayfanın kendisinden pahalıya gelir. Bir fazla satır isteyip
 * gelip gelmediğine bakmak "sonraki sayfa var mı" sorusunu bedavaya
 * cevaplıyor.
 * ============================================================================
 */

const PAGE_SIZE = 50

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface HareketParams extends FormParams {
  urun?: string
  kullanici?: string
  sebep?: string
  baslangic?: string
  bitis?: string
  atla?: string
  rapor?: string
  eposta?: string
}

function toOffset(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/**
 * Adres çubuğundaki değerler burada süzülüyor, şemaya ham gönderilmiyor.
 * Elle yazılmış `?sebep=xyz` bir doğrulama hatası (400 ekranı) değil,
 * yok sayılan bir filtre üretmeli: kullanıcı adresi kırptığında karşısına
 * hata sayfası çıkması, listeyi görmesinden daha kötü.
 */
function toReason(raw: string | undefined): MovementReason | undefined {
  return MOVEMENT_REASON_VALUES.find((r) => r === raw)
}

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<HareketParams>
}) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')

  const params = await searchParams
  const offset = toOffset(params.atla)
  const productId = params.urun && UUID_RE.test(params.urun) ? params.urun : undefined
  // Kullanıcı filtresi sunucuda yeniden değerlendiriliyor: çalışan
  // `?kullanici=<baskasi>` yollarsa `movementUserScope` bunu yok sayıp
  // kendi kimliğini kullanıyor. Buradaki değer sadece FORMUN durumu.
  const userId = params.kullanici && UUID_RE.test(params.kullanici) ? params.kullanici : undefined
  const reason = toReason(params.sebep)
  const from = dayStartIso(params.baslangic)
  const to = dayEndIso(params.bitis)

  const canFilterByUser = actor.role === 'ADMIN'

  const db = appDb()
  const [rows, product, people] = await Promise.all([
    listMovements(
      actor,
      // Bir fazla satır: "sonraki sayfa var mı" sorusunun cevabı.
      { productId, userId, reason, from, to, limit: PAGE_SIZE + 1, offset },
      { db },
    ),
    productId ? getProduct(actor, productId, { db }).catch(() => null) : Promise.resolve(null),
    canFilterByUser ? listTenantUsers(actor, { db }) : Promise.resolve([]),
  ])

  const hasNext = rows.length > PAGE_SIZE
  const visible = hasNext ? rows.slice(0, PAGE_SIZE) : rows

  // Fiyat sütunları cevaptan türetiliyor, rolden değil: `listMovements`
  // yetkisiz role fiyat alanlarını hiç koymuyor (T88 / D7 — kural artık
  // satır bazında: satış fiyatı kalıyor, alış fiyatı gidiyor).
  const pricedRows = visible.filter((r) => r.unitPrice !== undefined)
  const showPrice = pricedRows.length > 0
  // BAŞLIK DA CEVAPTAN TÜRÜYOR. Rolü ekranda ikinci kez yorumlamak
  // (`role === 'ADMIN' ? ... : ...`) yetki kararını iki yere bölerdi.
  // Gelen satırların hepsi satış dayanaklıysa sütun satış fiyatıdır;
  // "Birim fiyat" yazmak çalışana alış fiyatı da varmış gibi görünürdü.
  const priceHeader = pricedRows.every((r) => reasonPriceBasis(r.reason as MovementReason) === 'SALE')
    ? 'Satış fiyatı'
    : 'Birim fiyat'
  // Sapma sütunu YALNIZCA gerçekten sapma varsa çiziliyor: baştan sona
  // boş bir "Sapma" sütunu tabloyu genişletir, hiçbir şey söylemez.
  const showOverride = pricedRows.some((r) => r.priceOverrideReason != null)

  const filters = {
    urun: productId,
    kullanici: canFilterByUser ? userId : undefined,
    sebep: reason,
    baslangic: params.baslangic,
    bitis: params.bitis,
  }
  const hasFilter = Object.values(filters).some(Boolean)

  // Export EKRANDAKİ filtrelerle. `userId` burada da ham gönderiliyor;
  // `exportMovements` içindeki `movementUserScope` çalışanın gönderdiğini
  // yok sayıyor — Excel'e dökmek rol matrisini atlamanın yolu olamaz.
  const exportParams = { productId, userId, reason, from, to }
  const { plan: exportPlan, error: exportError } = actorCan(actor, 'export:excel')
    ? await exportPlanFor(actor, 'MOVEMENT_EXPORT', exportParams)
    : { plan: null, error: null }

  async function queueExport() {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    const back = exportHref('/hareketler', filters)
    const join = back.includes('?') ? '&' : '?'

    // Yönlendirmeler `try` DIŞINDA — gerekçe için bkz. /stok sayfası.
    let target: string
    try {
      const result = await exportMovements(owner, exportParams, { db: appDb() })
      target =
        result.mode === 'queued'
          ? `${back}${join}rapor=kuyrukta&eposta=${encodeURIComponent(result.notifyEmail)}`
          : exportHref('/api/rapor/hareket', filters)
    } catch (err) {
      target = `${back}${join}${errorQuery(err)}`
    }
    redirect(target)
  }

  const message = messageFrom(params)

  return (
    <>
      {message ? (
        <p
          role="alert"
          className="mb-4 flex gap-2 rounded-control border border-kritik bg-kritik-bg p-3 text-sm text-kritik"
        >
          <span aria-hidden>⚠</span>
          <span>{message}</span>
        </p>
      ) : null}

      {params.rapor === 'kuyrukta' ? (
        <p className="mb-4 flex gap-2 rounded-control border border-giris bg-surface p-3 text-sm text-ink-2">
          <span aria-hidden className="text-giris">
            ✓
          </span>
          <span>
            Rapor hazırlanıyor. Hazır olunca{' '}
            <span className="font-medium">{params.eposta}</span> adresine gönderilecek.
          </span>
        </p>
      ) : null}

      {exportPlan || exportError ? (
        <div className="mb-4 flex justify-end">
          <ExportControl
            href={exportHref('/api/rapor/hareket', filters)}
            plan={exportPlan}
            error={exportError}
            queueAction={queueExport}
          />
        </div>
      ) : null}

      {actor.role !== 'ADMIN' ? (
        <p className="mb-4 rounded-card border border-line bg-surface shadow-card p-3 text-sm text-ink-2">
          Bu listede yalnızca sizin yaptığınız hareketler görünür.
        </p>
      ) : null}

      <form method="get" action="/hareketler" className="mb-4 flex flex-wrap items-end gap-3">
        {/* Ürün filtresi stok tablosundan bağlantıyla geliyor; burada
            gizli alanda taşınıyor ki tarih filtresi eklendiğinde
            kaybolmasın. */}
        {productId ? <input type="hidden" name="urun" value={productId} /> : null}

        {canFilterByUser ? (
          <label className="block basis-52">
            <span className="text-sm font-medium">Kullanıcı</span>
            <select
              name="kullanici"
              defaultValue={userId ?? ''}
              className="mt-1 h-14 w-full rounded-control border border-line-control bg-surface px-3 text-base"
            >
              <option value="">Tümü</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {/* Pasif kullanıcı da listede: işten ayrılan birinin
                      geçmiş hareketleri denetimde tam da aranan şey. */}
                  {p.name}
                  {p.active ? '' : ' (pasif)'}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="block basis-56">
          <span className="text-sm font-medium">İşlem</span>
          <select
            name="sebep"
            defaultValue={reason ?? ''}
            className="mt-1 h-14 w-full rounded-control border border-line-control bg-surface px-3 text-base"
          >
            <option value="">Tümü</option>
            {/* Sayım düzeltmeleri de listede: giriş ekranında seçilemezler
                ama denetimde tam da onlar aranır. */}
            <optgroup label="Giriş">
              {MOVEMENT_REASON_VALUES.filter((r) => MOVEMENT_REASONS[r].direction === 'IN').map(
                (r) => (
                  <option key={r} value={r}>
                    {reasonLabel(r)}
                  </option>
                ),
              )}
            </optgroup>
            <optgroup label="Çıkış">
              {MOVEMENT_REASON_VALUES.filter((r) => MOVEMENT_REASONS[r].direction === 'OUT').map(
                (r) => (
                  <option key={r} value={r}>
                    {reasonLabel(r)}
                  </option>
                ),
              )}
            </optgroup>
          </select>
        </label>

        <label className="block basis-44">
          <span className="text-sm font-medium">Başlangıç</span>
          <input
            name="baslangic"
            type="date"
            defaultValue={params.baslangic ?? ''}
            className="mt-1 h-14 w-full rounded-control border border-line-control bg-surface px-3 text-base"
          />
        </label>

        <label className="block basis-44">
          <span className="text-sm font-medium">Bitiş</span>
          <input
            name="bitis"
            type="date"
            defaultValue={params.bitis ?? ''}
            className="mt-1 h-14 w-full rounded-control border border-line-control bg-surface px-3 text-base"
          />
        </label>

        <button
          type="submit"
          className="h-14 rounded-control bg-accent px-6 text-base font-medium text-accent-ink hover:brightness-110"
        >
          Filtrele
        </button>

        {hasFilter ? (
          <Link
            href="/hareketler"
            className="h-14 leading-[3.5rem] text-sm text-ink-2 underline"
          >
            Temizle
          </Link>
        ) : null}
      </form>

      {product ? (
        <p className="mb-4 text-sm text-ink-2">
          <span className="font-medium text-ink">{product.name}</span>{' '}
          <span className="tabular">({product.sku})</span> ürününün hareketleri
        </p>
      ) : null}

      <section aria-label="Hareket logu" className="rounded-card border border-line bg-surface shadow-card">
        {visible.length === 0 ? (
          // FİLTRE BOŞ DÖNDÜ ile HİÇ HAREKET YOK farklı durumlar ve çıkış
          // yolları da farklı: birinde filtreyi temizlemek, diğerinde ilk
          // hareketi yazmak gerekiyor. Tek metin ikisini de karşılayamaz.
          hasFilter ? (
            <EmptyState
              title="Bu filtrelere uyan hareket yok"
              description="Tarih aralığını genişletmeyi veya kullanıcı/sebep süzmesini kaldırmayı deneyin."
              action={{ href: '/hareketler', label: 'Filtreyi temizle' }}
            />
          ) : (
            <EmptyState
              title="Henüz hareket yok"
              description="Defter boş. İlk mal kabulünü veya satışı girdiğinizde kayıtlar burada görünmeye başlar."
              action={{ href: '/hareket', label: 'Giriş / Çıkış gir' }}
            />
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-ink-3">
                <tr>
                  <th className="px-4 py-2 font-medium">Tarih</th>
                  <th className="px-4 py-2 font-medium">Kullanıcı</th>
                  <th className="px-4 py-2 font-medium">Ürün</th>
                  <th className="px-4 py-2 text-right font-medium">Miktar</th>
                  <th className="px-4 py-2 font-medium">İşlem</th>
                  {showPrice ? (
                    <th className="px-4 py-2 text-right font-medium">{priceHeader}</th>
                  ) : null}
                  {showOverride ? (
                    <th className="px-4 py-2 font-medium">Sapma</th>
                  ) : null}
                  <th className="px-4 py-2 font-medium">Not</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((m) => (
                  <tr key={m.id} className="border-t border-line align-top">
                    <td className="tabular whitespace-nowrap px-4 py-2 text-ink-2">
                      {formatDateTime(m.createdAt)}
                    </td>
                    <td className="px-4 py-2">{m.userName}</td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/hareketler?urun=${m.productId}`}
                        className="underline decoration-slate-300 underline-offset-2"
                      >
                        {m.productName}
                      </Link>
                      <div className="tabular text-xs text-ink-2">{m.productSku}</div>
                    </td>
                    <td
                      className={`tabular whitespace-nowrap px-4 py-2 text-right font-medium ${
                        m.delta > 0 ? 'text-giris' : 'text-cikis'
                      }`}
                    >
                      {/* Ok işareti + artı/eksi: renk tek başına yön anlatmıyor. */}
                      {m.delta > 0 ? '↑ +' : '↓ −'}
                      {Math.abs(m.delta).toLocaleString('tr-TR')}
                    </td>
                    <td className="px-4 py-2 text-ink-2">
                      {reasonLabel(m.reason as MovementReason)}
                    </td>
                    {showPrice ? (
                      <td className="tabular px-4 py-2 text-right text-ink-2">
                        {/*
                          ÜÇ AYRI DURUM, ÜÇ AYRI GÖSTERİM:
                            alan yok   → "gizli"   (görmeye yetkin yok)
                            null       → "—"       (fiyat girilmemiş)
                            dolu       → tutar
                          İkisini de "—" yapmak, çalışana "bu satın almanın
                          fiyatı hiç girilmemiş" dedirtirdi.
                        */}
                        {m.unitPrice === undefined
                          ? 'gizli'
                          : m.unitPrice === null
                            ? '—'
                            : `${formatMoney(m.unitPrice)} ₺`}
                      </td>
                    ) : null}
                    {showOverride ? (
                      <td className="px-4 py-2 text-ink-2">
                        {m.priceOverrideReason == null ? (
                          ''
                        ) : (
                          // Renk TEK BAŞINA anlam taşımıyor (PLAN.md §11):
                          // ok işareti + etiket + tutar birlikte.
                          <span className="whitespace-nowrap">
                            <span aria-hidden>↓ </span>
                            {priceOverrideReasonLabel(m.priceOverrideReason as PriceOverrideReason)}
                            {m.listPrice != null && m.unitPrice != null ? (
                              <span className="tabular block text-xs text-ink-2">
                                liste {formatMoney(m.listPrice)} ₺ · fark{' '}
                                {formatMoney(m.listPrice - m.unitPrice)} ₺
                              </span>
                            ) : null}
                          </span>
                        )}
                      </td>
                    ) : null}
                    <td className="px-4 py-2 text-ink-2">{m.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination
          basePath="/hareketler"
          params={filters}
          offset={offset}
          limit={PAGE_SIZE}
          shown={visible.length}
          hasNext={hasNext}
        />
      </section>
    </>
  )
}
