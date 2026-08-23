import 'server-only'
import { XLSX_CONTENT_TYPE, type ExportResult } from '@stok/core'
import { NextResponse } from 'next/server'

/**
 * ============================================================================
 * RAPOR İNDİRME — ORTAK PARÇALAR
 *
 * SORGU PARAMETRELERİ BURADA TİPLENİYOR, şemada değil. Adres çubuğundan
 * gelen her şey metin; `z.coerce.boolean()` kullanmak cazip ama TEHLİKELİ:
 * `Boolean("false")` true'dur, yani `?kritik=false` "sadece kritikler"
 * demeye başlardı. Dönüşüm açıkça yazılıyor.
 *
 * Tanınmayan parametre sessizce yok sayılıyor: kullanıcının elle kırptığı
 * bir adres yüzünden rapor indirmemek, eksik filtreyle indirmekten daha
 * kötü bir davranış değil — ama şema zaten bilinmeyen alanları atıyor.
 * ============================================================================
 */

/** `?x=1` ve `?x=true` açık; başka her şey (ve yokluk) kapalı. */
function flag(params: URLSearchParams, key: string): boolean {
  const value = params.get(key)
  return value === '1' || value === 'true'
}

function trimmed(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim()
  return value ? value : undefined
}

export function stockQuery(params: URLSearchParams): Record<string, unknown> {
  return {
    search: trimmed(params, 'ara'),
    category: trimmed(params, 'kategori'),
    onlyCritical: flag(params, 'kritik'),
    includeArchived: flag(params, 'arsiv'),
  }
}

export function movementQuery(params: URLSearchParams): Record<string, unknown> {
  return {
    productId: trimmed(params, 'urun'),
    userId: trimmed(params, 'kullanici'),
    reason: trimmed(params, 'sebep'),
    from: trimmed(params, 'baslangic'),
    to: trimmed(params, 'bitis'),
  }
}

/**
 * Dosyayı indirme olarak döndürür.
 *
 * `Content-Disposition`'da HEM `filename` HEM `filename*` var. Dosya adı
 * bugün ASCII (`stok-20260823-0912.xlsx`) ama tarih biçimi değişip Türkçe
 * bir kelime girerse eski tarayıcı adı bozar; `filename*` (RFC 5987) o
 * durumu şimdiden kapatıyor.
 */
export function fileResponse(result: ExportResult): NextResponse {
  if (result.mode !== 'inline') {
    // Buraya normalde gelinmiyor: karar `planExport` ile önceden veriliyor.
    // Yine de gelirse dürüst cevap "dosya yok, iş kuyrukta" — yarım bir
    // dosya indirmek değil.
    return NextResponse.json(
      { code: 'EXPORT_QUEUED', jobId: result.jobId, notifyEmail: result.notifyEmail },
      { status: 202 },
    )
  }

  const ascii = result.fileName.replace(/[^\x20-\x7e]/g, '_')
  return new NextResponse(new Uint8Array(result.buffer), {
    headers: {
      'content-type': XLSX_CONTENT_TYPE,
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
      'content-length': String(result.buffer.byteLength),
      // Rapor anlık stoğu yansıtıyor; bir dakika sonrası farklı olabilir.
      'cache-control': 'no-store',
    },
  })
}
