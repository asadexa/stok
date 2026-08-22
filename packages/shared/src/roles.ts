/**
 * Roller ve yetki matrisi. TEK KAYNAK.
 *
 * PLAN.md Bölüm 4'teki tablo burada koda dönüşüyor. Dokümanda kalsaydı
 * T47 testi neyi doğrulayacağını bilemezdi ve matris zamanla koddan
 * ayrı düşerdi.
 *
 * KRİTİK: bu matris SUNUCUDA zorlanır. Arayüzde butonu gizlemek yetki
 * kontrolü değildir; kullanıcı API'ye doğrudan istek atabilir.
 * (PLAN.md tehdit S6, S7)
 *
 * Rol kodları da sebep kodları gibi İngilizce (D-2.4): API cevaplarına
 * ve ileride entegrasyonlara gidiyorlar.
 */

export const ROLES = {
  ADMIN: { tr: 'Yönetici' },
  STAFF: { tr: 'Çalışan' },
} as const

export type Role = keyof typeof ROLES
export const ROLE_VALUES = Object.keys(ROLES) as Role[]

export function roleLabel(role: Role): string {
  return ROLES[role].tr
}

/**
 * Yetkiler. İsimlendirme: `<kaynak>:<eylem>`.
 * Yeni bir yetki eklendiğinde PERMISSIONS'a eklenmesi ZORUNLU, çünkü
 * matris `satisfies` ile tam kapsama zorlanıyor: eksik bırakırsan
 * typecheck patlar.
 */
export const PERMISSIONS = [
  'product:create',
  'product:update',
  'product:archive',
  'product:read',
  'barcode:create',
  'movement:create',
  'movement:allowNegative',
  'movement:read:all',
  'movement:read:own',
  'stock:read',
  'price:read',
  'export:excel',
  'user:manage',
  'count:start',
  'count:approve',
] as const

export type Permission = (typeof PERMISSIONS)[number]

type PermissionSet = Readonly<Record<Permission, boolean>>

const ADMIN_PERMISSIONS: PermissionSet = {
  'product:create': true,
  'product:update': true,
  'product:archive': true,
  'product:read': true,
  'barcode:create': true,
  'movement:create': true,
  'movement:allowNegative': true,
  'movement:read:all': true,
  'movement:read:own': true,
  'stock:read': true,
  'price:read': true,
  'export:excel': true,
  'user:manage': true,
  'count:start': true,
  'count:approve': true,
}

const STAFF_PERMISSIONS: PermissionSet = {
  // Çalışan depoda ne yapıyorsa onu yapabilir: okutur, arar, görür.
  'movement:create': true,
  'product:read': true,
  'stock:read': true,
  'movement:read:own': true,
  'count:start': true,

  // Yapamadıkları ve NEDEN yapamadıkları:
  'product:create': false, // yeni ürün tanımı admin işi, yanlış tanım stoğu bozar
  'product:update': false,
  'product:archive': false, // hareketi olan ürünü kaldırmak denetim izini bozar
  'barcode:create': false, // yanlış barkod eşlemesi sessiz stok hatası üretir
  'movement:allowNegative': false, // negatif stok bilinçli bir yönetim kararı
  'movement:read:all': false, // başkasının hareketini görmesi gerekmiyor
  'price:read': false, // alış fiyatı ve maliyet ticari bilgi
  'export:excel': false, // toplu veri dışarı çıkarma admin işi
  'user:manage': false,
  'count:approve': false, // sayımı yapan onaylayamaz, ayrı göz gerekir
}

export const ROLE_PERMISSIONS = {
  ADMIN: ADMIN_PERMISSIONS,
  STAFF: STAFF_PERMISSIONS,
} as const satisfies Record<Role, PermissionSet>

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role][permission]
}

/** Bir rolün sahip olduğu tüm yetkiler. Testler ve hata ayıklama için. */
export function permissionsOf(role: Role): Permission[] {
  return PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role][p])
}

export function rolesCheckConstraint(column = 'role'): string {
  return `${column} IN (${ROLE_VALUES.map((r) => `'${r}'`).join(', ')})`
}

/**
 * ============================================================================
 * KABA KUVVET SAYACI KAPSAMLARI (T51)
 *
 * `auth_attempts` tablosu tek bir sayaç deposu; hangi şeyin sayıldığını
 * bu kapsam belirler. Tek depo olması bilinçli: T32'deki PIN kilitlemesi
 * ikinci bir tablo ve ikinci bir mantık kurmasın.
 *
 * Değerler DB CHECK constraint'iyle senkron tutuluyor (schema-sync testi).
 * Yazım hatası (`login_email` gibi) sayacı sessizce devre dışı bırakırdı:
 * yeni bir kapsam adı = her zaman sıfırdan başlayan bir sayaç = koruma yok.
 * ============================================================================
 */
export const AUTH_ATTEMPT_SCOPES = {
  /** Hesap bazlı: aynı e-postaya parola denemesi. */
  LOGIN_EMAIL: { tr: 'Giriş (e-posta)' },
  /** Kaynak bazlı: tek bir adresten çok sayıda hesaba deneme. */
  LOGIN_IP: { tr: 'Giriş (adres)' },
  /** T32: paylaşılan telefonda PIN denemesi. */
  PIN: { tr: 'PIN' },
} as const

export type AuthAttemptScope = keyof typeof AUTH_ATTEMPT_SCOPES

export const AUTH_ATTEMPT_SCOPE_VALUES = Object.keys(
  AUTH_ATTEMPT_SCOPES,
) as AuthAttemptScope[]

export function authScopesCheckConstraint(column = 'scope'): string {
  return `${column} IN (${AUTH_ATTEMPT_SCOPE_VALUES.map((s) => `'${s}'`).join(', ')})`
}
