import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ZXING_WASM_SHA256 } from 'barcode-detector/ponyfill'
import { describe, expect, it } from 'vitest'
import {
  type DetectedCode,
  INITIAL_SCAN_STATE,
  type ScanState,
  cameraErrorText,
  formatLabel,
  nativeCoversFormats,
  nextScanState,
} from './scan-logic'

const A: DetectedCode = { format: 'ean_13', rawValue: '2000000000015' }
const B: DetectedCode = { format: 'ean_13', rawValue: '2000000000022' }

/** Kareleri sırayla işler, her karede ekrana yazılan okumayı (yoksa null) döndürür. */
function feed(frames: DetectedCode[][], start: ScanState = INITIAL_SCAN_STATE) {
  let state = start
  return frames.map((codes) => {
    const step = nextScanState(state, codes)
    state = step.state
    return step.read?.rawValue ?? null
  })
}

describe('nextScanState (WS-SCAN okuma teyidi)', () => {
  it('ilk görüşte okumuyor, aynı değer ikinci kez gelince okuyor', () => {
    expect(feed([[A], [A]])).toEqual([null, A.rawValue])
  })

  it('barkod kamerada durdukça aynı okumayı yeniden yazmıyor', () => {
    expect(feed([[A], [A], [A], [A]])).toEqual([null, A.rawValue, null, null])
  })

  // Tek karelik yanlış çözümleme ekrana düşmemeli: arada başka değer görülürse
  // teyit baştan başlıyor.
  it('araya giren farklı değer teyidi baştan başlatıyor', () => {
    expect(feed([[A], [B], [A], [A]])).toEqual([null, null, null, A.rawValue])
  })

  // Elde tutulan telefonda çözümleme kare atlıyor; boş kare teyidi bozsaydı
  // titreyen elde okuma hiç gelmezdi.
  it('barkodsuz kare teyidi sıfırlamıyor', () => {
    expect(feed([[A], [], [A]])).toEqual([null, null, A.rawValue])
  })

  it('karede birden fazla barkod varsa okumuyor ve teyidi sıfırlıyor', () => {
    expect(feed([[A], [A, B], [A]])).toEqual([null, null, null])
  })

  it('farklı bir barkod kendi teyidiyle okunuyor, eskisine dönünce o da yeniden okunuyor', () => {
    expect(feed([[A], [A], [B], [B], [A], [A]])).toEqual([
      null,
      A.rawValue,
      null,
      B.rawValue,
      null,
      A.rawValue,
    ])
  })

  // "Sonraki Ürünü Tara" durumu sıfırlıyor: aynı üründen ikinci adet ancak
  // bu bilinçli adımla okunuyor, sıfırlanmadan asla.
  it('sıfırlamadan sonra aynı barkod yeniden okunuyor', () => {
    const before = feed([[A], [A], [A]])
    const after = feed([[A], [A]], INITIAL_SCAN_STATE)
    expect(before).toEqual([null, A.rawValue, null])
    expect(after).toEqual([null, A.rawValue])
  })

  it('aynı rakamlar farklı biçimde gelirse ayrı okuma sayılıyor', () => {
    const code128: DetectedCode = { format: 'code_128', rawValue: A.rawValue }
    expect(feed([[A], [code128]])).toEqual([null, null])
  })
})

describe('nativeCoversFormats', () => {
  it('beş biçimin hepsi varsa yerleşik çözücü seçiliyor', () => {
    expect(nativeCoversFormats(['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'])).toBe(
      true,
    )
  })

  it.each([[[]], [['ean_13', 'ean_8', 'upc_a', 'upc_e']], [['qr_code']]])(
    'biçimlerden biri eksikse WASM seçiliyor: %j',
    (supported) => {
      expect(nativeCoversFormats(supported)).toBe(false)
    },
  )
})

describe('formatLabel', () => {
  it.each([
    ['ean_13', 'EAN-13'],
    ['ean_8', 'EAN-8'],
    ['upc_a', 'UPC-A'],
    ['upc_e', 'UPC-E'],
    ['code_128', 'Code 128'],
    ['bilinmeyen', 'bilinmeyen'],
  ])('%s → %s', (format, label) => {
    expect(formatLabel(format)).toBe(label)
  })
})

describe('cameraErrorText', () => {
  it.each([
    ['NotAllowedError', /izni verilmedi/],
    ['SecurityError', /izni verilmedi/],
    ['NotFoundError', /kamera bulunamadı/],
    ['NotReadableError', /başka bir uygulama/],
    ['AbortError', /başka bir uygulama/],
    ['TuhafError', /Kamera açılamadı\./],
  ])('%s Türkçe metne çevriliyor ve adı izde kalıyor', (name, metin) => {
    const text = cameraErrorText(new DOMException('ingilizce mesaj', name))

    expect(text).toMatch(metin)
    // Telefon denemesinde arıza sınıfını ekrandan okumanın tek yolu.
    expect(text).toContain(`(${name})`)
    expect(text).not.toContain('ingilizce mesaj')
  })

  it('Error olmayan değerde de metin üretiyor', () => {
    expect(cameraErrorText('x')).toBe('Kamera açılamadı. (bilinmeyen hata)')
  })
})

/**
 * SERVİS EDİLEN WASM, ÇÖZÜCÜNÜN BEKLEDİĞİ İKİLİNİN AYNISI MI.
 *
 * Çözücünün JS tarafı barcode-detector'ın sabitlediği zxing-wasm'dan, servis
 * edilen `.wasm` ise uygulamanın kendi zxing-wasm bağımlılığından geliyor
 * (scanner.tsx). İki sürüm ayrışırsa pnpm iki kopya kurar ve tarayıcıya JS
 * tarafına uymayan bir ikili gider. Bu yalnız WASM yolunda, yani iPhone'da
 * bozulur; yerleşik çözücülü Android ve masaüstü testleri yeşil kalırdı.
 */
describe('çözücü WASM dosyası', () => {
  it('uygulamanın servis ettiği dosyanın özeti barcode-detector’ın beklediğiyle aynı', () => {
    const path = createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm')
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')

    expect(sha256).toBe(ZXING_WASM_SHA256)
  })
})
