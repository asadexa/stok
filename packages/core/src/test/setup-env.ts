import { config } from 'dotenv'

// Kök dizindeki tek .env. globalSetup ana süreçte yüklüyor ama test
// çalışanları ayrı süreç; burada da yüklemek, çalışanın bağlantı
// dizesini "bazen bulamamasını" engelliyor.
config({ path: '../../.env' })

import { setLogSink } from '../observability'

/**
 * Yapısal log (T36) test çıktısından SUSTURULUYOR.
 *
 * Her reddedilen hareket bir JSON satırı yazıyor ve hata yollarını sınayan
 * testler bunlardan yüzlercesini üretiyor: gerçek bir test hatası o
 * gürültünün içinde görünmez oluyor. Log'un KENDİSİNİ sınayan testler
 * (`observability.test.ts`) kendi yazıcısını takıyor.
 */
setLogSink({ write() {} })
