import { AppError } from '@stok/shared'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'

/**
 * ============================================================================
 * TABLO DOSYASI OKUYUCU (T23, T171) — CSV ve XLSX → hücre metinleri matrisi
 *
 * TARAYICIDA DA ÇALIŞIYOR (T171, T1-A). Ürün aktarımında 100 MB'a kadar dosya
 * tarayıcıda ayrıştırılıyor ve sunucuya yalnız eşlenen hücreler gidiyor; tedarikçi
 * dosyası (T200) aynı okuyucuyu sunucuda kullanıyor. Bu yüzden burada veritabanı
 * ve Node'a özgü API YOK: `Buffer` yerine `Uint8Array` (Buffer da bir
 * Uint8Array, sunucudaki çağıranlar değişmedi), `toString('utf8')` yerine
 * `TextDecoder`. İki ayrı okuyucu, BOM, `;` ayırıcı ve önekli SpreadsheetML
 * derslerini iki kez öğrenmek demek olurdu.
 * ============================================================================
 */

/**
 * XLSX'in OKUNAN parçalarının (çalışma kitabı, sayfalar, paylaşılan metinler,
 * biçimler) açılmış toplam boyutu. Sıkıştırılmış küçük bir dosya açılınca
 * gigabaytlara çıkabilir (sıkıştırma bombası); sınır olmadan bu sekmeyi ya da
 * tedarikçi dosyasını okuyan sunucuyu çökertirdi. 20.000 satırlık 13 sütunlu bir
 * sayfa birkaç on MB tutuyor; görseller zaten okunmuyor (aşağıda).
 */
export const XLSX_PARTS_BYTE_LIMIT = 64 * 1024 * 1024

/** `.csv` ya da `.xlsx` dosyasını hücre metinleri matrisine çevirir; başlık yorumlamaz. */
export async function readSheet(data: Uint8Array, fileName: string): Promise<string[][]> {
  return fileName.toLowerCase().endsWith('.csv') ? parseCsv(data) : parseXlsx(data)
}

async function parseXlsx(data: Uint8Array): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook()
  const readable = await valuesOnlyWorkbook(data)
  await workbook.xlsx.load(readable as unknown as Parameters<typeof workbook.xlsx.load>[0])
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new AppError('IMPORT_NO_HEADER', 'workbook has no sheet')

  const matrix: string[][] = []
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellText(cell.value)
    })
    matrix.push(cells.map((c) => c ?? ''))
  })
  return matrix
}

/**
 * ExcelJS'e verilecek kitabın YALNIZ DEĞER parçaları: çalışma kitabı ve ilişkileri,
 * sayfalar, paylaşılan metinler, biçimler. Görsel, çizim, yorum, tablo, tema ve
 * belge özellikleri hiç AÇILMIYOR.
 *
 * Neden: ExcelJS kitabın bütün parçalarını, görseller dahil, belleğe alıyor.
 * Ürün listelerinde ürün görseli gömülü olması yaygın ve 100 MB'lık dosyanın
 * neredeyse tamamı görsel olur; değerlerin yanında onları da açmak belleği
 * dosya boyutunun katlarına çıkarırdı.
 *
 * Sayfanın kendi ilişki dosyası (`xl/worksheets/_rels/…`) atıldığı için sayfa
 * XML'inin sonundaki ona başvuran öğeler (çizim, köprü listesi, tablo) de
 * siliniyor; yoksa ExcelJS olmayan ilişkiyi ararken çöküyor (T171 spike). Köprülü
 * hücrenin METNİ hücrenin kendisinde, kaybolmuyor; yalnız bağlantı adresi düşüyor.
 *
 * Önekli SpreadsheetML (aşağıda) de burada çözülüyor: her parça zaten açılıyor.
 */
async function valuesOnlyWorkbook(data: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(data).catch(() => {
    throw new AppError('IMPORT_UNREADABLE', 'not a zip')
  })
  const out = new JSZip()
  let budget = XLSX_PARTS_BYTE_LIMIT

  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !VALUE_PARTS.test(entry.name)) continue
    const bytes = await inflateWithin(entry, budget)
    budget -= bytes.byteLength

    let xml = new TextDecoder('utf-8').decode(bytes)
    const root = PREFIXED_ROOT.exec(xml)
    if (root?.[0].includes(`xmlns:${root[1]}="${SPREADSHEETML_NS}"`)) {
      xml = xml.replace(new RegExp(`<(/?)${root[1]}:`, 'g'), '<$1')
    }
    if (WORKSHEET.test(entry.name)) xml = withoutRelationshipElements(xml)
    out.file(entry.name, xml)
  }

  // STORE: veri birazdan ExcelJS tarafından açılacak; yeniden sıkıştırmak
  // yalnız süre harcardı.
  return out.generateAsync({ type: 'uint8array', compression: 'STORE' })
}

/** ExcelJS'in değer okumak için kullandığı parçalar (başında `/` olabilir). */
const VALUE_PARTS =
  /^\/?xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/sheet\d+\.xml)$/
const WORKSHEET = /worksheets\/sheet\d+\.xml$/

/**
 * Sayfa XML'inin `</sheetData>` SONRASINDAKİ, sayfa ilişki dosyasına başvuran
 * öğeleri siler. Şema sırasına göre bu öğeler hep hücre verisinden sonra
 * geliyor; aramayı yalnız kuyrukta yapmak, 20.000 satırlık hücre verisinde
 * düzenli ifade çalıştırmayı da önlüyor.
 */
function withoutRelationshipElements(xml: string): string {
  const at = xml.lastIndexOf('</sheetData>')
  if (at < 0) return xml
  const tail = xml
    .slice(at)
    .replace(/<(hyperlinks|tableParts|oleObjects|controls)\b[\s\S]*?<\/\1>/g, '')
    .replace(/<(drawing|legacyDrawing|legacyDrawingHF|picture|tablePart)\b[^>]*\/>/g, '')
  return xml.slice(0, at) + tail
}

/**
 * Bir zip girdisini açar; açılan bayt `budget`'ı geçerse durur ve reddeder.
 *
 * Akışla açılıyor çünkü zip başlığındaki "açılmış boyut" alanı dosyayı yazanın
 * beyanı: bomba küçük beyan edip büyük açılır. Sayaç gerçekten açılan bayta
 * bakıyor ve sınırda akışı duraklatıyor; geri kalanı hiç açılmıyor.
 */
function inflateWithin(entry: JSZip.JSZipObject, budget: number): Promise<Uint8Array> {
  // `internalStream` JSZip'in belgelenmiş akış yolu ama tiplerde nesneye bağlı değil.
  const stream = (
    entry as unknown as {
      internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>
    }
  ).internalStream('uint8array')

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let total = 0
    stream
      .on('data', (chunk) => {
        total += chunk.byteLength
        if (total > budget) {
          stream.pause()
          reject(
            new AppError('IMPORT_XLSX_TOO_LARGE', 'xlsx value parts exceed limit', {
              limitMb: XLSX_PARTS_BYTE_LIMIT / (1024 * 1024),
            }),
          )
          return
        }
        chunks.push(chunk)
      })
      .on('error', () => reject(new AppError('IMPORT_UNREADABLE', 'xlsx part unreadable')))
      .on('end', () => {
        const joined = new Uint8Array(total)
        let offset = 0
        for (const c of chunks) {
          joined.set(c, offset)
          offset += c.byteLength
        }
        resolve(joined)
      })
      .resume()
  })
}

const SPREADSHEETML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
/**
 * XML bildiriminden sonraki ilk öğe, önekliyse: `<x:workbook xmlns:x="…">`.
 *
 * ExcelJS etiketleri öneksiz arıyor ve ad alanı çözmüyor; .NET Open XML SDK ise
 * SpreadsheetML'i önekli yazıyor (ChatGPT'nin ürettiği xlsx ve SDK kullanan
 * programların dışa aktarımları). Kökü SpreadsheetML'e bağlı bir önekle başlayan
 * parçalardan o önek atılıyor; öneksiz parçalara dokunulmuyor.
 */
const PREFIXED_ROOT = /^\s*(?:<\?[\s\S]*?\?>\s*)?<([A-Za-z_]\w*):[A-Za-z_][\w.-]*[^>]*>/

/**
 * Hücre değerini metne çevirir. Formül sonucu ve zengin metin dahil.
 *
 * KESİRLİ SAYI VİRGÜLLE YAZILIYOR (T171, K1): sayı hücresi kesin bir sayıdır, ama
 * `String(1.125)` "1.125" verir ve Türkçe okuyucu onu "bin yüz yirmi beş mi, bir
 * virgül yüz yirmi beş mi" diye belirsiz sayıp reddederdi. "1,125" Türkçe
 * okuyucuda tek anlamlı. Tam sayılar (barkod, adet) olduğu gibi kalıyor.
 */
export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(value).replace('.', ',')
  }
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('')
    }
    // Formül hücresinde YAZILAN formül değil HESAPLANAN değer alınıyor:
    // kullanıcı ekranda 12,50 görüyorsa dosyada da o girmeli.
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue)
    if ('hyperlink' in value && 'text' in value) return String(value.text)
    return ''
  }
  return String(value)
}

/**
 * Küçük bir CSV çözümleyici. Tırnak içi ayırıcı ve çift tırnak kaçışı
 * destekleniyor; bunlar ürün adında gerçekten görülüyor ("15" cetvel").
 *
 * AYIRICI OTOMATİK: Türkçe Excel `;` ile kaydediyor çünkü ondalık ayırıcı
 * virgül. Sabit `,` varsayımı, Türkiye'de üretilmiş dosyaların çoğunu tek
 * sütun olarak okurdu.
 *
 * BOM ATILIYOR: Excel'in yazdığı UTF-8 BOM ilk başlığın başına yapışır ve
 * "Stok Kodu" sütunu eşleşmez.
 */
export function parseCsv(data: Uint8Array): string[][] {
  let text = new TextDecoder('utf-8').decode(data)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = countOutsideQuotes(firstLine, ';') > countOutsideQuotes(firstLine, ',') ? ';' : ','

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function countOutsideQuotes(line: string, ch: string): number {
  let count = 0
  let inQuotes = false
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes
    else if (c === ch && !inQuotes) count += 1
  }
  return count
}

/**
 * Başlığı karşılaştırılabilir hâle getirir: Türkçe harfler sadeleşiyor,
 * noktalama ve fazla boşluk düşüyor. `packages/db` içindeki `tr_norm` ile
 * aynı harf eşlemesi — ikisi ayrı düşerse "Ürün Adı" başlığı bir yerde
 * eşleşip diğerinde eşleşmezdi.
 */
export function normalizeHeader(raw: string): string {
  const map: Record<string, string> = {
    İ: 'i', I: 'i', ı: 'i', Ş: 's', ş: 's', Ğ: 'g', ğ: 'g',
    Ü: 'u', ü: 'u', Ö: 'o', ö: 'o', Ç: 'c', ç: 'c',
  }
  return raw
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Virgülsüz, tek noktalı ve noktadan sonra TAM ÜÇ rakamlı yazım ("1.234",
 * "12.500"). Türkçe dosyada binlik ayırıcı da olabilir (bin iki yüz otuz dört),
 * ondalık da (bir virgül iki yüz otuz dört): ikisi bin kat farklı ve hangisinin
 * kastedildiği metinden anlaşılamıyor (K1, T205). Baştaki grup sıfırla
 * başlamıyor: "0.125" binlik olamaz, ondalıktır.
 */
const AMBIGUOUS_NUMBER = /^-?[1-9]\d{0,2}\.\d{3}$/

export function isAmbiguousTurkishNumber(raw: string): boolean {
  return AMBIGUOUS_NUMBER.test(raw.trim())
}

/** Belirsiz yazımın satır hatası metni; ürün ve tedarikçi aktarımı aynı cümleyi kullanıyor. */
export function ambiguousNumberMessage(raw: string): string {
  return `"${raw.trim()}" belirsiz: binlik ayırıcı mı ondalık mı anlaşılmıyor. Binlik ayırıcısız (1234) ya da virgüllü ondalıkla (1,234) yazın`
}

/**
 * Türkçe sayı: "1.234,56" → 1234.56.
 *
 * Nokta binlik, virgül ondalık. Bunu yapmazsak muhasebeden gelen her
 * fiyat ya reddedilir ya da bin kat yanlış okunur — ikisi de kötü ama
 * ikincisi çok daha kötü, çünkü sessiz.
 *
 * BELİRSİZ YAZIM SAYI DEĞİL (K1): "1.234" `NaN` döner. Sessizce bir anlam seçmek,
 * açılış stoğunu append-only deftere bin kat yanlış yazabilirdi ve defterde
 * düzeltme akışı yok (T127). Çağıranlar daha açık mesaj için önce
 * `isAmbiguousTurkishNumber`'a bakıyor; bakmayan da en kötü ihtimalle reddeder.
 */
export function parseTurkishNumber(raw: string): number | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  if (AMBIGUOUS_NUMBER.test(text)) return Number.NaN
  const hasComma = text.includes(',')
  const cleaned = hasComma ? text.replace(/\./g, '').replace(',', '.') : text
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : Number.NaN
}
