import { describe, expect, it } from 'vitest'
import { AppError, ERROR_CODES, errorText, isRetryable } from './errors.js'
import { formatQty } from './units.js'

describe('hata sözleşmesi (D-2.2)', () => {
  it('her kodun http durumu, tekrar denenebilirlik bayrağı ve Türkçe metni var', () => {
    for (const code of Object.keys(ERROR_CODES)) {
      const meta = ERROR_CODES[code as keyof typeof ERROR_CODES]
      expect(meta.http).toBeGreaterThanOrEqual(200)
      expect(typeof meta.retryable).toBe('boolean')
      expect(typeof meta.tr({})).toBe('string')
    }
  })

  it('Türkçe metin detaylardan üretilir', () => {
    expect(errorText('INSUFFICIENT_STOCK', { available: 3, requested: 5 })).toBe(
      'Elde 3 adet var, 5 adet çıkışı yapılamaz',
    )
  })

  it('EXPORT_TOO_LARGE olmayacak bir e-posta vaat ETMİYOR', () => {
    // Metin eskiden "arka planda hazırlanıp e-posta ile gönderilecek"
    // diyordu ama bu kod SADECE istek reddedildiğinde fırlıyor: hiçbir iş
    // kuyruğa alınmıyor, hiçbir e-posta gitmiyor. Kullanıcı gelmeyecek
    // bir postayı beklerdi.
    const text = errorText('EXPORT_TOO_LARGE', { rowCount: 250_000, limit: 200_000 })

    expect(text).not.toContain('e-posta')
    expect(text).toContain('250000')
    expect(text).toContain('200000')
    // Kullanıcının yapabileceği somut şey metinde olmalı.
    expect(text).toContain('daraltın')
  })

  it('doğrulama hatası hangi alanın yanlış olduğunu söylüyor', () => {
    // zod mesajları zaten Türkçe ve alana özgü; yutulup genel bir cümleye
    // çevrilseydi kullanıcı formda denemeyle arardı.
    expect(
      errorText('VALIDATION_FAILED', {
        issues: [{ path: 'qtyMultiplier', message: 'Barkod türü ile çarpan uyuşmuyor' }],
      }),
    ).toBe('Barkod türü ile çarpan uyuşmuyor')

    // Ayrıntı yoksa genel metne düşüyor.
    expect(errorText('VALIDATION_FAILED', {})).toBe('Girilen bilgilerde hata var')
  })

  it('çift kayıt kullanıcıya gösterilmez', () => {
    // Doğru davranış: aynı okutma iki kez gönderilmiş, sistem sessizce
    // tek kayıt tutmuş. Kullanıcının bilmesi gereken bir şey yok.
    expect(errorText('DUPLICATE_MOVEMENT')).toBe('')
  })
})

describe('tanınmayan kod (eski istemci, yeni sunucu)', () => {
  it('genel bir mesaja düşer, patlamaz', () => {
    expect(errorText('SOME_FUTURE_CODE')).toBe('Beklenmeyen bir hata oluştu')
  })

  it('varsayılan olarak tekrar denenebilir sayılır', () => {
    // Bilmediğimiz bir hatada kaydı atmaktansa tekrar denemek güvenli.
    // Veri kaybetmemek önceliklidir.
    expect(isRetryable('SOME_FUTURE_CODE')).toBe(true)
  })
})

describe('outbox durum makinesini besleyen retryable bayrağı', () => {
  it('iş kuralı hataları tekrar denenmez, kullanıcıya sorulur', () => {
    expect(isRetryable('INSUFFICIENT_STOCK')).toBe(false)
    expect(isRetryable('BARCODE_UNKNOWN')).toBe(false)
    expect(isRetryable('INVALID_QUANTITY')).toBe(false)
  })

  it('geçici hatalar tekrar denenir', () => {
    expect(isRetryable('POOL_EXHAUSTED')).toBe(true)
    expect(isRetryable('SERIALIZATION_FAILURE')).toBe(true)
    expect(isRetryable('SERVER_ERROR')).toBe(true)
  })

  it('zorunlu güncelleme tekrar denenmez', () => {
    // Tekrar denemek sonsuza kadar 426 alır. Kullanıcı uygulamayı
    // güncellemeli, kuyruk korunur.
    expect(isRetryable('CLIENT_TOO_OLD')).toBe(false)
  })
})

describe('AppError', () => {
  it('kodundan http durumunu türetir', () => {
    expect(new AppError('BARCODE_UNKNOWN', 'no such barcode').http).toBe(404)
    expect(new AppError('FORBIDDEN', 'role=calisan').http).toBe(403)
  })

  it('API gövdesine çevrilir, İngilizce mesaj korunur', () => {
    const e = new AppError('INSUFFICIENT_STOCK', 'qty 5 > available 3', {
      available: 3,
      requested: 5,
    })
    expect(e.toBody()).toEqual({
      code: 'INSUFFICIENT_STOCK',
      message: 'qty 5 > available 3',
      details: { available: 3, requested: 5 },
    })
  })
})

describe('miktar gösterimi', () => {
  it('adet ondalıksız', () => {
    expect(formatQty(55, 'ADET')).toBe('55 adet')
  })

  it('ağırlık Türkçe ondalık ayırıcıyla', () => {
    expect(formatQty(3.5, 'KG')).toBe('3,500 kg')
  })
})
