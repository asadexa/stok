import { type Db, users, withTenant } from '@stok/db'
import { type Role } from '@stok/shared'
import { and, eq, sql } from 'drizzle-orm'
import { type Actor, requirePermission } from './authz.js'

/**
 * ============================================================================
 * KULLANICI LİSTESİ
 *
 * Şimdilik tek işi var: hareket logundaki "kim" filtresini beslemek (T20).
 * Kullanıcı yönetimi (ekle / rol ver / pasifleştir) T24'te bu dosyaya
 * eklenecek.
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
