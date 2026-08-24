import { config } from 'dotenv'
import { adminDbUnsafe } from './client.js'

/**
 * Veritabanındaki ürün sayısını tek satır olarak basar.
 *
 * Demo koşucusu (scripts/demo.mjs) buna bakıp örnek veriyi yeniden
 * yükleyip yüklemeyeceğine karar veriyor: seed MEVCUT VERİYİ SİLİYOR ve
 * bir saattir demo verisiyle oynayan kullanıcının kayıtlarını sessizce
 * sıfırlamak kabul edilemez.
 *
 * AYRI BİR DOSYA, `tsx -e "..."` DEĞİL. Çok satırlı ve tırnaklı bir kod
 * parçasını Windows kabuğundan geçirmek, tırnak kaçışlarının platforma
 * göre değiştiği bir alan; komut orada sessizce bozuluyor. Dosya olarak
 * çağrıldığında kabuk devrede olmuyor.
 *
 * `adminDbUnsafe` bilerek: RLS'i atlayan bağlantı. Soru "bu veritabanında
 * hiç ürün var mı", tek bir tenant'ın kaç ürünü olduğu değil.
 */

config({ path: '../../.env' })

const { client, db } = adminDbUnsafe()
try {
  const result = await db.execute('SELECT count(*)::int AS n FROM products')
  const [row] = [...result] as { n: number }[]
  console.log(row?.n ?? 0)
} finally {
  await client.end()
}
