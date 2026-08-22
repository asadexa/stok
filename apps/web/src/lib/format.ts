/**
 * Ekranlarda ortak biçimlendirme.
 *
 * `Intl` nesneleri modül düzeyinde bir kez kuruluyor: her satır için yeni
 * bir `Intl.DateTimeFormat` yaratmak 200 satırlık bir tabloda ölçülebilir
 * bir maliyet ve hepsi aynı sonucu üretiyor.
 *
 * Sayı biçimi HER YERDE `tr-TR`: ondalık ayırıcı virgül, binlik nokta.
 * Bir tabloda "1,234.50", diğerinde "1.234,50" görmek, depoda fiyat
 * okuyan biri için gerçek bir hata kaynağı.
 */

const dateTimeFmt = new Intl.DateTimeFormat('tr-TR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const dateFmt = new Intl.DateTimeFormat('tr-TR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

const moneyFmt = new Intl.NumberFormat('tr-TR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatDateTime(value: Date): string {
  return dateTimeFmt.format(value)
}

export function formatDate(value: Date): string {
  return dateFmt.format(value)
}

/** Para: "1.234,50". Birim simgesi ÇAĞIRAN yerde — kur alanı yok, ₺ sabit. */
export function formatMoney(value: number): string {
  return moneyFmt.format(value)
}

/**
 * `<input type="date">` değerini (YYYY-MM-DD) gün başlangıcına çevirir.
 *
 * Saat dilimi bilerek YEREL: kullanıcı "1 Mart" yazdığında kastettiği şey
 * kendi gününün başlangıcı. UTC'ye sabitlersek Türkiye'de (UTC+3) 1 Mart
 * 03:00 öncesi hareketler filtreye girmez ve kullanıcı kaybolan satırların
 * nedenini asla bulamaz.
 *
 * Geçersiz girdide `undefined`: adres çubuğuna elle yazılmış bir değer
 * yüzünden sayfa çökmemeli, filtre yok sayılmalı.
 */
export function dayStartIso(value: string | undefined): string | undefined {
  const parts = parseDateParts(value)
  if (!parts) return undefined
  return new Date(parts.y, parts.m - 1, parts.d, 0, 0, 0, 0).toISOString()
}

/** Aynısının gün SONU hâli. Bitiş tarihi dahil olmalı: kullanıcı "1-5 Mart"
 *  derken 5 Mart'ı da kastediyor. */
export function dayEndIso(value: string | undefined): string | undefined {
  const parts = parseDateParts(value)
  if (!parts) return undefined
  return new Date(parts.y, parts.m - 1, parts.d, 23, 59, 59, 999).toISOString()
}

function parseDateParts(value: string | undefined) {
  if (!value) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  return { y, m, d }
}
