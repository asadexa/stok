import { describe, expect, it } from 'vitest'
import { describeTarget } from './target'
import { detUuid as independentDetUuid } from './testing'
import { DEMO_TENANT_IDS, type WipeDecision, decideWipe, refuseTarget } from './wipe-guard'

/**
 * Seed (T125) ve db:reset (WS-1.2b) aynı kurala dayanıyor: buradaki bir
 * gevşeme iki komutta birden gerçek veriyi silinebilir bırakır. Satırlar
 * kapı sırasını da sınıyor; örneğin RLS'e tabi rol "0 yabancı kiracı"
 * görünse bile izin almamalı.
 */
const named = { isLocal: true, database: 'stok_dev' }
const probe = { bypassRls: true, foreignTenants: 0, args: [] as string[] }

describe('decideWipe', () => {
  it.each<[string, Parameters<typeof decideWipe>[0], WipeDecision]>([
    [
      'uzak hedef, hedefin adıyla onay verilse bile',
      { isLocal: false, database: 'stok', bypassRls: true, foreignTenants: 1, args: ['--wipe-non-demo-data=stok'] },
      { allowed: false, reason: 'remote' },
    ],
    [
      'uzak hedef, yalnız demo kiracı olsa bile',
      { ...probe, isLocal: false, database: 'stok' },
      { allowed: false, reason: 'remote' },
    ],
    // WS-1.2a regresyonu: adsız adres kullanıcı adıyla aynı veritabanına
    // bağlanıyor; silinecek şey yazılmadan silme olmamalı.
    [
      'adsız hedef, yalnız demo kiracı',
      { ...probe, isLocal: true, database: '' },
      { allowed: false, reason: 'unnamed' },
    ],
    [
      'adsız hedef, boş onayla (eski açık: "" === "")',
      { isLocal: true, database: '', bypassRls: true, foreignTenants: 1, args: ['--wipe-non-demo-data='] },
      { allowed: false, reason: 'unnamed' },
    ],
    [
      'yalnız boşluktan oluşan ad, aynı boşlukla onay',
      { isLocal: true, database: ' ', bypassRls: true, foreignTenants: 1, args: ['--wipe-non-demo-data= '] },
      { allowed: false, reason: 'unnamed' },
    ],
    [
      'RLS atlanmıyor ve sayım 0 görünüyor',
      { ...named, ...probe, bypassRls: false },
      { allowed: false, reason: 'rls-hidden' },
    ],
    ['yalnız demo kiracı', { ...named, ...probe }, { allowed: true, foreignTenants: 0 }],
    [
      'yabancı kiracı, onay yok',
      { ...named, ...probe, foreignTenants: 2 },
      { allowed: false, reason: 'foreign-unconfirmed' },
    ],
    [
      'yabancı kiracı, başka veritabanının adıyla onay',
      { ...named, ...probe, foreignTenants: 1, args: ['--wipe-non-demo-data=stok'] },
      { allowed: false, reason: 'foreign-unconfirmed' },
    ],
    // WS-1.2a regresyonu: boş onay, adlı hedefte de hiçbir şeyi onaylamaz.
    [
      'yabancı kiracı, boş onay',
      { ...named, ...probe, foreignTenants: 1, args: ['--wipe-non-demo-data='] },
      { allowed: false, reason: 'foreign-unconfirmed' },
    ],
    [
      'yabancı kiracı, yalnız boşluktan oluşan onay',
      { ...named, ...probe, foreignTenants: 1, args: ['--wipe-non-demo-data= '] },
      { allowed: false, reason: 'foreign-unconfirmed' },
    ],
    [
      'yabancı kiracı, hedefin adıyla onay',
      { ...named, ...probe, foreignTenants: 3, args: ['--wipe-non-demo-data=stok_dev'] },
      { allowed: true, foreignTenants: 3 },
    ],
  ])('%s', (_name, input, expected) => {
    expect(decideWipe(input)).toEqual(expected)
  })
})

describe('refuseTarget (bağlantıdan önce)', () => {
  // Gerçek adres çözümlemesiyle: "adsız" durumu `describeTarget`'ın
  // ürettiği hedeften geliyor, elle kurulmuş bir nesneden değil.
  it.each([
    ['postgresql://u:p@127.0.0.1:5433', 'unnamed'],
    ['postgresql://u:p@127.0.0.1:5433/', 'unnamed'],
    ['postgresql://u:p@192.168.1.20:5432/stok', 'remote'],
    ['postgresql://u:p@127.0.0.1:5433/stok', null],
  ])('%s → %s', (url, expected) => {
    expect(refuseTarget(describeTarget(url))).toBe(expected)
  })
})

describe('DEMO_TENANT_IDS', () => {
  it('seed kiracılarının kimlikleri taşımadan sonra aynı (bağımsız türetmeyle)', () => {
    expect([...DEMO_TENANT_IDS]).toEqual([
      independentDetUuid('tenant:yilmaz'),
      independentDetUuid('tenant:demir'),
    ])
  })
})
