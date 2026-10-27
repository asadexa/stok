import { type ParsedInventoryFile, parseInventoryFile } from '@stok/core/inventory-file'
import { type ParsedFile, parseProductFile } from '@stok/core/product-file'
import { AppError, type ErrorDetails } from '@stok/shared'

/**
 * ============================================================================
 * T171 — DOSYAYI TARAYICIDA ÇÖZÜMLEYEN İŞÇİ (Web Worker)
 *
 * Neden ayrı bir işçi: 20.000 satırlık bir Excel dosyasını çözümlemek
 * saniyeler sürüyor. Sayfanın kendi iş parçacığında olsaydı o süre boyunca
 * sayfa donar, tarayıcı "sayfa yanıt vermiyor" derdi (güvence 1).
 *
 * Bellek: dosyanın baytları işçide; görseller ve diğer parçalar hiç
 * açılmıyor, hücre verisi 64 MiB bütçeyle açılıyor (`sheet.ts`). İş bitince
 * sayfa işçiyi kapatıyor ve bellek geri veriliyor. Sayfaya yalnız hücre
 * metinleri dönüyor.
 *
 * Aynı işçi iki dosya türünü okuyor (T219): ürün kataloğu ve envanter
 * dosyası. Tür sayfadan geliyor; ikinci bir işçi dosyası aynı bellek ve
 * hata sözleşmesinin kopyası olurdu.
 *
 * Buradaki kontroller kullanıcıya erken haber vermek için. Güvenlik sınırı
 * değil: sunucu gelen her satırı yeniden sınırlıyor ve doğruluyor.
 * ============================================================================
 */

export type ParseKind = 'PRODUCT' | 'INVENTORY'

export interface ParseRequest {
  kind: ParseKind
  file: File
}

export type ParseResult =
  | { ok: true; kind: 'PRODUCT'; file: ParsedFile }
  | { ok: true; kind: 'INVENTORY'; file: ParsedInventoryFile }
  | { ok: false; code: string; details: ErrorDetails }

self.onmessage = async (event: MessageEvent<ParseRequest>) => {
  let result: ParseResult
  try {
    const { kind, file: upload } = event.data
    const data = new Uint8Array(await upload.arrayBuffer())
    result =
      kind === 'INVENTORY'
        ? { ok: true, kind, file: await parseInventoryFile(data, upload.name) }
        : { ok: true, kind: 'PRODUCT', file: await parseProductFile(data, upload.name) }
  } catch (err) {
    // AppError sınıfı iş parçacıkları arasında taşınmıyor; kod ve ayrıntı taşınıyor.
    result =
      err instanceof AppError
        ? { ok: false, code: err.code, details: err.details }
        : { ok: false, code: 'IMPORT_UNREADABLE', details: {} }
  }
  self.postMessage(result)
}
