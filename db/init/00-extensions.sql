-- Eklentiler. Bu dosya sadece container ilk kez oluşturulurken çalışır.
-- Yeniden çalıştırmak için: pnpm db:reset

-- Ürün adı aramasında trigram benzerlik index'i için (PLAN.md Bölüm 7).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Not: gen_random_uuid() PostgreSQL 13'ten beri çekirdekte, pgcrypto gerekmiyor.
-- Not: unaccent BİLEREK kurulmuyor. Türkçe'de ı/I/i/İ dört ayrı harf ve
--      unaccent + lower() collation'a bağlı davranıyor. Arama normalizasyonu
--      tr_norm() fonksiyonuyla yapılıyor (migration'da tanımlı), böylece
--      hangi collation kurulu olursa olsun sonuç aynı. Bkz. PLAN.md D-4.1.
