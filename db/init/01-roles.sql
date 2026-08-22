-- ============================================================================
-- D5: Tenant izolasyonunun temeli.
--
-- RLS politikası yazmak TEK BAŞINA YETMEZ. Uygulama veritabanına 'postgres'
-- kullanıcısıyla bağlanırsa o rol tabloların SAHİBİDİR ve varsayılan olarak
-- kendi tablolarında RLS'i atlar. Supabase'de 'service_role' anahtarı da
-- aynı etkiyi yaratır. Tek tenant'la test ederken bu asla fark edilmez;
-- ikinci müşteri geldiğinde A müşterisi B'nin verisini görür.
--
-- Bu yüzden iki ayrı rol var:
--
--   postgres  → tabloların sahibi. SADECE migration çalıştırır.
--   stok_app  → uygulamanın bağlandığı rol. Sahibi değil, superuser değil,
--               BYPASSRLS yok. RLS politikaları buna UYGULANIR.
--
-- Migration'lar ayrıca her tabloda FORCE ROW LEVEL SECURITY açar, böylece
-- yanlışlıkla sahip rolüyle bağlanılsa bile politikalar geçerli kalır.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stok_app') THEN
    -- Yerel geliştirme şifresi. Üretimde farklı olacak ve .env'den gelecek.
    CREATE ROLE stok_app LOGIN PASSWORD 'stok_app_dev'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

-- GRANT CONNECT veritabanı adını sabit yazmak zorunda; current_database()
-- ile dinamik veriyoruz ki aynı dosya test veritabanlarına da uygulanabilsin
-- (packages/db/src/testing.ts bu dosyayı aynen çalıştırır). Kurulum kodunun
-- tek kopyası olması, testin ürünle aynı yapılandırmayı sınamasını sağlar.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO stok_app', current_database());
END
$$;

GRANT USAGE  ON SCHEMA public  TO stok_app;

-- Bundan sonra 'postgres' tarafından public şemasında oluşturulan her tablo,
-- otomatik olarak stok_app'e veri yetkisi verir. Migration'da tek tek
-- GRANT yazmayı unutma riski böylece ortadan kalkar.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stok_app;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO stok_app;

-- İSTİSNA: stock_movements üzerinde UPDATE ve DELETE, tablo oluşturulduktan
-- sonra migration içinde GERİ ALINIR (append-only ledger, PLAN.md Bölüm 1).
-- Burada yapılamaz çünkü tablo henüz yok.
