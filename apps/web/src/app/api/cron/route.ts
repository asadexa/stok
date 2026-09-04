import { timingSafeEqual } from 'node:crypto'
import { type MailTransport, runCronAllTenants, createSmtpTransport } from '@stok/core'
import { AppError } from '@stok/shared'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { errorResponse } from '@/server/http'

/**
 * ============================================================================
 * CRON UCU — T34
 *
 * `runQueuedJobs()` T14'te yazıldı ama ÇAĞIRANI YOKTU: kuyruğa giren rapor
 * sonsuza kadar QUEUED'da bekliyordu. Zamanlayıcının (Vercel Cron, systemd
 * timer, cron + curl — hangisi kuruluysa) vurduğu kapı burası.
 *
 * NEDEN AYRI BİR SÜREÇ / İŞÇİ DEĞİL. Depo başına birkaç yüz hareket var;
 * ikinci bir dağıtım birimi (worker konteyneri) çalıştırmak, "işçi ölmüş ve
 * kimse fark etmemiş" diye ikinci bir sessiz arıza sınıfı açardı. Tek
 * süreç, tek kuyruk: işçi ölürse uygulama da ölmüştür ve görünür.
 *
 * KİMLİK DOĞRULAMA OTURUMLA DEĞİL PAYLAŞILAN SIRLA. Zamanlayıcının çerezi
 * yok; kullanıcı oturumu istemek, birinin tarayıcıda açık bırakması
 * gerektiği anlamına gelirdi.
 * ============================================================================
 */

// Node çalışma zamanı zorunlu: postgres.js ve nodemailer Edge'de çalışmıyor.
export const runtime = 'nodejs'
// Bu uç YAN ETKİLİ; Next'in statik olarak ön-derlemesi ya da cevabı
// önbelleğe alması, cron'un ikinci turunun hiç çalışmaması demek olurdu.
export const dynamic = 'force-dynamic'

/**
 * Sabit zamanlı karşılaştırma. `===` kullanılsaydı, cevap süresi ilk
 * uyuşmayan karakterin yerine göre değişir ve sır karakter karakter
 * tahmin edilebilirdi. Uzunluk farkı da sızmasın diye önce özet değil,
 * doğrudan uzunluk kontrolü var — uzunluk zaten gizli bilgi değil.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * SMTP yapılandırması eksikse HATA GECİKTİRİLİYOR, tur düşürülmüyor.
 *
 * `createSmtpTransport()` bilerek kurulumda patlıyor (bkz. mail.ts): eksik
 * ayarı ilk gönderimde öğrenmek G4'ün ta kendisi. Ama o hatayı buradan
 * fırlatmak turun TAMAMINI düşürüyordu — kuyruk işlenmiyor (G1 export'ları
 * asılı kalıyor), invariant denetlenmiyor (T37 alarmı hiç çalmıyor), kaba
 * kuvvet sayaçları budanmıyor. Üstelik bunların hiçbiri e-postaya bağlı
 * değil. Ölçülerek bulundu: SMTP'siz bir kurulumda uç 500 dönüyor ve
 * yalnızca "SMTP_URL tanımlı değil" yazıyordu.
 *
 * Şimdi hata GÖNDERİM ANINDA çıkıyor, yani ait olduğu işin satırına
 * yazılıyor ve admin panelindeki Sistem Sağlığı kartında görünüyor. Bu,
 * kimsenin okumadığı bir 500'den daha görünür.
 */
function mailTransport(): MailTransport {
  try {
    return createSmtpTransport()
  } catch (err) {
    return {
      async send() {
        throw err
      },
    }
  }
}

/**
 * `POST` çünkü YAN ETKİLİ: rapor gönderiyor, kuyruk işliyor, sayaç buduyor.
 * `GET` olsaydı tarayıcı ön-getirmesi ya da bir link tarayıcısı turu
 * tetikleyebilirdi.
 */
export async function POST(request: NextRequest) {
  try {
    const expected = process.env.CRON_SECRET
    // Sır TANIMSIZSA uç KAPALI. "Tanımsızsa doğrulama yapma" varsayılanı,
    // ortam değişkenini eklemeyi unutan her kurulumda gün sonu raporunu
    // internete açık bir tetiğe çevirirdi.
    if (!expected || expected.length < 32) {
      throw new AppError('SERVER_ERROR', 'CRON_SECRET tanımlı değil ya da 32 karakterden kısa')
    }

    const header = request.headers.get('authorization') ?? ''
    const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!secretMatches(provided, expected)) {
      // TOKEN_INVALID (401): sunulan kimlik bilgisi geçersiz. Yeni bir hata
      // kodu eklenmedi çünkü kodlar mobil outbox'ın da okuduğu ortak
      // sözleşme; tek çağıranı zamanlayıcı olan bir uç için sözleşmeyi
      // büyütmek, her istemciye anlamsız bir dal daha eklerdi.
      throw new AppError('TOKEN_INVALID', 'cron secret mismatch')
    }

    const result = await runCronAllTenants({ mail: mailTransport() })

    /**
     * ALARM EŞİĞİ.
     *
     * 500 → invariant kırık (T37) YA DA bir işin deneme hakkı bitti.
     * 200 → tur döndü; hata varsa bile işin bir hakkı daha var.
     *
     * Invariant için gövdeye yazıp 200 dönmek, `SUM(delta) !=
     * current_stock.qty` durumunu kimsenin okumadığı bir JSON alanına
     * gömerdi; zamanlayıcı ve izleme araçları HTTP durumuna bakıyor.
     *
     * İlk SMTP hatasında ALARM ÇALMIYOR çünkü geçici hata yaygın ve iş
     * bir sonraki turda tekrar denenecek (jobs.ts, `RETRY_DELAY_SECONDS`).
     * Her geçici hatada 500 dönmek, operatörü alarmı yok saymaya
     * alıştırırdı — bu, alarmın hiç olmamasından kötü. Hak bitince iş
     * FAILED oluyor, hem burası hem admin panelindeki Sistem Sağlığı kartı
     * gösteriyor.
     */
    const status = result.invariantBroken || result.failed ? 500 : 200
    return NextResponse.json(result, { status })
  } catch (err) {
    return errorResponse(err)
  }
}
