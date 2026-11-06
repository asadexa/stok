import { currentStock, products } from '@stok/db'
import { type SQL, type SQLWrapper, sql } from 'drizzle-orm'

/**
 * Kritik stok ve "Stok yok" kuralı (T244, PRD-25). TEK KAYNAK, SQL yarısı.
 *
 * TS yarısı `@stok/shared` `isCriticalStock` / `isOutOfStock`; kuralın
 * gerekçesi orada. Stok listesi, Excel, zil, panel, kategori, gün sonu raporu
 * ve kritik stok e-postası bu iki fonksiyonu kullanıyor. Eskiden dokuz yerde
 * ayrı `COALESCE(qty, 0) <= min_stock` yazılıydı; birini değiştirip diğerini
 * unutmak zilin "3" derken listenin iki satır göstermesi demekti.
 *
 * Varsayılan argümanlar Drizzle sütunları. Ham SQL sorguları (`p`, `cs`
 * takma adlarıyla) kendi ifadelerini geçiyor: `sql\`cs.qty\``, `sql\`p.min_stock\``.
 * Stok satırı yoksa (hiç hareket yok) miktar 0 sayılıyor.
 */

export function outOfStockCondition(qty: SQLWrapper = currentStock.qty): SQL {
  return sql`(COALESCE(${qty}, 0) <= 0)`
}

export function criticalStockCondition(
  qty: SQLWrapper = currentStock.qty,
  minStock: SQLWrapper = products.minStock,
): SQL {
  return sql`(COALESCE(${qty}, 0) > 0 AND COALESCE(${qty}, 0) <= ${minStock})`
}
