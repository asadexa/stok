import { describe, expect, it } from 'vitest'
import { describeTarget } from './target'
import { detUuid as independentDetUuid } from './testing'
import {
  APP_TABLES,
  type DatabaseProbe,
  DEMO_TENANT_IDS,
  type TargetState,
  type VolumeProbe,
  type WipeDecision,
  decideVolumeWipe,
  decideWipe,
  isLocalDockerEndpoint,
  refuseTarget,
  sameTarget,
  volumeConfirmed,
} from './wipe-guard'

/**
 * Seed (T125) ve db:reset (WS-1.2b) aynı kurala dayanıyor: buradaki bir
 * gevşeme iki komutta birden gerçek veriyi silinebilir bırakır. Satırlar
 * kapı sırasını da sınıyor; örneğin RLS'e tabi rol "0 yabancı kiracı"
 * görünse bile izin almamalı.
 */
const named = { isLocal: true, database: 'stok_dev' }
// Varsayılan ölçüm: bağlanılan veritabanı `named` ile aynı, tablolar public'te.
const probe = {
  connectedDatabase: 'stok_dev',
  schemaShadowed: false,
  bypassRls: true,
  foreignTenants: 0,
  args: [] as string[],
}

describe('decideWipe', () => {
  it.each<[string, Parameters<typeof decideWipe>[0], WipeDecision]>([
    [
      'uzak hedef, hedefin adıyla onay verilse bile',
      {
        ...probe,
        isLocal: false,
        database: 'stok',
        connectedDatabase: 'stok',
        foreignTenants: 1,
        args: ['--wipe-non-demo-data=stok'],
      },
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
      // Adsız adreste sürücü kullanıcı adıyla aynı veritabanına bağlanıyor.
      {
        ...probe,
        isLocal: true,
        database: '',
        connectedDatabase: 'postgres',
        foreignTenants: 1,
        args: ['--wipe-non-demo-data='],
      },
      { allowed: false, reason: 'unnamed' },
    ],
    [
      'yalnız boşluktan oluşan ad, aynı boşlukla onay',
      {
        ...probe,
        isLocal: true,
        database: ' ',
        connectedDatabase: ' ',
        foreignTenants: 1,
        args: ['--wipe-non-demo-data= '],
      },
      { allowed: false, reason: 'unnamed' },
    ],
    // T187: kapının gösterdiği ile bağlanılan ayrışırsa onay hiçbir şeyi
    // onaylamaz; adres ayrıştırması ne kadar dar olursa olsun son ölçü bu.
    [
      'bağlanılan veritabanı yazılan hedef değil, hedefin adıyla onay verilse bile',
      { ...named, ...probe, connectedDatabase: 'stok', foreignTenants: 1, args: ['--wipe-non-demo-data=stok_dev'] },
      { allowed: false, reason: 'target-mismatch' },
    ],
    [
      'bağlanılan veritabanı farklı, yalnız demo kiracı görünse bile',
      { ...named, ...probe, connectedDatabase: 'stok' },
      { allowed: false, reason: 'target-mismatch' },
    ],
    [
      'bağlanılan veritabanı okunamadı (boş)',
      { ...named, ...probe, connectedDatabase: '' },
      { allowed: false, reason: 'target-mismatch' },
    ],
    // T187: tablolar başka şemaya çözülürse kapının saydığı ile silinen ayrışır.
    [
      'tablolar başka şemaya çözülüyor, yalnız demo kiracı görünse bile',
      { ...named, ...probe, schemaShadowed: true },
      { allowed: false, reason: 'schema-shadowed' },
    ],
    [
      'tablolar başka şemaya çözülüyor, hedefin adıyla onay verilse bile',
      { ...named, ...probe, schemaShadowed: true, foreignTenants: 1, args: ['--wipe-non-demo-data=stok_dev'] },
      { allowed: false, reason: 'schema-shadowed' },
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

/**
 * WS-1.2b — volume sıfırlama kararı. Taban, bugünkü kurulumun ürettiği
 * küme; her satır onu tek bir yerden bozuyor. Taban izinliyse ve bozulan her
 * satır reddediliyorsa, ret gerçekten o tek farktan geliyor.
 */
const cleanDb = (database: string, extra: Partial<DatabaseProbe> = {}): DatabaseProbe => ({
  database,
  superuser: true,
  schemas: ['public'],
  relations: [],
  largeObjects: 0,
  extensions: ['plpgsql'],
  foreignTenants: null,
  ...extra,
})
const appTable = (name: string, extra = {}) => ({ schema: 'public', name, kind: 'r', forceRls: true, policies: 1, ...extra })
const baseProbe = (): VolumeProbe => ({
  databases: ['postgres', 'stok', 'template0', 'template1'],
  roles: ['postgres', 'stok_app'],
  tablespaces: ['pg_default', 'pg_global'],
  inspected: {
    postgres: cleanDb('postgres'),
    template1: cleanDb('template1'),
    stok: cleanDb('stok', {
      schemas: ['drizzle', 'public'],
      extensions: ['pg_trgm', 'plpgsql'],
      relations: [
        { schema: 'drizzle', name: '__drizzle_migrations', kind: 'r', forceRls: false, policies: 0 },
        ...APP_TABLES.map((name) => appTable(name)),
      ],
      foreignTenants: 0,
    }),
  },
})
const stokOf = (p: VolumeProbe) => p.inspected.stok!

describe('decideVolumeWipe', () => {
  it('bugünkü kurulumun kümesi, yalnız demo kiracıyla izinli (taban)', () => {
    expect(decideVolumeWipe(baseProbe(), [])).toEqual({ allowed: true, foreignTenants: 0 })
  })

  it.each<[string, (p: VolumeProbe) => void, string, string[]?]>([
    // Ad kanıt değil: `stok_test_` önekli bir veritabanı da doğrulanamıyor.
    ['stok_test_* adlı veritabanı', (p) => p.databases.push('stok_test_x'), 'unknown-database', ['stok_test_x']],
    ['başka bir veritabanı', (p) => p.databases.push('pilot_kopya'), 'unknown-database', ['pilot_kopya']],
    ['tanınmayan rol', (p) => p.roles.push('yedek_okur'), 'unknown-role', ['yedek_okur']],
    ['ek tablespace', (p) => p.tablespaces.push('harici'), 'unknown-tablespace', ['harici']],
    ['template1 incelenmemiş', (p) => delete p.inspected.template1, 'uninspected-database', ['template1']],
    ['template1 içinde tablo', (p) => p.inspected.template1!.relations.push(appTable('kopya')), 'unknown-object'],
    ['postgres içinde ek şema', (p) => p.inspected.postgres!.schemas.push('arsiv'), 'unknown-object'],
    ['postgres içinde eklenti', (p) => p.inspected.postgres!.extensions.push('dblink'), 'unknown-object'],
    ['postgres içinde large object', (p) => { p.inspected.postgres!.largeObjects = 1 }, 'unknown-object'],
    // RLS tek başına kimlik değil: FORCE RLS ve politikalı yabancı tablo.
    ['stok içinde RLS ve politikalı yabancı tablo', (p) => stokOf(p).relations.push(appTable('yabanci')), 'unknown-object'],
    ['uygulama tablosu RLS\'siz (INV-4)', (p) => { stokOf(p).relations.find((r) => r.name === 'products')!.forceRls = false }, 'unknown-object'],
    ['uygulama tablosu politikasız (INV-4)', (p) => { stokOf(p).relations.find((r) => r.name === 'users')!.policies = 0 }, 'unknown-object'],
    ['uygulama adıyla materialized view', (p) => { stokOf(p).relations.find((r) => r.name === 'products')!.kind = 'm' }, 'unknown-object'],
    ['stok içinde ek şema', (p) => stokOf(p).schemas.push('golge'), 'unknown-object'],
    ['drizzle şemasında ek tablo', (p) => stokOf(p).relations.push({ ...appTable('notlar'), schema: 'drizzle' }), 'unknown-object'],
    ['stok içinde large object', (p) => { stokOf(p).largeObjects = 2 }, 'unknown-object'],
    ['tenants yok ama başka uygulama tablosu var', (p) => {
      stokOf(p).foreignTenants = null
      stokOf(p).relations = [appTable('products')]
    }, 'unverifiable', ['products']],
    ['bağlanılan veritabanı stok değil', (p) => { stokOf(p).database = 'stok_kopya' }, 'target-mismatch'],
    ['inceleme rolü RLS\'i atlamıyor', (p) => { stokOf(p).superuser = false }, 'rls-hidden'],
    ['demo dışı kiracı, onay yok', (p) => { stokOf(p).foreignTenants = 2 }, 'foreign-unconfirmed'],
  ])('%s → ret', (_name, mutate, reason, details) => {
    const probe = baseProbe()
    mutate(probe)
    const decision = decideVolumeWipe(probe, [])
    expect(decision).toMatchObject({ allowed: false, reason })
    if (details) expect(decision).toMatchObject({ details })
  })

  it('tanınmayan veritabanı stok onayıyla da aşılamıyor', () => {
    const probe = baseProbe()
    probe.databases.push('stok_test_x')
    expect(decideVolumeWipe(probe, ['--wipe-non-demo-data=stok'])).toMatchObject({ allowed: false, reason: 'unknown-database' })
  })

  it.each([
    [['--wipe-non-demo-data='], false],
    [['--wipe-non-demo-data=stok_test_db'], false],
    [['--wipe-non-demo-data=stok'], true],
  ])('demo dışı kiracı, onay %j → izin: %s', (args, allowed) => {
    const probe = baseProbe()
    stokOf(probe).foreignTenants = 2
    expect(decideVolumeWipe(probe, args).allowed).toBe(allowed)
  })

  it('migration öncesi taze volume (tenants yok, tablo yok) izinli', () => {
    const probe = baseProbe()
    stokOf(probe).foreignTenants = null
    stokOf(probe).relations = []
    stokOf(probe).schemas = ['public']
    expect(decideVolumeWipe(probe, [])).toEqual({ allowed: true, foreignTenants: 0 })
  })
})

describe('volumeConfirmed', () => {
  it.each<[string[], boolean]>([
    [['--confirm-volume=stok_stok_pgdata'], true],
    [[], false],
    [['--confirm-volume='], false],
    [['--confirm-volume= '], false],
    [['--confirm-volume=stok'], false],
    [['--confirm-volume=stok_stok_pgdata_x'], false],
  ])('%j → %s', (args, expected) => {
    expect(volumeConfirmed(args, 'stok_stok_pgdata')).toBe(expected)
  })
})

describe('isLocalDockerEndpoint', () => {
  it.each([
    ['npipe:////./pipe/dockerDesktopLinuxEngine', true],
    ['unix:///var/run/docker.sock', true],
    ['tcp://192.168.1.20:2375', false],
    ['ssh://kullanici@sunucu', false],
    ['', false],
  ])('%s → %s', (host, expected) => {
    expect(isLocalDockerEndpoint(host)).toBe(expected)
  })
})

describe('sameTarget', () => {
  const inspected: TargetState = {
    volumeCreatedAt: '2026-10-14T10:00:00Z',
    volumeUsers: ['abc'],
    containerRunning: false,
    containerFinishedAt: '2026-10-14T10:05:00Z',
  }
  it.each<[string, Partial<TargetState>, boolean]>([
    ['değişmemiş', {}, true],
    ['volume yeniden yaratılmış', { volumeCreatedAt: '2026-10-14T10:06:00Z' }, false],
    ['kapsayıcı çalıştırılıp durdurulmuş', { containerFinishedAt: '2026-10-14T10:07:00Z' }, false],
    ['kapsayıcı çalışıyor', { containerRunning: true }, false],
    ['volume\'e ikinci kapsayıcı bağlanmış', { volumeUsers: ['abc', 'def'] }, false],
    ['volume\'ü başka kapsayıcı kullanıyor', { volumeUsers: ['def'] }, false],
  ])('%s → %s', (_name, change, expected) => {
    expect(sameTarget('abc', inspected, { ...inspected, ...change })).toBe(expected)
  })

  // Docker çıktısında alan yoksa iki taraf da tanımsız; bu "değişmedi" değil.
  it.each<[string, Partial<TargetState>]>([
    ['CreatedAt okunamadı', { volumeCreatedAt: undefined as unknown as string }],
    ['FinishedAt okunamadı', { containerFinishedAt: '' }],
  ])('%s (iki tarafta da aynı biçimde) → false', (_name, change) => {
    const blank = { ...inspected, ...change }
    expect(sameTarget('abc', blank, { ...blank })).toBe(false)
  })
})
