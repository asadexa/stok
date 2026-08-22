import { describe, expect, it } from 'vitest'
import { PERMISSIONS, ROLE_VALUES, can, permissionsOf, rolesCheckConstraint } from './roles.js'

describe('yetki matrisi (PLAN.md Bölüm 4)', () => {
  it('admin her şeyi yapabilir', () => {
    for (const p of PERMISSIONS) {
      expect(can('ADMIN', p), `admin ${p} yapamıyor`).toBe(true)
    }
  })

  it('çalışan depo işini yapabilir', () => {
    expect(can('STAFF', 'movement:create')).toBe(true)
    expect(can('STAFF', 'product:read')).toBe(true)
    expect(can('STAFF', 'stock:read')).toBe(true)
    expect(can('STAFF', 'movement:read:own')).toBe(true)
    expect(can('STAFF', 'count:start')).toBe(true)
  })
})

describe('çalışanın yapamadıkları (tehdit S6, S7)', () => {
  it('ürün tanımına dokunamaz', () => {
    expect(can('STAFF', 'product:create')).toBe(false)
    expect(can('STAFF', 'product:update')).toBe(false)
    expect(can('STAFF', 'product:archive')).toBe(false)
    expect(can('STAFF', 'barcode:create')).toBe(false)
  })

  it('alış fiyatı ve maliyet göremez', () => {
    expect(can('STAFF', 'price:read')).toBe(false)
  })

  it('başkasının hareketlerini göremez', () => {
    expect(can('STAFF', 'movement:read:all')).toBe(false)
  })

  it('toplu veri dışarı çıkaramaz', () => {
    expect(can('STAFF', 'export:excel')).toBe(false)
  })

  it('negatif stoğu kendi başına geçemez', () => {
    expect(can('STAFF', 'movement:allowNegative')).toBe(false)
  })

  it('kendi başlattığı sayımı onaylayamaz', () => {
    // Sayımı yapan onaylayamaz: ayrı göz gerekir.
    expect(can('STAFF', 'count:start')).toBe(true)
    expect(can('STAFF', 'count:approve')).toBe(false)
  })

  it('kullanıcı yönetemez', () => {
    expect(can('STAFF', 'user:manage')).toBe(false)
  })
})

describe('matris bütünlüğü', () => {
  it('her rol her yetki için açık bir cevap veriyor', () => {
    // `satisfies` bunu derleme zamanında zorluyor; bu test çalışma
    // zamanında da doğruluyor. Eksik bir yetki `undefined` dönerse
    // JavaScript onu false sayar ve sessizce yetki kapanır; sessiz
    // davranış bu projede kabul edilmiyor.
    for (const role of ROLE_VALUES) {
      for (const p of PERMISSIONS) {
        expect(typeof can(role, p), `${role}/${p} boolean değil`).toBe('boolean')
      }
    }
  })

  it('çalışanın yetkileri adminin yetkilerinin alt kümesi', () => {
    const admin = new Set(permissionsOf('ADMIN'))
    for (const p of permissionsOf('STAFF')) {
      expect(admin.has(p), `${p} adminde yok ama çalışanda var`).toBe(true)
    }
  })

  it('DB constraint rol listesinden üretiliyor', () => {
    const sql = rolesCheckConstraint()
    expect(sql).toBe("role IN ('ADMIN', 'STAFF')")
  })
})
