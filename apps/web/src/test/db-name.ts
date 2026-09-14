/**
 * Bu paketin test veritabanı.
 *
 * Her paket kendi veritabanını kullanıyor (`packages/db` → `stok_test_db`).
 * Paylaşılan tek veritabanı, iki paketin testleri aynı anda koştuğunda
 * birbirinin şemasını siler ve hatayı "bazen kırmızı" olarak gösterir —
 * teşhis edilmesi en pahalı hata türü.
 */
export const TEST_DB_NAME = 'stok_test_web'
