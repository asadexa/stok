import {
  MOVEMENT_REASONS,
  MOVEMENT_REASON_VALUES,
  type MovementReason,
  reasonLabel,
} from '@stok/shared'
import { getProduct, listMovements, listTenantUsers } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { Pagination } from '@/components/pagination'
import { dayEndIso, dayStartIso, formatDateTime, formatMoney } from '@/lib/format'
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

interface HareketParams {
  urun?: string
  kullanici?: string
  sebep?: string
  baslangic?: string
  bitis?: string
  atla?: string
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

  // Fiyat sütunu cevaptan türetiliyor, rolden değil: `listMovements`
  // yetkisiz role `unitCost` alanını hiç koymuyor.
  const showCost = visible.some((r) => r.unitCost !== undefined)

  const filters = {
    urun: productId,
    kullanici: canFilterByUser ? userId : undefined,
    sebep: reason,
    baslangic: params.baslangic,
    bitis: params.bitis,
  }
  const hasFilter = Object.values(filters).some(Boolean)

  return (
    <Shell role={actor.role} active="/hareketler">
      {actor.role !== 'ADMIN' ? (
        <p className="mb-4 rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-600">
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
              className="mt-1 h-14 w-full rounded-md border border-slate-300 bg-white px-3 text-base outline-none focus:border-slate-900"
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
            className="mt-1 h-14 w-full rounded-md border border-slate-300 bg-white px-3 text-base outline-none focus:border-slate-900"
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
            className="mt-1 h-14 w-full rounded-md border border-slate-300 bg-white px-3 text-base outline-none focus:border-slate-900"
          />
        </label>

        <label className="block basis-44">
          <span className="text-sm font-medium">Bitiş</span>
          <input
            name="bitis"
            type="date"
            defaultValue={params.bitis ?? ''}
            className="mt-1 h-14 w-full rounded-md border border-slate-300 bg-white px-3 text-base outline-none focus:border-slate-900"
          />
        </label>

        <button
          type="submit"
          className="h-14 rounded-md bg-slate-900 px-6 text-base font-medium text-white hover:bg-slate-700"
        >
          Filtrele
        </button>

        {hasFilter ? (
          <Link
            href="/hareketler"
            className="h-14 leading-[3.5rem] text-sm text-slate-600 underline"
          >
            Temizle
          </Link>
        ) : null}
      </form>

      {product ? (
        <p className="mb-4 text-sm text-slate-600">
          <span className="font-medium text-slate-900">{product.name}</span>{' '}
          <span className="tabular">({product.sku})</span> ürününün hareketleri
        </p>
      ) : null}

      <section aria-label="Hareket logu" className="rounded-md border border-slate-200 bg-white">
        {visible.length === 0 ? (
          <p className="p-6 text-slate-600">
            {hasFilter ? 'Bu filtrelere uyan hareket yok.' : 'Henüz hareket yok.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Tarih</th>
                  <th className="px-4 py-2 font-medium">Kullanıcı</th>
                  <th className="px-4 py-2 font-medium">Ürün</th>
                  <th className="px-4 py-2 text-right font-medium">Miktar</th>
                  <th className="px-4 py-2 font-medium">İşlem</th>
                  {showCost ? <th className="px-4 py-2 text-right font-medium">Birim maliyet</th> : null}
                  <th className="px-4 py-2 font-medium">Not</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((m) => (
                  <tr key={m.id} className="border-t border-slate-100 align-top">
                    <td className="tabular whitespace-nowrap px-4 py-2 text-slate-600">
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
                      <div className="tabular text-xs text-slate-500">{m.productSku}</div>
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
                    <td className="px-4 py-2 text-slate-600">
                      {reasonLabel(m.reason as MovementReason)}
                    </td>
                    {showCost ? (
                      <td className="tabular px-4 py-2 text-right text-slate-600">
                        {m.unitCost == null ? '—' : `${formatMoney(m.unitCost)} ₺`}
                      </td>
                    ) : null}
                    <td className="px-4 py-2 text-slate-600">{m.note ?? ''}</td>
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
    </Shell>
  )
}
