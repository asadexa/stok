/**
 * Bu paketin test veritabanı. Her paket kendi veritabanını kullanır:
 * paylaşılan tek veritabanı, iki paketin testleri aynı anda koştuğunda
 * birbirinin şemasını siler ve hatayı "bazen kırmızı" olarak gösterir.
 */
export const TEST_DB_NAME = 'stok_test_core'
