/**
 * ============================================================================
 * TOPLU ÜRÜN AKTARIMI KAYDI SÖZLÜKLERİ (T171). TEK KAYNAK.
 *
 * Aktarım ve satır durumları hem kodda hem DB CHECK'inde (INV-9). DB
 * CHECK'leri buradan üretilir ve `schema-sync.test.ts` ikisini karşılaştırır:
 * listeye yeni bir durum eklenip migration üretilmezse aktarım 23514 ile
 * patlar, kullanıcı 500 görürdü.
 * ============================================================================
 */

/**
 * Aktarımın yaşam döngüsü:
 *
 *   UPLOADING  satırlar tarayıcıdan parça parça geliyor
 *   PREVIEWED  önizleme hesaplandı; ürün ve stok verisi DEĞİŞMEDİ
 *   RUNNING    kullanıcı onayladı, satırlar işleniyor
 *   DONE       bütün satırlar işlendi
 *   CANCELLED  kullanıcı iptal etti; işlenen satırlar korunur, kalanlar işlenmez
 *
 * Duraklat/devam yok (ürün kapsamı dışı); sekme kapanırsa aktarım RUNNING
 * kalır ve 30 günlük temizlikle silinir.
 */
export const IMPORT_RUN_STATUSES = {
  UPLOADING: { tr: 'Yükleniyor' },
  PREVIEWED: { tr: 'Önizlendi' },
  RUNNING: { tr: 'Aktarılıyor' },
  DONE: { tr: 'Tamamlandı' },
  CANCELLED: { tr: 'İptal edildi' },
} as const

export type ImportRunStatus = keyof typeof IMPORT_RUN_STATUSES
export const IMPORT_RUN_STATUS_VALUES = Object.keys(IMPORT_RUN_STATUSES) as ImportRunStatus[]

/**
 * Satırın sonucu.
 *
 *   PENDING      henüz işlenmedi (iptalden sonra: "işlenmedi")
 *   IN_PROGRESS  bir parça işleyici bu satırı aldı; sonucu henüz yazılmadı
 *   DONE         ürün yazıldı (eklendi ya da güncellendi)
 *   INVALID      önizlemede hatalı; hiç denenmedi
 *   FAILED       yazımda hata (barkod başka ürünün, şema)
 *   CONFLICT     önizlemeden sonra başka biri değiştirdi; dosyadaki değer YAZILMADI
 *   UNCERTAIN    kesinti: ürünün yazılıp yazılmadığı doğrulanamadı
 *
 * UNCERTAIN ayrı çünkü kesintide "başarılı" ya da "başarısız" demek ikisi de
 * yanlış olabilir; kullanıcı ürünü kontrol etmeli (T171, güvence 5).
 */
export const IMPORT_ROW_STATUSES = {
  PENDING: { tr: 'İşlenmedi' },
  IN_PROGRESS: { tr: 'İşleniyor' },
  DONE: { tr: 'Aktarıldı' },
  INVALID: { tr: 'Hatalı' },
  FAILED: { tr: 'Yazılamadı' },
  CONFLICT: { tr: 'Çakışma' },
  UNCERTAIN: { tr: 'Belirsiz' },
} as const

export type ImportRowStatus = keyof typeof IMPORT_ROW_STATUSES
export const IMPORT_ROW_STATUS_VALUES = Object.keys(IMPORT_ROW_STATUSES) as ImportRowStatus[]

/** Önizlemenin satır kararı. */
export const IMPORT_ROW_ACTIONS = {
  create: { tr: 'Yeni ürün' },
  update: { tr: 'Güncelleme' },
  error: { tr: 'Hatalı' },
} as const

export type ImportRowAction = keyof typeof IMPORT_ROW_ACTIONS
export const IMPORT_ROW_ACTION_VALUES = Object.keys(IMPORT_ROW_ACTIONS) as ImportRowAction[]

/** Açılış stoğunun (T128) sonucu; ürün sonucundan ayrı, ürün yazılıp devir atlanabiliyor. */
export const IMPORT_OPENING_OUTCOMES = {
  WRITTEN: { tr: 'Yazıldı' },
  SKIPPED: { tr: 'Atlandı' },
  FAILED: { tr: 'Yazılamadı' },
} as const

export type ImportOpeningOutcome = keyof typeof IMPORT_OPENING_OUTCOMES
export const IMPORT_OPENING_OUTCOME_VALUES = Object.keys(
  IMPORT_OPENING_OUTCOMES,
) as ImportOpeningOutcome[]

function inList(column: string, values: readonly string[]): string {
  return `${column} IN (${values.map((v) => `'${v}'`).join(', ')})`
}

export function importRunStatusCheckConstraint(column = 'status'): string {
  return inList(column, IMPORT_RUN_STATUS_VALUES)
}

export function importRowStatusCheckConstraint(column = 'status'): string {
  return inList(column, IMPORT_ROW_STATUS_VALUES)
}

export function importRowActionCheckConstraint(column = 'action'): string {
  return inList(column, IMPORT_ROW_ACTION_VALUES)
}

export function importOpeningOutcomeCheckConstraint(column = 'opening_outcome'): string {
  return `(${column} IS NULL OR ${inList(column, IMPORT_OPENING_OUTCOME_VALUES)})`
}
