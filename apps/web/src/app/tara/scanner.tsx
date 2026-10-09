'use client'

import { errorText } from '@stok/shared'
import zxingReaderWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert } from '@/components/field'
import {
  type DetectedCode,
  INITIAL_SCAN_STATE,
  SCAN_FORMATS,
  type ScanState,
  cameraErrorText,
  formatLabel,
  nativeCoversFormats,
  nextScanState,
} from './scan-logic'

/**
 * ============================================================================
 * WS-SCAN — TELEFON: OKUT VE LAPTOPA GÖNDER
 *
 * Telefon laptoptaki `/hareket` panelinin QR'ıyla eşleşiyor ve okuduğu
 * barkodu YALNIZ metin olarak gönderiyor. Ürün, fiyat ya da stok almıyor;
 * stok laptopta Kaydet'e basılınca değişiyor. Okutma stok hareketi değil.
 *
 * EŞLEŞME. QR'daki tek kullanımlık token adresin fragment'inde (`#e=…`):
 * HTTP isteğine girmiyor, tünelin loguna düşmüyor. Sayfa onu okuyup adres
 * çubuğundan siliyor ve telefonun kendi token'ına çeviriyor. Bu token
 * `sessionStorage`'da (sayfa yenilense de bağlantı kopmasın) ve yalnız
 * `Authorization` başlığıyla gidiyor; çerez yok.
 *
 * HER GÖNDERİM BİLİNÇLİ BİR ADIM. Okuma kabul edilince tarama DURUYOR,
 * kamera açık kalıyor. Kullanıcı "Sonraki Ürünü Tara"ya basmadan yeni okuma
 * yok: kamera rafta gezinirken kaza okuması ve aynı barkodun art arda
 * gönderilmesi yapısal olarak yok. Aynı üründen ikinci adet de bu düğmeyle
 * okutuluyor.
 *
 * ÇÖZÜCÜ. Yerleşik BarcodeDetector beş biçimin hepsini destekliyorsa o
 * (Android Chrome), değilse barcode-detector'ın ZXing WASM'ı. iPhone
 * Safari'de yerleşik API yalnız elle açılan deneysel bir bayrağın arkasında
 * (MDN uyumluluk verisi: Safari 17, "Shape Detection API"), yani iPhone her
 * zaman WASM yolunda.
 *
 * WASM KENDİ ORIGIN'İMİZDEN. Paketin varsayılanı jsDelivr: telefon tünelin
 * arkasındayken çözücünün üçüncü taraf bir CDN'e bağlı kalması, o CDN'e
 * erişilemeyen ağda (ya da ileride CSP ile, T137) okutmanın hiç başlamaması
 * demek. Dosyayı `next.config.ts`'teki Turbopack `asset` kuralı derlemeye
 * kopyalıyor ve içerik özetli bir `/_next/static/media/...` adresi veriyor. Elle
 * kopyalanmış dosya ya da kopyalama betiği yok, paket sürümüyle birlikte
 * değişiyor. Dosyanın çözücünün beklediği ikiliyle aynı olduğunu
 * `scan-logic.test.ts` özetle denetliyor.
 * ============================================================================
 */

interface Detector {
  detect(source: HTMLVideoElement): Promise<DetectedCode[]>
}

interface NativeDetectorClass {
  new (options: { formats: string[] }): Detector
  getSupportedFormats(): Promise<string[]>
}

type DecoderKind = 'native' | 'wasm'

type CameraState = { status: 'off' } | { status: 'starting' } | { status: 'on'; size: string }

type DecoderState =
  | { status: 'loading' }
  | { status: 'ready'; kind: DecoderKind }
  | { status: 'failed'; detail: string }

type LinkState =
  | { status: 'none' }
  | { status: 'pairing' }
  | { status: 'paired'; online: boolean }
  | { status: 'closed'; message: string }

interface Read {
  /** Okuma anında üretiliyor: "Tekrar Dene" aynı kimlikle gider, sunucu ikinci kez saymaz. */
  scanId: string
  barcode: string
  format: string
  /** Tarama başlayalı (ya da "Sonraki Ürünü Tara"dan beri) geçen süre. */
  readMs: number
  /** Okumayı veren karenin çözümleme süresi. */
  frameMs: number
}

type SendState = { status: 'sending' } | { status: 'sent' } | { status: 'failed'; message: string }

const PHONE_TOKEN_KEY = 'stok.tara.telefon'
/** Laptop 15 sn nabız görmezse "yanıt vermiyor" diyor. */
const HEARTBEAT_MS = 5000

// TEK nesne, modül seviyesinde: `prepareZXingModule` `overrides`'ı yüzeysel
// karşılaştırıyor. Her çağrıda yeni bir `locateFile` verilseydi (React'in
// geliştirmede efekti iki kez koşturması dahil) WASM yeniden indirilirdi.
const ZXING_OVERRIDES = {
  locateFile: (path: string, prefix: string) =>
    path.endsWith('.wasm') ? zxingReaderWasmUrl : prefix + path,
}

async function createDetector(): Promise<{ kind: DecoderKind; detector: Detector }> {
  const Native = (globalThis as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector
  if (Native && nativeCoversFormats(await Native.getSupportedFormats())) {
    return { kind: 'native', detector: new Native({ formats: [...SCAN_FORMATS] }) }
  }

  // Dinamik import: ZXing'in JS'i sunucu render'ında hiç değerlendirilmiyor
  // ve yerleşik çözücüsü olan telefona hiç inmiyor.
  const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill')
  // WASM kamera açılmadan indirilip derleniyor: yanlış adres ya da bozuk dosya
  // ilk okutmada değil, sayfa açılır açılmaz "Çözücü" satırında görünsün.
  await prepareZXingModule({ overrides: ZXING_OVERRIDES, fireImmediately: true })
  return { kind: 'wasm', detector: new BarcodeDetector({ formats: [...SCAN_FORMATS] }) }
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

const SECONDS = new Intl.NumberFormat('tr-TR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

// `sessionStorage` gizli sekmede ya da kapalı depolamada fırlatabiliyor; o
// durumda bağlantı yalnız bu sayfa açık kaldıkça sürüyor.
function readPhoneToken(): string | null {
  try {
    return sessionStorage.getItem(PHONE_TOKEN_KEY)
  } catch {
    return null
  }
}

function writePhoneToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(PHONE_TOKEN_KEY, token)
    else sessionStorage.removeItem(PHONE_TOKEN_KEY)
  } catch {
    // Depolama yoksa token yalnız bellekte.
  }
}

/** Ağ hatasında fırlatır; sunucu hatasında kodu döndürür. */
async function post(
  path: string,
  token: string | null,
  body: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; code: string }> {
  const res = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const data: unknown = await res.json().catch(() => ({}))
  if (res.ok) return { ok: true, data }
  return { ok: false, code: (data as { code?: string }).code ?? 'SERVER_ERROR' }
}

const UNREACHABLE = 'Sunucuya ulaşılamadı. İnternet bağlantısını kontrol edip tekrar deneyin.'

export function Scanner() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const detectorRef = useRef<Detector | null>(null)
  /**
   * Her başlatma ve durdurma bu sayacı artırıyor. Bekleyen bir `getUserMedia`,
   * `play()` ya da `detect()` döndüğünde sayaç değişmişse sonucu atılıyor:
   * izin penceresi açıkken "Durdur"a basılırsa ya da sayfadan çıkılırsa kamera
   * arkada açık kalmasın.
   */
  const sessionRef = useRef(0)
  const frameRef = useRef(0)
  const scanRef = useRef<ScanState>(INITIAL_SCAN_STATE)
  const startedAtRef = useRef(0)
  /** Okuma kabul edilince `true`: "Sonraki Ürünü Tara"ya kadar yeni kare çözülmüyor. */
  const pausedRef = useRef(false)
  const tokenRef = useRef<string | null>(null)

  const [camera, setCamera] = useState<CameraState>({ status: 'off' })
  const [decoder, setDecoder] = useState<DecoderState>({ status: 'loading' })
  const [link, setLink] = useState<LinkState>({ status: 'none' })
  const [read, setRead] = useState<Read | null>(null)
  const [send, setSend] = useState<SendState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    createDetector().then(
      ({ kind, detector }) => {
        if (!active) return
        detectorRef.current = detector
        setDecoder({ status: 'ready', kind })
      },
      (err: unknown) => {
        if (active) setDecoder({ status: 'failed', detail: errorDetail(err) })
      },
    )
    return () => {
      active = false
    }
  }, [])

  // Durum yazmıyor: sayfadan çıkılırken de çağrılıyor.
  const release = useCallback(() => {
    sessionRef.current += 1
    cancelAnimationFrame(frameRef.current)
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  useEffect(() => release, [release])

  const stop = useCallback(() => {
    release()
    setCamera({ status: 'off' })
  }, [release])

  /** Laptop tarafı kapandı: gönderilecek yer kalmadı, kamera da kapanıyor. */
  const closeLink = useCallback(
    (code: string) => {
      tokenRef.current = null
      writePhoneToken(null)
      setLink({ status: 'closed', message: errorText(code) })
      stop()
    },
    [stop],
  )

  // Eşleşme: QR'dan gelen token varsa çevriliyor, yoksa bu sekmenin kayıtlı
  // token'ı kullanılıyor.
  useEffect(() => {
    const match = /^#e=([A-Za-z0-9_-]+)$/.exec(location.hash)
    if (!match) {
      const saved = readPhoneToken()
      if (saved) {
        tokenRef.current = saved
        setLink({ status: 'paired', online: true })
      }
      return
    }
    // Token adres çubuğunda, geçmişte ve paylaşılan bağlantıda kalmasın.
    history.replaceState(null, '', location.pathname)
    setLink({ status: 'pairing' })
    post('/api/tara/eslestir', null, { token: match[1] }).then(
      (result) => {
        if (!result.ok) {
          setLink({ status: 'closed', message: errorText(result.code) })
          return
        }
        const token = (result.data as { phoneToken: string }).phoneToken
        tokenRef.current = token
        writePhoneToken(token)
        setLink({ status: 'paired', online: true })
      },
      () => setLink({ status: 'closed', message: UNREACHABLE }),
    )
  }, [])

  // Nabız: laptop "Telefon bağlı" desin, oturum boşta kapanmasın. Laptop
  // bağlantıyı kestiyse cevap söylüyor ve kamera kapanıyor.
  const paired = link.status === 'paired'
  useEffect(() => {
    if (!paired) return
    let stopped = false
    const beat = async () => {
      const token = tokenRef.current
      if (!token || stopped) return
      try {
        const result = await post('/api/tara/telefon', token, {})
        if (stopped) return
        if (result.ok) {
          setLink((l) => (l.status === 'paired' && !l.online ? { status: 'paired', online: true } : l))
        } else if (result.code === 'SCAN_SESSION_CLOSED' || result.code === 'NOT_FOUND') {
          closeLink(result.code)
        }
      } catch {
        if (!stopped) {
          setLink((l) => (l.status === 'paired' && l.online ? { status: 'paired', online: false } : l))
        }
      }
    }
    const timer = setInterval(beat, HEARTBEAT_MS)
    // iPhone arka plandaki sekmenin zamanlayıcılarını durduruyor; öne
    // gelince beklemeden yokla.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void beat()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [paired, closeLink])

  const deliver = useCallback(
    async (current: Read) => {
      const token = tokenRef.current
      if (!token) {
        setSend({ status: 'failed', message: errorText('SCAN_SESSION_CLOSED') })
        return
      }
      setSend({ status: 'sending' })
      try {
        const result = await post('/api/tara/okut', token, {
          scanId: current.scanId,
          barcode: current.barcode,
        })
        if (result.ok) {
          setSend({ status: 'sent' })
          return
        }
        setSend({ status: 'failed', message: errorText(result.code) })
        if (result.code === 'SCAN_SESSION_CLOSED' || result.code === 'NOT_FOUND') {
          closeLink(result.code)
        }
      } catch {
        setSend({ status: 'failed', message: UNREACHABLE })
      }
    },
    [closeLink],
  )

  // Bir kare çözülmeden sonrakine geçilmiyor: çözücü yavaşsa istekler
  // birikmiyor, sekme arka plandayken requestAnimationFrame zaten duruyor.
  const scan = useCallback(
    (session: number) => {
      const tick = async () => {
        if (session !== sessionRef.current || pausedRef.current) return
        const video = videoRef.current
        const detector = detectorRef.current
        // Kare gelmeden çağrılırsa çözücü InvalidStateError fırlatıyor; WASM
        // henüz hazır değilse de beklemek yeterli.
        if (video && detector && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const frameStart = performance.now()
          let codes: DetectedCode[]
          try {
            codes = await detector.detect(video)
          } catch (err) {
            if (session === sessionRef.current) {
              stop()
              setError(`Barkod çözümlenemedi (${errorDetail(err)}).`)
            }
            return
          }
          if (session !== sessionRef.current || pausedRef.current) return

          const step = nextScanState(scanRef.current, codes)
          scanRef.current = step.state
          if (step.read) {
            // Okuma kabul edildi: tarama DURUYOR, kamera açık kalıyor.
            pausedRef.current = true
            const now = performance.now()
            const accepted: Read = {
              scanId: crypto.randomUUID(),
              barcode: step.read.rawValue,
              format: step.read.format,
              readMs: now - startedAtRef.current,
              frameMs: now - frameStart,
            }
            setRead(accepted)
            void deliver(accepted)
            return
          }
        }
        frameRef.current = requestAnimationFrame(tick)
      }
      frameRef.current = requestAnimationFrame(tick)
    },
    [deliver, stop],
  )

  function resetScan() {
    setRead(null)
    setSend(null)
    setError(null)
    scanRef.current = INITIAL_SCAN_STATE
    pausedRef.current = false
    startedAtRef.current = performance.now()
  }

  async function start() {
    resetScan()
    // Güvenli olmayan bağlamda (düz http, yerel ağ adresi) `mediaDevices`
    // tanımsız geliyor; "desteklemiyor" demek yanlış teşhis olurdu.
    if (!window.isSecureContext) {
      setError('Kamera yalnız güvenli bağlantıda açılır. Sayfayı https:// ile başlayan adresten açın.')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Bu tarayıcı kamera erişimini desteklemiyor.')
      return
    }

    sessionRef.current += 1
    const session = sessionRef.current
    setCamera({ status: 'starting' })

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
    } catch (err) {
      if (session === sessionRef.current) {
        setCamera({ status: 'off' })
        setError(cameraErrorText(err))
      }
      return
    }
    if (session !== sessionRef.current) {
      for (const track of stream.getTracks()) track.stop()
      return
    }

    const video = videoRef.current!
    streamRef.current = stream
    video.srcObject = stream
    try {
      await video.play()
    } catch (err) {
      if (session === sessionRef.current) {
        stop()
        setError(cameraErrorText(err))
      }
      return
    }
    if (session !== sessionRef.current) return

    startedAtRef.current = performance.now()
    setCamera({ status: 'on', size: `${video.videoWidth}×${video.videoHeight}` })
    scan(session)
  }

  /** "Sonraki Ürünü Tara": kamera açıksa aynı akışta taramaya döner, kapalıysa açar. */
  function nextProduct() {
    if (camera.status !== 'on') {
      void start()
      return
    }
    resetScan()
    scan(sessionRef.current)
  }

  const canScan = link.status === 'paired'

  return (
    <main className="mx-auto max-w-xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">Barkod okut</h1>
        <p className="mt-1 text-sm text-ink-2">
          Okunan barkod laptopta hareket ekranında açılır. Stok, laptopta Kaydet’e basılınca
          değişir.
        </p>
      </div>

      {link.status === 'none' ? (
        <p className="rounded-control border border-line bg-surface p-3 text-sm">
          Laptopta hareket ekranındaki “Telefonla Barkod Okut” düğmesine basın ve çıkan QR kodunu bu
          telefonun kamerasıyla okutun.
        </p>
      ) : null}
      {link.status === 'closed' ? <Alert>{link.message}</Alert> : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-semibold">Laptop</dt>
        <dd>
          {link.status === 'pairing'
            ? 'Bağlanıyor…'
            : link.status === 'paired'
              ? link.online
                ? 'Bağlı ✓'
                : 'Bağlantı sorunu, yeniden deneniyor…'
              : 'Bağlı değil'}
        </dd>
        <dt className="font-semibold">Kamera</dt>
        <dd>
          {camera.status === 'off'
            ? 'Kapalı'
            : camera.status === 'starting'
              ? 'Açılıyor…'
              : `Açık (${camera.size})`}
        </dd>
        <dt className="font-semibold">Çözücü</dt>
        <dd>
          {decoder.status === 'loading'
            ? 'Hazırlanıyor…'
            : decoder.status === 'ready'
              ? decoder.kind === 'native'
                ? 'Hazır: yerleşik BarcodeDetector'
                : 'Hazır: ZXing WASM'
              : `Yüklenemedi (${decoder.detail})`}
        </dd>
      </dl>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={start}
          disabled={camera.status !== 'off' || !canScan}
          className="h-14 flex-1 rounded-control bg-accent px-4 text-base font-semibold text-accent-ink hover:brightness-110 disabled:opacity-50"
        >
          Kamerayı Başlat
        </button>
        <button
          type="button"
          onClick={stop}
          disabled={camera.status === 'off'}
          className="h-14 flex-1 rounded-control border border-line-control bg-surface px-4 text-base font-semibold text-ink hover:bg-surface-2 disabled:opacity-50"
        >
          Kamerayı Durdur
        </button>
      </div>

      {error ? <Alert>{error}</Alert> : null}

      {/* Sonuç videonun ÜSTÜNDE: altında kalsaydı küçük ekranlı telefonda
          barkoda nişan alan kişi okumayı görmek için kaydırmak zorunda kalırdı. */}
      <section aria-live="polite" className="space-y-2 rounded-card border border-line bg-surface p-4">
        {read ? (
          <>
            <p className="text-lg">
              Barkod: <span className="break-all font-mono font-semibold">{read.barcode}</span>
            </p>
            <p>Format: {formatLabel(read.format)}</p>
            <p className="font-semibold">
              {send?.status === 'sending'
                ? 'Laptopa gönderiliyor…'
                : send?.status === 'sent'
                  ? 'Laptopa gönderildi ✓'
                  : send?.status === 'failed'
                    ? send.message
                    : ''}
            </p>
            <p className="text-xs text-ink-2">
              Okuma {SECONDS.format(read.readMs / 1000)} sn · tek kare çözümleme{' '}
              {Math.round(read.frameMs)} ms
            </p>
            {send && send.status !== 'sending' && canScan ? (
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={nextProduct}
                  className="h-14 flex-1 rounded-control bg-accent px-4 text-base font-semibold text-accent-ink hover:brightness-110"
                >
                  Sonraki Ürünü Tara
                </button>
                {send.status === 'failed' ? (
                  <button
                    type="button"
                    onClick={() => void deliver(read)}
                    className="h-14 rounded-control border border-line-control bg-surface px-4 text-base font-semibold text-ink hover:bg-surface-2"
                  >
                    Tekrar Dene
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-ink-2">
            {camera.status === 'on' ? 'Barkodu kameraya tutun.' : 'Henüz barkod okunmadı.'}
          </p>
        )}
      </section>

      {/* `playsInline` + `muted`: iPhone Safari bunlar olmadan videoyu tam
          ekrana açıyor ya da kendiliğinden oynatmıyor. */}
      <video
        ref={videoRef}
        playsInline
        muted
        className="aspect-[3/4] max-h-[60vh] w-full rounded-card bg-black object-contain"
      />
    </main>
  )
}
