import { sql } from 'drizzle-orm'
import type { Db } from './client'

/**
 * ============================================================================
 * HEDEF VERİTABANI — SEED VE KİRACI AÇMA İÇİN ORTAK YARDIMCI
 *
 * İkisi de sahip rolüyle (`MIGRATION_DATABASE_URL`) bağlanıyor ve
 * operatörün kendi makinesinde koşuyor. Yanlış kabukta yanlış adres en
 * pahalı hata: seed üretimi siler (T125), kiracı açma yanlış veritabanına
 * yazar.
 *
 * YEREL = yalnız localhost, 127.0.0.1, ::1. Başka her şey UZAK sayılıyor,
 * LAN adresi (192.168…) dahil: dükkândaki bir sunucu da gerçek veridir.
 *
 * Hedef adresten KESİN okunamıyorsa da UZAK (fail closed, T187). Burada
 * okunan hedef ile postgres.js'in bağlandığı hedef şu durumlarda ayrışıyor:
 *   - sorgu parametresi: sürücü tanımadığı parametreleri başlangıç mesajına
 *     koyuyor; `?database=` başka veritabanına, `?search_path=`/`?options=`
 *     başka şemaya götürüyor (`?host=` de buraya giriyor). Parametre izin
 *     listesi her sürücü sürümünde yeniden doğrulama isterdi; yerel adres
 *     parametre istemiyor.
 *   - `%` kodlu yol: burada çözülüyor, sürücü çözmeden gönderiyor.
 *   - portsuz adres: sürücü `PGPORT`'u kullanıyor, burada 5432 görünürdü.
 * Bu kural ayrıştırmayı daraltıyor; bağlanınca gerçek veritabanı ayrıca
 * `connectedDatabase` ile karşılaştırılıyor.
 * ============================================================================
 */
export interface DatabaseTarget {
  host: string
  port: number
  database: string
  isLocal: boolean
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export function describeTarget(url: string): DatabaseTarget {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('MIGRATION_DATABASE_URL bir bağlantı adresi olarak çözümlenemedi.')
  }
  // URL, IPv6 adresini köşeli parantezle döndürüyor: "[::1]".
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1')
  const definite = parsed.port !== '' && parsed.search === '' && !parsed.pathname.includes('%')
  return {
    host,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    isLocal: LOCAL_HOSTS.has(host) && definite,
  }
}

export function formatTarget(target: DatabaseTarget): string {
  return `${target.host}:${target.port}/${target.database} (${target.isLocal ? 'YEREL' : 'UZAK'})`
}

/**
 * Bağlanan rol RLS'i atlıyor mu (superuser ya da BYPASSRLS).
 *
 * Gerekli çünkü tablolar FORCE RLS: atlamayan bir sahip rolü kiracı bağlamı
 * kurmadan `tenants`'ı sorgularsa BOŞ görür. "Hiç kiracı yok" sanmak, seed
 * korumasını sessizce açık bırakırdı.
 */
export async function canBypassRls(db: Db): Promise<boolean> {
  const result = await db.execute<{ bypass: boolean }>(
    sql`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`,
  )
  return [...result][0]?.bypass === true
}

/**
 * Bağlantının gerçekten açıldığı veritabanı (T187).
 *
 * Adresin ayrıştırılması ile sürücünün okuması ayrışabiliyor; hedefi
 * gösterip onay isteyen araç, gösterdiği adı bununla karşılaştırmazsa
 * kullanıcı başka bir veritabanını onaylamış olur. Okunamazsa boş döner ve
 * karşılaştırma reddeder (fail closed).
 */
export async function connectedDatabase(db: Db): Promise<string> {
  const result = await db.execute<{ name: string }>(sql`SELECT current_database() AS name`)
  return [...result][0]?.name ?? ''
}
