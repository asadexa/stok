import { closeAppDb } from '@stok/db'
import {
  TEST_PASSWORD,
  type TestTenant,
  seedOpeningStock,
  seedTestTenant,
  testAdminDb,
} from '@stok/db/testing'
import { NextRequest } from 'next/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { endPhoneScan, startPhoneScan } from '@/app/(panel)/hareket/phone-scan-actions'
import { startSession } from '@/server/session'
import { resetCookieJar } from '@/test/cookie-jar'
import { TEST_DB_NAME } from '@/test/db-name'
import { POST as eslestirPOST } from './eslestir/route'
import { POST as okutPOST } from './okut/route'
import { GET as oturumGET } from './oturum/route'
import { POST as telefonPOST } from './telefon/route'

/**
 * ============================================================================
 * WS-SCAN — TELEFON → LAPTOP KÖPRÜSÜNÜN UÇLARI
 *
 * Gerçek rota kodu, gerçek server action, gerçek PostgreSQL. Sahte olan
 * yalnız çerez kavanozu (T94 ile aynı sınır).
 *
 * EN ÖNEMLİ TEST "okutma stok hareketi değil": telefondan ne kadar okuma
 * gelirse gelsin defter ve projeksiyon değişmiyor. Stok yalnız laptoptaki
 * Kaydet'le, mevcut `createMovement` kapısından değişir.
 * ============================================================================
 */

const admin = testAdminDb(TEST_DB_NAME)
let tenant: TestTenant
const BASE = 'https://ornek.trycloudflare.com'

async function loginAs(email: string): Promise<void> {
  resetCookieJar()
  await startSession(email, TEST_PASSWORD)
}

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const poll = (since = 0) =>
  oturumGET(new NextRequest(new URL(`http://localhost/api/tara/oturum?since=${since}`)))

let scanCounter = 0
const scanBody = (barcode: string) => ({
  scanId: `00000000-0000-4000-8000-${String(++scanCounter).padStart(12, '0')}`,
  barcode,
})

/** Oturumdaki laptop kullanıcısı için QR açar, QR'daki token'la telefonu eşler. */
async function pairedPhone(): Promise<string> {
  const started = await startPhoneScan(BASE)
  if (!started.ok) throw new Error(started.error)
  const pairingToken = new URL(started.pairingUrl).hash.slice('#e='.length)
  const res = await eslestirPOST(post('/api/tara/eslestir', { token: pairingToken }))
  expect(res.status).toBe(200)
  return ((await res.json()) as { phoneToken: string }).phoneToken
}

async function code(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code
}

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'webtara')
})

afterAll(async () => {
  await admin.client.end()
  await closeAppDb()
})

beforeEach(() => {
  resetCookieJar()
  delete (globalThis as { __stokScanSessions?: unknown }).__stokScanSessions
  vi.stubEnv('ENABLE_PHONE_SCANNER', 'true')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('bayrak kapalıyken köprü yok', () => {
  it('dört uç da 404, oturum açılamıyor', async () => {
    await loginAs(tenant.adminEmail)
    vi.stubEnv('ENABLE_PHONE_SCANNER', 'false')

    for (const res of [
      await eslestirPOST(post('/api/tara/eslestir', { token: 'x' })),
      await okutPOST(post('/api/tara/okut', scanBody('1'), 'x')),
      await telefonPOST(post('/api/tara/telefon', {}, 'x')),
      await poll(),
    ]) {
      expect(res.status).toBe(404)
      expect(await code(res)).toBe('NOT_FOUND')
    }
    expect((await startPhoneScan(BASE)).ok).toBe(false)
  })
})

describe('laptop tarafı', () => {
  it('oturumsuz polling reddediliyor', async () => {
    const res = await poll()
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('TOKEN_INVALID')
  })

  it('http adresiyle QR açılmıyor ve bağlı telefon düşmüyor', async () => {
    await loginAs(tenant.adminEmail)
    const phoneToken = await pairedPhone()

    const result = await startPhoneScan('http://ornek.trycloudflare.com')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/https/)

    const res = await telefonPOST(post('/api/tara/telefon', {}, phoneToken))
    expect(res.status).toBe(200)
  })

  it('çalışan da telefonu bağlayıp okuma alabiliyor', async () => {
    await loginAs(tenant.staffEmail)
    const phoneToken = await pairedPhone()
    await okutPOST(post('/api/tara/okut', scanBody('123'), phoneToken))

    const body = (await (await poll()).json()) as { session: { latest: { barcode: string } } }
    expect(body.session.latest.barcode).toBe('123')
  })

  it('BAŞKA KULLANICI başkasının okumasını göremiyor', async () => {
    await loginAs(tenant.adminEmail)
    const adminPhone = await pairedPhone()
    await okutPOST(post('/api/tara/okut', scanBody('GIZLI-1'), adminPhone))

    await loginAs(tenant.staffEmail)
    expect(((await (await poll()).json()) as { session: unknown }).session).toBeNull()

    // Çalışanın kendi oturumu açıkken de yalnız kendi okumasını görüyor.
    await pairedPhone()
    const body = (await (await poll()).json()) as { session: { latest: unknown; seq: number } }
    expect(body.session.latest).toBeNull()
    expect(body.session.seq).toBe(0)
  })
})

describe('telefon tarafı', () => {
  it('okuma laptopa düşüyor; cevapta ürün, fiyat, stok YOK; since sonrası tekrar gelmiyor', async () => {
    await loginAs(tenant.adminEmail)
    const phoneToken = await pairedPhone()
    const barcode = tenant.products['DEF-001']!.barcode

    const res = await okutPOST(post('/api/tara/okut', scanBody(barcode), phoneToken))
    expect(res.status).toBe(200)
    expect(Object.keys((await res.json()) as object)).toEqual(['seq'])

    const first = (await (await poll(0)).json()) as {
      session: { state: string; phoneOnline: boolean; latest: { seq: number; barcode: string } }
    }
    expect(first.session.state).toBe('paired')
    expect(first.session.phoneOnline).toBe(true)
    expect(first.session.latest).toEqual({ seq: 1, barcode })

    const again = (await (await poll(1)).json()) as { session: { latest: unknown } }
    expect(again.session.latest).toBeNull()
  })

  it('QR ikinci kez kullanılamıyor, uydurma QR da', async () => {
    await loginAs(tenant.adminEmail)
    const started = await startPhoneScan(BASE)
    if (!started.ok) throw new Error(started.error)
    const pairingToken = new URL(started.pairingUrl).hash.slice('#e='.length)

    expect((await eslestirPOST(post('/api/tara/eslestir', { token: pairingToken }))).status).toBe(
      200,
    )
    const reuse = await eslestirPOST(post('/api/tara/eslestir', { token: pairingToken }))
    expect(reuse.status).toBe(410)
    expect(await code(reuse)).toBe('SCAN_PAIRING_INVALID')

    const fake = await eslestirPOST(post('/api/tara/eslestir', { token: 'uydurma' }))
    expect(await code(fake)).toBe('SCAN_PAIRING_INVALID')
  })

  it('geçersiz ya da eksik telefon token’ı okuma gönderemiyor', async () => {
    await loginAs(tenant.adminEmail)
    await pairedPhone()

    const wrong = await okutPOST(post('/api/tara/okut', scanBody('1'), 'uydurma'))
    expect(wrong.status).toBe(410)
    expect(await code(wrong)).toBe('SCAN_SESSION_CLOSED')

    const missing = await okutPOST(post('/api/tara/okut', scanBody('1')))
    expect(missing.status).toBe(401)
    expect(await code(missing)).toBe('TOKEN_INVALID')

    const body = (await (await poll()).json()) as { session: { seq: number } }
    expect(body.session.seq).toBe(0)
  })

  it('uzun barkod ve bozuk gövde 400, sunucu hatası değil', async () => {
    await loginAs(tenant.adminEmail)
    const phoneToken = await pairedPhone()

    const long = await okutPOST(post('/api/tara/okut', scanBody('1'.repeat(65)), phoneToken))
    expect(long.status).toBe(400)
    expect(await code(long)).toBe('VALIDATION_FAILED')

    const broken = await okutPOST(post('/api/tara/okut', '{bozuk', phoneToken))
    expect(broken.status).toBe(400)
  })

  it('Kes sonrası nabız ve okuma "bağlantı kapandı" alıyor', async () => {
    await loginAs(tenant.adminEmail)
    const phoneToken = await pairedPhone()
    expect((await telefonPOST(post('/api/tara/telefon', {}, phoneToken))).status).toBe(200)

    await endPhoneScan()

    const beat = await telefonPOST(post('/api/tara/telefon', {}, phoneToken))
    expect(beat.status).toBe(410)
    expect(await code(beat)).toBe('SCAN_SESSION_CLOSED')
    expect(((await (await poll()).json()) as { session: unknown }).session).toBeNull()
  })
})

describe('SCAN ≠ STOCK MOVEMENT', () => {
  it('telefondan gelen okumalar defteri ve stoğu DEĞİŞTİRMİYOR', async () => {
    const product = tenant.products['KAL-001']!
    await seedOpeningStock(admin.db, tenant, product.id, '10')
    const snapshot = async () => {
      const [row] = await admin.client`
        SELECT
          (SELECT count(*)::int FROM stock_movements WHERE tenant_id = ${tenant.tenantId}) AS hareket,
          (SELECT coalesce(sum(qty), 0)::text FROM current_stock WHERE tenant_id = ${tenant.tenantId}) AS stok
      `
      return row
    }
    const before = await snapshot()
    expect(before).toEqual({ hareket: 1, stok: '10.000' })

    await loginAs(tenant.adminEmail)
    const phoneToken = await pairedPhone()
    for (const barcode of [product.barcode, product.caseBarcode!, product.barcode]) {
      const res = await okutPOST(post('/api/tara/okut', scanBody(barcode), phoneToken))
      expect(res.status).toBe(200)
    }

    expect(await snapshot()).toEqual(before)
  })
})
