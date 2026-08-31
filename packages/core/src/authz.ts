import {
  AppError,
  type MovementReason,
  type Permission,
  type Role,
  can,
  reasonPriceBasis,
  roleLabel,
} from '@stok/shared'

/**
 * ============================================================================
 * YETKİLENDİRME — ROL MATRİSİNİN SUNUCU TARAFI ZORLAMASI (T13)
 *
 * PLAN.md Bölüm 4'teki matris `packages/shared/src/roles.ts` içinde veri
 * olarak duruyor. Bu dosya o veriyi ZORLAYAN tek boğaz.
 *
 *   ┌──────────────┐
 *   │ route / servis│
 *   └──────┬────────┘
 *          │ requirePermission(actor, 'product:create')
 *          ▼
 *   ┌───────────────────────────┐
 *   │ ROLE_PERMISSIONS matrisi  │ ← tek kaynak
 *   └───────────────────────────┘
 *          │ izin yoksa
 *          ▼
 *       AppError('FORBIDDEN', 403)
 *
 * KRİTİK (tehdit S6): arayüzde butonu gizlemek yetki kontrolü DEĞİLDİR.
 * Kullanıcı API'ye doğrudan istek atabilir; mobil uygulamanın APK'sı
 * herkesin elinde ve içindeki her endpoint görünür. Kontrol burada,
 * sunucuda olmak zorunda.
 *
 * İKİ AYRI KONTROL VAR ve karıştırmak sessiz sızıntı üretir:
 *
 *   requirePermission  →  "bu işlemi YAPABİLİR Mİ"   (403 ile reddet)
 *   redactPrices       →  "bu ALANI GÖREBİLİR Mİ"    (sessizce çıkar)
 *
 * İkincisi neden reddetmiyor: çalışanın ürün listesi görmesi meşru, sadece
 * alış fiyatını görmemesi gerekiyor (tehdit S7). İsteği reddetseydik
 * çalışan ürün arayamazdı.
 * ============================================================================
 */

/**
 * İsteği yapan kimlik. Token'dan çözülür, İSTEMCİDEN GELMEZ.
 *
 * `tenantId` de burada: istemcinin gönderdiği tenant kimliğine güvenmek,
 * tenant izolasyonunu istemciye emanet etmek olurdu.
 */
export interface Actor {
  tenantId: string
  userId: string
  role: Role
}

/**
 * Yetki yoksa 403 fırlatır. Her yazma yolunun ilk satırı bu olmalı.
 *
 * `details.permission` dolu dönüyor ki hata ayıklarken "hangi yetki
 * eksikti" sorusu log'dan cevaplanabilsin; kullanıcıya gösterilen metin
 * sabit ve genel ("Bu işlem için yetkiniz yok").
 */
export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor.role, permission)) {
    throw new AppError(
      'FORBIDDEN',
      `role ${actor.role} lacks permission ${permission}`,
      { permission, role: actor.role, roleLabel: roleLabel(actor.role) },
    )
  }
}

/** Fırlatmayan biçim: arayüze "bu butonu göster" bilgisi vermek için. */
export function actorCan(actor: Actor, permission: Permission): boolean {
  return can(actor.role, permission)
}

// ---------------------------------------------------------------------------
// TİCARİ BİLGİ GİZLEME (tehdit S7)
// ---------------------------------------------------------------------------

/**
 * Alış fiyatı ve maliyet ticari bilgidir; çalışan API cevabında bunları
 * GÖRMEMELİ. Arayüzde gizlemek yetmez: cevabın içinde giderse tarayıcı
 * ağ sekmesinde, mobilde de proxy'de görünür.
 */
export const PRICE_FIELDS = ['purchasePrice', 'salePrice', 'unitPrice'] as const

export type PriceField = (typeof PRICE_FIELDS)[number]

export function canSeePrices(role: Role): boolean {
  return can(role, 'price:read')
}

/**
 * Fiyat alanlarını cevaptan ÇIKARIR (null'a çevirmez, siler).
 *
 * `null` bırakmak yanlış olurdu: arayüz "fiyat girilmemiş" ile "fiyatı
 * görmeye yetkin yok" durumlarını ayırt edemez, kullanıcıya yanlış bilgi
 * gösterir. Alan yoksa arayüz sütunu hiç çizmez.
 */
export function redactPrices<T extends object>(actor: Actor, row: T): Omit<T, PriceField> {
  if (canSeePrices(actor.role)) return row
  const copy = { ...row } as Record<string, unknown>
  for (const field of PRICE_FIELDS) delete copy[field]
  return copy as Omit<T, PriceField>
}

export function redactPricesAll<T extends object>(actor: Actor, rows: T[]): Omit<T, PriceField>[] {
  if (canSeePrices(actor.role)) return rows
  return rows.map((r) => redactPrices(actor, r))
}

/**
 * ---------------------------------------------------------------------------
 * HAREKET SATIRINDA FİYAT: KURAL SATIR BAZINDA (T88, D7)
 * ---------------------------------------------------------------------------
 *
 * `unit_price` artık iki farklı şey tutuyor: girişte ALIŞ, çıkışta SATIŞ.
 * Sütunu topluca silmek bu yüzden yanlış cevap verir.
 *
 *   satış fiyatı  → ticari sır DEĞİL. Müşteri zaten biliyor, fiyatı
 *                   çalışanın kendisi söyledi. Gizlemek, çalışanın kendi
 *                   yazdığı satırı okuyamaması demek olurdu.
 *   alış fiyatı   → ticari sır (tehdit S7). `OPENING` de dahil: devir bir
 *                   alış değerlemesidir.
 *
 * Ayrım `reason === 'SALE'` ile değil `reasonPriceBasis(reason) === 'SALE'`
 * ile yapılıyor. İkisi satışta aynı sonucu veriyor ama müşteri iadesinde
 * (`RETURN_IN`) ayrışıyor: iade edilen tutar da satış fiyatıdır, müşteri
 * onu da biliyor. Sebebe bakan bir liste burada ikinci bir yerde
 * güncellenmeyi beklerdi; `priceBasis` tek kaynak (`reasons.ts`).
 *
 * ALAN SİLİNİYOR, null'a ÇEVRİLMİYOR — `redactPrices` ile aynı gerekçe:
 * `null` "fiyat girilmemiş" demek, yokluk ise "göremezsin". Ekran ikisini
 * ayırt edebilmeli.
 */
export const MOVEMENT_PRICE_FIELDS = [
  'unitPrice',
  'listPrice',
  'clientListPrice',
  'priceOverrideReason',
] as const

export type MovementPriceField = (typeof MOVEMENT_PRICE_FIELDS)[number]

/** Satırın fiyatı yetkisiz role de açık mı: yalnızca satış dayanaklı olanlar. */
export function movementPriceIsPublic(reason: string): boolean {
  return reasonPriceBasis(reason as MovementReason) === 'SALE'
}

/**
 * Dönüş tipi UNION: alanın varlığı artık satıra bağlı, `Omit` yalan olurdu.
 * Çağıran `'unitPrice' in row` ile ayırt ediyor — tam da istenen davranış.
 */
export function redactMovementPricesAll<T extends { reason: string }>(
  actor: Actor,
  rows: T[],
): (T | Omit<T, MovementPriceField>)[] {
  if (canSeePrices(actor.role)) return rows
  return rows.map((row) => {
    if (movementPriceIsPublic(row.reason)) return row
    const copy = { ...row } as Record<string, unknown>
    for (const field of MOVEMENT_PRICE_FIELDS) delete copy[field]
    return copy as Omit<T, MovementPriceField>
  })
}

// ---------------------------------------------------------------------------
// HAREKET GEÇMİŞİ KAPSAMI
// ---------------------------------------------------------------------------

/**
 * Rol matrisi: "Hareket geçmişi (tüm kullanıcılar) → admin ✓, çalışan
 * sadece kendi".
 *
 * `undefined` = kısıt yok (admin). Dolu = sorgu SADECE bu kullanıcının
 * hareketlerini döndürmeli.
 *
 * İstemcinin gönderdiği `userId` filtresi buraya girmiyor: çalışan
 * `?userId=<baskasi>` yollarsa sunucu onu yok sayıp kendi kimliğini
 * kullanır. Bu fonksiyon o zorlamanın tek yeri.
 */
export function movementUserScope(actor: Actor, requestedUserId?: string): string | undefined {
  if (can(actor.role, 'movement:read:all')) return requestedUserId
  requirePermission(actor, 'movement:read:own')
  return actor.userId
}
