import { createHash } from 'node:crypto'

/**
 * RFC 9562 UUID sürüm 5: ad alanı (namespace) UUID'si + ad → SHA-1 → 128 bit,
 * sürüm bitleri 0101, varyant bitleri 10.
 *
 * NEDEN: toplu açılış stoğunun idempotency anahtarı aynı ürün için her zaman
 * aynı olmalı (T128). Rastgele UUID olsaydı içe aktarma her tekrar
 * çalıştırıldığında devri bir kez daha yazardı. Yeni bağımlılık yerine
 * `node:crypto`: algoritma on satır ve standart test vektörüyle sınanıyor.
 */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  if (ns.length !== 16) throw new Error(`namespace bir UUID değil: ${namespace}`)

  const bytes = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
