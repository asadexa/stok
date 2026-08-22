import { type ScryptOptions, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

// promisify, scrypt'in aşırı yüklerinden yalnızca 3 parametrelisini seçiyor.
// Maliyet parametrelerini (N, r, p) geçebilmek için imzayı açıkça yazıyoruz.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

/**
 * Parola ve PIN saklama.
 *
 * node:crypto scrypt kullanılıyor: bcrypt/argon2 native derleme gerektiriyor
 * ve Windows'ta kurulum sorunları çıkarıyor. scrypt çekirdekte, bağımlılık
 * yok, OWASP'ın önerdiği algoritmalardan biri.
 *
 * Format: scrypt$N$r$p$<salt-b64>$<hash-b64>
 * Parametreler kayıtta saklanıyor ki ileride maliyet artırılınca eski
 * kayıtlar hâlâ doğrulanabilsin.
 *
 * NOT: PIN 4-6 hane, yani kaba kuvvete açık. Koruma hash'te değil,
 * deneme sınırlamasında: 5 yanlışta 60 sn kilit, 10 yanlışta tam giriş
 * (PLAN.md tehdit S11, görev T32).
 */

const N = 16384
const R = 8
const P = 1
const KEYLEN = 64

export async function hashSecret(plain: string): Promise<string> {
  const salt = randomBytes(16)
  const key = (await scrypt(plain, salt, KEYLEN, { N, r: R, p: P })) as Buffer
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifySecret(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = Buffer.from(parts[4] ?? '', 'base64')
  const expected = Buffer.from(parts[5] ?? '', 'base64')
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false

  const actual = (await scrypt(plain, salt, expected.length, { N: n, r, p })) as Buffer
  // Uzunluk farkıysa timingSafeEqual fırlatır, önce kontrol et.
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
