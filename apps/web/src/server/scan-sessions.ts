import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { parseOrThrow, validationError } from '@stok/core'
import { AppError, barcodeSchema } from '@stok/shared'

/**
 * ============================================================================
 * WS-SCAN — TELEFON → LAPTOP TARAMA OTURUMLARI (süreç belleği)
 *
 * Telefon laptoptaki kullanıcının ekranına YALNIZ barkod metni koyabiliyor.
 * Ürün, miktar, fiyat, kiracı ya da kullanıcı göndermiyor ve almıyor; stok
 * ancak laptop kullanıcısı `/hareket`te Kaydet'e basınca, kendi yetkisiyle
 * değişiyor. Okutma stok hareketi DEĞİL.
 *
 * NEDEN VERİTABANI DEĞİL, BELLEK. Pilot tek süreçli `next start` üzerinde
 * koşuyor ve oturum kısa ömürlü (dakikalar). Tablo, migration ve temizlik işi
 * bu ömür için bakım borcu olurdu (PROJECT_BRAIN §12.10). Bedeli: sunucu
 * yeniden başlayınca oturumlar düşüyor (telefon "bağlantı kapandı" görüyor)
 * ve çok örnekli kurulumda (Vercel) ÇALIŞMAZ; orada bayrak kapalı kalmalı.
 *
 * TOKEN'LARIN KENDİSİ SAKLANMIYOR, SHA-256 ÖZETİ SAKLANIYOR ve arama özetle
 * yapılıyor: karşılaştırma zamanından bilgi sızmıyor, bellek dökümü de token
 * vermiyor. Token 256 bit; tahmin etmek pratikte imkânsız olduğu için
 * eşleştirmede ayrıca deneme sayacı yok.
 *
 * Süre kontrolleri her işlemin İÇİNDE ve açıkça yapılıyor, toplu süpürmeye
 * bırakılmıyor: süpürme yalnız yeni oturum açılırken belleği temizliyor.
 * Koruma süpürmeye yaslansaydı süpürmenin çağrılmadığı ilk yolda süresi
 * dolmuş QR kabul edilirdi.
 * ============================================================================
 */

export const SCAN_TIMING = {
  /** QR'ın geçerli kaldığı süre. Ekranda duran kod fotoğraflanıp sonradan kullanılmasın. */
  pairingMs: 2 * 60_000,
  /** Eşleşmiş telefondan bu kadar süre ne nabız ne okuma gelmezse oturum kapanır. */
  phoneIdleMs: 10 * 60_000,
  /** Mutlak üst sınır: bir iş günü. */
  maxAgeMs: 12 * 60 * 60_000,
  /** Laptop "Telefon bağlı" der; daha eski nabızda "yanıt vermiyor". Telefon 5 sn'de bir yokluyor. */
  phoneOnlineMs: 15_000,
} as const

/** Telefon her gönderimden sonra duruyor; bu sınır yalnız taşkına karşı. */
const SCANS_PER_SECOND = 5
/** Ağ tekrarında aynı okumanın ikinci kez sayılmaması için hatırlanan son kimlikler. */
const RECENT_SCAN_IDS = 20

export type ScanSessionState = 'waiting' | 'paired' | 'expired' | 'closed'

interface Owner {
  tenantId: string
  userId: string
}

interface ScanSession {
  id: string
  /** Oturumu açan aktörden; istemciden ASLA gelmez. */
  tenantId: string
  userId: string
  createdAt: number
  /** Eşleşene kadar dolu, eşleşince silinir: QR tek kullanımlık. */
  pairingHash: string | null
  pairingExpiresAt: number
  phoneHash: string | null
  phoneSeenAt: number | null
  seq: number
  /** Yalnız son okuma. Laptop `since` ile soruyor; sunucuda onay (ack) durumu yok. */
  latest: { seq: number; barcode: string } | null
  recent: { scanId: string; seq: number }[]
  sendTimes: number[]
}

export interface ScanStore {
  sessions: Map<string, ScanSession>
  byOwner: Map<string, string>
  byPairing: Map<string, string>
  byPhone: Map<string, string>
}

export interface OwnerView {
  sessionId: string
  state: ScanSessionState
  phoneOnline: boolean
  pairingExpiresInMs: number
  seq: number
  latest: { seq: number; barcode: string } | null
}

export function createScanStore(): ScanStore {
  return { sessions: new Map(), byOwner: new Map(), byPairing: new Map(), byPhone: new Map() }
}

/**
 * Süreç başına TEK depo. `globalThis` üzerinde, çünkü geliştirmede modül
 * yeniden değerlendirildiğinde (HMR) modül değişkeni sıfırlanır ve açık
 * oturumlar sebepsiz yere düşerdi.
 */
export function scanStore(): ScanStore {
  const holder = globalThis as { __stokScanSessions?: ScanStore }
  holder.__stokScanSessions ??= createScanStore()
  return holder.__stokScanSessions
}

const ownerKey = (owner: Owner) => `${owner.tenantId}:${owner.userId}`
const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const newToken = () => randomBytes(32).toString('base64url')

function effectiveState(session: ScanSession, now: number): ScanSessionState {
  if (now - session.createdAt >= SCAN_TIMING.maxAgeMs) return 'closed'
  if (session.phoneHash === null) return now >= session.pairingExpiresAt ? 'expired' : 'waiting'
  const seen = session.phoneSeenAt ?? session.createdAt
  return now - seen >= SCAN_TIMING.phoneIdleMs ? 'closed' : 'paired'
}

function remove(store: ScanStore, session: ScanSession): void {
  store.sessions.delete(session.id)
  if (store.byOwner.get(ownerKey(session)) === session.id) store.byOwner.delete(ownerKey(session))
  if (session.pairingHash) store.byPairing.delete(session.pairingHash)
  if (session.phoneHash) store.byPhone.delete(session.phoneHash)
}

/**
 * Laptop kullanıcısı için yeni oturum. Kullanıcının açık oturumu varsa
 * kapanıyor: kullanıcı başına TEK aktif oturum, yani eski telefon bir sonraki
 * isteğinde "bağlantı kapandı" alıyor.
 */
export function openSession(store: ScanStore, owner: Owner, now: number) {
  for (const session of store.sessions.values()) {
    const state = effectiveState(session, now)
    if (state === 'expired' || state === 'closed') remove(store, session)
  }

  const previousId = store.byOwner.get(ownerKey(owner))
  const previous = previousId ? store.sessions.get(previousId) : undefined
  if (previous) remove(store, previous)

  const pairingToken = newToken()
  const session: ScanSession = {
    id: randomUUID(),
    tenantId: owner.tenantId,
    userId: owner.userId,
    createdAt: now,
    pairingHash: digest(pairingToken),
    pairingExpiresAt: now + SCAN_TIMING.pairingMs,
    phoneHash: null,
    phoneSeenAt: null,
    seq: 0,
    latest: null,
    recent: [],
    sendTimes: [],
  }
  store.sessions.set(session.id, session)
  store.byOwner.set(ownerKey(owner), session.id)
  store.byPairing.set(session.pairingHash!, session.id)

  return { sessionId: session.id, pairingToken, pairingExpiresAt: session.pairingExpiresAt }
}

/** QR'daki tek kullanımlık token'ı telefonun kalıcı token'ına çevirir. */
export function pairPhone(store: ScanStore, pairingToken: string, now: number) {
  const hash = digest(pairingToken)
  const id = store.byPairing.get(hash)
  const session = id ? store.sessions.get(id) : undefined
  if (!session) throw new AppError('SCAN_PAIRING_INVALID', 'unknown or used pairing token')

  if (effectiveState(session, now) !== 'waiting') {
    remove(store, session)
    throw new AppError('SCAN_PAIRING_INVALID', 'pairing token expired')
  }

  // Tek kullanım: özet hemen siliniyor, aynı QR ikinci bir telefonu bağlayamaz.
  store.byPairing.delete(hash)
  session.pairingHash = null

  const phoneToken = newToken()
  session.phoneHash = digest(phoneToken)
  session.phoneSeenAt = now
  store.byPhone.set(session.phoneHash, session.id)
  return { phoneToken }
}

function phoneSession(store: ScanStore, phoneToken: string, now: number): ScanSession {
  const id = store.byPhone.get(digest(phoneToken))
  const session = id ? store.sessions.get(id) : undefined
  // Bilinmeyen token da "kapandı" sayılıyor: sunucu yeniden başlayınca bütün
  // token'lar bilinmez olur ve kullanıcıya söylenecek çare aynı (yeni QR).
  if (!session) throw new AppError('SCAN_SESSION_CLOSED', 'unknown phone token')
  if (effectiveState(session, now) !== 'paired') {
    remove(store, session)
    throw new AppError('SCAN_SESSION_CLOSED', 'scan session closed')
  }
  return session
}

/** Telefonun nabzı: laptop "Telefon bağlı" diyebilsin, oturum boşta kapanmasın. */
export function heartbeat(store: ScanStore, phoneToken: string, now: number) {
  const session = phoneSession(store, phoneToken, now)
  session.phoneSeenAt = now
  return { state: 'paired' as const }
}

const SCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Perakende barkodlar rakam, Code 128 yazdırılabilir ASCII. Kontrol karakteri
// ya da Unicode laptop ekranına ve adres çubuğuna gitmesin (tehdit S8).
const scanBarcodeSchema = barcodeSchema.regex(/^[\x20-\x7E]+$/, 'Barkod geçersiz karakter içeriyor')

/** Telefonun gönderdiği gövde. Yalnız iki alan okunuyor; gerisi yok sayılıyor. */
export function parseScanInput(raw: unknown): { scanId: string; barcode: string } {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const scanId = typeof body.scanId === 'string' ? body.scanId : ''
  if (!SCAN_ID.test(scanId)) {
    throw validationError([{ path: 'scanId', message: 'Okuma kimliği geçersiz' }])
  }
  return { scanId, barcode: parseOrThrow(scanBarcodeSchema, body.barcode) }
}

/**
 * Okumayı oturuma yazar. YALNIZ bunu yapar: veritabanına, ürün aramasına ya
 * da `createMovement`'a dokunmaz. Laptop okumayı polling'le görüp mevcut
 * `/hareket?barkod=` akışını açıyor.
 */
export function recordScan(
  store: ScanStore,
  phoneToken: string,
  input: { scanId: string; barcode: string },
  now: number,
) {
  const session = phoneSession(store, phoneToken, now)
  session.phoneSeenAt = now

  const repeat = session.recent.find((r) => r.scanId === input.scanId)
  if (repeat) return { seq: repeat.seq }

  session.sendTimes = session.sendTimes.filter((t) => now - t < 1000)
  if (session.sendTimes.length >= SCANS_PER_SECOND) {
    throw new AppError('TOO_MANY_ATTEMPTS', 'scan rate exceeded', { retryAfterSeconds: 1 })
  }
  session.sendTimes.push(now)

  session.seq += 1
  session.latest = { seq: session.seq, barcode: input.barcode }
  session.recent = [...session.recent, { scanId: input.scanId, seq: session.seq }].slice(
    -RECENT_SCAN_IDS,
  )
  return { seq: session.seq }
}

/**
 * Laptopun polling'i. SALT OKUNUR: depoda hiçbir şeyi değiştirmiyor, süresi
 * dolan oturumu bile silmiyor, yalnız durumunu söylüyor. Tekrar uygulamayı
 * istemci kendi `since` değeriyle önlüyor.
 *
 * Yalnız aktörün KENDİ oturumu: parametrede oturum kimliği yok, yani başka
 * kullanıcının oturumunu isteyecek bir yüzey de yok.
 */
export function viewForOwner(
  store: ScanStore,
  owner: Owner,
  since: number,
  now: number,
): OwnerView | null {
  const id = store.byOwner.get(ownerKey(owner))
  const session = id ? store.sessions.get(id) : undefined
  if (!session || session.tenantId !== owner.tenantId || session.userId !== owner.userId) {
    return null
  }

  const state = effectiveState(session, now)
  return {
    sessionId: session.id,
    state,
    phoneOnline:
      state === 'paired' &&
      session.phoneSeenAt !== null &&
      now - session.phoneSeenAt < SCAN_TIMING.phoneOnlineMs,
    pairingExpiresInMs: state === 'waiting' ? session.pairingExpiresAt - now : 0,
    seq: session.seq,
    latest: session.latest && session.latest.seq > since ? session.latest : null,
  }
}

export function closeForOwner(store: ScanStore, owner: Owner): void {
  const id = store.byOwner.get(ownerKey(owner))
  const session = id ? store.sessions.get(id) : undefined
  if (session) remove(store, session)
}

/**
 * QR'a yazılacak adresin tabanı. Laptop kullanıcısı tünel adresini panele
 * yapıştırıyor; burada doğrulanıyor.
 *
 * YALNIZ `https:`. Telefon kamerası güvensiz bağlamda hiç açılmıyor; http
 * adresi kabul etmek, sahada "kamera açılmıyor" diye görünen bir kurulum
 * hatasını sessizce telefona taşımak olurdu. Yalnız origin kullanılıyor:
 * yapıştırılan adresteki yol, sorgu ya da fragment QR'a sızmıyor.
 */
export function parsePublicBase(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const fail = (message: string) => validationError([{ path: 'publicBase', message }])
  if (text === '') throw fail('Telefonun açacağı adresi (tünel adresi) girin')
  if (text.length > 200) throw fail('Adres çok uzun')

  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw fail('Adres geçerli değil. Örnek: https://ornek.trycloudflare.com')
  }
  if (url.protocol !== 'https:') throw fail('Adres https:// ile başlamalı; telefon kamerası yalnız HTTPS’te açılır')
  if (url.username || url.password) throw fail('Adres kullanıcı adı ya da parola içeremez')
  return url.origin
}

export function pairingUrl(origin: string, pairingToken: string): string {
  // Token FRAGMENT'te: HTTP isteğine hiç girmiyor, yani tünelin ve sunucunun
  // erişim loglarına ya da Referer başlığına düşmüyor.
  return `${origin}/tara#e=${pairingToken}`
}
