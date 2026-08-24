import { createHash } from 'node:crypto'
import { config } from 'dotenv'
import { sql } from 'drizzle-orm'
import type { MovementReason } from '@stok/shared'
import { toDelta } from '@stok/shared'
import { adminDbUnsafe } from './client.js'
import { hashSecret } from './password.js'
import {
  locations,
  productBarcodes,
  products,
  stockMovements,
  tenants,
  users,
} from './schema.js'

config({ path: '../../.env' })

/**
 * ============================================================================
 * SEED (T8)
 *
 * İKİ TENANT oluşturuyor. Tek tenant'la tenant izolasyonu TEST EDİLEMEZ:
 * her sorgu doğru görünür çünkü sızacak başka veri yoktur. İkinci tenant,
 * T46 çapraz tenant testlerinin var olma sebebi.
 *
 * Tamamen deterministik: Math.random yok, tohumlu bir üreteç var. Aynı
 * komut aynı veriyi üretir, böylece "bende çalışıyordu" tartışması olmaz.
 *
 * Ürün adları bilerek Türkçe karakterli: tr_norm() ve GIN trgm index'i
 * gerçek veriyle sınansın (ısıtıcı/Isıtıcı, şerit/ŞERİT, çakı/ÇAKI).
 *
 * RLS ATLANIYOR: seed sahip rolüyle (MIGRATION_DATABASE_URL) bağlanır.
 * Bu bilinçli; seed provisioning işidir, uygulama yolu değildir.
 * ============================================================================
 */

// --- deterministik üreteç (mulberry32) -------------------------------------
function makeRng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Tohumdan türetilmiş, kararlı UUID. Aynı girdi hep aynı kimliği verir. */
function detUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex')
  const v4 = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${
    ((parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20)
  }-${h.slice(20, 32)}`
  return v4
}

const rng = makeRng(20260822)
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!
const randInt = (min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min

// --- ürün adı parçaları (Türkçe karakter yoğun, bilerek) --------------------
const KIRTASIYE = {
  kinds: [
    'Defter', 'Kalem', 'Silgi', 'Cetvel', 'Zımba', 'Dosya', 'Klasör', 'Makas',
    'Yapıştırıcı', 'Şerit Bant', 'Post-it', 'Kalemtıraş', 'Fosforlu Kalem',
    'Hesap Makinesi', 'Delgeç', 'Ataç', 'Karton', 'Zarf',
  ],
  adjectives: [
    'Kırmızı', 'Mavi', 'Siyah', 'Yeşil', 'Sarı', 'Beyaz', 'Şeffaf', 'Çizgili',
    'Kareli', 'Büyük', 'Küçük', 'Orta Boy', 'Spiralli', 'Sert Kapak',
  ],
  brands: ['Faber-Castell', 'Bic', 'Stabilo', 'Mas', 'Gıpta', 'Keskin Color', 'Adel'],
  categories: ['Kağıt Ürünleri', 'Yazı Gereçleri', 'Ofis Malzemeleri', 'Dosyalama'],
}

const HIRDAVAT = {
  kinds: [
    'Tornavida', 'Pense', 'Çekiç', 'İngiliz Anahtarı', 'Matkap Ucu', 'Vida',
    'Somun', 'Şerit Metre', 'Testere', 'Çakı', 'Isıtıcı Tabanca', 'Eldiven',
  ],
  adjectives: ['Yıldız', 'Düz', 'Paslanmaz', 'Krom', 'Ağır Hizmet', 'Katlanır', 'Uzun Saplı'],
  brands: ['Bosch', 'Makita', 'İzeltaş', 'Ceta Form', 'Stanley'],
  categories: ['El Aletleri', 'Bağlantı Elemanları', 'Ölçüm', 'İş Güvenliği'],
}

const IN_REASONS: MovementReason[] = ['PURCHASE', 'RETURN_IN', 'OTHER_IN']
const OUT_REASONS: MovementReason[] = ['SALE', 'SALE', 'SALE', 'DAMAGE', 'USAGE', 'RETURN_OUT']

interface TenantSpec {
  key: string
  name: string
  vocab: typeof KIRTASIYE
  productCount: number
  movementsPerProduct: [number, number]
  staff: { name: string; email: string }[]
}

const TENANT_SPECS: TenantSpec[] = [
  {
    key: 'yilmaz',
    name: 'Yılmaz Kırtasiye Deposu',
    vocab: KIRTASIYE,
    productCount: 200,
    movementsPerProduct: [8, 32],
    staff: [
      { name: 'Ahmet Şahin', email: 'ahmet@yilmazkirtasiye.example' },
      { name: 'Mehmet Öztürk', email: 'mehmet@yilmazkirtasiye.example' },
    ],
  },
  {
    key: 'demir',
    name: 'Demir Hırdavat',
    vocab: HIRDAVAT,
    productCount: 40,
    movementsPerProduct: [4, 14],
    staff: [{ name: 'Fatma Kaya', email: 'fatma@demirhirdavat.example' }],
  },
]

const DAY = 24 * 60 * 60 * 1000

async function main() {
  const { client, db } = adminDbUnsafe()
  const startedAt = Date.now()

  try {
    console.log('Seed baslıyor. Mevcut veri siliniyor...')
    // Sıra önemli: FK bağımlılıkları. TRUNCATE CASCADE trigger'ları atlamaz
    // ama DELETE trigger'ı stock_movements'ta exception fırlatır, bu yüzden
    // TRUNCATE kullanıyoruz (trigger DELETE için, TRUNCATE için değil).
    await db.execute(sql`
      TRUNCATE TABLE
        current_stock, stock_movements, product_barcodes,
        products, locations, users, tenants
      RESTART IDENTITY CASCADE
    `)

    const adminPin = await hashSecret('1234')
    const staffPin = await hashSecret('1111')
    const adminPass = await hashSecret('admin123')
    // Çalışanlara da parola veriliyor: demo ve kullanıcı testi İKİ ROLLÜ
    // yapılıyor ve parolasız bir çalışan web'e hiç giremez. Üretimde
    // parolayı yönetici belirliyor (T24); bu sadece seed verisi.
    const staffPass = await hashSecret('calisan123')

    let totalProducts = 0
    let totalMovements = 0

    for (const spec of TENANT_SPECS) {
      const tenantId = detUuid(`tenant:${spec.key}`)
      await db.insert(tenants).values({ id: tenantId, name: spec.name })

      // --- kullanıcılar ---
      const adminId = detUuid(`user:${spec.key}:admin`)
      await db.insert(users).values({
        id: adminId,
        tenantId,
        email: `admin@${spec.key}.example`,
        name: `${spec.name} Yöneticisi`,
        role: 'ADMIN',
        passwordHash: adminPass,
        pinHash: adminPin,
      })

      const staffIds: string[] = []
      for (const s of spec.staff) {
        const id = detUuid(`user:${spec.key}:${s.email}`)
        staffIds.push(id)
        await db.insert(users).values({
          id,
          tenantId,
          email: s.email,
          name: s.name,
          role: 'STAFF',
          passwordHash: staffPass,
          pinHash: staffPin,
        })
      }
      const actors = [adminId, ...staffIds]

      // --- konumlar ---
      const locationIds: string[] = []
      for (const code of ['A-01', 'A-02', 'B-01', 'B-02', 'C-01']) {
        const id = detUuid(`loc:${spec.key}:${code}`)
        locationIds.push(id)
        await db.insert(locations).values({ id, tenantId, code, name: `${code} Rafı` })
      }

      // --- ürünler + barkodlar ---
      const productRows: (typeof products.$inferInsert)[] = []
      const barcodeRows: (typeof productBarcodes.$inferInsert)[] = []
      const unitBarcodeByProduct = new Map<string, string>()
      const caseBarcodeByProduct = new Map<string, { id: string; mult: number }>()
      const seenNames = new Set<string>()

      for (let i = 0; i < spec.productCount; i++) {
        const productId = detUuid(`product:${spec.key}:${i}`)
        let name = `${pick(spec.vocab.adjectives)} ${pick(spec.vocab.kinds)}`
        // Aynı ad tekrarlarsa ayırt et; sku zaten unique ama ad da okunur olsun.
        if (seenNames.has(name)) name = `${name} ${i}`
        seenNames.add(name)

        const purchase = randInt(5, 400) + randInt(0, 99) / 100
        productRows.push({
          id: productId,
          tenantId,
          sku: `${spec.key.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(4, '0')}`,
          name,
          category: pick(spec.vocab.categories),
          brand: pick(spec.vocab.brands),
          unit: 'ADET',
          purchasePrice: purchase.toFixed(2),
          salePrice: (purchase * (1.25 + rng() * 0.5)).toFixed(2),
          // Ürünlerin bir kısmı kritik seviyeye düşsün diye eşik yüksek tutuluyor.
          minStock: String(randInt(5, 40)),
          locationId: pick(locationIds),
        })

        const unitBarcodeId = detUuid(`bc:${spec.key}:${i}:unit`)
        const unitBarcode = `869${String(1000000 + i).padStart(7, '0')}${spec.key === 'demir' ? '1' : '0'}`
        unitBarcodeByProduct.set(productId, unitBarcodeId)
        barcodeRows.push({
          id: unitBarcodeId,
          tenantId,
          productId,
          barcode: unitBarcode,
          kind: 'UNIT',
          qtyMultiplier: '1',
        })

        // Ürünlerin yaklaşık üçte birinde koli barkodu da olsun (D7).
        if (rng() < 0.33) {
          const mult = pick([6, 10, 12, 24, 48])
          const caseId = detUuid(`bc:${spec.key}:${i}:case`)
          caseBarcodeByProduct.set(productId, { id: caseId, mult })
          barcodeRows.push({
            id: caseId,
            tenantId,
            productId,
            barcode: `${unitBarcode}K`,
            kind: 'CASE',
            qtyMultiplier: String(mult),
          })
        }
      }

      await db.insert(products).values(productRows)
      await db.insert(productBarcodes).values(barcodeRows)
      totalProducts += productRows.length

      // --- hareketler ---
      // Her ürün bir açılış devriyle başlar, sonra gerçekçi giriş/çıkış.
      // Çalışan stoğu hiç negatife düşürmez: gerçek depoda da düşmez.
      const movementRows: (typeof stockMovements.$inferInsert)[] = []
      let seq = 0

      for (const p of productRows) {
        const productId = p.id as string
        let running = randInt(20, 500)
        const openingAt = new Date(Date.now() - 90 * DAY + randInt(0, 2) * DAY)

        movementRows.push({
          id: detUuid(`mv:${spec.key}:${seq}`),
          tenantId,
          productId,
          userId: adminId,
          barcodeId: unitBarcodeByProduct.get(productId),
          delta: String(running),
          reason: 'OPENING',
          idempotencyKey: `seed:${spec.key}:${seq}`,
          createdAt: openingAt,
          clientCreatedAt: openingAt,
          locationId: p.locationId,
          unitCost: p.purchasePrice as string,
        })
        seq++

        const count = randInt(spec.movementsPerProduct[0], spec.movementsPerProduct[1])
        for (let m = 0; m < count; m++) {
          const isIn = rng() < 0.35
          const at = new Date(Date.now() - randInt(0, 88) * DAY - randInt(0, 86_400_000))

          let reason: MovementReason
          let qty: number
          let barcodeId = unitBarcodeByProduct.get(productId)

          if (isIn) {
            reason = pick(IN_REASONS)
            const caseBc = caseBarcodeByProduct.get(productId)
            // Girişlerin bir kısmı koli barkoduyla: çarpan gerçek veriyle sınansın.
            if (caseBc && rng() < 0.4) {
              const cases = randInt(1, 8)
              qty = cases * caseBc.mult
              barcodeId = caseBc.id
            } else {
              qty = randInt(5, 120)
            }
          } else {
            reason = pick(OUT_REASONS)
            if (running <= 1) continue // stok yok, çıkış olmaz
            qty = Math.min(randInt(1, 15), running)
          }

          running += toDelta(qty, reason)
          movementRows.push({
            id: detUuid(`mv:${spec.key}:${seq}`),
            tenantId,
            productId,
            userId: pick(actors),
            barcodeId,
            delta: String(toDelta(qty, reason)),
            reason,
            idempotencyKey: `seed:${spec.key}:${seq}`,
            createdAt: at,
            clientCreatedAt: at,
            locationId: p.locationId,
            unitCost: reason === 'PURCHASE' ? (p.purchasePrice as string) : null,
          })
          seq++
        }
      }

      // Toplu insert; trigger her satır için projeksiyonu günceller.
      const CHUNK = 500
      for (let i = 0; i < movementRows.length; i += CHUNK) {
        await db.insert(stockMovements).values(movementRows.slice(i, i + CHUNK))
      }
      totalMovements += movementRows.length

      console.log(
        `  ${spec.name}: ${productRows.length} ürün, ${barcodeRows.length} barkod, ${movementRows.length} hareket`,
      )
    }

    // --- INVARIANT DOĞRULAMASI ---------------------------------------------
    // Seed'in kendisi de bir testtir: projeksiyon trigger'ı 5000+ satırda
    // gerçekten doğru çalıştı mı? Bu kontrol geçmezse seed başarısız sayılır.
    const drift = await db.execute<{ cnt: string }>(sql`
      SELECT count(*) AS cnt FROM (
        SELECT m.tenant_id, m.product_id, SUM(m.delta) AS ledger, cs.qty AS projection
          FROM stock_movements m
          JOIN current_stock cs
            ON cs.tenant_id = m.tenant_id AND cs.product_id = m.product_id
         GROUP BY m.tenant_id, m.product_id, cs.qty
        HAVING SUM(m.delta) <> cs.qty
      ) d
    `)
    const driftCount = Number(drift[0]?.cnt ?? 0)

    const totals = await db.execute<{ tenant: string; products: string; qty: string }>(sql`
      SELECT t.name AS tenant,
             count(DISTINCT cs.product_id)::text AS products,
             COALESCE(SUM(cs.qty), 0)::text AS qty
        FROM tenants t
        LEFT JOIN current_stock cs ON cs.tenant_id = t.id
       GROUP BY t.name ORDER BY t.name
    `)

    const critical = await db.execute<{ cnt: string }>(sql`
      SELECT count(*)::text AS cnt
        FROM current_stock cs
        JOIN products p ON p.id = cs.product_id
       WHERE cs.qty < p.min_stock
    `)

    console.log('')
    console.log(`Toplam: ${totalProducts} ürün, ${totalMovements} hareket`)
    for (const r of totals) {
      console.log(`  ${r.tenant}: ${r.products} ürün, toplam ${r.qty} adet stok`)
    }
    console.log(`Kritik seviyedeki ürün: ${critical[0]?.cnt ?? '?'}`)
    console.log('')

    if (driftCount > 0) {
      console.error(`INVARIANT BOZUK: ${driftCount} üründe ledger != projeksiyon`)
      process.exitCode = 1
    } else {
      console.log('INVARIANT OK: SUM(movements.delta) == current_stock.qty, tüm ürünlerde')
    }
    console.log(`Süre: ${((Date.now() - startedAt) / 1000).toFixed(1)} sn`)
    console.log('')
    console.log('GİRİŞ BİLGİLERİ')
    console.log('  Yönetici : admin@yilmaz.example        / admin123')
    console.log('  Çalışan  : ahmet@yilmazkirtasiye.example / calisan123')
    console.log('  İkinci işletme (izolasyon denemesi için):')
    console.log('             admin@demir.example          / admin123')
    console.log('  PIN (mobil, E10): yönetici 1234, çalışan 1111')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
