import { randomUUID } from 'node:crypto'
import {
  type MovementReason,
  PRICE_OVERRIDE_REASON_VALUES,
  type Unit,
  formatQty,
  priceOverrideReasonLabel,
  reasonLabel,
  selectableReasons,
} from '@stok/shared'
import { createMovement, lookupBarcode } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert, SubmitButton } from '@/components/field'
import { formatMoney } from '@/lib/format'
import { SaveFeedback } from '@/components/save-feedback'
import {
  type FormParams,
  errorQuery,
  messageFrom,
  numberOr,
  optionalNumber,
  optionalText,
  preserveFields,
  text,
} from '@/server/form'
import { currentActor } from '@/server/session'
import { readSoundEnabled } from '@/server/theme'

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
 * çalışır, tarayıcı önceden çekse bile zarar yok.
 *
 * BURADA "JAVASCRIPT DE GEREKMİYOR" YAZIYORDU — DOĞRU DEĞİLDİ (ölçüldü
 * 2026-09-03, T110). Sayfa akışla (streaming) geliyor ve akan içeriği
 * yerine koyan şey SATIR İÇİ SCRIPT'LER. JavaScript kapalıyken ekranda
 * "Sayfa yükleniyor" iskeleti kalıyor ve "Kaydet" düğmesi hiç oluşmuyor,
 * yani form kullanılamıyor. Barkod adımının GET olması hâlâ değerli
 * (adres taşınabilir, geri tuşu çalışır) ama JS'siz çalışma iddiası
 * kaldırıldı.
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
  /** Hata sonrası geri doldurulan alanlar — kullanıcı baştan yazmasın. */
  fiyat?: string
  sebep?: string
  sapma?: string
  fiyatTarihi?: string
  tahmini?: string
  miktar?: string
  not?: string
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
  const soundEnabled = await readSoundEnabled()
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
    const reason = text(form, 'sebep')
    const unitPrice = optionalNumber(form, 'fiyat')
    const overrideReason = optionalText(form, 'sapma')
    let target: string
    try {
      const result = await createMovement(
        owner,
        {
          idempotencyKey: text(form, 'anahtar'),
          barcode: scanned,
          qty: numberOr(form, 'miktar', 0),
          reason,
          ...(optionalText(form, 'not') ? { note: optionalText(form, 'not') } : {}),
          ...(unitPrice === undefined ? {} : { unitPrice }),
          // Ekranda GÖRÜLEN liste fiyatı da gidiyor. Sunucu bunu
          // karşılaştırmada kullanmıyor — kendi okuduğunu kullanıyor —
          // ama ayrı sütuna yazıyor: fiyat aradan değiştiyse fiş ile
          // sistemin ayrıştığı ancak iki sayı yan yana durunca görülür.
          ...(optionalNumber(form, 'liste') === undefined
            ? {}
            : { clientListPrice: optionalNumber(form, 'liste') }),
          ...(overrideReason ? { priceOverrideReason: overrideReason } : {}),
          ...(optionalText(form, 'fiyatTarihi')
            ? { priceDate: optionalText(form, 'fiyatTarihi') }
            : {}),
          priceEstimated: form.get('tahmini') === 'on',
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
      /**
       * HATA DÖNÜŞÜNDE FORMUN TAMAMI KORUNUYOR.
       *
       * MİKTAR EN KRİTİĞİ ve tarayıcı testinde yakalandı: kullanıcı 5
       * yazıp "fiyat zorunlu" hatası alıyor, fiyatı dolduruyor, ama
       * miktar sessizce varsayılana (1) dönmüş oluyordu — ve ikinci
       * gönderim BAŞARILI olduğu için hiçbir uyarı çıkmıyordu. Yani
       * hata mesajı, sessiz bir YANLIŞ KAYIT üretiyordu. Depoda bunun
       * farkı sayım gününe kadar görünmez.
       */
      const keep = preserveFields(
        form,
        // Formdaki KULLANICI GİRDİSİ olan her alan. Listeden bir ad
        // düşerse o alan sessizce sıfırlanır — bkz. `preserveFields`.
        ['miktar', 'sebep', 'not', 'fiyat', 'sapma', 'fiyatTarihi'],
        {
          barkod: scanned,
          // Onay kutusu işaretsizken FormData'da hiç bulunmuyor; taşınacak
          // değer de "on" değil, sayfanın beklediği "1".
          tahmini: form.get('tahmini') === 'on' ? '1' : undefined,
        },
      )
      target = `/hareket?${keep.toString()}&${errorQuery(err)}`
    }
    redirect(target)
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Stok hareketi</h1>
        <Link href="/hareketler" className="text-sm text-ink-2 underline">
          Geçmiş hareketler
        </Link>
      </div>

      {/* ONAY ŞERİDİ — "35 → 55". Sadece yeni sayıyı göstermek yetmez:
          kullanıcı doğru miktarın işlendiğini ancak farktan anlar. */}
      {/*
        KAYIT ONAYI — T79.

        `role="status"`: ekran okuyucu için bu bir durum bildirimi, süs değil.
        Sayfanın EN BAŞINDA duruyor ki kayıttan sonraki gezinmede ilk okunan
        şey olsun.

        GÖRSEL PARÇALAR `aria-hidden`, ALTINDA TEK BİR CÜMLE VAR. Eskiden ok
        işareti gizli, sayılar açıktaydı; ekran okuyucu "446 496" diye
        ilişkisiz iki sayı okuyordu ve hangisinin yeni stok olduğu
        anlaşılmıyordu. Şimdi "... kaydedildi. Stok 446'dan 496'ya değişti."
        diye tam bir cümle duyuluyor.

        ODAK BURAYA ALINMIYOR. Alınsaydı barkod alanından çalınırdı ve arka
        arkaya okutma akışı bozulurdu (Kural 05). Sesli geri bildirim T81'in
        işi; bu şerit gözle ve ekran okuyucuyla okunan kanal.
      */}
      {/* Sesli + titreşimli geri bildirim (T81). Şeridin yanında, çünkü aynı
          olayı iki farklı kanaldan anlatıyorlar: göz ve kulak. */}
      {params.yeni !== undefined && params.urun ? (
        <SaveFeedback tone="ok" enabled={soundEnabled} signature={params.yeni} />
      ) : null}
      {message ? (
        <SaveFeedback tone="error" enabled={soundEnabled} signature={message} />
      ) : null}

      {params.yeni !== undefined && params.urun ? (
        <p
          role="status"
          className="mb-4 flex flex-wrap items-center gap-3 rounded-control border border-ok bg-ok-soft p-4 text-ok-soft-ink"
        >
          <span aria-hidden className="flex flex-wrap items-center gap-3">
            <span className="text-2xl">✓</span>
            <span className="font-semibold">{params.urun}</span>
            <span className="tabular text-lg">
              {params.onceki} → <span className="font-bold">{params.yeni}</span>
              {params.birim ? ` ${params.birim}` : ''}
            </span>
          </span>
          <span className="sr-only">
            {params.urun} kaydedildi. Stok {params.onceki} birimden {params.yeni}
            {params.birim ? ` ${params.birim}` : ''} birime değişti.
          </span>
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
            className="mt-1 h-16 w-full rounded-control border-2 border-line-control bg-surface px-4 text-xl"
          />
        </label>
      </form>

      {/* 2. ADIM — ÜRÜN GÖRÜNÜR, MİKTAR VE YÖN SEÇİLİR. */}
      {barcode && !found ? (
        <div className="max-w-xl rounded-card border border-kritik bg-kritik-bg p-4">
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
            <p className="mt-2 text-sm text-ink-2">Yöneticinizden ürünü tanımlamasını isteyin.</p>
          )}
        </div>
      ) : null}

      {found ? (
        <form action={save} className="max-w-xl space-y-5 rounded-card border border-line bg-surface shadow-card p-5">
          <input type="hidden" name="barkod" value={found.barcode} />
          <input type="hidden" name="anahtar" value={idempotencyKey} />

          <div>
            <p className="text-2xl font-semibold">{found.productName}</p>
            <p className="tabular text-sm text-ink-3">{found.sku}</p>
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
              <p className="mt-2 rounded-control bg-surface-2 px-3 py-2 text-sm">
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
                  defaultValue={params.miktar ?? '1'}
                  className="mt-1 h-16 w-full rounded-control border-2 border-line-control bg-surface px-4 text-xl"
                />
              </label>

              {/* YÖN SEBEPTEN TÜRÜYOR, ayrı bir giriş/çıkış düğmesi yok.
                  İşaret kullanıcıdan değil sebepten geliyor (reasons.ts) —
                  "-5 girmek isterken 5 girdi" hatası yapısal olarak
                  imkansız. */}
              <fieldset>
                <legend className="text-sm font-medium">İşlem</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <ReasonGroup
                    title="Giriş"
                    tone="giris"
                    reasons={selectableReasons('IN')}
                    selected={params.sebep}
                  />
                  <ReasonGroup
                    title="Çıkış"
                    tone="cikis"
                    reasons={selectableReasons('OUT')}
                    selected={params.sebep}
                  />
                </div>
              </fieldset>

              {/*
                ── KASA AÇIĞI KONTROLÜ (T88) ────────────────────────────

                Senaryo: liste 110 ₺, tanıdığa 100 ₺ verildi, kasada 10 ₺
                açık. Amaç açığı ENGELLEMEK DEĞİL, GİZLENEMEZ yapmak.

                LİSTE FİYATI ÖNCE OKUNUR HALDE YAZIYOR. Yazmasaydı çalışan
                sapıp sapmadığını bilemezdi ve "sebep seçin" uyarısı
                anlamsız bir engel gibi görünürdü.

                ALANLAR KOŞULLU GİZLENMİYOR. Gerekçe "form JS'siz çalışıyor"
                DEĞİL — o iddia yanlış çıktı (T110). Gerekçe daha basit:
                hangi işlemlerde fiyat girildiği etiketin İÇİNDE yazıyor ve
                sunucu yanlış eşleşmeyi zaten reddediyor, yani koşullu
                gizleme olmadan da kullanıcı ne yapacağını biliyor.
                Alanları sebebe göre açıp kapatmak ölçülmüş bir ihtiyaç
                değil; ölçülmeden yapılırsa T108'in uyardığı gereksiz iş.
              */}
              <fieldset className="rounded-control border border-line p-3">
                <legend className="px-1 text-sm font-medium">Fiyat</legend>

                <p className="text-sm text-ink-2">
                  Liste satış fiyatı:{' '}
                  <span className="tabular font-semibold text-ink">
                    {found.salePrice === null ? 'girilmemiş' : `${formatMoney(found.salePrice)} ₺`}
                  </span>
                  {found.purchasePrice == null ? null : (
                    <>
                      {' · alış: '}
                      <span className="tabular font-semibold text-ink">
                        {formatMoney(found.purchasePrice)} ₺
                      </span>
                    </>
                  )}
                </p>
                {/* Ekranda görülen liste fiyatı sunucuya da gidiyor; sunucu
                    kendi okuduğuyla karşılaştırmıyor ama ayrı sütuna yazıyor
                    ki ekran bayatladıysa kanıt kalsın. */}
                {found.salePrice === null ? null : (
                  <input type="hidden" name="liste" value={found.salePrice} />
                )}

                <label className="mt-3 block">
                  <span className="text-sm font-medium">
                    Birim fiyat{' '}
                    <span className="font-normal text-ink-2">
                      (alış, satış ve iadelerde; fire/kullanımda girilmez)
                    </span>
                  </span>
                  <input
                    name="fiyat"
                    type="text"
                    inputMode="decimal"
                    defaultValue={params.fiyat ?? ''}
                    placeholder={found.salePrice === null ? '' : String(found.salePrice)}
                    className="mt-1 h-14 w-full rounded-control border border-line-control bg-surface px-3 text-base"
                  />
                </label>

                <label className="mt-3 block">
                  <span className="text-sm font-medium">
                    Sapma sebebi{' '}
                    <span className="font-normal text-ink-2">
                      (liste fiyatından farklı yazdıysanız zorunlu)
                    </span>
                  </span>
                  {/*
                    SERBEST METİN DEĞİL, LİSTE. Takip toplanabilirlik demek:
                    "bu ay tanıdık indirimine kaç lira gitti" sorusunu
                    serbest metin cevaplayamaz.
                  */}
                  <select
                    name="sapma"
                    defaultValue={params.sapma ?? ''}
                    className="mt-1 h-14 w-full rounded-control border border-line-control bg-surface px-3 text-base"
                  >
                    <option value="">— Sapma yok —</option>
                    {PRICE_OVERRIDE_REASON_VALUES.map((r) => (
                      <option key={r} value={r}>
                        {priceOverrideReasonLabel(r)}
                      </option>
                    ))}
                  </select>
                </label>

                {/*
                  ── AÇILIŞ DEĞERLEMESİ (T89) ──────────────────────────

                  KRİTİK ALAN FİYAT DEĞİL TARİH. 5 yıldır rafta duran malın
                  devri bugün yazılıyor ama fiyatı 5 yıl öncesine ait. İkisi
                  aynı sayılsaydı enflasyon düzeltmesi (T90) o fiyatı bugünün
                  parası sanar ve yenileme maliyetini düşük hesaplardı.

                  YÖNLENDİRME METNİ FORMUN İÇİNDE, yardım sayfasında değil:
                  kullanıcının tıkandığı yer tam olarak burası ve "eski
                  fatura yoksa ne yazacağım" sorusunun cevabı, sorunun
                  sorulduğu anda görünmek zorunda.
                */}
                <div className="mt-4 rounded-control bg-surface-2 p-3">
                  <p className="text-sm text-ink-2">
                    <span className="font-medium text-ink">Eski mal mı giriyorsunuz?</span>{' '}
                    Elinizde eski fatura varsa o tutarı ve fatura tarihini girin — sistem
                    bugüne taşır. Fatura yoksa bugün aynısını kaça alacağınızı yazıp
                    “tahmini” işaretleyin.
                  </p>

                  <label className="mt-3 block">
                    <span className="text-sm font-medium">
                      Fiyat tarihi{' '}
                      <span className="font-normal text-ink-2">
                        (boş = bugün; satışta geçmiş tarih girilemez)
                      </span>
                    </span>
                    <input
                      name="fiyatTarihi"
                      type="date"
                      defaultValue={params.fiyatTarihi ?? ''}
                      className="mt-1 h-14 w-full rounded-control border border-line-control bg-surface px-3 text-base"
                    />
                  </label>

                  <label className="mt-3 flex min-h-14 items-center gap-3">
                    <input
                      type="checkbox"
                      name="tahmini"
                      defaultChecked={params.tahmini === '1'}
                      className="size-5 shrink-0"
                    />
                    <span className="text-sm">
                      <span className="font-medium">Tahmini fiyat</span>
                      <span className="block text-ink-2">
                        Faturam yok, bugünkü değerini tahmin ettim
                      </span>
                    </span>
                  </label>
                </div>
              </fieldset>

              <label className="block">
                <span className="text-sm font-medium">Not (isteğe bağlı)</span>
                <input
                  name="not"
                  type="text"
                  maxLength={500}
                  defaultValue={params.not ?? ''}
                  className="mt-1 h-14 w-full rounded-control border border-line-control bg-surface px-3 text-base"
                />
              </label>

              <SubmitButton>Kaydet</SubmitButton>
            </>
          )}
        </form>
      ) : null}
    </>
  )
}

function ReasonGroup({
  title,
  tone,
  reasons,
  selected,
}: {
  title: string
  tone: 'giris' | 'cikis'
  reasons: MovementReason[]
  /** Hatadan sonra geri gelen seçim; yoksa ilk giriş sebebi. */
  selected?: string
}) {
  const color = tone === 'giris' ? 'text-giris' : 'text-cikis'
  return (
    <div className="rounded-card border border-line p-3">
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
              // Hata dönüşünde kullanıcının seçtiği sebep korunuyor —
              // yoksa "sapma sebebi seçin" uyarısından sonra işlem
              // sessizce "Satın alma"ya döner ve satış kaydı kaybolurdu.
              defaultChecked={
                selected === undefined || selected === ''
                  ? tone === 'giris' && index === 0
                  : selected === reason
              }
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
