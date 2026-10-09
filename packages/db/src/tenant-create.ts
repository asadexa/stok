import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { AppError, errorText } from '@stok/shared'
import { config } from 'dotenv'
import { count } from 'drizzle-orm'
import { adminDbUnsafe } from './client'
import { provisionTenant } from './provision'
import { tenants } from './schema'
import { canBypassRls, describeTarget, formatTarget } from './target'

/**
 * Yeni işletme ve ilk yönetici (T162). Kullanım: `pnpm tenant:create`.
 *
 * Hiçbir değeri argümandan almıyor: ad ve e-posta soruluyor, parola
 * üretiliyor (bkz. provision.ts). Yalnız ekleme yaptığı için uzak hedefi
 * yasaklamıyor; ama önce hedefi ve içindeki kiracı sayısını gösteriyor ve
 * "evet" yazılmadan tek satır yazmıyor. Yanlış kabuktaki yanlış adres en sık
 * hata (T125'in aynısı), ilk görülmesi gereken şey o.
 */

config({ path: '../../.env' })

async function main(): Promise<number> {
  const url = process.env.MIGRATION_DATABASE_URL
  if (!url) {
    console.error('✗ MIGRATION_DATABASE_URL tanımlı değil (kök dizindeki .env).')
    return 1
  }
  const target = describeTarget(url)
  const { client, db } = adminDbUnsafe()
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  try {
    // RLS'e tabi bir rol kiracıları göremez; "0" yazmak yanıltırdı.
    const tenantCount = (await canBypassRls(db))
      ? String((await db.select({ n: count() }).from(tenants))[0]?.n ?? 0)
      : 'görülemiyor (rol RLS’e tabi)'

    console.log('\nYeni işletme ve ilk yönetici\n')
    console.log(`  Hedef          : ${formatTarget(target)}`)
    console.log(`  Mevcut kiracı  : ${tenantCount}\n`)

    const tenantName = await rl.question('İşletme adı          : ')
    const adminName = await rl.question('Yönetici adı soyadı  : ')
    const adminEmail = await rl.question('Yönetici e-postası   : ')

    const answer = await rl.question(
      `\n${formatTarget(target)} veritabanına yazılsın mı? Onay için "evet" yazın: `,
    )
    if (answer.trim().toLocaleLowerCase('tr') !== 'evet') {
      console.log('İptal edildi; hiçbir şey yazılmadı.')
      return 1
    }

    const created = await provisionTenant(db, { tenantName, adminName, adminEmail })
    console.log('\n✓ İşletme ve ilk yönetici oluşturuldu.\n')
    console.log(`  İşletme        : ${created.tenantName} (${created.tenantId})`)
    console.log(`  E-posta        : ${created.adminEmail}`)
    console.log(`  Geçici parola  : ${created.initialPassword}`)
    console.log('\n  Parola YALNIZ BU KEZ gösteriliyor ve hiçbir yere kaydedilmedi.')
    console.log('  Yöneticiye güvenli bir yoldan iletin; ilk girişten sonra Ayarlar → Parola')
    console.log('  bölümünden değiştirsin.')
    if (process.env.APP_URL) {
      console.log(`  Giriş          : ${new URL('/giris', process.env.APP_URL).toString()}`)
    }
    return 0
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`\n✗ ${errorText(err.code, err.details)}\n  Hiçbir şey yazılmadı.`)
      return 1
    }
    throw err
  } finally {
    rl.close()
    await client.end()
  }
}

process.exitCode = await main()
