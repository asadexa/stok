import { randomUUID } from 'node:crypto'
import {
  type MovementReason,
  type Unit,
  formatQty,
  reasonLabel,
  selectableReasons,
} from '@stok/shared'
import { createMovement, lookupBarcode } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert, SubmitButton } from '@/components/field'
import { Shell } from '@/components/shell'
import { type FormParams, errorQuery, messageFrom, numberOr, optionalText, text } from '@/server/form'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T52 — ELLE HAREKET GİRİŞİ
 *
 * PLAN.md Bölüm 11'deki mobil akışın web karşılığı, aynı üç adım:
 *
 *   okut ──▶ ürün + mevcut stok görünür ──▶ miktar + yön ──▶ "35 → 55"
 *
 * ÜRÜN ADI VE MEVCUT STOK ONAYDAN ÖNCE GÖRÜNÜYOR (D9). Görünmeseydi
 * kullanıcı doğru ürüne yazdığını doğrulayamazdı — ve yanlış ürüne yazılan
 * bir hareket, sayım gününe kadar fark edilmez.
 *
 * BARKOD ADIMI `GET`, YAZMA ADIMI `POST`. Barkod çözümleme salt okunur, o
 * yüzden adres çubuğunda taşınabiliyor: sayfa yenilenebilir, geri tuşu
 * çalışır, tarayıcı önceden çekse bile zarar yok. JavaScript de gerekmiyor —
 * depodaki eski Android tarayıcıda da çalışıyor.
 *
 * BARKOD OKUYUCU = KLAVYE. Alan `autoFocus` ve okuyucu satır sonu
 * gönderdiğinde form kendiliğinden gönderiliyor. Kaydettikten sonra
 * kullanıcı yine barkod alanında oluyor: arka arkaya okutma akışı bozulmuyor.
 *
 * IDEMPOTENCY ANAHTARI OKUTMA ANINDA ÜRETİLİYOR (D-1.3), gönderim anında
 * değil. Barkod çözümlendiğinde üretilip gizli alanda taşınıyor; kullanıcı
 * "Kaydet"e iki kez basarsa aynı anahtar gider ve ikinci istek sessizce
 * yutulur. Gönderim anında üretilseydi çift kayıt oluşurdu.
 * ============================================================================
 */

interface HareketParams extends FormParams {
  barkod?: string
  /** Kayıt sonrası onay şeridi. */
  urun?: string
  onceki?: string
  yeni?: string
  birim?: string
}

export default async function MovementEntryPage({
  searchParams,
}: {
  searchParams: Promise<HareketParams>
}) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')

  const params = await searchParams
  const message = messageFrom(params)
  const barcode = params.barkod?.trim()

  const db = appDb()
  const found = barcode ? await lookupBarcode(actor, barcode, { db }).catch(() => null) : null

  // Anahtar HER ÇÖZÜMLEMEDE yeniden üretiliyor, yani her okutma kendi
  // anahtarını alıyor. Aynı sayfayı yenilemek yeni anahtar üretir ve bu
  // doğru: kullanıcı gerçekten ikinci bir hareket girmek istiyor olabilir.
  const idempotencyKey = randomUUID()

  async function save(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    const scanned = text(form, 'barkod')
    let target: string
    try {
      const result = await createMovement(
        owner,
        {
          idempotencyKey: text(form, 'anahtar'),
          barcode: scanned,
          qty: numberOr(form, 'miktar', 0),
          reason: text(form, 'sebep'),
          ...(optionalText(form, 'not') ? { note: optionalText(form, 'not') } : {}),
          // Cihaz saati yok: web tarayıcısı "cihaz" değil ve sunucu saati
          // zaten doğru. Mobil bu alanı gerçek cihaz saatiyle dolduracak.
          clientCreatedAt: new Date().toISOString(),
        },
        { db: appDb() },
      )

      const previous = result.newQty - result.delta
      target =
        `/hareket?urun=${encodeURIComponent(result.productName)}` +
        `&onceki=${previous}&yeni=${result.newQty}`
    } catch (err) {
      // Hata olduğunda barkodu KORUYORUZ: kullanıcı miktarı düzeltip
      // tekrar deneyecek, etiketi ikinci kez okutmak zorunda kalmamalı.
      target = `/hareket?barkod=${encodeURIComponent(scanned)}&${errorQuery(err)}`
    }
    redirect(target)
  }

  return (
    <Shell role={actor.role} active="/hareket">
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Stok hareketi</h1>
        <Link href="/hareketler" className="text-sm text-slate-600 underline">
          Geçmiş hareketler
        </Link>
      </div>

      {/* ONAY ŞERİDİ — "35 → 55". Sadece yeni sayıyı göstermek yetmez:
          kullanıcı doğru miktarın işlendiğini ancak farktan anlar. */}
      {params.yeni !== undefined && params.urun ? (
        <p className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-giris bg-white p-4">
          <span aria-hidden className="text-2xl text-giris">
            ✓
          </span>
          <span className="font-medium">{params.urun}</span>
          <span className="tabular text-lg">
            {params.onceki} <span aria-hidden>→</span>{' '}
            <span className="font-semibold text-giris">{params.yeni}</span>
          </span>
          <span className="sr-only">kaydedildi</span>
        </p>
      ) : null}

      {message ? <div className="mb-4"><Alert>{message}</Alert></div> : null}

      {/* 1. ADIM — BARKOD. Salt okunur, GET. */}
      <form method="get" action="/hareket" className="mb-6 max-w-xl">
        <label className="block">
          <span className="text-sm font-medium">Barkod</span>
          <input
            // `key` HER DURUM DEĞİŞİMİNDE farklı: React alanı yeniden
            // kuruyor ve `autoFocus` tekrar çalışıyor.
            //
            // Gerekli çünkü sunucu eylemi yönlendirmesi App Router'da
            // YUMUŞAK gezinme — sayfa yeniden yüklenmiyor, `autoFocus`
            // yalnızca ilk montajda ateşleniyor. Bu olmadan kayıttan sonra
            // odak hiçbir yerde kalıyor ve kullanıcı her okutmadan önce
            // alana tıklamak zorunda. Depoda eldivenli elle bu, akışı
            // bitiren bir sürtünme. (Tarayıcı testinde yakalandı.)
            key={params.yeni ?? params.barkod ?? params.hata ?? 'bos'}
            name="barkod"
            type="text"
            required
            autoFocus={!found}
            defaultValue=""
            placeholder="Okutun veya elle yazın"
            className="mt-1 h-16 w-full rounded-md border-2 border-slate-300 bg-white px-4 text-xl outline-none focus:border-slate-900"
          />
        </label>
      </form>

      {/* 2. ADIM — ÜRÜN GÖRÜNÜR, MİKTAR VE YÖN SEÇİLİR. */}
      {barcode && !found ? (
        <div className="max-w-xl rounded-md border border-kritik bg-kritik-bg p-4">
          <p className="flex gap-2 text-kritik">
            <span aria-hidden>⚠</span>
            <span>
              <span className="tabular font-medium">{barcode}</span> barkodu tanımlı değil.
            </span>
          </p>
          {actor.role === 'ADMIN' ? (
            <Link href="/urunler/yeni" className="mt-2 inline-block text-sm underline">
              Bu barkodla yeni ürün ekleyin
            </Link>
          ) : (
            <p className="mt-2 text-sm text-slate-700">Yöneticinizden ürünü tanımlamasını isteyin.</p>
          )}
        </div>
      ) : null}

      {found ? (
        <form action={save} className="max-w-xl space-y-5 rounded-md border border-slate-200 bg-white p-5">
          <input type="hidden" name="barkod" value={found.barcode} />
          <input type="hidden" name="anahtar" value={idempotencyKey} />

          <div>
            <p className="text-2xl font-semibold">{found.productName}</p>
            <p className="tabular text-sm text-slate-500">{found.sku}</p>
            <p className="mt-2 text-lg">
              Mevcut stok:{' '}
              <span className="tabular font-semibold">
                {formatQty(found.qty, found.unit as Unit)}
              </span>
            </p>
            {found.qtyMultiplier !== 1 ? (
              // Koli barkodu okutulduğunda girilen miktar çarpanla
              // çarpılacak. Söylenmezse kullanıcı 5 yazıp 60 girmiş olur
              // ve farkı ancak sayımda görür (D7).
              <p className="mt-2 rounded-md bg-slate-100 px-3 py-2 text-sm">
                Koli barkodu: girdiğiniz miktar{' '}
                <span className="tabular font-semibold">×{found.qtyMultiplier}</span> ile çarpılacak.
              </p>
            ) : null}
            {found.archivedAt ? (
              <p className="mt-2 flex gap-2 text-sm text-kritik">
                <span aria-hidden>⚠</span>
                <span>Bu ürün arşivde; hareket yazılamaz.</span>
              </p>
            ) : null}
          </div>

          {found.archivedAt ? null : (
            <>
              <label className="block">
                <span className="text-sm font-medium">Miktar</span>
                <input
                  name="miktar"
                  type="text"
                  inputMode="decimal"
                  required
                  autoFocus
                  defaultValue="1"
                  className="mt-1 h-16 w-full rounded-md border-2 border-slate-300 bg-white px-4 text-xl outline-none focus:border-slate-900"
                />
              </label>

              {/* YÖN SEBEPTEN TÜRÜYOR, ayrı bir giriş/çıkış düğmesi yok.
                  İşaret kullanıcıdan değil sebepten geliyor (reasons.ts) —
                  "-5 girmek isterken 5 girdi" hatası yapısal olarak
                  imkansız. */}
              <fieldset>
                <legend className="text-sm font-medium">İşlem</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <ReasonGroup title="Giriş" tone="giris" reasons={selectableReasons('IN')} />
                  <ReasonGroup title="Çıkış" tone="cikis" reasons={selectableReasons('OUT')} />
                </div>
              </fieldset>

              <label className="block">
                <span className="text-sm font-medium">Not (isteğe bağlı)</span>
                <input
                  name="not"
                  type="text"
                  maxLength={500}
                  className="mt-1 h-14 w-full rounded-md border border-slate-300 bg-white px-3 text-base outline-none focus:border-slate-900"
                />
              </label>

              <SubmitButton>Kaydet</SubmitButton>
            </>
          )}
        </form>
      ) : null}
    </Shell>
  )
}

function ReasonGroup({
  title,
  tone,
  reasons,
}: {
  title: string
  tone: 'giris' | 'cikis'
  reasons: MovementReason[]
}) {
  const color = tone === 'giris' ? 'text-giris' : 'text-cikis'
  return (
    <div className="rounded-md border border-slate-200 p-3">
      <p className={`text-sm font-medium ${color}`}>
        <span aria-hidden>{tone === 'giris' ? '↑ ' : '↓ '}</span>
        {title}
      </p>
      <div className="mt-2 space-y-1">
        {reasons.map((reason, index) => (
          <label key={reason} className="flex min-h-[2.75rem] items-center gap-2">
            <input
              type="radio"
              name="sebep"
              value={reason}
              // İlk giriş sebebi varsayılan: mal kabulü en sık yapılan iş.
              defaultChecked={tone === 'giris' && index === 0}
              required
              className="size-5"
            />
            <span>{reasonLabel(reason)}</span>
          </label>
        ))}
      </div>
    </div>
  )
}
