-- ============================================================================
-- Planın üç temel garantisi. Uygulama koduna değil, veritabanına gömülü.
--
--   1. LEDGER DEĞİŞTİRİLEMEZ   stock_movements append-only
--   2. PROJEKSİYON OTOMATİK    current_stock her zaman ledger'a eşit
--   3. TENANT İZOLASYONU       RLS, uygulama filtresine güvenmeden
--
-- Bunların uygulama katmanında olmamasının nedeni: uygulama kodu unutabilir,
-- veritabanı unutmaz. "Sorguda filtre koymayı unutmam" bir güvenlik
-- stratejisi değildir.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 0. Türkçe arama index'i
--    Drizzle'ın index() API'si `USING GIN (col gin_trgm_ops)` ifade edemiyor,
--    bu yüzden elle. products.name_norm generated column, tr_norm(name).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS products_name_norm_trgm_idx
  ON products USING GIN (name_norm gin_trgm_ops);
--> statement-breakpoint

-- SKU araması da aynı normalizasyondan geçsin (ifade index'i).
CREATE INDEX IF NOT EXISTS products_sku_norm_trgm_idx
  ON products USING GIN (tr_norm(sku) gin_trgm_ops);
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 1. LEDGER DEĞİŞTİRİLEMEZLİĞİ
--
--    İki katman:
--      a) Yetki: stok_app'ten UPDATE ve DELETE geri alınır
--      b) Trigger: yetki bir şekilde verilse bile exception fırlatır
--
--    Admin bile logu değiştiremez. Değiştirebilseydi "kim ne yaptı" ekranı
--    hiçbir şey ispat etmezdi ve ürünün ana değer önerisi çökerdi.
--
--    Düzeltme yolu: silme değil, TERS HAREKET (reverses_id ile bağlı).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION raise_immutable_ledger() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'stock_movements append-only bir defterdir, % islemi engellendi', TG_OP
    USING ERRCODE   = 'restrict_violation',
          HINT      = 'Duzeltme icin ters hareket yazin (reverses_id).',
          TABLE     = 'stock_movements';
END
$$;
--> statement-breakpoint

CREATE TRIGGER movements_no_mutate
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION raise_immutable_ledger();
--> statement-breakpoint

REVOKE UPDATE, DELETE ON stock_movements FROM stok_app;
--> statement-breakpoint

-- current_stock türetilmiş veri. Satır silmek invariant'ı bozar,
-- meşru bir kullanımı yok.
REVOKE DELETE ON current_stock FROM stok_app;
--> statement-breakpoint

-- Tenant kaydı açmak bir provisioning işlemi, uygulama işi değil.
REVOKE INSERT, UPDATE, DELETE ON tenants FROM stok_app;
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 2. PROJEKSİYON
--
--    current_stock, stock_movements'tan TÜRETİLİR. Trigger tercih edildi
--    çünkü invariant hareketi KİMİN yazdığından bağımsız korunmalı:
--    psql'den elle atılan bir INSERT bile projeksiyonu günceller.
--
--    Uygulama katmanında yapılsaydı, tek bir kod yolu bunu atladığında
--    stok sessizce yanlışa kayardı ve bunu ancak sayım tutmayınca fark
--    ederdik.
--
--    INSERT ... ON CONFLICT DO UPDATE atomiktir ve satır kilidini kendisi
--    alır. Yarış durumu yok.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_movement_to_stock() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO current_stock (tenant_id, product_id, qty, last_movement_at)
  VALUES (NEW.tenant_id, NEW.product_id, NEW.delta, NEW.created_at)
  ON CONFLICT (tenant_id, product_id) DO UPDATE
    SET qty = current_stock.qty + EXCLUDED.qty,
        last_movement_at = GREATEST(
          COALESCE(current_stock.last_movement_at, EXCLUDED.last_movement_at),
          EXCLUDED.last_movement_at
        );
  RETURN NULL;  -- AFTER trigger: donus degeri yok sayilir
END
$$;
--> statement-breakpoint

CREATE TRIGGER movements_apply_projection
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_movement_to_stock();
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 3. TENANT İZOLASYONU (RLS)
--
--    KRİTİK: RLS politikası yazmak TEK BAŞINA YETMEZ. Uygulama 'postgres'
--    veya Supabase 'service_role' ile baglanirsa o rol RLS'i atlar ve
--    yazilan her politika sessizce devre disi kalir. Tek tenant'la test
--    ederken bu ASLA fark edilmez.
--
--    Bu yuzden:
--      • uygulama stok_app olarak baglanir (BYPASSRLS yok, sahip degil)
--      • FORCE ROW LEVEL SECURITY: sahip rol de politikalara tabi olur
--        (Supabase'de sahip superuser olmayabilir, orada bu sart)
--
--    current_tenant_id() ayarlanmamissa NULL doner. `tenant_id = NULL`
--    sonucu NULL'dir, yani satir GECMEZ. Yanlis yapilandirmada sistem
--    veri sizdirmaz, bos doner. Guvenli varsayilan bu yonde.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$
  -- NULLIF: bos string ''::uuid cast hatasi verirdi, NULL'a ceviriyoruz.
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
--> statement-breakpoint

COMMENT ON FUNCTION current_tenant_id() IS
  'Oturumun tenant kimligi. withTenant() SET LOCAL ile ayarlar. Ayarli degilse NULL, politikalar hicbir satir gecirmez.';
--> statement-breakpoint

-- tenants: kendi kaydindan baskasini goremez (tenant_id degil, id ile eslesir)
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_tenant_id());
--> statement-breakpoint

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON users
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE locations FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON locations
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE products FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON products
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint

ALTER TABLE product_barcodes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE product_barcodes FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON product_barcodes
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stock_movements FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON stock_movements
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint

ALTER TABLE current_stock ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE current_stock FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON current_stock
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
