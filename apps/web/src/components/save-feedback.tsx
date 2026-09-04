'use client'

import { useEffect } from 'react'

/**
 * ============================================================================
 * SESLİ VE TİTREŞİMLİ KAYIT GERİ BİLDİRİMİ — T81 (PLAN.md E4)
 *
 * PLAN.md Bölüm 11: "Sesli ve titreşimli geri bildirim. Başarılı = tek bip +
 * yeşil, hata = çift bip + kırmızı. Çalışan ekrana bakmaz, dinler."
 *
 * Depoda çalışan telefonu bir eliyle tutuyor, diğer eliyle malı taşıyor.
 * Ekrana bakmak için işi durdurmak gerekiyor; bip duymak gerekmiyor. Ölçülen
 * kazanç planda yazılı: hız iki katına çıkıyor.
 *
 * OTOMATİK OYNATMA POLİTİKASI NEDEN ENGEL DEĞİL: tarayıcılar sesi ancak
 * kullanıcı etkileşiminden sonra çalıyor. Buradaki akışta "Kaydet"e basmak o
 * etkileşim, VE sunucu eylemi belgeyi yeniden yüklemiyor — Next.js App Router
 * yönlendirmesi yumuşak gezinme. Yani bip aynı belgede, etkinleştirmeden
 * sonra çalıyor. (Klasik form gönderimi olsaydı yeni belge yüklenir ve ilk
 * bip engellenirdi.)
 *
 * SES DOSYASI YOK, WEB AUDIO İLE ÜRETİLİYOR. Bir mp3 indirmek deponun zayıf
 * bağlantısında ilk okutmayı geciktirirdi ve çevrimdışı çalışmazdı. Osilatör
 * sıfır bayt.
 *
 * TİTREŞİM AYRI BİR KANAL, SESİN YEDEĞİ DEĞİL. Depoda gürültü var ve telefon
 * cepte olabilir; ses duyulmazsa titreşim hissediliyor. `navigator.vibrate`
 * iOS Safari'de yok — orada sessizce atlanıyor, hata verilmiyor.
 * ============================================================================
 */

type Tone = 'ok' | 'error'

/** Tek osilatör, kısa zarf. Zarf olmadan bip "tık" diye patlıyor. */
function beep(ctx: AudioContext, freq: number, startAt: number, ms: number) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq

  const end = startAt + ms / 1000
  // Hızlı yükseliş, yumuşak iniş: kulakta tıklama bırakmıyor.
  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(0.22, startAt + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(gain).connect(ctx.destination)
  osc.start(startAt)
  osc.stop(end + 0.02)
}

function play(tone: Tone) {
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return

  let ctx: AudioContext
  try {
    ctx = new Ctor()
  } catch {
    return
  }

  const t = ctx.currentTime
  if (tone === 'ok') {
    // Tek, yüksek, kısa: "oldu".
    beep(ctx, 880, t, 90)
  } else {
    // Çift, alçak: "olmadı". Perde farkı bilerek büyük — gürültülü depoda
    // iki bipi saymak yerine tonu tanımak daha hızlı.
    beep(ctx, 440, t, 90)
    beep(ctx, 440, t + 0.17, 90)
  }

  // Bağlamı serbest bırak: her kayıtta yeni bir tane açılıyor ve tarayıcının
  // eşzamanlı ses bağlamı sınırı var (Chrome'da ~6).
  window.setTimeout(() => void ctx.close().catch(() => {}), tone === 'ok' ? 400 : 700)
}

function buzz(tone: Tone) {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate(tone === 'ok' ? 40 : [60, 80, 60])
  } catch {
    // Bazı tarayıcılar arka plandaki sekmede fırlatıyor. Önemsiz.
  }
}

export function SaveFeedback({
  tone,
  enabled,
  /**
   * Aynı sonuç iki kez gösterilirse (kullanıcı sayfayı yeniledi) React
   * `useEffect`'i yeniden çalıştırsın diye. Kayıt sonrası adresteki yeni
   * stok değeri bu işi görüyor.
   */
  signature,
}: {
  tone: Tone
  enabled: boolean
  signature: string
}) {
  // efekt gövdesinde KULLANILMIYOR ve olayı da bu. Yeniden tetikleme
  // anahtarı: her kayıtta değeri değişiyor ve ses yeniden çalıyor.
  // Kaldırılsaydı ikinci kayıtta hiçbir şey duyulmazdı (T79, T81).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature`
  useEffect(() => {
    if (!enabled) return
    play(tone)
    buzz(tone)
  }, [tone, enabled, signature])

  return null
}
