import { pingDb } from '@stok/db'
import { NextResponse } from 'next/server'

/**
 * ============================================================================
 * T114 — SAĞLIK UCU
 *
 * PLAN.md Bölüm 9, deploy sonrası ilk beş dakikanın 1. MADDESİ olarak
 * "`/api/v1/health` 200 mü" diyor. Böyle bir uç yoktu, yani o kontrol
 * listesi bugüne kadar hiç çalıştırılamadı.
 *
 * NEDEN `/saglik` SAYFASI YETMİYOR. O panel kartı `user:manage` istiyor.
 * Deploy'un sağ olup olmadığını öğrenmek için önce tarayıcıda yönetici
 * olarak giriş yapmak gerekiyordu — bir izleme aracının yapamayacağı şey.
 * Kontrol listesinin varlık sebebi tam olarak bunu ortadan kaldırmaktı.
 *
 * NEDEN `systemHealth()` KULLANILMIYOR. O fonksiyon farklı bir soruyu
 * cevaplıyor: "defter ile projeksiyon ayrıştı mı, kuyrukta çürüyen iş var
 * mı". Yetki ve kiracı bağlamı istiyor, üstelik pahalı. Buradaki soru çok
 * daha dar: "bu sürüm ayakta ve veritabanına ulaşabiliyor mu".
 *
 * VERİTABANINA GERÇEKTEN DOKUNULUYOR. Sadece 200 dönen bir uç, Node
 * sürecinin yaşadığını ispatlar, uygulamanın çalıştığını değil. Üretimde
 * en sık görülen arıza "uygulama ayakta, veritabanı erişilemez" ve
 * dokunmayan bir sağlık ucu o arızada da yeşil yanar — yani izlemeyi
 * susturur.
 * ============================================================================
 */

// postgres.js Edge'de çalışmıyor.
export const runtime = 'nodejs'
// Yan etkisi yok ama ÖNBELLEĞE ALINMAMALI: önbellekten dönen bir "ok",
// veritabanı düştükten sonra da yeşil yanmaya devam ederdi.
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await pingDb()
    return NextResponse.json({ status: 'ok' }, { status: 200 })
  } catch {
    /**
     * CEVAP BİLEREK SUSKUN: kimliği doğrulanmamış bir çağırana sürüm,
     * şema durumu ya da kiracı sayısı yazmak altyapı haritası vermek
     * olurdu. Hata METNİ hiç yazılmıyor çünkü postgres.js'in bağlantı
     * hatası bağlantı dizesini (kullanıcı adı, sunucu, port) içerebilir.
     *
     * 503, 500 DEĞİL: "geçici olarak hizmet veremiyor" demek ve yük
     * dengeleyici de izleme aracı da bunu "trafiği buraya gönderme" diye
     * okuyor. 500 ise "istek bozuk çıktı" anlamına gelirdi.
     */
    return NextResponse.json({ status: 'error' }, { status: 503 })
  }
}
