/**
 * ============================================================================
 * WS-SCAN — KAMERA OKUTMA KURALLARI (saf: DOM, kamera, çözücü yok)
 *
 * Bileşenden ayrı duruyor, çünkü bu makinede kamera yok ve kurallar gerçek
 * kamera olmadan sınanabilmeli. Burada verilen tek karar bir çözümlemenin ne
 * zaman "okundu" sayılacağı. Okutma stok hareketi DEĞİL: aşağıdaki bastırma
 * yalnız aynı barkodun ekrana tekrar tekrar yazılmasını önlüyor; hareketin
 * çift kaydını önleyen şey `createMovement`'ın idempotency anahtarı (D-1.3).
 * ============================================================================
 */

/** Pilot kapsamı. QR ve ITF bilinçli olarak yok: dükkândaki ürün barkodları bunlar. */
export const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] as const

type ScanFormat = (typeof SCAN_FORMATS)[number]

const FORMAT_LABELS: Readonly<Record<string, string>> = {
  ean_13: 'EAN-13',
  ean_8: 'EAN-8',
  upc_a: 'UPC-A',
  upc_e: 'UPC-E',
  code_128: 'Code 128',
} satisfies Record<ScanFormat, string>

export function formatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format
}

/**
 * Yerleşik BarcodeDetector yalnız beş biçimin HEPSİNİ destekliyorsa seçilir.
 * Kısmen destekleyen bir uygulamada eksik biçimdeki ürün hiç okunmaz ve
 * kullanıcı bunu kameranın hatası sanardı; WASM aynı arayüzle hepsini okuyor.
 */
export function nativeCoversFormats(supported: readonly string[]): boolean {
  return SCAN_FORMATS.every((format) => supported.includes(format))
}

export interface DetectedCode {
  rawValue: string
  format: string
}

export interface ScanState {
  /** Bir kez görülmüş, henüz teyit edilmemiş okuma. */
  candidate: string | null
  /** Ekrana en son yazılan okuma. */
  accepted: string | null
}

export const INITIAL_SCAN_STATE: ScanState = { candidate: null, accepted: null }

/**
 * Bir karenin çözümleme sonucunu işler.
 *
 * İKİ ARDIŞIK ÇÖZÜMLEME AYNI DEĞERİ VERMEDEN OKUMA KABUL EDİLMİYOR: bulanık
 * bir karede tek seferlik yanlış çözümlenen rakam ekrana düşmesin. Barkodsuz
 * kare teyidi SIFIRLAMIYOR: elde tutulan telefonda çözümleme kare atlayarak
 * geliyor ve sıfırlasaydı okuma titreyen elde hiç teyit edilemezdi. Arada
 * başka bir değer görülürse teyit baştan başlıyor.
 *
 * Karede birden fazla barkod varsa hangisinin kastedildiği bilinemez: o kare
 * teyidi sıfırlıyor. Raftaki komşu ürünün barkodu yanlış ürün okutmak demek.
 *
 * Ekrandakiyle aynı okuma yeniden yazılmıyor; barkod kamerada durdukça her
 * kare yeni bir okuma üretirdi.
 */
export function nextScanState(
  state: ScanState,
  codes: readonly DetectedCode[],
): { state: ScanState; read: DetectedCode | null } {
  if (codes.length === 0) return { state, read: null }
  if (codes.length > 1) return { state: { ...state, candidate: null }, read: null }

  const code = codes[0]!
  const key = `${code.format}:${code.rawValue}`
  if (key !== state.candidate) return { state: { ...state, candidate: key }, read: null }
  if (key === state.accepted) return { state, read: null }
  return { state: { candidate: key, accepted: key }, read: code }
}

/**
 * `getUserMedia` / `video.play()` hatasının kullanıcıya gösterilecek metni.
 * Hata ADINA bakılıyor: ad spesifikasyonda sabit, mesaj tarayıcıya göre
 * değişiyor ve İngilizce.
 *
 * Ad metnin sonunda da duruyor: aynı ad birden fazla sebepten geliyor (bu
 * geliştirme makinesinde fiziksel kamera yokken kayıtlı bir sanal kamera
 * `NotReadableError` verdi) ve telefon denemesinde arızayı sınıflandırmak
 * için kullanıcının ekranda okuyacağı tek iz bu.
 */
export function cameraErrorText(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  const suffix = ` (${name || 'bilinmeyen hata'})`
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Kamera izni verilmedi. Tarayıcının site ayarlarından bu sayfaya kamera izni verip tekrar deneyin.${suffix}`
    case 'NotFoundError':
      return `Bu cihazda kullanılabilir kamera bulunamadı.${suffix}`
    case 'NotReadableError':
    case 'AbortError':
      return `Kamera açılamadı; başka bir uygulama kullanıyor olabilir. O uygulamayı kapatıp tekrar deneyin.${suffix}`
    default:
      return `Kamera açılamadı.${suffix}`
  }
}
