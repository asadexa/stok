'use client'

import { useEffect } from 'react'

/**
 * ============================================================================
 * OTURUM ÇEREZİNİ TAZELE — T87
 *
 * Sunucu bu isteği yenilerken taze çerezi YAZAMADIYSA (render sırasında çerez
 * deposu salt okunur) kabuk bu bileşeni basıyor. Burası da bir kez
 * `POST /oturum/yenile` çağırıp çerezi kalıcılaştırıyor.
 *
 * NEDEN YÖNLENDİRME DEĞİL: yönlendirme kullanıcıyı sayfadan koparırdı ve
 * form doldurmakta olan biri yazdığını kaybederdi. Buradaki istek sessiz,
 * arka planda ve sayfayı hiç etkilemiyor.
 *
 * JAVASCRIPT KAPALIYSA NE OLUR: hiçbir şey kırılmıyor. Çerez eski kalıyor ve
 * her render bir yenileme sorgusu yapıyor — yani T87 öncesi davranış. Depoda
 * eski tarayıcılar var; bu yol bir optimizasyon, bir gereklilik değil.
 *
 * Cevap OKUNMUYOR. Uç 204 dönüyor ve başarısızlık da sorun değil: bir sonraki
 * render yine deneyecek. Hata yakalayıcı boş çünkü kullanıcının yapabileceği
 * bir şey yok ve konsola kırmızı satır yazmak işe yaramaz.
 * ============================================================================
 */
export function SessionKeepAlive() {
  useEffect(() => {
    // `keepalive`: kullanıcı hemen başka sayfaya geçse bile istek iptal
    // edilmiyor. Sekme kapanırken bile tarayıcı bunu göndermeye çalışıyor.
    void fetch('/oturum/yenile', { method: 'POST', keepalive: true }).catch(() => {})
  }, [])

  return null
}
