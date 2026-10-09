import { provisionTenant } from '@stok/db/provision'
import { testAdminDb, testAppDb } from '@stok/db/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { actorFromAccessToken, login } from './auth'
import { TEST_DB_NAME } from './test/db-name'

/**
 * T162 — kiracı açma aracının ürettiği yönetici GERÇEK giriş yolundan
 * girebilmeli: uygulama rolüyle (`stok_app`, RLS uygulanır), e-posta
 * eşleştirmesi `auth_lookup_user` üzerinden, parola özeti scrypt ile.
 * Araç yalnız satır yazıp "oldu" demiş olsaydı (yanlış normalizasyon, yanlış
 * özet biçimi, yanlış kiracı) bu test yakalardı; db paketindeki testler
 * girişi göremez.
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

describe('kiracı açma aracıyla açılan yönetici (T162)', () => {
  it('normal girişten giriyor ve yalnız kendi kiracısında ADMIN', async () => {
    const created = await provisionTenant(admin.db, {
      tenantName: 'Sentetik Giriş İşletmesi',
      adminName: 'Giriş Deneme',
      adminEmail: '  Giris.Deneme@Sentetik.TEST ',
    })

    const result = await login(
      { email: 'Giris.Deneme@sentetik.test', password: created.initialPassword },
      { db: app.db },
    )

    expect(result.user).toMatchObject({
      userId: created.adminUserId,
      tenantId: created.tenantId,
      email: 'giris.deneme@sentetik.test',
      role: 'ADMIN',
    })
    expect(await actorFromAccessToken(result.tokens.accessToken)).toEqual({
      tenantId: created.tenantId,
      userId: created.adminUserId,
      role: 'ADMIN',
    })
  })
})
