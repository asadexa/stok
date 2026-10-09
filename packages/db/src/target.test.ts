import { describe, expect, it } from 'vitest'
import { describeTarget } from './target'

/**
 * Seed (T125) ve kiracı açma aynı sınıflandırmaya dayanıyor: buradaki bir
 * gevşeme (LAN'ı yerel saymak, `?host=` yönlendirmesini görmemek) seed'in
 * gerçek veriyi silebileceği hedefleri açar.
 */
describe('describeTarget', () => {
  it.each([
    ['postgresql://u:p@localhost:5433/stok', true],
    ['postgresql://u:p@127.0.0.1:5433/stok', true],
    ['postgresql://u:p@[::1]:5433/stok', true],
    // 127.0.0.2 de loopback ama izin listesinde değil: liste bilerek dar.
    ['postgresql://u:p@127.0.0.2:5433/stok', false],
    // Dükkândaki bir sunucu da gerçek veridir.
    ['postgresql://u:p@192.168.1.20:5432/stok', false],
    ['postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres', false],
    // Adres yerel görünüp bağlantı başka sunucuya yönlendirilebiliyor.
    ['postgresql://u:p@localhost:5432/stok?host=db.example.com', false],
    // Şeması unutulmuş adres: `new URL` "localhost:"u şema sayıyor ve
    // fırlatmıyor (config.ts'te ölçülmüş tuzak). Ana makine boş kalıyor,
    // yerel sayılmıyor.
    ['localhost:5433/stok', false],
  ])('%s → yerel: %s', (url, isLocal) => {
    expect(describeTarget(url).isLocal).toBe(isLocal)
  })

  it('port verilmezse 5432, veritabanı adını yoldan okuyor', () => {
    expect(describeTarget('postgresql://u:p@localhost/stok_test_db')).toEqual({
      host: 'localhost',
      port: 5432,
      database: 'stok_test_db',
      isLocal: true,
    })
  })

  it('çözümlenemeyen adreste fırlatıyor (sessizce yerel saymıyor)', () => {
    expect(() => describeTarget('bu bir adres değil')).toThrow(/çözümlenemedi/)
  })
})
