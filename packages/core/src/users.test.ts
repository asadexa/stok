import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { AppError } from '@stok/shared'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { Actor } from './authz.js'
import { getTenantUser, listTenantUsers } from './users.js'
import { TEST_DB_NAME } from './test/db-name.js'

/**
 * ============================================================================
 * KULLANICI LİSTESİ (T20 filtresi)
 *
 * İki şeyi sınıyor: kimin görebildiği ve NE göremediği. İkincisi daha
 * önemli — `select().from(users)` yazılsaydı parola ve PIN hash'leri
 * sessizce cevaba düşerdi ve hiçbir davranış testi bunu fark etmezdi.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)
const opts = { db: app.db }

let tenant: TestTenant
let other: TestTenant
let boss: Actor
let staff: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'users-a')
  other = await seedTestTenant(admin.db, 'users-b')
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

describe('listTenantUsers', () => {
  it('yönetici kiracının kullanıcılarını Türkçe sırayla alıyor', async () => {
    // "Test Çalışan" < "Test Yönetici". Veritabanı collation'ı C.UTF-8 ve
    // ham `ORDER BY name` bayt sırasına düşüyor: 'Ç' (0xC3 0x87) 'Y'den
    // (0x59) büyük olduğu için Türkçe baş harfli her isim listenin dibine
    // inerdi. `tr_norm` bunu collation'dan bağımsız düzeltiyor.
    const rows = await listTenantUsers(boss, opts)

    expect(rows.map((r) => r.name)).toEqual(['Test Çalışan', 'Test Yönetici'])
    expect(rows.map((r) => r.id)).toEqual([tenant.staffUserId, tenant.adminUserId])
  })

  it('parola ve PIN hash cevaba GİRMİYOR', async () => {
    const rows = await listTenantUsers(boss, opts)

    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['active', 'id', 'name', 'role'])
    }
  })

  it('çalışan listeyi alamıyor', async () => {
    // Göremediği hareketlerin sahiplerini isim isim saymasına gerek yok.
    await expect(listTenantUsers(staff, opts)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(listTenantUsers(staff, opts)).rejects.toBeInstanceOf(AppError)
  })

  it('başka kiracının kullanıcıları görünmüyor', async () => {
    const rows = await listTenantUsers(boss, opts)
    const ids = rows.map((r) => r.id)

    expect(ids).not.toContain(other.adminUserId)
    expect(ids).not.toContain(other.staffUserId)
  })
})

describe('getTenantUser', () => {
  it('kendi kiracısındaki kullanıcıyı buluyor', async () => {
    const row = await getTenantUser(boss, tenant.staffUserId, opts)
    expect(row).toMatchObject({ id: tenant.staffUserId, role: 'STAFF' })
  })

  it('başka kiracının kullanıcısı için null dönüyor', async () => {
    // Fırlatmıyor: "yok" ile "senin değil" ayrımı, saldırgana kimlik
    // doğrulama yapmadan kiracı keşfi imkanı verirdi.
    expect(await getTenantUser(boss, other.adminUserId, opts)).toBeNull()
  })
})
