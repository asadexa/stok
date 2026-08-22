-- Türkçe arama normalizasyonu (PLAN.md D-4.1).
--
-- SORUN: unaccent + lower() Türkçe'de güvenilmez.
--   • ı I i İ dört ayrı harf
--   • lower() davranışı veritabanı collation'ına göre değişiyor
--   • "ısıtıcı" arayan kullanıcı "Isıtıcı" ürününü bulamayabiliyor
--
-- ÇÖZÜM: translate() tabanlı, collation'dan tamamen bağımsız katlama.
-- Aramada dört I harfini de tek 'i'ye, Türkçe'ye özgü harfleri ASCII
-- karşılığına indiriyoruz. Amaç doğru Türkçe küçültme DEĞİL, arama
-- eşleşmesi: kullanıcı nasıl yazarsa yazsın ürünü bulsun.
--
--   Isıtıcı → isitici
--   ISITICI → isitici
--   ısıtıcı → isitici
--   İSİTİCİ → isitici
--
-- IMMUTABLE olması ŞART: generated column ve index ifadesi bunu gerektiriyor.
-- translate() ve string birleştirme deterministik olduğu için güvenli.
-- lower() BİLEREK kullanılmıyor: collation'a bağımlılık getirir.

CREATE OR REPLACE FUNCTION tr_norm(t text) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  STRICT
AS $$
  SELECT translate(
    t,
    'ABCDEFGHIJKLMNOPQRSTUVWXYZİıŞşĞğÜüÖöÇç',
    'abcdefghijklmnopqrstuvwxyziissgguuoocc'
  )
$$;

COMMENT ON FUNCTION tr_norm(text) IS
  'Türkçe arama normalizasyonu. Collation bağımsız. products.name_norm ve GIN trgm index bunu kullanır.';
