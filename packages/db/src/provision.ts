import { randomBytes, randomUUID } from 'node:crypto'
import { AppError, createUserSchema } from '@stok/shared'
import { sql } from 'drizzle-orm'
import { type Db, withTenant } from './client'
import { hashSecret } from './password'
import { tenants, users } from './schema'

/**
 * ============================================================================
 * T162 — KİRACI VE İLK YÖNETİCİ AÇMA
 *
 * Bugüne kadar tek yol seed'di (her şeyi siler) ya da elle SQL + scrypt
 * özeti. Uygulama `tenants`'a yazamıyor (SEC-03); bu bir provisioning
 * işlevi: sahip rolüyle, operatörün makinesinden çağrılıyor
 * (`tenant-create.ts`).
 *
 * TEK TRANSACTION. Kiracı ile yöneticisi ayrı yazılsaydı, yönetici yazımı
 * patladığında yöneticisiz bir kiracı kalırdı: kimse giremez, `cron_tenants()`
 * onu hiç döndürmez (T139), temizlemek de elle iş.
 *
 * withTenant İLE. Tablolar FORCE RLS; sahip rolü RLS'i atlamıyorsa
 * politikalar kiracı bağlamı istiyor. Bağlamı yeni kiracıya kurmak, işlemi
 * rolün RLS'i atlayıp atlamamasından bağımsız kılıyor.
 *
 * E-POSTA BAŞKA KİRACIDA VARSA RED, kalıcı karar (SEC-14) verilene kadar:
 * aynı e-posta iki kiracıda olunca web girişi TENANT_AMBIGUOUS çıkmazına
 * düşüyor (T123). Kontrol `auth_lookup_user` ile, çünkü RLS altında diğer
 * kiracıların kullanıcıları görünmüyor; girişin eşleştirdiği fonksiyon da o.
 * Kontrol ile yazma arasındaki yarışı advisory lock kapatıyor: aynı e-postayla
 * eşzamanlı ikinci çağrı bekliyor ve birincinin kullanıcısını görüyor.
 * Uygulamadaki `createUser` bu kilidi almıyor; o yol SEC-14'ün konusu.
 *
 * PAROLA ÜRETİLİYOR, ALINMIYOR. Argüman ya da ortam değişkeni kabuk
 * geçmişine düşerdi; gizli giriş istemi Git Bash'te TTY olmadığı için
 * çalışmayabiliyor. Parola yalnız dönüş değerinde, hiçbir yere yazılmıyor.
 * ============================================================================
 */

/** Advisory lock isim alanı: aynı e-postayla kiracı açmaları sıraya girer. */
export const PROVISION_LOCK_NAMESPACE = 162

export interface ProvisionInput {
  tenantName: string
  adminName: string
  adminEmail: string
}

export interface ProvisionedTenant {
  tenantId: string
  tenantName: string
  adminUserId: string
  adminEmail: string
  /** Bir kez gösterilmek için. Saklanmıyor, loglanmıyor. */
  initialPassword: string
}

export async function provisionTenant(db: Db, input: ProvisionInput): Promise<ProvisionedTenant> {
  const tenantName = input.tenantName.trim()
  if (tenantName.length < 2 || tenantName.length > 200) {
    throw invalid('tenantName', 'İşletme adı 2–200 karakter olmalı')
  }

  // 18 bayt = 144 bit; base64url ile 24 karakter.
  const initialPassword = randomBytes(18).toString('base64url')
  const parsed = createUserSchema.safeParse({
    email: input.adminEmail,
    name: input.adminName,
    role: 'ADMIN',
    password: initialPassword,
  })
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    throw new AppError(
      'VALIDATION_FAILED',
      issues.map((i) => `${i.path}: ${i.message}`).join('; '),
      { issues },
    )
  }
  const { email, name } = parsed.data
  const passwordHash = await hashSecret(initialPassword)
  const tenantId = randomUUID()

  const adminUserId = await withTenant(
    tenantId,
    async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${PROVISION_LOCK_NAMESPACE}, hashtext(${email}))`,
      )
      const existing = await tx.execute(sql`SELECT tenant_id FROM auth_lookup_user(${email})`)
      if ([...existing].length > 0) {
        throw new AppError('EMAIL_IN_OTHER_TENANT', `email ${email} belongs to another tenant`, {
          email,
        })
      }

      await tx.insert(tenants).values({ id: tenantId, name: tenantName })
      const [row] = await tx
        .insert(users)
        .values({ tenantId, email, name, role: 'ADMIN', passwordHash })
        .returning({ id: users.id })
      if (!row) throw new AppError('SERVER_ERROR', 'admin insert returned no row')
      return row.id
    },
    db,
  )

  return { tenantId, tenantName, adminUserId, adminEmail: email, initialPassword }
}

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', `${path}: ${message}`, { issues: [{ path, message }] })
}
