import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import process from 'node:process'
import { isCliEntry } from './cli-entry'
import {
  DATA_DIR,
  DockerRefused,
  ROOT,
  type Target,
  docker,
  dockerEndpoint,
  dockerOk,
  inspectOne,
  lines,
  parseJson,
  targetFromContainer,
} from './docker'
import {
  CONFIRM_VOLUME_FLAG,
  DEMO_TENANT_IDS,
  type DatabaseProbe,
  type TargetState,
  type VolumeDecision,
  type VolumeProbe,
  WIPE_FLAG,
  decideVolumeWipe,
  isLocalDockerEndpoint,
  sameTarget,
  volumeConfirmed,
} from './wipe-guard'

/**
 * ============================================================================
 * GÜVENLİ `pnpm db:reset` (WS-1.2b)
 *
 * Eski komut `docker compose down -v` idi: volume'deki BÜTÜN kümeyi hiçbir
 * soru sormadan siliyordu. Kural `wipe-guard.ts`'te, Docker katmanı
 * `docker.ts`'te; burada akış ve sorgular var.
 *
 *   pnpm db:reset                          kullanım; Docker'a dokunmaz
 *   pnpm db:reset --dry-run                canlı, salt okunur, kesintisiz ön kontrol
 *   pnpm db:reset --confirm-volume=<ad>    gerçek sıfırlama
 *
 * Gerçek sıfırlama ÖNCE DURDURUR, SONRA İNCELER: kapsayıcı durunca hiçbir
 * istemci yazamaz; volume ağı ve TCP dinleyicisi olmayan geçici bir
 * kapsayıcıda incelenir. Canlı inceleme ile silme arasında bir istemcinin
 * yazabileceği pencere böylece kalmıyor. Dry-run bu yüzden nihai onay değil.
 *
 * Geri dönüşsüz tek adım `docker volume rm`. Ondan önceki her adımda veri
 * yerinde: inceleme reddederse kapsayıcı yeniden açılır; kapsayıcı silinip
 * volume silinemezse compose aynı volume'le yeniden kurulur.
 * ============================================================================
 */

const INSPECT_LABEL = 'stok.reset.inspect'

const USAGE = [
  'Kullanım:',
  '  pnpm db:reset --dry-run',
  '      Canlı veritabanını salt okunur inceler; kapsayıcıyı durdurmaz, hiçbir şey silmez.',
  `  pnpm db:reset ${CONFIRM_VOLUME_FLAG}<volume-adı> [${WIPE_FLAG}stok]`,
  '      Kapsayıcıyı durdurur, volume\'ü izole ortamda yeniden inceler; ancak kontroller',
  '      geçerse volume\'ü (bütün veritabanları ve rollerle) siler ve boş bir küme kurar.',
  'Onaysız çağrı hiçbir şey yapmaz. Volume adı --dry-run çıktısında yazar.',
].join('\n')

class ResetRefused extends DockerRefused {}

export type ResetMode =
  | { mode: 'usage' }
  | { mode: 'error'; message: string }
  | { mode: 'dry-run' | 'reset'; args: string[] }

export function parseResetArgs(argv: readonly string[]): ResetMode {
  // pnpm bazı sürümlerde araya `--` koyuyor; bayrak değil.
  const args = argv.filter((a) => a !== '--')
  const unknown = args.filter(
    (a) => a !== '--dry-run' && !a.startsWith(CONFIRM_VOLUME_FLAG) && !a.startsWith(WIPE_FLAG),
  )
  if (unknown.length) return { mode: 'error', message: `Bilinmeyen seçenek: ${unknown.join(' ')}` }
  const dryRun = args.includes('--dry-run')
  const confirm = args.some((a) => a.startsWith(CONFIRM_VOLUME_FLAG))
  if (dryRun && confirm) {
    return { mode: 'error', message: '--dry-run ile --confirm-volume birlikte verilemez.' }
  }
  if (dryRun) return { mode: 'dry-run', args }
  return confirm ? { mode: 'reset', args } : { mode: 'usage' }
}

/**
 * İnceleme kapsayıcısı: ağı yok (`--network none`), TCP dinlemiyor
 * (`listen_addresses=`), işlemler salt okunur, autovacuum kapalı; ayarlar
 * komut satırında, volume'e yazılmıyor. `POSTGRES_PASSWORD` BİLEREK yok:
 * volume beklenmedik biçimde boşsa initdb çalışamaz ve inceleme başarısız
 * olur; boş bir küme "temiz" diye okunmaz. İmaj, asıl kapsayıcının imaj
 * kimliği: aynı PostgreSQL sürümü, indirme yok.
 */
export function inspectionRunArgs(name: string, volume: string, image: string): string[] {
  return [
    'run', '-d', '--rm', '--name', name, '--label', `${INSPECT_LABEL}=1`, '--network', 'none',
    '--mount', `type=volume,src=${volume},dst=${DATA_DIR}`, image,
    'postgres', '-c', 'listen_addresses=', '-c', 'autovacuum=off',
    '-c', 'default_transaction_read_only=on',
  ]
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Compose `db` kapsayıcısı → veri bağlaması → volume; zincirin her halkası doğrulanıyor. */
function resolveTarget(): Target {
  const ids = lines(dockerOk(['compose', 'ps', '-a', '-q', 'db'], 'compose kapsayıcısı aranamadı'))
  if (ids.length !== 1) {
    throw new ResetRefused(
      ids.length === 0
        ? 'Compose `db` kapsayıcısı bulunamadı; hangi volume\'ün silineceği belirlenemiyor. Önce: pnpm db:up'
        : `Compose \`db\` için ${ids.length} kapsayıcı var; hangisinin silineceği belirsiz.`,
    )
  }
  return targetFromContainer(ids[0]!)
}

function targetState(t: Target): TargetState {
  const c = inspectOne(['inspect', t.containerId], 'kapsayıcı bilgisi')
  const v = inspectOne(['volume', 'inspect', t.volume], 'volume bilgisi')
  if (
    typeof v.CreatedAt !== 'string' ||
    typeof c.State?.FinishedAt !== 'string' ||
    typeof c.State?.Running !== 'boolean'
  ) {
    throw new ResetRefused('Kapsayıcı ya da volume durumu okunamadı.')
  }
  const users = lines(
    dockerOk(['ps', '-a', '--no-trunc', '--filter', `volume=${t.volume}`, '--format', '{{.ID}}'], 'volume kullanıcıları okunamadı'),
  )
  return {
    volumeCreatedAt: v.CreatedAt,
    volumeUsers: users,
    containerRunning: c.State.Running,
    containerFinishedAt: c.State.FinishedAt,
  }
}

// ---------------------------------------------------------------------------
// İnceleme (salt okunur katalog sorguları)
// ---------------------------------------------------------------------------

const READ_ONLY = 'SET default_transaction_read_only = on;\n'

const CLUSTER_SQL = String.raw`
SELECT json_build_object(
  'databases', (SELECT json_agg(datname ORDER BY datname) FROM pg_database),
  'roles', (SELECT coalesce(json_agg(rolname ORDER BY rolname), '[]'::json)
            FROM pg_roles WHERE rolname NOT LIKE 'pg\_%'),
  'tablespaces', (SELECT json_agg(spcname ORDER BY spcname) FROM pg_tablespace)
);`

// Veri taşıyan ilişkiler: tablo (r), bölümlü tablo (p), materialized view
// (m), foreign table (f). İndeks, görünüm ve dizi veri tutmuyor.
const DATABASE_SQL = String.raw`
SELECT json_build_object(
  'database', current_database(),
  'superuser', (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user),
  'schemas', (SELECT coalesce(json_agg(nspname ORDER BY nspname), '[]'::json)
              FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'),
  'relations', (SELECT coalesce(json_agg(json_build_object(
                  'schema', n.nspname, 'name', c.relname, 'kind', c.relkind::text,
                  'forceRls', c.relrowsecurity AND c.relforcerowsecurity,
                  'policies', (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid))
                ORDER BY n.nspname, c.relname), '[]'::json)
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p', 'm', 'f')
                  AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'),
  'largeObjects', (SELECT count(*) FROM pg_largeobject_metadata),
  'extensions', (SELECT json_agg(extname ORDER BY extname) FROM pg_extension),
  'hasTenants', to_regclass('public.tenants') IS NOT NULL
);`

// Kimlikler `wipe-guard`'dan: seed ile aynı demo tanımı. Sabit UUID'ler.
const FOREIGN_TENANTS_SQL = `SELECT count(*) FROM public.tenants WHERE id NOT IN (${DEMO_TENANT_IDS.map((id) => `'${id}'`).join(', ')});`

function psql(container: string, database: string, sql: string): string {
  return dockerOk(
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', database],
    `${database} incelenemedi`,
    READ_ONLY + sql,
  )
}

const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string')

/** Küme kataloğu beklenen biçimde mi; değilse karar `undefined` üstünden verilirdi. */
export function isClusterProbe(x: unknown): x is Omit<VolumeProbe, 'inspected'> {
  const p = x as Record<string, unknown> | null
  return isStrings(p?.databases) && isStrings(p?.roles) && isStrings(p?.tablespaces)
}

/** Bir veritabanının kataloğu beklenen biçimde mi (sayılar tam sayı, listeler metin). */
export function isDatabaseProbe(x: unknown): x is Omit<DatabaseProbe, 'foreignTenants'> & { hasTenants: boolean } {
  const p = x as Record<string, unknown> | null
  return (
    typeof p?.database === 'string' &&
    typeof p.superuser === 'boolean' &&
    typeof p.hasTenants === 'boolean' &&
    Number.isInteger(p.largeObjects) &&
    isStrings(p.schemas) &&
    isStrings(p.extensions) &&
    Array.isArray(p.relations) &&
    p.relations.every((r: Record<string, unknown> | null) =>
      typeof r?.schema === 'string' &&
      typeof r.name === 'string' &&
      typeof r.kind === 'string' &&
      typeof r.forceRls === 'boolean' &&
      Number.isInteger(r.policies),
    )
  )
}

function probeVolume(container: string): VolumeProbe {
  const cluster = parseJson<unknown>(psql(container, 'postgres', CLUSTER_SQL), 'küme kataloğu')
  if (!isClusterProbe(cluster)) throw new ResetRefused('Küme kataloğu beklenen biçimde değil.')
  const inspected: Record<string, DatabaseProbe> = {}
  // Tanınmayan veritabanlarına bağlanılmıyor: karar onları zaten reddediyor.
  for (const name of ['postgres', 'template1', 'stok'].filter((d) => cluster.databases.includes(d))) {
    const db = parseJson<unknown>(psql(container, name, DATABASE_SQL), `${name} kataloğu`)
    if (!isDatabaseProbe(db)) throw new ResetRefused(`${name} kataloğu beklenen biçimde değil.`)
    const foreign = name === 'stok' && db.hasTenants ? Number(psql(container, name, FOREIGN_TENANTS_SQL)) : null
    if (foreign !== null && !Number.isInteger(foreign)) throw new ResetRefused('Kiracı sayısı okunamadı.')
    inspected[name] = { ...db, foreignTenants: foreign }
  }
  return { ...cluster, inspected }
}

/** Durdurulmuş volume'ü ağsız geçici kapsayıcıda inceler; kapsayıcıyı her durumda kaldırır. */
async function probeIsolated(t: Target): Promise<VolumeProbe> {
  const name = `${t.project}-reset-inspect-${randomBytes(4).toString('hex')}`
  try {
    dockerOk(inspectionRunArgs(name, t.volume, t.image), 'inceleme kapsayıcısı açılamadı')
    for (let i = 0; i < 60; i++) {
      if (docker(['exec', name, 'pg_isready', '-U', 'postgres', '-q']).ok) return probeVolume(name)
      if (!docker(['inspect', name]).ok) break
      await sleep(1000)
    }
    throw new ResetRefused('İnceleme kapsayıcısında PostgreSQL açılmadı; volume doğrulanamadı.')
  } finally {
    // Önce düzgün kapanış (checkpoint), sonra kaldırma. `--rm` kaldırmayı
    // eşzamansız yapıyor ve `docker run` yarıda kalırsa hiç yapmıyor; liste-
    // den düşmeyen kapsayıcıyı `sameTarget` volume kullanıcısı sayıp yersiz
    // ret verirdi. Gerçekten gidene kadar bekleniyor (ve kalırsa ret).
    docker(['stop', '-t', '60', name])
    for (let i = 0; i < 20 && docker(['inspect', name]).ok; i++) {
      docker(['rm', '-f', name])
      await sleep(500)
    }
  }
}

// ---------------------------------------------------------------------------
// Kapsayıcıyı geri açma ve yeniden kurma
// ---------------------------------------------------------------------------

function waitReady(): boolean {
  const published = lines(docker(['compose', 'port', 'db', '5432']).out)[0] ?? ''
  const port = Number(published.slice(published.lastIndexOf(':') + 1))
  if (!Number.isInteger(port) || port <= 0) return false
  const waiter = join(ROOT, 'scripts', 'wait-for-db.mjs')
  return spawnSync(process.execPath, [waiter, String(port)], { cwd: ROOT, stdio: 'inherit' }).status === 0
}

function restore(t: Target): void {
  if (!t.running) return
  // Durdurma hiç gerçekleşmemiş de olabilir: `docker start` çalışan kapsayıcıda
  // etkisiz, bu yüzden mesaj "yeniden açıldı" değil, son durumu söylüyor.
  if (docker(['start', t.containerId]).ok && waitReady()) {
    console.log('  ✓ Kapsayıcı çalışır durumda; veri yerinde.')
    return
  }
  console.error(`  ! Kapsayıcı geri açılamadı; veri yerinde. Elle: docker start ${t.containerId} ya da pnpm db:up`)
}

// ---------------------------------------------------------------------------
// Mesajlar
// ---------------------------------------------------------------------------

function refusalText(decision: Extract<VolumeDecision, { allowed: false }>, probe: VolumeProbe): string {
  const list = decision.details.map((d) => `    - ${d}`).join('\n')
  switch (decision.reason) {
    case 'unknown-database':
      return `Volume'de doğrulanamayan veritabanı var:\n${list}\n  Adı ne olursa olsun (stok_test_* dahil) içeriği doğrulanamayan veritabanı silinmez.\n  Gerçekten gözden çıkarılabilirse önce kendiniz silin, sonra tekrar deneyin.`
    case 'unknown-role':
      return `Kümede tanınmayan PostgreSQL rolü var:\n${list}`
    case 'unknown-tablespace':
      return `Kümede ek tablespace var (veri volume dışında olabilir):\n${list}`
    case 'uninspected-database':
      return `Şu veritabanları incelenemedi:\n${list}`
    case 'unknown-object':
      return `Uygulamaya ait olmayan ya da beklenmeyen nesne var:\n${list}`
    case 'unverifiable':
      return `stok'ta tenants tablosu yok ama başka tablolar var; veri sınıflandırılamadı:\n${list}`
    case 'foreign-unconfirmed':
      return `stok'ta demo dışı ${probe.inspected.stok?.foreignTenants ?? '?'} kiracı var; bu veri gerçek ya da pilot olabilir.\n  Bilerek silmek için ayrıca: ${WIPE_FLAG}stok`
    case 'rls-hidden':
      return 'İnceleme rolü RLS\'i atlamıyor; kiracılar doğrulanamadı.'
    default:
      return `stok doğrulanamadı (${decision.reason}).`
  }
}

// ---------------------------------------------------------------------------
// Modlar
// ---------------------------------------------------------------------------

function printTarget(t: Target): void {
  console.log(`\nHedef: compose projesi ${t.project}, kapsayıcı ${t.containerId.slice(0, 12)}, volume ${t.volume}`)
}

function dryRun(args: string[]): number {
  const t = resolveTarget()
  printTarget(t)
  if (!t.running) {
    throw new ResetRefused('Kapsayıcı çalışmıyor; canlı ön kontrol yapılamadı (dry-run kapsayıcıyı başlatmaz).')
  }
  const probe = probeVolume(t.containerId)
  const decision = decideVolumeWipe(probe, args)
  if (!decision.allowed) {
    console.error(`\n✗ Ön kontrol: silinemez. ${refusalText(decision, probe)}\n`)
    return 1
  }
  console.log('\n✓ Ön kontrol: içerik silinebilir görünüyor. Bu NİHAİ ONAY DEĞİL: gerçek sıfırlama')
  console.log('  kapsayıcıyı durdurup volume\'ü izole ortamda yeniden inceler.')
  console.log(`  Silmek için: pnpm db:reset ${CONFIRM_VOLUME_FLAG}<volume-adı>${decision.foreignTenants > 0 ? ` ${WIPE_FLAG}stok` : ''}\n`)
  return 0
}

async function reset(args: string[]): Promise<number> {
  const t = resolveTarget()
  printTarget(t)
  // Durdurmadan ÖNCE: yanlış ya da eksik onayda kapsayıcıya dokunulmuyor.
  if (!volumeConfirmed(args, t.volume)) {
    throw new ResetRefused(`Volume onayı eksik ya da yanlış. Silinecek volume: ${t.volume}\n  Kullanım: pnpm db:reset ${CONFIRM_VOLUME_FLAG}<volume-adı>`)
  }
  // Önceki yarım kalmış incelemenin kapsayıcısı (yalnız bizim etiketimiz).
  for (const id of lines(docker(['ps', '-a', '-q', '--filter', `label=${INSPECT_LABEL}`, '--filter', `volume=${t.volume}`]).out)) {
    docker(['rm', '-f', id])
  }
  const users = targetState(t).volumeUsers
  if (users.length !== 1 || users[0] !== t.containerId) {
    throw new ResetRefused(`Volume ${t.volume} başka kapsayıcı tarafından da kullanılıyor; durdurulmadı.`)
  }

  console.log('Kapsayıcı durduruluyor; volume izole ortamda incelenecek...')
  // Durdurma da `try` içinde: `docker stop` hata dönse bile kapsayıcı durmuş
  // olabilir; geri açma her durumda deneniyor.
  let stage: 'stopped' | 'container-removed' | 'volume-removed' = 'stopped'
  try {
    if (t.running) dockerOk(['stop', '-t', '60', t.containerId], 'kapsayıcı durdurulamadı')
    const stopped = targetState(t)
    const probe = await probeIsolated(t)
    const decision = decideVolumeWipe(probe, args)
    if (!decision.allowed) {
      console.error(`\n✗ İzole doğrulama: silinemez. ${refusalText(decision, probe)}\n  Sıfırlama yapılmadı.\n`)
      return 1
    }
    if (!sameTarget(t.containerId, stopped, targetState(t)) || !volumeConfirmed(args, t.volume)) {
      throw new ResetRefused('İnceleme ile silme arasında hedef değişti; incelenen veri silinecek veri olmayabilir.')
    }
    dockerOk(['rm', t.containerId], 'kapsayıcı silinemedi')
    stage = 'container-removed'
    dockerOk(['volume', 'rm', t.volume], 'volume silinemedi')
    stage = 'volume-removed'
  } finally {
    if (stage === 'stopped') restore(t)
    if (stage === 'container-removed') {
      // Kapsayıcı aynı volume'le, başlangıçtaki durumunda (çalışıyor/duruyor) yeniden kuruluyor.
      console.error('  ! Volume silinemedi; veri yerinde. Kapsayıcı aynı volume\'le yeniden kuruluyor.')
      const recreated = docker(['compose', 'up', t.running ? '-d' : '--no-start']).ok
      if (!recreated || (t.running && !waitReady())) console.error('  ! Elle: pnpm db:up')
    }
  }

  console.log(`✓ Volume ${t.volume} silindi; boş küme kuruluyor...`)
  if (!docker(['compose', 'up', '-d']).ok || !waitReady()) {
    console.error('✗ Yeni küme açılamadı. Elle: pnpm db:up')
    return 1
  }
  console.log('✓ Sıfırlandı. Örnek veri için: pnpm demo --seed')
  return 0
}

async function main(): Promise<number> {
  const parsed = parseResetArgs(process.argv.slice(2))
  if (parsed.mode === 'error') {
    console.error(`✗ ${parsed.message}\n\n${USAGE}`)
    return 1
  }
  // Onaysız çağrı: yalnız kullanım. Sıfırlanmadığı için çıkış 0 değil;
  // `db:reset && …` diye zincirlenen bir betik sıfırlandığını sanmasın.
  if (parsed.mode === 'usage') {
    console.log(USAGE)
    return 1
  }
  try {
    const endpoint = dockerEndpoint()
    if (!isLocalDockerEndpoint(endpoint)) {
      throw new ResetRefused(`Docker yerel değil (${endpoint}); başka bir makinenin volume'ü silinebilirdi.`)
    }
    return parsed.mode === 'dry-run' ? dryRun(parsed.args) : await reset(parsed.args)
  } catch (err) {
    // `ResetRefused` bir `DockerRefused`; Docker katmanının (`docker.ts`)
    // retleri de aynı biçimde basılıyor, yığın iziyle değil.
    if (err instanceof DockerRefused) {
      console.error(`\n✗ ${err.message}\n  Sıfırlama yapılmadı.\n`)
      return 1
    }
    throw err
  }
}

// Testler saf fonksiyonları içe aktarıyor; CLI yalnız doğrudan çalıştırılınca
// koşar, junction/symlink içeren yoldan da (`cli-entry.ts`).
if (isCliEntry(import.meta.url, process.argv[1])) {
  process.exitCode = await main()
}
