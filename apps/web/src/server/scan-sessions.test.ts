import { AppError } from '@stok/shared'
import { describe, expect, it } from 'vitest'
import {
  SCAN_TIMING,
  closeForOwner,
  createScanStore,
  heartbeat,
  openSession,
  pairPhone,
  pairingUrl,
  parsePublicBase,
  parseScanInput,
  recordScan,
  viewForOwner,
} from './scan-sessions'

const A = { tenantId: 'tenant-1', userId: 'user-a' }
const B = { tenantId: 'tenant-1', userId: 'user-b' }
const T0 = 1_000_000

/** Fırlatılan hata kodunu döndürür; fırlatmazsa `null`. */
function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (err) {
    return err instanceof AppError ? err.code : String(err)
  }
}

function paired(owner = A) {
  const store = createScanStore()
  const { pairingToken } = openSession(store, owner, T0)
  const { phoneToken } = pairPhone(store, pairingToken, T0 + 1000)
  return { store, phoneToken }
}

const scan = (n: number) => ({
  scanId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  barcode: '2000000000015',
})

describe('eşleştirme (QR)', () => {
  it('yeni oturum bekliyor, QR iki dakika geçerli', () => {
    const store = createScanStore()
    openSession(store, A, T0)

    const view = viewForOwner(store, A, 0, T0)
    expect(view?.state).toBe('waiting')
    expect(view?.pairingExpiresInMs).toBe(SCAN_TIMING.pairingMs)
  })

  it('QR tek kullanımlık: ikinci telefon aynı kodla bağlanamıyor', () => {
    const store = createScanStore()
    const { pairingToken } = openSession(store, A, T0)

    expect(codeOf(() => pairPhone(store, pairingToken, T0 + 1000))).toBeNull()
    expect(codeOf(() => pairPhone(store, pairingToken, T0 + 2000))).toBe('SCAN_PAIRING_INVALID')
    expect(viewForOwner(store, A, 0, T0 + 2000)?.state).toBe('paired')
  })

  it('süresi dolan QR reddediliyor', () => {
    const store = createScanStore()
    const { pairingToken } = openSession(store, A, T0)

    expect(viewForOwner(store, A, 0, T0 + SCAN_TIMING.pairingMs)?.state).toBe('expired')
    expect(codeOf(() => pairPhone(store, pairingToken, T0 + SCAN_TIMING.pairingMs))).toBe(
      'SCAN_PAIRING_INVALID',
    )
  })

  it('uydurma token reddediliyor', () => {
    const store = createScanStore()
    openSession(store, A, T0)
    expect(codeOf(() => pairPhone(store, 'uydurma', T0))).toBe('SCAN_PAIRING_INVALID')
  })
})

describe('telefon token’ı', () => {
  it('okuma laptopun görünümüne düşüyor; since sonrası tekrar gelmiyor', () => {
    const { store, phoneToken } = paired()

    expect(recordScan(store, phoneToken, scan(1), T0 + 2000)).toEqual({ seq: 1 })
    expect(viewForOwner(store, A, 0, T0 + 2000)?.latest).toEqual({
      seq: 1,
      barcode: '2000000000015',
    })
    expect(viewForOwner(store, A, 1, T0 + 2000)?.latest).toBeNull()
  })

  it('geçersiz token okuma gönderemiyor', () => {
    const { store } = paired()
    expect(codeOf(() => recordScan(store, 'uydurma', scan(1), T0 + 2000))).toBe(
      'SCAN_SESSION_CLOSED',
    )
    expect(viewForOwner(store, A, 0, T0 + 2000)?.seq).toBe(0)
  })

  it('aynı okuma kimliği (ağ tekrarı) ikinci kez sayılmıyor', () => {
    const { store, phoneToken } = paired()
    recordScan(store, phoneToken, scan(1), T0 + 2000)

    expect(recordScan(store, phoneToken, scan(1), T0 + 3000)).toEqual({ seq: 1 })
    expect(viewForOwner(store, A, 0, T0 + 3000)?.seq).toBe(1)
  })

  it('saniyede beşten fazla okuma reddediliyor, bir saniye sonra açılıyor', () => {
    const { store, phoneToken } = paired()
    for (let i = 1; i <= 5; i++) recordScan(store, phoneToken, scan(i), T0 + 2000)

    expect(codeOf(() => recordScan(store, phoneToken, scan(6), T0 + 2000))).toBe(
      'TOO_MANY_ATTEMPTS',
    )
    expect(codeOf(() => recordScan(store, phoneToken, scan(6), T0 + 3000))).toBeNull()
  })
})

describe('kapanma', () => {
  it('Kes sonrası telefon kapandı alıyor, laptop oturum görmüyor', () => {
    const { store, phoneToken } = paired()
    closeForOwner(store, A)

    expect(codeOf(() => recordScan(store, phoneToken, scan(1), T0 + 2000))).toBe(
      'SCAN_SESSION_CLOSED',
    )
    expect(viewForOwner(store, A, 0, T0 + 2000)).toBeNull()
  })

  it('kullanıcı başına tek oturum: yenisi açılınca eski telefon ve eski QR geçersiz', () => {
    const store = createScanStore()
    const first = openSession(store, A, T0)
    const { phoneToken } = pairPhone(store, first.pairingToken, T0 + 1000)
    const unused = openSession(store, A, T0 + 2000)
    openSession(store, A, T0 + 3000)

    expect(codeOf(() => recordScan(store, phoneToken, scan(1), T0 + 4000))).toBe(
      'SCAN_SESSION_CLOSED',
    )
    expect(codeOf(() => pairPhone(store, unused.pairingToken, T0 + 4000))).toBe(
      'SCAN_PAIRING_INVALID',
    )
    expect(store.sessions.size).toBe(1)
  })

  it('telefon on dakika sessiz kalırsa oturum kapanıyor; nabız onu canlı tutuyor', () => {
    const { store, phoneToken } = paired()
    const idle = SCAN_TIMING.phoneIdleMs

    heartbeat(store, phoneToken, T0 + idle - 1000)
    expect(codeOf(() => recordScan(store, phoneToken, scan(1), T0 + idle + 500))).toBeNull()
    expect(viewForOwner(store, A, 0, T0 + 2 * idle + 500)?.state).toBe('closed')
    expect(codeOf(() => heartbeat(store, phoneToken, T0 + 2 * idle + 500))).toBe(
      'SCAN_SESSION_CLOSED',
    )
  })

  it('nabız sürse de on iki saatin sonunda kapanıyor', () => {
    const { store, phoneToken } = paired()
    for (let t = T0; t < T0 + SCAN_TIMING.maxAgeMs; t += SCAN_TIMING.phoneIdleMs / 2) {
      heartbeat(store, phoneToken, t)
    }
    expect(codeOf(() => heartbeat(store, phoneToken, T0 + SCAN_TIMING.maxAgeMs))).toBe(
      'SCAN_SESSION_CLOSED',
    )
  })

  it('on beş saniye nabız gelmezse laptop "yanıt vermiyor" görüyor', () => {
    const { store, phoneToken } = paired()
    heartbeat(store, phoneToken, T0 + 2000)

    expect(viewForOwner(store, A, 0, T0 + 2000 + SCAN_TIMING.phoneOnlineMs - 1)?.phoneOnline).toBe(
      true,
    )
    expect(viewForOwner(store, A, 0, T0 + 2000 + SCAN_TIMING.phoneOnlineMs)?.phoneOnline).toBe(
      false,
    )
  })
})

describe('laptop görünümü', () => {
  it('başka kullanıcı ya da başka kiracı oturumu göremiyor', () => {
    const { store, phoneToken } = paired(A)
    recordScan(store, phoneToken, scan(1), T0 + 2000)

    expect(viewForOwner(store, B, 0, T0 + 2000)).toBeNull()
    expect(viewForOwner(store, { tenantId: 'tenant-2', userId: A.userId }, 0, T0 + 2000)).toBeNull()
  })

  it('SALT OKUNUR: görünüm depoyu değiştirmiyor, süresi doluyu bile silmiyor', () => {
    const { store, phoneToken } = paired()
    recordScan(store, phoneToken, scan(1), T0 + 2000)
    const before = structuredClone(store)

    viewForOwner(store, A, 0, T0 + 3000)
    viewForOwner(store, A, 0, T0 + SCAN_TIMING.maxAgeMs + 1)

    expect(store).toEqual(before)
  })
})

describe('parseScanInput', () => {
  it('geçerli gövdeyi kabul ediyor, barkodun boşluklarını kırpıyor', () => {
    expect(parseScanInput({ ...scan(1), barcode: ' 2000000000015\n' })).toEqual(scan(1))
  })

  it.each([
    ['okuma kimliği yok', { barcode: '123' }],
    ['okuma kimliği uuid değil', { scanId: '1', barcode: '123' }],
    ['barkod yok', { scanId: scan(1).scanId }],
    ['barkod boş', { scanId: scan(1).scanId, barcode: '  ' }],
    ['barkod 64 karakterden uzun', { scanId: scan(1).scanId, barcode: '1'.repeat(65) }],
    ['kontrol karakteri', { scanId: scan(1).scanId, barcode: '12\u000734' }],
    ['ASCII dışı', { scanId: scan(1).scanId, barcode: '١٢٣' }],
    ['gövde nesne değil', 'metin'],
  ])('reddediyor: %s', (_ad, body) => {
    expect(codeOf(() => parseScanInput(body))).toBe('VALIDATION_FAILED')
  })
})

describe('parsePublicBase (QR adresinin tabanı)', () => {
  it('https adresinden yalnız origin kalıyor', () => {
    expect(parsePublicBase(' https://ornek.trycloudflare.com/hareket?x=1#y ')).toBe(
      'https://ornek.trycloudflare.com',
    )
  })

  it.each([
    ['boş', ''],
    ['http', 'http://ornek.trycloudflare.com'],
    ['kullanıcı bilgisi', 'https://ad:parola@ornek.trycloudflare.com'],
    ['adres değil', 'ornek.trycloudflare.com'],
    ['javascript şeması', 'javascript:alert(1)'],
    ['çok uzun', `https://${'a'.repeat(200)}.com`],
    ['metin değil', 42],
  ])('reddediyor: %s', (_ad, raw) => {
    expect(codeOf(() => parsePublicBase(raw))).toBe('VALIDATION_FAILED')
  })

  it('token QR adresinin fragment’inde', () => {
    expect(pairingUrl('https://ornek.trycloudflare.com', 'abc')).toBe(
      'https://ornek.trycloudflare.com/tara#e=abc',
    )
  })
})
