import { formatCount } from '@/lib/format'

/**
 * Başlık 1. satırda değilse önizlemenin üstündeki not (ERP raporu: başlığın
 * üstünde rapor adı ve tarih satırları). Okuyucu o satırları atlıyor
 * (`findHeaderRow`); bunu söylemeseydi kullanıcı dosyanın tamamının okunduğunu
 * sanar ve başlık yanlış satırdan seçildiyse fark edemezdi.
 */
export function HeaderRowNote({ headerRowNumber }: { headerRowNumber: number }) {
  if (headerRowNumber <= 1) return null
  return (
    <p role="status" className="rounded-control border border-line bg-surface-2 p-3 text-sm text-ink-2">
      Sütun başlıkları {formatCount(headerRowNumber)}. satırda bulundu; üstteki{' '}
      {formatCount(headerRowNumber - 1)} satır okunmadı.
    </p>
  )
}
