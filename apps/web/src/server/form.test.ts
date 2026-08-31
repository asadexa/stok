import { AppError } from '@stok/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  errorQuery,
  logServerFault,
  messageFrom,
  nullableNumber,
  nullableText,
  numberOr,
  optionalNumber,
  optionalText,
  preserveFields,
  text,
} from '@/server/form'

/**
 * ============================================================================
 * T94 — FORM KATMANI
 *
 * Saf fonksiyonlar, veritabanı yok. Üç ayrı risk kümesi:
 *
 *   1. KONTROL AKIŞI  Next'in yönlendirmesi bir istisna olarak geliyor.
 *      Yutulursa form gönderimi hiçbir yere gitmez ve kullanıcı boş ekranda
 *      kalır — hata da almaz.
 *   2. SIZINTI        Hata ayrıntıları adres çubuğuna yazılıyor. İç
 *      kimlikler (userId, tenantId) oraya düşerse kullanıcıya sistemin iç
 *      yapısı gösterilmiş olur.
 *   3. AYIRIM         `optional` (girilmedi) ile `nullable` (temizlendi)
 *      karışırsa, bir kez girilen alış fiyatı bir daha boşaltılamaz.
 * ============================================================================
 */

function form(entries: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(entries)) fd.set(k, v)
  return fd
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('kontrol akışı istisnaları yutulmuyor', () => {
  it('NEXT_REDIRECT yeniden fırlatılıyor', () => {
    // `redirect()` çağrısı bir istisna fırlatarak çalışıyor. errorQuery onu
    // yakalayıp sorgu dizesine çevirseydi, form gönderimi hiçbir yere
    // gitmez ve kullanıcı sessizce boş ekranda kalırdı.
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;push;/panel;303;',
    })
    expect(() => errorQuery(redirect)).toThrow()
  })

  it('NEXT_NOT_FOUND yeniden fırlatılıyor', () => {
    const notFound = Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' })
    expect(() => errorQuery(notFound)).toThrow()
  })

  it('digest taşımayan sıradan hata yutuluyor', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(errorQuery(new Error('sıradan'))).toContain('hata=SERVER_ERROR')
  })
})

describe('errorQuery: ne sızıyor, ne sızmıyor', () => {
  it('iş kuralı hatası kodu ve güvenli ayrıntıları taşıyor', () => {
    const q = new URLSearchParams(
      errorQuery(new AppError('INSUFFICIENT_STOCK', 'qty 5 > 3', { available: 3, requested: 5 })),
    )
    expect(q.get('hata')).toBe('INSUFFICIENT_STOCK')
    expect(q.get('available')).toBe('3')
    expect(q.get('requested')).toBe('5')
  })

  it('iç kimlikler adres çubuğuna DÜŞMÜYOR', () => {
    const q = new URLSearchParams(
      errorQuery(
        new AppError('FORBIDDEN', 'nope', {
          userId: 'u-1',
          tenantId: 't-1',
          productId: 'p-1',
          permission: 'export:excel',
          available: 7,
        }),
      ),
    )
    for (const gizli of ['userId', 'tenantId', 'productId', 'permission']) {
      expect(q.get(gizli), `${gizli} sızdı`).toBeNull()
    }
    // Güvenli olan yine geçiyor: kural "her şeyi gizle" değil.
    expect(q.get('available')).toBe('7')
  })

  it('beklenmeyen hatanın mesajı kullanıcıya GİTMİYOR', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // `err.message` adres çubuğuna konsaydı SQL parçaları ve dosya yolları
    // sızardı.
    const q = errorQuery(new Error('relation "stock_movements" does not exist'))
    expect(q).toContain('hata=SERVER_ERROR')
    expect(q).not.toContain('stock_movements')
  })

  it('doğrulama sorunlarından ilki mesaj olarak taşınıyor', () => {
    const q = new URLSearchParams(
      errorQuery(
        new AppError('VALIDATION_FAILED', 'bad', {
          issues: [{ message: 'Miktar sıfırdan büyük olmalı' }, { message: 'ikinci' }],
        }),
      ),
    )
    expect(q.get('sorun')).toBe('Miktar sıfırdan büyük olmalı')
  })
})

describe('logServerFault: yalnızca sunucu kusuru (T61)', () => {
  it('5xx loga yazılıyor', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logServerFault('giris', new AppError('SERVER_ERROR', 'AUTH_SECRET tanımlı değil'))
    expect(spy).toHaveBeenCalledOnce()
    expect(String(spy.mock.calls[0]?.[0])).toContain('AUTH_SECRET')
  })

  it('4xx loga YAZILMIYOR', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // "Parola hatalı" kullanıcının yaptığı bir şey, sunucunun kusuru değil.
    // Loga yazmak günlüğü gürültüye boğar ve gerçek arızayı görünmez kılar.
    logServerFault('giris', new AppError('INSUFFICIENT_STOCK', 'qty 5 > 3'))
    logServerFault('giris', new AppError('FORBIDDEN', 'nope'))
    expect(spy).not.toHaveBeenCalled()
  })

  it('AppError olmayan şey yok sayılıyor', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logServerFault('giris', new Error('düz hata'))
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('messageFrom: sayı bekleyen alana sayı gidiyor', () => {
  it('sayıya çevrilebilen parametre sayı olarak veriliyor', () => {
    // "Elde 3 adet" ile 'Elde "3" adet' arasındaki fark.
    const msg = messageFrom({ hata: 'INSUFFICIENT_STOCK', available: '3', requested: '5' })
    expect(msg).toBe('Elde 3 adet var, 5 adet çıkışı yapılamaz')
  })

  it('hata yoksa mesaj da yok', () => {
    expect(messageFrom({})).toBeNull()
  })

  it('tanınmayan kod genel mesaja düşüyor', () => {
    expect(messageFrom({ hata: 'GELECEKTEN_GELEN_KOD' })).toBe('Beklenmeyen bir hata oluştu')
  })
})

describe('alan okuyucuları: girilmedi mi, temizlendi mi', () => {
  it('zorunlu metin boşsa boş dize veriyor (zod reddetsin diye)', () => {
    expect(text(form({ ad: '' }), 'ad')).toBe('')
    expect(text(form({}), 'ad')).toBe('')
  })

  it('optionalText boş alanı undefined yapıyor', () => {
    expect(optionalText(form({ marka: '   ' }), 'marka')).toBeUndefined()
    expect(optionalText(form({ marka: ' Bic ' }), 'marka')).toBe('Bic')
  })

  it('nullableText boş alanı null yapıyor', () => {
    // Güncelleme formunda boş alan "girilmedi" değil "TEMİZLE" demek.
    // İkisi karışsaydı bir kez girilen alış fiyatı bir daha boşaltılamazdı.
    expect(nullableText(form({ marka: '' }), 'marka')).toBeNull()
    expect(nullableText(form({ marka: 'Bic' }), 'marka')).toBe('Bic')
  })

  it('undefined ile null AYNI ŞEY DEĞİL', () => {
    const bos = form({ marka: '' })
    expect(optionalText(bos, 'marka')).toBeUndefined()
    expect(nullableText(bos, 'marka')).toBeNull()
  })

  it('Türkçe ondalık virgülü kabul ediliyor', () => {
    // Türkçe klavyede ondalık ayırıcı virgül; "3,5" yazanı reddetmek
    // anlamsız bir engel olurdu.
    expect(optionalNumber(form({ fiyat: '3,5' }), 'fiyat')).toBe(3.5)
    expect(optionalNumber(form({ fiyat: '3.5' }), 'fiyat')).toBe(3.5)
  })

  it('sayıya çevrilemeyen metin NaN oluyor, sessizce 0 OLMUYOR', () => {
    // 0'a çevirmek, kullanıcının yazdığından farklı bir değeri kaydetmek
    // olurdu. NaN zod tarafından reddediliyor.
    expect(optionalNumber(form({ fiyat: 'abc' }), 'fiyat')).toBeNaN()
  })

  it('nullableNumber boş alanı null yapıyor', () => {
    expect(nullableNumber(form({ fiyat: '' }), 'fiyat')).toBeNull()
    expect(nullableNumber(form({ fiyat: '12' }), 'fiyat')).toBe(12)
  })

  it('numberOr boş alanda varsayılanı veriyor', () => {
    expect(numberOr(form({ minStok: '' }), 'minStok', 0)).toBe(0)
    expect(numberOr(form({ minStok: '5' }), 'minStok', 0)).toBe(5)
  })
})

/**
 * ============================================================================
 * HATA DÖNÜŞÜNDE FORM GERİ DOLDURULUYOR MU
 *
 * Bu blok bir hata sınıfını koruyor: sunucu eylemi hata verip yönlendirdiğinde
 * taşınmayan alan varsayılanına döner ve kullanıcı bunu FARK ETMEZ, çünkü
 * ikinci gönderim başarılı olur. Tarayıcı testinde yaşandı: miktar 5 yazıldı,
 * "birim fiyat zorunlu" hatası alındı, fiyat dolduruldu ve stoğa 5 yerine
 * 1 girdi (T89).
 * ============================================================================
 */
describe('preserveFields', () => {
  const formOf = (entries: Record<string, string>) => {
    const f = new FormData()
    for (const [k, v] of Object.entries(entries)) f.append(k, v)
    return f
  }

  it('girilen alanları taşıyor', () => {
    const kept = preserveFields(formOf({ miktar: '5', fiyat: '45,00', not: 'eski stok' }), [
      'miktar',
      'fiyat',
      'not',
    ])
    expect(kept.get('miktar')).toBe('5')
    expect(kept.get('fiyat')).toBe('45,00')
    expect(kept.get('not')).toBe('eski stok')
  })

  it('MİKTAR sıfırlanmıyor — sessiz yanlış kaydın kaynağı buydu', () => {
    const kept = preserveFields(formOf({ miktar: '5' }), ['miktar', 'fiyat'])
    expect(kept.get('miktar')).toBe('5')
    // Girilmemiş alan taşınmıyor: sorgu dizesini boş anahtarlarla şişirmenin
    // faydası yok ve sayfa zaten varsayılanını biliyor.
    expect(kept.has('fiyat')).toBe(false)
  })

  it('boş ve yalnızca boşluktan oluşan değer taşınmıyor', () => {
    const kept = preserveFields(formOf({ not: '   ', fiyat: '' }), ['not', 'fiyat'])
    expect(kept.has('not')).toBe(false)
    expect(kept.has('fiyat')).toBe(false)
  })

  it('ek alanlar formdan bağımsız eklenebiliyor', () => {
    // Onay kutusu işaretsizken FormData'da HİÇ BULUNMUYOR; taşınacak değer
    // de "on" değil, sayfanın beklediği "1".
    const kept = preserveFields(formOf({ miktar: '2' }), ['miktar'], {
      barkod: '869123',
      tahmini: '1',
      yok: undefined,
    })
    expect(kept.get('barkod')).toBe('869123')
    expect(kept.get('tahmini')).toBe('1')
    expect(kept.has('yok')).toBe(false)
  })
})
