'use client'

import { errorText } from '@stok/shared'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert } from '@/components/field'
import { endPhoneScan, startPhoneScan } from './phone-scan-actions'

/**
 * ============================================================================
 * WS-SCAN — "TELEFONLA BARKOD OKUT" (laptop paneli)
 *
 * Telefon QR ile bağlanıyor ve okuduğu barkod BURADA, USB okuyucunun bugün
 * açtığı `/hareket?barkod=` adresiyle açılıyor. Ürün önizlemesi, miktar,
 * sebep ve Kaydet tamamen mevcut sayfa; stok yalnız Kaydet'le değişir.
 *
 * POLLING SALT OKUNUR: `GET /api/tara/oturum?since=<son uygulanan>`. Aynı
 * okumanın iki kez açılmasını sunucu değil bu bileşen önlüyor; son uygulanan
 * sıra numarası `sessionStorage`'da. Sayfa ya da bileşen yeniden kurulsa da
 * okuma tekrar açılmıyor. Sekme görünmezken polling duruyor.
 *
 * KİRLİ FORM KORUMASI. Telefonun kamerası sürekli açık; kaza okuması USB
 * okuyucudan olasıdır. Açık hareket formunda miktar ya da sebep
 * değiştirilmişse yeni okuma sayfayı DEĞİŞTİRMİYOR, şerit çıkıyor.
 * Değiştirseydi yazılan miktar sessizce kaybolur ve kullanıcı alışkanlıkla
 * Enter'a basıp yanlış ürüne kayıt atabilirdi.
 * ============================================================================
 */

const POLL_MS = 1000
const RETRY_MS = 5000
const ADDRESS_KEY = 'stok.tara.adres'
const SESSION_KEY = 'stok.tara.oturum'

interface SessionView {
  sessionId: string
  state: 'waiting' | 'paired' | 'expired' | 'closed'
  phoneOnline: boolean
  pairingExpiresInMs: number
  seq: number
  latest: { seq: number; barcode: string } | null
}

interface Stored {
  sessionId: string
  lastSeq: number
  /** Yalnız eşleşme beklenirken; sayfa yeniden kurulsa da QR ekranda kalsın. */
  qr?: string
  pairingUrl?: string
}

// `sessionStorage` gizli sekmede ya da kapalı depolamada fırlatabiliyor;
// o durumda panel yine çalışıyor, yalnız yeniden kurulmada QR kayboluyor.
function readStored(): Stored | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Stored) : null
  } catch {
    return null
  }
}

function writeStored(value: Stored | null): void {
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // Depolama yoksa bellekteki durumla devam.
  }
}

/** Açık hareket formunda kullanıcı bir şey değiştirmiş mi (D3). */
function movementFormDirty(): boolean {
  const form = document.querySelector<HTMLInputElement>('form input[name="anahtar"]')?.form
  if (!form) return false
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'hidden') continue
      if (el.type === 'radio' || el.type === 'checkbox') {
        if (el.checked !== el.defaultChecked) return true
      } else if (el.value !== el.defaultValue) return true
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue) return true
    } else if (el instanceof HTMLSelectElement) {
      for (const option of Array.from(el.options)) {
        if (option.selected !== option.defaultSelected) return true
      }
    }
  }
  return false
}

function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const BUTTON = 'h-13 rounded-control px-5 text-base font-semibold'
const PRIMARY = `${BUTTON} bg-accent text-accent-ink hover:brightness-110 disabled:opacity-50`
const SECONDARY = `${BUTTON} border border-line-control bg-surface text-ink hover:bg-surface-2`

export function PhoneScanPanel() {
  const router = useRouter()
  const [address, setAddress] = useState('')
  const [stored, setStored] = useState<Stored | null>(null)
  const [view, setView] = useState<SessionView | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const storedRef = useRef<Stored | null>(null)

  const remember = useCallback((value: Stored | null) => {
    storedRef.current = value
    setStored(value)
    writeStored(value)
  }, [])

  const open = useCallback(
    (barcode: string) => {
      setPending(null)
      router.push(`/hareket?barkod=${encodeURIComponent(barcode)}`)
    },
    [router],
  )

  const reset = useCallback(
    (message: string | null) => {
      remember(null)
      setView(null)
      setNotice(message)
    },
    [remember],
  )

  /** Polling cevabını uygular; polling sürsün mü döndürür. */
  const handle = useCallback(
    (session: SessionView | null): boolean => {
      const current = storedRef.current
      if (!session || session.state === 'closed') {
        reset(current ? 'Telefon bağlantısı kapandı.' : null)
        return false
      }

      // Bu sekme oturumu tanımıyorsa (başka sekmede açıldı ya da kayıt yok)
      // eski okuma açılmıyor: başlangıç noktası şimdiki sıra numarası.
      const known = current?.sessionId === session.sessionId
      const next: Stored = known ? { ...current } : { sessionId: session.sessionId, lastSeq: session.seq }
      // Eşleşince QR'ın işi bitti; ekranda ve depoda kalmasın.
      if (session.state === 'paired') {
        next.qr = undefined
        next.pairingUrl = undefined
      }

      const latest = session.latest
      const fresh = latest !== null && latest.seq > next.lastSeq
      // Önce kaydediliyor, sonra açılıyor: gezinme bileşeni yeniden kursa da
      // aynı okuma ikinci kez açılmasın.
      if (fresh) next.lastSeq = latest.seq
      remember(next)
      setView(session)
      if (fresh) {
        if (movementFormDirty()) setPending(latest.barcode)
        else open(latest.barcode)
      }
      return session.state !== 'expired'
    },
    [open, remember, reset],
  )

  // İlk kurulum: adres ve bu sekmenin oturumu geri geliyor. Sekmede kayıt
  // yoksa bir kez soruluyor: oturum başka sekmede açılmış olabilir.
  useEffect(() => {
    let saved = ''
    try {
      saved = sessionStorage.getItem(ADDRESS_KEY) ?? ''
    } catch {
      saved = ''
    }
    setAddress(saved || (location.protocol === 'https:' ? location.origin : ''))

    const restored = readStored()
    if (restored) {
      remember(restored)
      return
    }
    let cancelled = false
    fetch('/api/tara/oturum?since=0', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<{ session: SessionView | null }>) : null))
      .then((body) => {
        if (!cancelled && body?.session) handle(body.session)
      })
      .catch(() => {
        // Yoklama yalnız kolaylık: başarısızsa panel boşta başlıyor.
      })
    return () => {
      cancelled = true
    }
  }, [remember, handle])

  const sessionId = stored?.sessionId ?? ''

  useEffect(() => {
    if (!sessionId) return
    let stopped = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      if (stopped || inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      let delay = POLL_MS
      let keepGoing = true
      try {
        const since = Math.max(0, storedRef.current?.lastSeq ?? 0)
        const res = await fetch(`/api/tara/oturum?since=${since}`, { cache: 'no-store' })
        const body = (await res.json()) as { session?: SessionView | null; code?: string }
        if (stopped) return
        if (!res.ok) {
          // Oturum düştü ya da bayrak kapandı: tekrar denemek işe yaramaz.
          reset(null)
          setError(errorText(body.code ?? 'SERVER_ERROR'))
          keepGoing = false
        } else {
          keepGoing = handle(body.session ?? null)
        }
      } catch {
        // Ağ hatası (laptop sunucusu yeniden başlıyor olabilir): bekleyip dene.
        delay = RETRY_MS
      } finally {
        inFlight = false
      }
      if (!stopped && keepGoing) timer = setTimeout(tick, delay)
    }

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      clearTimeout(timer)
      void tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sessionId, handle, reset])

  async function start() {
    setBusy(true)
    setError(null)
    setNotice(null)
    setPending(null)
    try {
      const result = await startPhoneScan(address)
      if (!result.ok) {
        setError(result.error)
        return
      }
      try {
        sessionStorage.setItem(ADDRESS_KEY, result.origin)
      } catch {
        // Depolama yoksa adres bir sonraki açılışta yeniden yazılır.
      }
      setAddress(result.origin)
      setView(null)
      remember({
        sessionId: result.sessionId,
        lastSeq: 0,
        qr: result.qr,
        pairingUrl: result.pairingUrl,
      })
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    try {
      await endPhoneScan()
    } finally {
      remember(null)
      setView(null)
      setPending(null)
      setBusy(false)
    }
  }

  const active = Boolean(sessionId)
  const state = view?.state ?? (active ? 'waiting' : null)

  return (
    <section aria-label="Telefonla barkod okut" className="mb-6 max-w-xl space-y-3">
      {pending ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-control border border-warn bg-warn-soft p-3 text-warn-soft-ink"
        >
          <span>
            Telefondan yeni barkod: <span className="tabular font-semibold">{pending}</span>. Formdaki
            değişiklikler kaybolmasın diye açılmadı.
          </span>
          <button type="button" className={PRIMARY} onClick={() => open(pending)}>
            Aç
          </button>
          <button type="button" className={SECONDARY} onClick={() => setPending(null)}>
            Yok say
          </button>
        </div>
      ) : null}

      {error ? <Alert>{error}</Alert> : null}

      {!active || state === 'expired' ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void start()
          }}
        >
          <label className="block min-w-64 flex-1">
            <span className="text-sm font-medium">Telefon adresi (tünel)</span>
            <input
              name="adres"
              type="url"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="https://ornek.trycloudflare.com"
              className="mt-1 h-13 w-full rounded-control border border-line-control bg-surface px-3.5 text-base"
            />
          </label>
          <button type="submit" className={PRIMARY} disabled={busy}>
            {state === 'expired' ? 'Yeni QR oluştur' : 'Telefonla Barkod Okut'}
          </button>
          {state === 'expired' ? (
            <p className="w-full text-sm text-ink-2">QR kodunun süresi doldu.</p>
          ) : null}
          {notice && !active ? <p className="w-full text-sm text-ink-2">{notice}</p> : null}
        </form>
      ) : null}

      {active && state === 'waiting' ? (
        <div className="rounded-card border border-line bg-surface p-4">
          {stored?.qr ? (
            // QR sunucuda üretilmiş bir data: SVG; next/image'in optimize
            // edeceği bir dosya yok.
            // biome-ignore lint/performance/noImgElement: data: SVG
            <img
              src={stored.qr}
              alt="Telefonla okutulacak eşleştirme kodu"
              width={220}
              height={220}
              className="bg-white"
            />
          ) : null}
          <p className="mt-3" role="status">
            Telefonun kamerasıyla bu kodu okutun
            {view ? ` · ${countdown(view.pairingExpiresInMs)} içinde geçersiz olur` : ''}.
          </p>
          {stored?.pairingUrl ? (
            <p className="mt-2 break-all text-xs text-ink-2">
              QR okunmuyorsa telefonda bu adresi açın: {stored.pairingUrl}
            </p>
          ) : null}
        </div>
      ) : null}

      {active && state === 'paired' ? (
        <p role="status" className="text-sm">
          {view?.phoneOnline ? (
            <span className="font-semibold text-ok">Telefon bağlı ✓</span>
          ) : (
            <span className="font-semibold text-warn">Telefon yanıt vermiyor</span>
          )}{' '}
          <span className="text-ink-2">
            · Telefonda okutulan barkod burada açılır; stok yalnız Kaydet’e basınca değişir.
          </span>
        </p>
      ) : null}

      {active && state !== 'expired' ? (
        <button type="button" className={SECONDARY} onClick={() => void stop()} disabled={busy}>
          Bağlantıyı kes
        </button>
      ) : null}
    </section>
  )
}
