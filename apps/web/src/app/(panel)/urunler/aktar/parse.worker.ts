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
 * Buradaki kontroller kullanıcıya erken haber vermek için. Güvenlik sınırı
 * değil: sunucu gelen her satırı yeniden sınırlıyor ve doğruluyor.
 * ============================================================================
 */

export type ParseResult =
  | { ok: true; file: ParsedFile }
  | { ok: false; code: string; details: ErrorDetails }

self.onmessage = async (event: MessageEvent<File>) => {
  let result: ParseResult
  try {
    const upload = event.data
    const file = await parseProductFile(new Uint8Array(await upload.arrayBuffer()), upload.name)
    result = { ok: true, file }
  } catch (err) {
    // AppError sınıfı iş parçacıkları arasında taşınmıyor; kod ve ayrıntı taşınıyor.
    result =
      err instanceof AppError
        ? { ok: false, code: err.code, details: err.details }
        : { ok: false, code: 'IMPORT_UNREADABLE', details: {} }
  }
  self.postMessage(result)
}
