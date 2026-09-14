import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from './client'
import {
  isCheckViolation,
  isDeadlock,
  isImmutableLedgerViolation,
  isPrivilegeError,
  isUniqueViolation,
  pgConstraint,
  pgErrorCode,
} from './pg-errors'
import { products, stockMovements } from './schema'
import { type TestTenant, detUuid, seedTestTenant, testAdminDb, testAppDb } from './testing'
import { TEST_DB_NAME } from './test/db-name'

/**
 * Bu testler GERÇEK hatalarla koşuyor, elle kurulmuş sahte nesnelerle
 * değil. Sebebi somut: Drizzle sürücü hatasını kendi hatasının `cause`
 * alanına sarıyor ve `err.code` undefined kalıyor. Sahte bir
 * `{ code: '23505' }` nesnesiyle yazılmış test bunu göremez, yeşil yanar,
 * ve idempotency yarışı üretimde 500 olarak patlar.
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

let tenant: TestTenant

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'pgerr', [{ sku: 'E-1', name: 'Hata Ürünü' }])
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  const err = await fn().then(
    () => undefined,
    (e: unknown) => e,
  )
  if (err === undefined) throw new Error('hata bekleniyordu, sorgu başarılı oldu')
  return err
}

describe('Drizzle sarmalını çözme', () => {
  it('sarılmış hatanın kendi code alanı YOKTUR', async () => {
    const err = await capture(() =>
      withTenant(
        tenant.tenantId,
        (tx) => tx.insert(products).values({ tenantId: tenant.tenantId, sku: 'E-1', name: 'Kopya' }),
        app.db,
      ),
    )
    // Bu satır, cause zincirini yürümenin neden gerekli olduğunu belgeliyor.
    expect((err as { code?: unknown }).code).toBeUndefined()
    expect(pgErrorCode(err)).toBe('23505')
  })

  it('constraint adını da zincirden çıkarır', async () => {
    const err = await capture(() =>
      withTenant(
        tenant.tenantId,
        (tx) => tx.insert(products).values({ tenantId: tenant.tenantId, sku: 'E-1', name: 'Kopya' }),
        app.db,
      ),
    )
    expect(pgConstraint(err)).toBe('products_tenant_sku_uq')
  })
})

describe('isUniqueViolation', () => {
  it('doğru constraint için true', async () => {
    const key = detUuid('pgerr:dup')
    const write = () =>
      withTenant(
        tenant.tenantId,
        (tx) =>
          tx.insert(stockMovements).values({
            tenantId: tenant.tenantId,
            productId: tenant.products['E-1']!.id,
            userId: tenant.adminUserId,
            delta: '1',
            reason: 'PURCHASE',
            idempotencyKey: key,
          }),
        app.db,
      )

    await write()
    const err = await capture(write)

    expect(isUniqueViolation(err)).toBe(true)
    expect(isUniqueViolation(err, 'movements_tenant_idem_uq')).toBe(true)
  })

  it('BAŞKA bir constraint için false', async () => {
    // "Herhangi bir UNIQUE ihlali" ile "aynı idempotency anahtarı" iki
    // farklı durum. İkincisi başarı sayılıyor; birincisini onunla
    // karıştırmak gerçek bir veri hatasını başarı gibi gösterirdi.
    const err = await capture(() =>
      withTenant(
        tenant.tenantId,
        (tx) => tx.insert(products).values({ tenantId: tenant.tenantId, sku: 'E-1', name: 'Kopya' }),
        app.db,
      ),
    )
    expect(isUniqueViolation(err)).toBe(true)
    expect(isUniqueViolation(err, 'movements_tenant_idem_uq')).toBe(false)
  })

  it('alakasız hata için false', () => {
    expect(isUniqueViolation(new Error('ağ koptu'))).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation('metin')).toBe(false)
  })
})

describe('diğer sınıflandırmalar', () => {
  it('isCheckViolation: sıfır miktarlı hareket', async () => {
    const err = await capture(() =>
      withTenant(
        tenant.tenantId,
        (tx) =>
          tx.insert(stockMovements).values({
            tenantId: tenant.tenantId,
            productId: tenant.products['E-1']!.id,
            userId: tenant.adminUserId,
            delta: '0',
            reason: 'PURCHASE',
            idempotencyKey: detUuid('pgerr:zero'),
          }),
        app.db,
      ),
    )
    expect(isCheckViolation(err)).toBe(true)
    expect(pgConstraint(err)).toBe('movements_delta_nonzero_ck')
  })

  it('isPrivilegeError: uygulama rolü defteri silemez', async () => {
    const err = await capture(() =>
      withTenant(
        tenant.tenantId,
        (tx) => tx.delete(stockMovements).where(eq(stockMovements.tenantId, tenant.tenantId)),
        app.db,
      ),
    )
    expect(isPrivilegeError(err)).toBe(true)
  })

  it('isImmutableLedgerViolation: sahip rolü bile defteri değiştiremez', async () => {
    const err = await capture(() =>
      admin.db
        .update(stockMovements)
        .set({ note: 'değişti' })
        .where(eq(stockMovements.tenantId, tenant.tenantId)),
    )
    expect(isImmutableLedgerViolation(err)).toBe(true)
  })

  it('isDeadlock: alakasız hata için false', () => {
    expect(isDeadlock(new Error('ağ koptu'))).toBe(false)
  })
})
