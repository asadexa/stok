import { AppError } from '@stok/shared'
import nodemailer from 'nodemailer'

/**
 * ============================================================================
 * E-POSTA GÖNDERİMİ — KRİTİK AÇIK G4'ün yarısı
 *
 * Arayüz bilerek KÜÇÜK: `send()` ya döner ya `MAIL_DELIVERY_FAILED`
 * fırlatır. Üçüncü bir sonuç yok — özellikle "sessizce başarısız" yok.
 * nodemailer bazı yapılandırmalarda hata yerine reddedilmiş alıcı listesi
 * döndürüyor; onu da hataya çeviriyoruz, çünkü çağıran taraf için
 * "gönderilemedi" tek bir durumdur.
 *
 * Arayüz olmasının sebebi test edilebilirlik değil sadece: gün sonu
 * raporunun gönderilememesi ürünün SESSİZ KALAMAYACAĞI bir durum ve bunu
 * doğrulamanın tek yolu, hata veren bir taşıyıcıyla gerçek iş akışını
 * çalıştırmak.
 * ============================================================================
 */

export interface MailAttachment {
  filename: string
  content: Buffer
  contentType?: string
}

export interface MailMessage {
  to: string
  subject: string
  text: string
  attachments?: MailAttachment[]
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>
}

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * SMTP taşıyıcısı. `SMTP_URL` ve `REPORT_FROM_EMAIL` ortam değişkenlerinden.
 *
 * Yapılandırma eksikse BAŞLANGIÇTA patlıyor, ilk gönderimde değil:
 * eksik yapılandırmayı gün sonu raporu gitmediğinde öğrenmek, tam olarak
 * G4'ün tarif ettiği durumdur.
 */
export function createSmtpTransport(
  url = process.env.SMTP_URL,
  from = process.env.REPORT_FROM_EMAIL,
): MailTransport {
  if (!url) throw new AppError('SERVER_ERROR', 'SMTP_URL tanımlı değil')
  if (!from) throw new AppError('SERVER_ERROR', 'REPORT_FROM_EMAIL tanımlı değil')

  const transporter = nodemailer.createTransport(url)

  return {
    async send(message) {
      const info = await transporter
        .sendMail({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          attachments: message.attachments?.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
          })),
        })
        .catch((err: unknown) => {
          throw new AppError(
            'MAIL_DELIVERY_FAILED',
            `smtp send failed: ${err instanceof Error ? err.message : String(err)}`,
            { to: message.to },
          )
        })

      // Sunucu bağlantıyı kabul edip alıcıyı reddedebilir. Bu durumda
      // sendMail hata FIRLATMAZ, sadece rejected listesi dolu döner.
      if (info.rejected?.length) {
        throw new AppError('MAIL_DELIVERY_FAILED', `recipient rejected: ${info.rejected.join(', ')}`, {
          to: message.to,
          rejected: info.rejected,
        })
      }
    },
  }
}

/**
 * Test ve yerel geliştirme için: gönderilenleri bellekte tutar.
 * Üretimde ASLA kullanılmaz; adı bunu söylüyor.
 */
export function createInMemoryTransport(): MailTransport & { sent: MailMessage[] } {
  const sent: MailMessage[] = []
  return {
    sent,
    async send(message) {
      sent.push(message)
    },
  }
}
