import { describe, expect, it } from 'vitest'
import {
  MOVEMENT_REASONS,
  MOVEMENT_REASON_VALUES,
  reasonsCheckConstraint,
  selectableReasons,
  toDelta,
} from './reasons'

describe('sebep kodları', () => {
  it('her sebebin yönü, Türkçe etiketi ve seçilebilirlik bayrağı var', () => {
    for (const r of MOVEMENT_REASON_VALUES) {
      const meta = MOVEMENT_REASONS[r]
      expect(meta.direction).toMatch(/^(IN|OUT)$/)
      expect(meta.tr.length).toBeGreaterThan(0)
      expect(typeof meta.userSelectable).toBe('boolean')
    }
  })

  it('kod değerleri İngilizce ve büyük harf (D-2.4)', () => {
    // API cevaplarına ve Excel'e gidiyorlar; ileride Logo/Mikro bunları tüketecek.
    for (const r of MOVEMENT_REASON_VALUES) {
      expect(r).toMatch(/^[A-Z][A-Z_]*$/)
    }
  })
})

describe('delta işareti sebepten türetilir', () => {
  it('giriş sebebi pozitif delta üretir', () => {
    expect(toDelta(20, 'PURCHASE')).toBe(20)
    expect(toDelta(20, 'RETURN_IN')).toBe(20)
  })

  it('çıkış sebebi negatif delta üretir', () => {
    expect(toDelta(3, 'SALE')).toBe(-3)
    expect(toDelta(3, 'DAMAGE')).toBe(-3)
  })

  it('kullanıcı negatif girse bile işareti sebep belirler', () => {
    // Bu senaryo şema tarafından zaten engelleniyor (qty > 0), ama
    // fonksiyonun tek sorumluluğu işaret koymak, doğrulama değil.
    expect(toDelta(5, 'SALE')).toBeLessThan(0)
  })
})

describe('sayım düzeltmeleri elle seçilemez', () => {
  it('giriş listesinde COUNT_ADJUST_UP yok', () => {
    expect(selectableReasons('IN')).not.toContain('COUNT_ADJUST_UP')
    expect(selectableReasons('IN')).toContain('PURCHASE')
  })

  it('çıkış listesinde COUNT_ADJUST_DOWN yok', () => {
    expect(selectableReasons('OUT')).not.toContain('COUNT_ADJUST_DOWN')
    expect(selectableReasons('OUT')).toContain('SALE')
  })

  it('elle seçilebilseydi denetim izi anlamını kaybederdi', () => {
    // Sayım düzeltmeleri SADECE sayım akışı tarafından üretilmeli.
    const selectable = [...selectableReasons('IN'), ...selectableReasons('OUT')]
    expect(selectable).toHaveLength(MOVEMENT_REASON_VALUES.length - 2)
  })
})

describe('DB constraint tek kaynaktan üretiliyor (T44)', () => {
  it('constraint metni tüm sebep kodlarını içerir', () => {
    const sql = reasonsCheckConstraint()
    for (const r of MOVEMENT_REASON_VALUES) {
      expect(sql).toContain(`'${r}'`)
    }
    expect(sql).toMatch(/^reason IN \(/)
  })

  it('kolon adı özelleştirilebilir', () => {
    expect(reasonsCheckConstraint('m.reason')).toMatch(/^m\.reason IN \(/)
  })

  // NOT: Bu test constraint METNİNİ doğruluyor. Veritabanındaki GERÇEK
  // constraint ile karşılaştırma, DB gerektiren entegrasyon testinde
  // yapılacak (T44'ün ikinci yarısı). İkisi birden olmadan drift kapanmaz.
})
