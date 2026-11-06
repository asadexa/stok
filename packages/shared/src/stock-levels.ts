/**
 * Kritik stok ve "Stok yok" kuralı (T244, PRD-25). TEK KAYNAK, TS yarısı.
 *
 * SQL yarısı `packages/core/src/stock-rules.ts` içinde ve AYNI kuralı
 * yazıyor; `stock-rules.test.ts` ikisini aynı örnek tablosuyla sınıyor.
 * Kural ayrı yerlerde yazılsaydı rozet "Kritik" derken zil saymayabilirdi.
 *
 * - Stok yok: stok ≤ 0 (eksi stok dahil). Eşikten bağımsız.
 * - Kritik: stok > 0 ve stok ≤ eşik.
 *
 * Stoğu biten ürün kritik SAYILMIYOR: eskiden `stok ≤ eşik` idi ve eşiği 0
 * olan her tükenmiş ürün zili, paneli ve kritik stok e-postasını dolduruyordu.
 * Bitmiş ürün "azaldı" değil "yok"; ayrı bir bölümde gösteriliyor. Eşik 0 ise
 * stoğu olan ürün hiçbir zaman kritik olmaz: 0 "takip yok" demek.
 */

export function isOutOfStock(qty: number): boolean {
  return qty <= 0
}

export function isCriticalStock(qty: number, minStock: number): boolean {
  return qty > 0 && qty <= minStock
}
