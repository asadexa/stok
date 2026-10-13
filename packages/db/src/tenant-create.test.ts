import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetTestDatabase, testAdminDb, testDatabaseUrls } from './testing'

/**
 * T187 — `tenant:create` GÖSTERDİĞİ VERİTABANINA YAZAR.
 *
 * Araç hedefi gösterip "evet" istiyor; adresteki `?database=` sürücüyü
 * başka bir veritabanına götürürse kullanıcı gördüğü değil başka bir yeri
 * onaylamış olur. Gerçek alt süreç koşuyor ve her soru göründükçe
 * cevaplanıyor: koruma kaldırılırsa araç izole test veritabanına GERÇEKTEN
 * yazar ve test orada kırmızı yanar.
 *
 * Cevaplar tek seferde borudan verilmiyor: `readline` girdinin sonunu
 * görünce ilk sorudan önce kapanıyor ve araç hiç yazamıyordu; test o zaman
 * korumadan değil bu yüzden geçerdi.
 */

const TARGET_DB = 'stok_test_tenantcreate'
// Hiç kurulmuyor; yalnız adreste görünen ad.
const SHOWN_DB = 'stok_test_tenantcreate_gosterilen'
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const ANSWERS = ['Sentetik Pilot', 'Sentetik Yönetici', 'yonetici@sentetik.example']

let admin: ReturnType<typeof testAdminDb>

function runTenantCreate(url: string, answers: string[]) {
  return new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/tenant-create.ts'], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, MIGRATION_DATABASE_URL: url },
    })
    const queue = [...answers]
    let output = ''
    // Sorular satır sonu olmadan ": " ile bitiyor; her biri bir cevap alıyor.
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      output += d
      if (output.endsWith(': ')) {
        const answer = queue.shift()
        if (answer === undefined) child.stdin.end()
        else child.stdin.write(`${answer}\n`)
      }
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      output += d
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    child.on('error', reject)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, output })
    })
  })
}

async function tenantCount(): Promise<number> {
  const [row] = await admin.client<{ n: string }[]>`SELECT count(*) AS n FROM public.tenants`
  return Number(row!.n)
}

const divertedUrl = () => {
  const u = new URL(testDatabaseUrls(SHOWN_DB).migrationUrl)
  u.searchParams.set('database', TARGET_DB)
  return u.toString()
}

beforeAll(async () => {
  await resetTestDatabase(TARGET_DB)
  admin = testAdminDb(TARGET_DB)
}, 120_000)

afterAll(async () => {
  await admin.client.end()
})

describe('tenant:create hedef doğrulaması (T187)', () => {
  it('?database= adresi gösterilenden başka veritabanına ulaşıyor (kontrol)', async () => {
    const sql = postgres(divertedUrl(), { max: 1, onnotice: () => {} })
    try {
      const [row] = await sql<{ db: string }[]>`SELECT current_database() AS db`
      expect(row!.db).toBe(TARGET_DB)
    } finally {
      await sql.end()
    }
  })

  it('gösterilen ile bağlanılan ayrışınca soru sormadan reddediyor ve yazmıyor', async () => {
    const { status, output } = await runTenantCreate(divertedUrl(), [...ANSWERS, 'evet'])

    expect(status).not.toBe(0)
    expect(output).toMatch(new RegExp(`bağlanılan veritabanı "${TARGET_DB}"`))
    expect(output).not.toMatch(/İşletme adı/)
    expect(await tenantCount()).toBe(0)
  })

  it('gösterilen ile bağlanılan aynıysa soruları soruyor (kontrol: koruma fazla katı değil)', async () => {
    const { status, output } = await runTenantCreate(testDatabaseUrls(TARGET_DB).migrationUrl, [
      ...ANSWERS,
      'hayır',
    ])

    expect(status).toBe(1)
    expect(output).toMatch(/İşletme adı/)
    expect(output).toMatch(/İptal edildi; hiçbir şey yazılmadı/)
    expect(await tenantCount()).toBe(0)
  })
})
