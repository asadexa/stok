import {
  AppError,
  type LoginInput,
  type RefreshInput,
  type Role,
  ROLE_VALUES,
  loginSchema,
  refreshSchema,
} from '@stok/shared'
import { type Db, appDb, hashSecret, users, verifySecret, withTenant } from '@stok/db'
import { eq, sql } from 'drizzle-orm'
import { SignJWT, jwtVerify } from 'jose'
import { type Actor, requirePermission } from './authz'
import { parseOrThrow } from './validate'
import {
  LOGIN_EMAIL_POLICY,
  LOGIN_IP_POLICY,
  assertNotLocked,
  clearAttempts,
  recordFailure,
  throwIfLocked,
} from './rate-limit'

/**
 * ============================================================================
 * KİMLİK DOĞRULAMA (T13)
 *
 * İki tür token var ve ayrımları bilinçli:
 *
 *   ACCESS   15 dk   SADECE imzadan doğrulanır, veritabanına gitmez.
 *                    Her barkod okutmada bir sorgu daha atmak, depoda
 *                    zayıf WiFi'de hissedilir bir gecikme demek.
 *
 *   REFRESH  30 gün  Veritabanına gider: kullanıcı hâlâ aktif mi,
 *                    token_version değişmiş mi (uzaktan oturum kapatma).
 *
 * Takas açıkça şu: bir kullanıcıyı pasifleştirdiğinizde elindeki access
 * token en fazla 15 dakika daha çalışır. Depo uygulamasında kabul
 * edilebilir; alternatifi her istekte fazladan bir sorgu.
 *
 * GİRİŞ AKIŞI — tavuk-yumurta problemi:
 *
 *   e-posta  ──▶  auth_lookup_user()  ──▶  (user_id, tenant_id)
 *                 SECURITY DEFINER,          │
 *                 sadece bu iki alanı döner  │
 *                                            ▼
 *                                   withTenant(tenant_id)
 *                                            │
 *                                            ▼
 *                              parola özeti, rol, aktiflik
 *                              (normal RLS altında)
 *
 * RLS, tenant bağlamı kurulmadan hiçbir satır geçirmiyor; ama giriş
 * anında tenant'ı henüz bilmiyoruz. Ayrıntılı gerekçe ve elenen
 * alternatifler migration 0004'te yazılı.
 * ============================================================================
 */

const ACCESS_TTL_SECONDS = 15 * 60
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60

const ISSUER = 'stok'
const AUDIENCE = 'stok-api'
const ALGORITHM = 'HS256'

export type TokenType = 'access' | 'refresh'

interface StokClaims {
  sub: string
  tid: string
  role: Role
  typ: TokenType
  /** Kullanıcının token sürümü. Refresh doğrulamasında DB ile karşılaştırılır. */
  ver: number
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  /** Unix saniye. İstemci bunu kullanarak süre dolmadan yenileme yapar. */
  accessExpiresAt: number
  refreshExpiresAt: number
}

export interface AuthenticatedUser {
  userId: string
  tenantId: string
  email: string
  name: string
  role: Role
}

export interface LoginResult {
  user: AuthenticatedUser
  tokens: TokenPair
}

export interface AuthOptions {
  db?: Db
  /** Test edilebilirlik: saat enjekte edilebilir, süre dolması sınanabilsin. */
  now?: () => number
  /**
   * İsteğin geldiği adres. Kaba kuvvet sayacının ikinci anahtarı (T51).
   *
   * SUNUCU KATMANINDAN gelir (proxy başlığından çözülmüş), İSTEK
   * GÖVDESİNDEN ASLA: istemcinin yazdığı bir değere göre sayaç tutmak,
   * saldırgana her denemede yeni bir kimlik uydurma imkanı verirdi.
   * Bu yüzden `loginSchema` içinde değil, burada.
   */
  clientIp?: string
}

// ---------------------------------------------------------------------------
// İMZALAMA ANAHTARI
// ---------------------------------------------------------------------------

let cachedKey: { secret: string; key: Uint8Array } | undefined

/**
 * `AUTH_SECRET` yoksa veya kısaysa PATLAR, varsayılana düşmez.
 *
 * Gömülü bir varsayılan anahtar, kimlik doğrulamayı tamamen devre dışı
 * bırakır: kaynak kodu gören herkes kendine admin token'ı imzalayabilir.
 * Ve bu, hiçbir testte görünmez — sistem sorunsuz çalışıyor gibi durur.
 */
function signingKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET
  if (!secret || secret.length < 32) {
    throw new AppError(
      'SERVER_ERROR',
      'AUTH_SECRET tanımlı değil veya 32 karakterden kısa (üret: openssl rand -base64 32)',
    )
  }
  if (cachedKey?.secret !== secret) {
    cachedKey = { secret, key: new TextEncoder().encode(secret) }
  }
  return cachedKey.key
}

async function signToken(claims: StokClaims, ttlSeconds: number, nowMs: number): Promise<string> {
  const issuedAt = Math.floor(nowMs / 1000)
  return new SignJWT({ tid: claims.tid, role: claims.role, typ: claims.typ, ver: claims.ver })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(signingKey())
}

/**
 * Token'ı doğrular ve iddialarını döner.
 *
 * `algorithms` SABİTLENMİŞ. Verilmeseydi saldırgan `alg: "none"` başlıklı
 * bir token gönderip imzasız geçebilirdi — JWT'nin en bilinen açığı.
 */
async function readToken(token: string, expected: TokenType, nowMs: number): Promise<StokClaims> {
  const verified = await jwtVerify(token, signingKey(), {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: [ALGORITHM],
    currentDate: new Date(nowMs),
  }).catch((err: unknown) => {
    const code = (err as { code?: unknown })?.code
    if (code === 'ERR_JWT_EXPIRED') {
      throw new AppError('TOKEN_EXPIRED', 'token expired')
    }
    throw new AppError('TOKEN_INVALID', `token rejected: ${String(code ?? err)}`)
  })

  const p = verified.payload as Record<string, unknown>
  const claims: StokClaims = {
    sub: String(p.sub ?? ''),
    tid: String(p.tid ?? ''),
    role: p.role as Role,
    typ: p.typ as TokenType,
    ver: typeof p.ver === 'number' ? p.ver : -1,
  }

  // İmza geçerli olsa bile içerik beklediğimiz biçimde olmayabilir:
  // eski sürüm bir token, elle üretilmiş bir yük, ya da rolü sonradan
  // kaldırılmış bir kullanıcı. Sessizce kabul etmiyoruz.
  if (!claims.sub || !claims.tid) {
    throw new AppError('TOKEN_INVALID', 'token missing subject or tenant')
  }
  if (!ROLE_VALUES.includes(claims.role)) {
    throw new AppError('TOKEN_INVALID', `unknown role in token: ${String(claims.role)}`)
  }
  if (claims.typ !== expected) {
    // Refresh token'ı access olarak kullanmak, 15 dakikalık pencereyi
    // 30 güne çevirirdi. Tür ayrımı imzanın içinde.
    throw new AppError('TOKEN_INVALID', `expected ${expected} token, got ${String(claims.typ)}`)
  }
  return claims
}

/**
 * Access token'dan `Actor` üretir. Her korumalı isteğin ilk adımı.
 * Veritabanına GİTMEZ; iptal en fazla token ömrü kadar gecikir.
 */
export async function actorFromAccessToken(
  token: string,
  options: AuthOptions = {},
): Promise<Actor> {
  const now = options.now?.() ?? Date.now()
  const claims = await readToken(token, 'access', now)
  return { tenantId: claims.tid, userId: claims.sub, role: claims.role }
}

/** `Authorization: Bearer <token>` başlığını çözer. */
export function bearerToken(header: string | null | undefined): string {
  const value = header?.trim() ?? ''
  const match = /^Bearer (.+)$/i.exec(value)
  if (!match?.[1]) throw new AppError('TOKEN_INVALID', 'Authorization header missing or malformed')
  return match[1].trim()
}

// ---------------------------------------------------------------------------
// GİRİŞ
// ---------------------------------------------------------------------------

/**
 * Kullanıcı bulunamadığında da parola doğrulaması YAPILIR.
 *
 * Yapılmasaydı "yok" cevabı milisaniyeler içinde, "var ama parola yanlış"
 * cevabı scrypt süresi kadar sonra dönerdi ve saldırgan bu farktan hangi
 * e-postaların kayıtlı olduğunu okurdu (kullanıcı sayımı). Sabit maliyet
 * ödeyerek o kanalı kapatıyoruz.
 */
let dummyHashPromise: Promise<string> | undefined

async function burnPasswordTime(password: string): Promise<void> {
  dummyHashPromise ??= hashSecret('gecersiz-parola-yer-tutucu')
  await verifySecret(password, await dummyHashPromise)
}

interface LookupRow extends Record<string, unknown> {
  user_id: string
  tenant_id: string
}

/**
 * E-postadan (user_id, tenant_id) çözer. Migration 0004'teki
 * SECURITY DEFINER fonksiyonunu çağırır: RLS'in tenant bağlamı olmadan
 * satır geçirmediği tek istisna, ve sadece bu iki alanı döner.
 */
async function lookupCandidates(db: Db, email: string): Promise<LookupRow[]> {
  const rows = await db.execute<LookupRow>(
    sql`SELECT user_id, tenant_id FROM auth_lookup_user(${email})`,
  )
  return [...rows]
}

export async function login(raw: unknown, options: AuthOptions = {}): Promise<LoginResult> {
  const input: LoginInput = parseOrThrow(loginSchema, raw)
  const db = options.db ?? defaultDb()
  const now = options.now?.() ?? Date.now()
  const ip = options.clientIp

  // Kilit kontrolü EN BAŞTA: scrypt her denemede ~100 ms CPU yiyor ve
  // sayaç sonradan bakılsaydı kilitli bir hesap bile saldırganın
  // sunucuyu yormasına izin verirdi (T51, tehdit S9).
  await assertNotLocked(db, 'LOGIN_EMAIL', input.email, LOGIN_EMAIL_POLICY, now)
  if (ip) await assertNotLocked(db, 'LOGIN_IP', ip, LOGIN_IP_POLICY, now)

  const candidates = await lookupCandidates(db, input.email)
  const matches = input.tenantId
    ? candidates.filter((c) => c.tenant_id === input.tenantId)
    : candidates

  if (matches.length === 0) {
    // Kayıtlı OLMAYAN e-posta da sayılıyor. Sadece var olan hesaplar
    // kilitlenseydi, "kilitlendim" cevabı hesabın varlığını ele verir ve
    // giriş hatalarını tek kod altında toplama çabamız boşa giderdi.
    await burnPasswordTime(input.password)
    await noteLoginFailure(db, input.email, ip, now)
    throw new AppError('INVALID_CREDENTIALS', `no user for ${input.email}`)
  }

  if (matches.length > 1) {
    // Aynı e-posta iki işletmede kayıtlı. Birini tahmin etmek yerine
    // istemciye seçtiriyoruz; yanlış tenant'a giriş yaptırmak, kullanıcının
    // başka bir müşterinin deposuna bakması demek olurdu.
    await burnPasswordTime(input.password)
    throw new AppError('TENANT_AMBIGUOUS', `${matches.length} tenants share ${input.email}`, {
      tenantIds: matches.map((m) => m.tenant_id),
    })
  }

  const match = matches[0]!
  const user = await withTenant(
    match.tenant_id,
    async (tx) => {
      const [row] = await tx
        .select({
          id: users.id,
          tenantId: users.tenantId,
          email: users.email,
          name: users.name,
          role: users.role,
          passwordHash: users.passwordHash,
          active: users.active,
          tokenVersion: users.tokenVersion,
        })
        .from(users)
        .where(eq(users.id, match.user_id))
        .limit(1)
      return row
    },
    db,
  )

  if (!user?.passwordHash) {
    // Parola özeti olmayan kullanıcı: sadece PIN ile çalışan bir hesap
    // (E10) veya yarım kalmış davet. Giriş yolu kapalı.
    await burnPasswordTime(input.password)
    await noteLoginFailure(db, input.email, ip, now)
    throw new AppError('INVALID_CREDENTIALS', `user ${match.user_id} has no password`)
  }

  const ok = await verifySecret(input.password, user.passwordHash)
  if (!ok) {
    await noteLoginFailure(db, input.email, ip, now)
    throw new AppError('INVALID_CREDENTIALS', `bad password for ${input.email}`)
  }

  // Aktiflik kontrolü parola doğrulamasından SONRA: önce yapılsaydı,
  // parolayı bilmeyen biri "bu hesap pasif" cevabından hesabın varlığını
  // öğrenirdi.
  // Parola doğru: bu bir tahmin değil. Hesap pasif olsa bile sayacı
  // temizliyoruz, çünkü sayaç kaba kuvveti ölçüyor ve burada kaba kuvvet yok.
  await clearLoginAttempts(db, input.email, ip)

  if (!user.active) {
    throw new AppError('ACCOUNT_INACTIVE', `user ${user.id} is inactive`, { userId: user.id })
  }

  return {
    user: {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      role: user.role as Role,
    },
    tokens: await issueTokens(
      { tenantId: user.tenantId, userId: user.id, role: user.role as Role },
      user.tokenVersion,
      now,
    ),
  }
}

/**
 * Başarısız denemeyi hem hesap hem adres sayacına yazar ve yeni durum
 * kilit gerektiriyorsa `TOO_MANY_ATTEMPTS` fırlatır.
 *
 * Kilit BU denemede başlıyorsa kullanıcı `INVALID_CREDENTIALS` yerine
 * doğrudan bekleme süresini görür; "parola yanlış" deyip bir sonraki
 * denemede sessizce kilitlemek, kullanıcıya ne olduğunu anlatmazdı.
 */
async function noteLoginFailure(
  db: Db,
  email: string,
  ip: string | undefined,
  now: number,
): Promise<void> {
  const byEmail = await recordFailure(db, 'LOGIN_EMAIL', email, LOGIN_EMAIL_POLICY, now)
  const byIp = ip
    ? await recordFailure(db, 'LOGIN_IP', ip, LOGIN_IP_POLICY, now)
    : undefined

  throwIfLocked(byEmail, 'LOGIN_EMAIL', now)
  if (byIp) throwIfLocked(byIp, 'LOGIN_IP', now)
}

async function clearLoginAttempts(db: Db, email: string, ip: string | undefined): Promise<void> {
  await clearAttempts(db, 'LOGIN_EMAIL', email)
  if (ip) await clearAttempts(db, 'LOGIN_IP', ip)
}

async function issueTokens(actor: Actor, tokenVersion: number, now: number): Promise<TokenPair> {
  const base: Omit<StokClaims, 'typ'> = {
    sub: actor.userId,
    tid: actor.tenantId,
    role: actor.role,
    ver: tokenVersion,
  }
  const [accessToken, refreshToken] = await Promise.all([
    signToken({ ...base, typ: 'access' }, ACCESS_TTL_SECONDS, now),
    signToken({ ...base, typ: 'refresh' }, REFRESH_TTL_SECONDS, now),
  ])
  const issuedAt = Math.floor(now / 1000)
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: issuedAt + ACCESS_TTL_SECONDS,
    refreshExpiresAt: issuedAt + REFRESH_TTL_SECONDS,
  }
}

// ---------------------------------------------------------------------------
// YENİLEME VE İPTAL
// ---------------------------------------------------------------------------

/**
 * Refresh token'ı yeni bir token çifti ile takas eder.
 *
 * Access token'ın aksine BU doğrulama veritabanına gider: kullanıcının
 * hâlâ aktif olduğu ve oturumlarının iptal edilmediği burada anlaşılır.
 * Rol de yeniden okunur — admin yetkisi alınan biri bir sonraki
 * yenilemede çalışan olarak devam eder.
 */
export async function refreshSession(
  raw: unknown,
  options: AuthOptions = {},
): Promise<LoginResult> {
  const input: RefreshInput = parseOrThrow(refreshSchema, raw)
  const db = options.db ?? defaultDb()
  const now = options.now?.() ?? Date.now()

  const claims = await readToken(input.refreshToken, 'refresh', now)

  const user = await withTenant(
    claims.tid,
    async (tx) => {
      const [row] = await tx
        .select({
          id: users.id,
          tenantId: users.tenantId,
          email: users.email,
          name: users.name,
          role: users.role,
          active: users.active,
          tokenVersion: users.tokenVersion,
        })
        .from(users)
        .where(eq(users.id, claims.sub))
        .limit(1)
      return row
    },
    db,
  )

  if (!user) throw new AppError('TOKEN_INVALID', `user ${claims.sub} not found`)
  if (!user.active) {
    throw new AppError('ACCOUNT_INACTIVE', `user ${user.id} is inactive`, { userId: user.id })
  }
  if (user.tokenVersion !== claims.ver) {
    throw new AppError('TOKEN_INVALID', 'session revoked', { userId: user.id })
  }

  return {
    user: {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      role: user.role as Role,
    },
    tokens: await issueTokens(
      { tenantId: user.tenantId, userId: user.id, role: user.role as Role },
      user.tokenVersion,
      now,
    ),
  }
}

/**
 * Bir kullanıcının dağıtılmış TÜM refresh token'larını geçersiz kılar
 * (tehdit S5: çalınan telefon, işten ayrılan çalışan).
 *
 * Kendi oturumunu herkes kapatabilir; başkasınınkini sadece `user:manage`
 * yetkisi olan kapatabilir.
 */
export async function revokeSessions(
  actor: Actor,
  targetUserId: string,
  options: AuthOptions = {},
): Promise<void> {
  if (targetUserId !== actor.userId) requirePermission(actor, 'user:manage')

  const updated = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .update(users)
        .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, targetUserId))
        .returning({ id: users.id }),
    options.db ?? defaultDb(),
  )

  // RLS başka tenant'ın kullanıcısını görünmez yapar; UPDATE sessizce
  // sıfır satır günceller. Sessiz başarı, yöneticiye "oturum kapatıldı"
  // yalanı söylerdi.
  if (updated.length === 0) {
    throw new AppError('NOT_FOUND', `user ${targetUserId} not found`, { userId: targetUserId })
  }
}

// ---------------------------------------------------------------------------

/**
 * Bağlantı verilmediyse uygulamanın normal havuzunu kullan. Testler ve
 * cron işleri kendi bağlantılarını geçiyor.
 */
function defaultDb(): Db {
  return appDb()
}

/** Mobil istemci yenileme zamanlamasını bu sabitlere göre kurar. */
export const TOKEN_TTL = {
  accessSeconds: ACCESS_TTL_SECONDS,
  refreshSeconds: REFRESH_TTL_SECONDS,
} as const
