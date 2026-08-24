import {
  type Db,
  hashSecret,
  isUniqueViolation,
  pgConstraint,
  users,
  withTenant,
} from '@stok/db'
import {
  AppError,
  type Role,
  createUserSchema,
  setPasswordSchema,
  updateUserSchema,
} from '@stok/shared'
import { and, eq, ne, sql } from 'drizzle-orm'
import { revokeSessions } from './auth.js'
import { type Actor, requirePermission } from './authz.js'
import { parseOrThrow } from './validate.js'

/**
 * ============================================================================
 * KULLANICI LİSTESİ
 *
 * İki işi var: hareket logundaki "kim" filtresini beslemek (T20) ve
 * kullanıcı yönetimi (T24).
 *
 * T24'ÜN İKİ KİLİDİ, ikisi de aynı felaketi engelliyor: işletmenin kendi
 * sisteminden kilitlenmesi. Geri dönüşü veritabanına elle müdahale
 * gerektirir ve o müdahaleyi yapacak kişi çoğu zaman yoktur.
 *
 *   1. KENDİNİ KİLİTLEME YASAK — yönetici kendi rolünü düşüremez,
 *      kendini pasifleştiremez.
 *   2. SON YÖNETİCİ KORUMASI — başkası olsa bile, geriye yönetici
 *      kalmıyorsa işlem reddedilir.
 *
 * İkisi de gerekli: (1) olmadan tek yönetici kendini düşürür, (2)
 * olmadan iki yönetici birbirini düşürür.
 *
 * PAROLA VE PIN HASH'LERİ SORGUYA HİÇ GİRMİYOR. `select()` alanları tek
 * tek sayılıyor, `select().from(users)` yazılmıyor: ikincisi bugün de
 * çalışırdı ama şemaya yarın eklenecek her gizli alan sessizce cevaba
 * düşerdi.
 * ============================================================================
 */

export interface TenantUser {
  id: string
  name: string
  role: Role
  active: boolean
}

export interface UserOptions {
  db?: Db
}

/**
 * Kiracının kullanıcıları.
 *
 * Yetki `movement:read:all`: bu listenin tek tüketicisi hareket logunun
 * kullanıcı filtresi ve o filtreyi zaten sadece bu yetkiye sahip rol
 * kullanabiliyor. Çalışana isim listesi vermek, göremediği hareketlerin
 * sahiplerini saymasına yarardı.
 */
export async function listTenantUsers(
  actor: Actor,
  options: UserOptions = {},
): Promise<TenantUser[]> {
  requirePermission(actor, 'movement:read:all')

  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
          active: users.active,
        })
        .from(users)
        .where(eq(users.tenantId, actor.tenantId))
        // Pasif kullanıcılar da listede: işten ayrılan birinin geçmiş
        // hareketleri defterde duruyor ve denetimde tam da onlar aranıyor.
        //
        // Sıralama `tr_norm(name)` üzerinden: veritabanı collation'ı
        // `C.UTF-8` ve orada bayt sırası geçerli — "Çağla" ve "Ümit",
        // "Zeynep"ten SONRA gelirdi. Açılır listede aranan ismi
        // bulamamak demek.
        .orderBy(sql`tr_norm(${users.name})`),
    options.db,
  )

  return rows.map((r) => ({ ...r, role: r.role as Role }))
}

/** Tek kullanıcı. Filtre etiketinde adı göstermek için. */
export async function getTenantUser(
  actor: Actor,
  userId: string,
  options: UserOptions = {},
): Promise<TenantUser | null> {
  requirePermission(actor, 'movement:read:all')

  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
          active: users.active,
        })
        .from(users)
        .where(and(eq(users.tenantId, actor.tenantId), eq(users.id, userId)))
        .limit(1),
    options.db,
  )

  const row = rows[0]
  return row ? { ...row, role: row.role as Role } : null
}

// ---------------------------------------------------------------------------
// YAZMA (T24)
// ---------------------------------------------------------------------------

/**
 * Kullanıcı ekler.
 *
 * PAROLAYI YÖNETİCİ BELİRLİYOR, davet e-postası yok. Depo işletmesinde
 * çalışanın çoğu zaman iş e-postası yok; davet bağlantısı gönderecek bir
 * adres de yok. Yönetici parolayı belirleyip sözlü olarak veriyor —
 * gerçekte olan bu, ve akışı buna göre kurmak "e-postanı kontrol et"
 * diyip çıkmaz sokağa sokmaktan dürüst.
 */
export async function createUser(
  actor: Actor,
  raw: unknown,
  options: UserOptions = {},
): Promise<TenantUser> {
  requirePermission(actor, 'user:manage')
  const input = parseOrThrow(createUserSchema, raw)

  const passwordHash = await hashSecret(input.password)
  const pinHash = input.pin ? await hashSecret(input.pin) : null

  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .insert(users)
        .values({
          tenantId: actor.tenantId,
          email: input.email,
          name: input.name,
          role: input.role,
          passwordHash,
          pinHash,
        })
        .returning({
          id: users.id,
          name: users.name,
          role: users.role,
          active: users.active,
        })
        .catch((err: unknown) => {
          // Çakışma SQLSTATE'den okunuyor, önden SELECT ile değil: önden
          // kontrol yarışı kapatmaz, iki yönetici aynı anda aynı adresi
          // eklerse ikisi de "boşta" görür ve biri 500 alır.
          if (isUniqueViolation(err) && pgConstraint(err) === 'users_tenant_email_uq') {
            throw new AppError('EMAIL_EXISTS', `email ${input.email} already exists`, {
              email: input.email,
            })
          }
          throw err
        }),
    options.db,
  )

  const row = rows[0]!
  return { ...row, role: row.role as Role }
}

/**
 * Ad, rol ve aktiflik günceller.
 *
 * PASİFLEŞTİRME OTURUMLARI DA İPTAL EDİYOR (`token_version` artıyor).
 * Sadece bayrağı çevirmek yetmezdi: refresh token'ı elinde olan kullanıcı
 * hiçbir şey olmamış gibi devam ederdi.
 *
 * DÜRÜST OLALIM: access token imzadan doğrulanıyor ve veritabanına
 * gitmiyor (her barkod okutmada fazladan sorgu olmasın diye, D-1.3), yani
 * pasifleştirme en fazla access token ömrü kadar (15 dk) gecikmeli etki
 * eder. Bu bilinçli bir takas; işten çıkarma gibi acil bir durumda
 * yöneticinin bunu bilmesi gerekiyor.
 */
export async function updateUser(
  actor: Actor,
  targetUserId: string,
  raw: unknown,
  options: UserOptions = {},
): Promise<TenantUser> {
  requirePermission(actor, 'user:manage')
  const input = parseOrThrow(updateUserSchema, raw)

  const target = await getTenantUser(actor, targetUserId, options)
  if (!target) {
    throw new AppError('NOT_FOUND', `user ${targetUserId} not found`, { userId: targetUserId })
  }

  const losesAdmin =
    target.role === 'ADMIN' && (input.role === 'STAFF' || input.active === false)

  if (losesAdmin) {
    if (targetUserId === actor.userId) {
      throw new AppError('SELF_LOCKOUT', 'admin cannot demote or deactivate self', {
        userId: targetUserId,
      })
    }
    await assertAnotherAdminRemains(actor, targetUserId, options)
  }

  const patch: Record<string, unknown> = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.role !== undefined) patch.role = input.role
  if (input.active !== undefined) patch.active = input.active
  if (input.pin !== undefined) patch.pinHash = input.pin ? await hashSecret(input.pin) : null

  if (Object.keys(patch).length === 0) return target

  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .update(users)
        .set(patch)
        .where(and(eq(users.tenantId, actor.tenantId), eq(users.id, targetUserId)))
        .returning({
          id: users.id,
          name: users.name,
          role: users.role,
          active: users.active,
        }),
    options.db,
  )

  const row = rows[0]
  if (!row) {
    throw new AppError('NOT_FOUND', `user ${targetUserId} not found`, { userId: targetUserId })
  }

  // Pasifleştirme ve rol düşürme oturumları geçersiz kılıyor. Rol
  // düşürmede de şart: access token rolü İÇİNDE taşıyor, yenilenmezse
  // eski rol 15 dk daha geçerli kalırdı.
  if (input.active === false || (input.role && input.role !== target.role)) {
    await revokeSessions(actor, targetUserId, options)
  }

  return { ...row, role: row.role as Role }
}

/**
 * Parola sıfırlar ve TÜM oturumları kapatır.
 *
 * Oturum kapatmak isteğe bağlı değil: parolayı değiştirmenin sebebi çoğu
 * zaman "başkasının eline geçti". Eski oturumlar ayakta kalsaydı parola
 * değişikliği hiçbir şeyi düzeltmezdi.
 */
export async function setUserPassword(
  actor: Actor,
  targetUserId: string,
  raw: unknown,
  options: UserOptions = {},
): Promise<void> {
  // Kullanıcı KENDİ parolasını değiştirebilir; başkasınınkini sadece
  // yönetici. `revokeSessions` ile aynı kural.
  if (targetUserId !== actor.userId) requirePermission(actor, 'user:manage')
  const input = parseOrThrow(setPasswordSchema, raw)

  const passwordHash = await hashSecret(input.password)
  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .update(users)
        .set({ passwordHash })
        .where(and(eq(users.tenantId, actor.tenantId), eq(users.id, targetUserId)))
        .returning({ id: users.id }),
    options.db,
  )

  if (rows.length === 0) {
    throw new AppError('NOT_FOUND', `user ${targetUserId} not found`, { userId: targetUserId })
  }

  await revokeSessions(actor, targetUserId, options)
}

/** Hedef dışında AKTİF bir yönetici daha var mı. */
async function assertAnotherAdminRemains(
  actor: Actor,
  excludeUserId: string,
  options: UserOptions,
): Promise<void> {
  const rows = await withTenant(
    actor.tenantId,
    (tx) =>
      tx
        .select({ n: sql<string>`count(*)::text` })
        .from(users)
        .where(
          and(
            eq(users.tenantId, actor.tenantId),
            eq(users.role, 'ADMIN'),
            eq(users.active, true),
            ne(users.id, excludeUserId),
          ),
        ),
    options.db,
  )

  if (Number(rows[0]?.n ?? 0) === 0) {
    throw new AppError('LAST_ADMIN', 'tenant would be left without an active admin', {
      userId: excludeUserId,
    })
  }
}
