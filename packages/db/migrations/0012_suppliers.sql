-- ============================================================================
-- T200 — B2B V1: TEDARİKÇİ VERİSİ (PRD-14, ADR-006)
--
-- YALNIZ EKLEME (DAT-13): üç yeni tablo, var olan hiçbir tabloya dokunulmuyor.
-- Eski kod bu tabloları görmez; karışık sürüm güvenli. Geri dönüş: kodu geri
-- almak yeter, boş tablolar zararsız kalır. Tablo silmek ayrı ve açık onaylı
-- bir iştir, bu migration'ın parçası değil.
--
-- Tablo tanımları drizzle-kit'in üretimi; RLS ve yetki satırları (dosyanın
-- sonu) elle, 0006'daki gibi: Drizzle RLS ifadesi üretmiyor.
-- ============================================================================

CREATE TABLE "supplier_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_code" text NOT NULL,
	"barcode" text,
	"name" text NOT NULL,
	"brand" text,
	"price" numeric(14, 4) NOT NULL,
	"currency" text NOT NULL,
	"tax_mode" text NOT NULL,
	"price_type" text NOT NULL,
	"price_qty" numeric(14, 3),
	"stock_qty" numeric(14, 3),
	"source_updated_at" timestamp with time zone,
	"fetched_at" timestamp with time zone NOT NULL,
	"product_id" uuid,
	"match_state" text DEFAULT 'UNMATCHED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_items_currency_ck" CHECK (currency IN ('TRY', 'USD', 'EUR')),
	CONSTRAINT "supplier_items_tax_mode_ck" CHECK (tax_mode IN ('INCLUDED', 'EXCLUDED')),
	CONSTRAINT "supplier_items_price_type_ck" CHECK (price_type IN ('NET', 'LIST')),
	CONSTRAINT "supplier_items_match_state_ck" CHECK (match_state IN ('AUTO', 'MANUAL', 'UNMATCHED', 'IGNORED')),
	CONSTRAINT "supplier_items_match_link_ck" CHECK ((product_id IS NOT NULL) = (match_state IN ('AUTO', 'MANUAL'))),
	CONSTRAINT "supplier_items_price_ck" CHECK (price > 0),
	CONSTRAINT "supplier_items_price_qty_ck" CHECK (price_qty IS NULL OR price_qty > 0),
	CONSTRAINT "supplier_items_stock_ck" CHECK (stock_qty IS NULL OR stock_qty >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_price_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_item_id" uuid NOT NULL,
	"old_price" numeric(14, 4) NOT NULL,
	"old_currency" text NOT NULL,
	"old_tax_mode" text NOT NULL,
	"old_price_type" text NOT NULL,
	"old_price_qty" numeric(14, 3),
	"new_price" numeric(14, 4) NOT NULL,
	"new_currency" text NOT NULL,
	"new_tax_mode" text NOT NULL,
	"new_price_type" text NOT NULL,
	"new_price_qty" numeric(14, 3),
	"is_comparable" boolean GENERATED ALWAYS AS ((old_currency = new_currency
  AND old_tax_mode = new_tax_mode
  AND old_price_type = new_price_type
  AND old_price_qty IS NOT NULL
  AND new_price_qty IS NOT NULL
  AND old_price_qty = new_price_qty)) STORED,
	"change_pct" numeric GENERATED ALWAYS AS (CASE WHEN old_currency = new_currency
  AND old_tax_mode = new_tax_mode
  AND old_price_type = new_price_type
  AND old_price_qty IS NOT NULL
  AND new_price_qty IS NOT NULL
  AND old_price_qty = new_price_qty THEN round((new_price - old_price) * 100 / old_price, 1) END) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_price_changes_distinct_ck" CHECK ((old_price, old_currency, old_tax_mode, old_price_type, old_price_qty)
          IS DISTINCT FROM (new_price, new_currency, new_tax_mode, new_price_type, new_price_qty)),
	CONSTRAINT "supplier_price_changes_old_price_ck" CHECK (old_price > 0),
	CONSTRAINT "supplier_price_changes_new_price_ck" CHECK (new_price > 0),
	CONSTRAINT "supplier_price_changes_old_currency_ck" CHECK (old_currency IN ('TRY', 'USD', 'EUR')),
	CONSTRAINT "supplier_price_changes_new_currency_ck" CHECK (new_currency IN ('TRY', 'USD', 'EUR')),
	CONSTRAINT "supplier_price_changes_old_tax_mode_ck" CHECK (old_tax_mode IN ('INCLUDED', 'EXCLUDED')),
	CONSTRAINT "supplier_price_changes_new_tax_mode_ck" CHECK (new_tax_mode IN ('INCLUDED', 'EXCLUDED')),
	CONSTRAINT "supplier_price_changes_old_price_type_ck" CHECK (old_price_type IN ('NET', 'LIST')),
	CONSTRAINT "supplier_price_changes_new_price_type_ck" CHECK (new_price_type IN ('NET', 'LIST'))
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_norm" text GENERATED ALWAYS AS (tr_norm(name)) STORED,
	"default_currency" text NOT NULL,
	"default_tax_mode" text NOT NULL,
	"default_price_type" text NOT NULL,
	"unit_price_declared" boolean DEFAULT false NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_currency_ck" CHECK (default_currency IN ('TRY', 'USD', 'EUR')),
	CONSTRAINT "suppliers_tax_mode_ck" CHECK (default_tax_mode IN ('INCLUDED', 'EXCLUDED')),
	CONSTRAINT "suppliers_price_type_ck" CHECK (default_price_type IN ('NET', 'LIST'))
);
--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_price_changes" ADD CONSTRAINT "supplier_price_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_price_changes" ADD CONSTRAINT "supplier_price_changes_supplier_item_id_supplier_items_id_fk" FOREIGN KEY ("supplier_item_id") REFERENCES "public"."supplier_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_items_code_uq" ON "supplier_items" USING btree ("tenant_id","supplier_id","supplier_code");--> statement-breakpoint
CREATE INDEX "supplier_items_product_idx" ON "supplier_items" USING btree ("tenant_id","product_id") WHERE product_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "supplier_price_changes_item_idx" ON "supplier_price_changes" USING btree ("tenant_id","supplier_item_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_tenant_name_uq" ON "suppliers" USING btree ("tenant_id","name_norm");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- KİRACI İZOLASYONU (INV-4, ADR-002). Tedarikçi fiyatı alış fiyatı
-- niteliğinde: bir işletmenin pazarlık ettiği fiyat başka işletmede
-- görünemez. `rls.test.ts`'in FORCE taraması bu satırlar unutulursa kırmızı
-- yanar.
-- ---------------------------------------------------------------------------
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE suppliers FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON suppliers
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE supplier_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE supplier_items FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON supplier_items
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE supplier_price_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE supplier_price_changes FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON supplier_price_changes
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint

-- Fiyat geçmişi APPEND-ONLY. Varsayılan yetkiler (db/init/01-roles.sql)
-- uygulama rolüne UPDATE ve DELETE de veriyor; burada geri alınıyor.
-- Geçmiş bir pazarlıkta kanıt: uygulama onu düzeltemez, yalnız yeni satır ekler.
REVOKE UPDATE, DELETE ON supplier_price_changes FROM stok_app;