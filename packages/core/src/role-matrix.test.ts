import { randomUUID } from 'node:crypto'
import {
  AppError,
  PERMISSIONS,
  type Permission,
  ROLE_VALUES,
  can,
} from '@stok/shared'
import { type TestTenant, seedTestTenant, testAdminDb, testAppDb } from '@stok/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Actor, redactPrices, requirePermission } from './authz'
import { createMovement, listMovements } from './movements'
import { TEST_DB_NAME } from './test/db-name'

/**
 * ============================================================================
 * T47 — ROL MATRİSİ, SUNUCU TARAFI
 *
 * PLAN.md Bölüm 4'teki 11 satırın HER BİRİ burada bir teste karşılık
 * geliyor. Tehdit S6'nın tek cümlelik özeti: **arayüzde butonu gizlemek
 * yetki kontrolü değildir.** Mobil uygulamanın APK'sı herkesin elinde,
 * içindeki her endpoint görünür ve `curl` ile çağrılabilir.
 *
 * İki katman test ediliyor:
 *
 *   1. TEK BOĞAZ    requirePermission() matrisin her satırını doğru
 *                   uyguluyor mu — 11 satırın hepsi
 *   2. SERVİS YOLU  servisi bugün var olan satırlarda gerçek çağrı
 *                   reddediliyor mu — matris tablosuna değil, çalışan
 *                   koda bakarak
 *
 * Servisi henüz olmayan satırlar (ürün/kullanıcı yönetimi, Excel, sayım)
 * aşağıda AÇIKÇA işaretli. Servis yazıldığında `requirePermission`
 * çağrısını eklemek yeterli; koruma zaten burada test edilmiş durumda.
 * ============================================================================
 */

const app = testAppDb(TEST_DB_NAME)
const admin = testAdminDb(TEST_DB_NAME)

let tenant: TestTenant
let boss: Actor
let staff: Actor

beforeAll(async () => {
  tenant = await seedTestTenant(admin.db, 'matrix', [
    { sku: 'M-1', name: 'Matris Ürünü' },
    { sku: 'M-2', name: 'İkinci Ürün' },
  ])
  boss = { tenantId: tenant.tenantId, userId: tenant.adminUserId, role: 'ADMIN' }
  staff = { tenantId: tenant.tenantId, userId: tenant.staffUserId, role: 'STAFF' }
})

afterAll(async () => {
  await app.client.end()
  await admin.client.end()
})

// ---------------------------------------------------------------------------
// MATRİSİN KENDİSİ — PLAN.md Bölüm 4 tablosunun birebir kopyası
// ---------------------------------------------------------------------------

interface MatrixRow {
  /** Plandaki satır metni, birebir. */
  islem: string
  permissions: Permission[]
  admin: boolean
  /** `true` = tam yetki, `false` = yasak, 'own' = sadece kendi kaydı. */
  staff: boolean | 'own'
  /** Bu satırı zorlayan servis bugün var mı? */
  servis: string | null
}

const MATRIX: MatrixRow[] = [
  {
    islem: 'Ürün ekle / düzenle / arşivle',
    permissions: ['product:create', 'product:update', 'product:archive'],
    admin: true,
    staff: false,
    servis: null, // T21
  },
  {
    islem: 'Barkod ekle',
    permissions: ['barcode:create'],
    admin: true,
    staff: false,
    servis: null, // T21
  },
  {
    islem: 'Stok giriş / çıkış',
    permissions: ['movement:create'],
    admin: true,
    staff: true,
    servis: 'createMovement',
  },
  {
    islem: 'Ürün / stok görüntüle',
    permissions: ['product:read', 'stock:read'],
    admin: true,
    staff: true,
    servis: null, // T19
  },
  {
    islem: 'Alış fiyatı ve maliyet gör',
    permissions: ['price:read'],
    admin: true,
    staff: false,
    servis: 'listMovements (redaksiyon)',
  },
  {
    islem: 'Hareket geçmişi (tüm kullanıcılar)',
    permissions: ['movement:read:all'],
    admin: true,
    staff: 'own',
    servis: 'listMovements',
  },
  {
    islem: 'Excel export',
    permissions: ['export:excel'],
    admin: true,
    staff: false,
    servis: null, // T14 / T22
  },
  {
    islem: 'Kullanıcı ekle / yetki ver',
    permissions: ['user:manage'],
    admin: true,
    staff: false,
    servis: 'revokeSessions (kısmi)', // T24
  },
  {
    islem: 'Sayım başlat',
    permissions: ['count:start'],
    admin: true,
    staff: true,
    servis: null, // TODOS E2
  },
  {
    islem: 'Sayım onayla',
    permissions: ['count:approve'],
    admin: true,
    staff: false,
    servis: null, // TODOS E2
  },
  {
    islem: 'Negatif stoğa izin ver',
    permissions: ['movement:allowNegative'],
    admin: true,
    staff: false,
    servis: 'createMovement',
  },
]

function expectForbidden(fn: () => void, permission: Permission) {
  let thrown: unknown
  try {
    fn()
  } catch (e) {
    thrown = e
  }
  expect(thrown, `${permission}: reddedilmesi gerekirken izin verildi`).toBeInstanceOf(AppError)
  expect((thrown as AppError).code).toBe('FORBIDDEN')
  expect((thrown as AppError).http).toBe(403)
  expect((thrown as AppError).details.permission).toBe(permission)
}

describe('T47 - matrisin 11 satırı, tek boğazdan', () => {
  it.each(MATRIX.map((r, i) => [i + 1, r.islem, r] as const))(
    'satır %s: %s',
    (_n, _islem, row) => {
      for (const permission of row.permissions) {
        // Admin sütunu
        if (row.admin) {
          expect(() => requirePermission(boss, permission)).not.toThrow()
        } else {
          expectForbidden(() => requirePermission(boss, permission), permission)
        }

        // Çalışan sütunu
        if (row.staff === true) {
          expect(() => requirePermission(staff, permission)).not.toThrow()
        } else if (row.staff === false) {
          expectForbidden(() => requirePermission(staff, permission), permission)
        } else {
          // 'own': tümünü göremez ama kendi kaydını görebilir
          expectForbidden(() => requirePermission(staff, 'movement:read:all'), 'movement:read:all')
          expect(() => requirePermission(staff, 'movement:read:own')).not.toThrow()
        }
      }
    },
  )

  it('matris planın 11 satırını kapsıyor', () => {
    expect(MATRIX).toHaveLength(11)
  })

  it('her yetki en az bir matris satırında geçiyor', () => {
    // Yeni bir yetki eklenip matrise yazılmazsa, o yetkinin rol davranışı
    // hiç test edilmemiş olur ve sessizce yanlış tarafa düşebilir.
    const covered = new Set(MATRIX.flatMap((r) => r.permissions))
    // read:own, 'own' satırında dolaylı kapsanıyor.
    covered.add('movement:read:own')
    const missing = PERMISSIONS.filter((p) => !covered.has(p))
    expect(missing, `matriste geçmeyen yetkiler: ${missing.join(', ')}`).toEqual([])
  })

  it('sadece iki rol var; yeni rol eklenirse bu dosya güncellenmeli', () => {
    expect(ROLE_VALUES).toEqual(['ADMIN', 'STAFF'])
  })
})

// ---------------------------------------------------------------------------
// SERVİS YOLU: gerçek çağrılar
// ---------------------------------------------------------------------------

function req(barcode: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    barcode,
    qty: 1,
    reason: 'PURCHASE',
    clientCreatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('satır 3 + 11: stok hareketi ve negatif stok, servis üzerinden', () => {
  it('çalışan hareket yazabilir', async () => {
    const p = tenant.products['M-1']!
    await expect(
      createMovement(staff, req(p.barcode, { qty: 10 }), { db: app.db }),
    ).resolves.toMatchObject({ delta: 10 })
  })

  it('çalışan allowNegative gönderirse 403 alır ve HAREKET YAZILMAZ', async () => {
    const p = tenant.products['M-1']!
    const err = await createMovement(
      staff,
      req(p.barcode, { qty: 999, reason: 'SALE', allowNegative: true }),
      { db: app.db },
    ).then(
      () => undefined,
      (e: unknown) => e as AppError,
    )

    expect(err?.code).toBe('FORBIDDEN')
    expect(err?.details.permission).toBe('movement:allowNegative')
    // Reddedilen istek deftere hiçbir şey yazmamalı.
    const after = await listMovements(boss, { productId: p.id }, { db: app.db })
    expect(after.every((m) => m.delta > 0)).toBe(true)
  })

  it('admin allowNegative kullanabilir', async () => {
    const p = tenant.products['M-2']!
    await expect(
      createMovement(boss, req(p.barcode, { qty: 5, reason: 'SALE', allowNegative: true }), {
        db: app.db,
      }),
    ).resolves.toMatchObject({ newQty: -5 })
  })
})

describe('satır 6: hareket geçmişi kapsamı, servis üzerinden', () => {
  beforeAll(async () => {
    const p = tenant.products['M-2']!
    await createMovement(boss, req(p.barcode, { qty: 3 }), { db: app.db })
    await createMovement(staff, req(p.barcode, { qty: 4 }), { db: app.db })
  })

  it('admin herkesin hareketini görür', async () => {
    const rows = await listMovements(boss, {}, { db: app.db })
    const owners = new Set(rows.map((r) => r.userId))

    expect(owners.has(tenant.adminUserId)).toBe(true)
    expect(owners.has(tenant.staffUserId)).toBe(true)
  })

  it('çalışan SADECE kendi hareketlerini görür', async () => {
    const rows = await listMovements(staff, {}, { db: app.db })

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.userId === tenant.staffUserId)).toBe(true)
  })

  it('çalışan userId filtresiyle başkasının geçmişini ÇEKEMEZ', async () => {
    // Saldırı yolu: `GET /movements?userId=<patron>`. Arayüzde o kutu yok
    // ama endpoint herkese açık. Sunucu filtreyi yok sayıp kendi
    // kimliğine sabitliyor.
    const rows = await listMovements(staff, { userId: tenant.adminUserId }, { db: app.db })

    expect(rows.every((r) => r.userId === tenant.staffUserId)).toBe(true)
  })

  it('admin userId filtresini kullanabilir', async () => {
    const rows = await listMovements(boss, { userId: tenant.staffUserId }, { db: app.db })

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.userId === tenant.staffUserId)).toBe(true)
  })
})

describe('satır 5: alış fiyatı ve maliyet gizleme (tehdit S7)', () => {
  beforeAll(async () => {
    const p = tenant.products['M-1']!
    await createMovement(boss, req(p.barcode, { qty: 2, unitPrice: 42.5 }), { db: app.db })
  })

  it('admin cevabında unitPrice var', async () => {
    const rows = await listMovements(boss, { productId: tenant.products['M-1']!.id }, { db: app.db })
    const withCost = rows.find((r) => r.unitPrice !== null && r.unitPrice !== undefined)

    expect(withCost?.unitPrice).toBe(42.5)
  })

  it('çalışan cevabında ALIŞ fiyatı ALANI HİÇ YOK, SATIŞ fiyatı var (T88)', async () => {
    // T88'e kadar kural "sütunu topluca sil"di. Sütun artık iki farklı
    // şey tutuyor — girişte alış, çıkışta satış — ve kural satır bazına
    // indi: satış fiyatı ticari sır değil, müşteri zaten biliyor.
    //
    // null bırakmak yine yetmez: arayüz "fiyat girilmemiş" ile "görmeye
    // yetkin yok" durumlarını ayırt edemez ve kullanıcıya yanlış bilgi
    // gösterir. Ayrıca değer ağ sekmesinde görünmemeli.
    await createMovement(staff, req(tenant.products['M-1']!.barcode, { qty: 1, unitPrice: 99 }), {
      db: app.db,
    })
    await createMovement(
      staff,
      req(tenant.products['M-1']!.barcode, { qty: 1, reason: 'SALE', unitPrice: 77 }),
      { db: app.db },
    )
    const rows = await listMovements(staff, { productId: tenant.products['M-1']!.id }, { db: app.db })

    const purchases = rows.filter((r) => r.reason === 'PURCHASE')
    expect(purchases.length).toBeGreaterThan(0)
    for (const row of purchases) {
      expect(Object.hasOwn(row, 'unitPrice')).toBe(false)
      // Değer başka bir alana sızmış olabilir; alan adına değil DEĞERE
      // bakıyoruz. Ham JSON içinde '99' aramak flaky'di: satırdaki
      // rastgele UUID'ler bu diziyi kendiliğinden içerebiliyor ve test
      // ayda bir sebepsiz kırmızıya dönüyordu.
      expect(Object.values(row)).not.toContain(99)
    }

    const sale = rows.find((r) => r.reason === 'SALE')
    expect(sale?.unitPrice).toBe(77)
  })

  it('redactPrices üç fiyat alanının hepsini çıkarır', () => {
    const product = {
      id: 'x',
      name: 'Ürün',
      purchasePrice: 10,
      salePrice: 20,
      unitPrice: 5,
    }

    expect(redactPrices(boss, product)).toEqual(product)
    expect(redactPrices(staff, product)).toEqual({ id: 'x', name: 'Ürün' })
  })

  it('redaksiyon girdiyi değiştirmez (yan etki yok)', () => {
    // Aynı nesne birden fazla cevapta paylaşılıyorsa, yerinde silme
    // admin'in cevabından da fiyatı kaldırırdı.
    const product = { id: 'x', purchasePrice: 10 }
    redactPrices(staff, product)

    expect(product.purchasePrice).toBe(10)
  })
})

describe('matris ile roles.ts arasında sapma yok', () => {
  it.each(MATRIX)('$islem', (row) => {
    for (const permission of row.permissions) {
      expect(can('ADMIN', permission)).toBe(row.admin)
      if (typeof row.staff === 'boolean') {
        expect(can('STAFF', permission)).toBe(row.staff)
      }
    }
  })

  it('servisi olmayan satırlar açıkça işaretli', () => {
    // Bu test bir iddia değil, bir envanter: hangi satırların bugün
    // sadece boğaz seviyesinde korunduğu görünür kalsın.
    const pending = MATRIX.filter((r) => r.servis === null).map((r) => r.islem)

    expect(pending).toEqual([
      'Ürün ekle / düzenle / arşivle',
      'Barkod ekle',
      'Ürün / stok görüntüle',
      'Excel export',
      'Sayım başlat',
      'Sayım onayla',
    ])
  })
})
