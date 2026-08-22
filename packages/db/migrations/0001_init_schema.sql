CREATE TABLE "current_stock" (
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty" numeric(14, 3) DEFAULT '0' NOT NULL,
	"last_movement_at" timestamp with time zone,
	CONSTRAINT "current_stock_tenant_id_product_id_pk" PRIMARY KEY("tenant_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_barcodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"barcode" text NOT NULL,
	"kind" text DEFAULT 'UNIT' NOT NULL,
	"qty_multiplier" numeric(14, 3) DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "barcodes_kind_ck" CHECK (kind IN ('UNIT', 'CASE', 'EAN', 'INTERNAL')),
	CONSTRAINT "barcodes_multiplier_ck" CHECK (qty_multiplier > 0),
	CONSTRAINT "barcodes_case_multiplier_ck" CHECK (kind <> 'CASE' OR qty_multiplier > 1)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"name_norm" text GENERATED ALWAYS AS (tr_norm(name)) STORED,
	"category" text,
	"brand" text,
	"unit" text DEFAULT 'ADET' NOT NULL,
	"purchase_price" numeric(12, 2),
	"sale_price" numeric(12, 2),
	"min_stock" numeric(14, 3) DEFAULT '0' NOT NULL,
	"location_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_unit_ck" CHECK (unit IN ('ADET', 'KG', 'METRE', 'LITRE')),
	CONSTRAINT "products_min_stock_ck" CHECK (min_stock >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"barcode_id" uuid,
	"delta" numeric(14, 3) NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"location_id" uuid,
	"unit_cost" numeric(12, 2),
	"idempotency_key" text NOT NULL,
	"count_session_id" uuid,
	"reverses_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_created_at" timestamp with time zone,
	CONSTRAINT "movements_reason_ck" CHECK (reason IN ('PURCHASE', 'RETURN_IN', 'OPENING', 'OTHER_IN', 'COUNT_ADJUST_UP', 'SALE', 'DAMAGE', 'RETURN_OUT', 'USAGE', 'OTHER_OUT', 'COUNT_ADJUST_DOWN')),
	CONSTRAINT "movements_delta_nonzero_ck" CHECK (delta <> 0)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"password_hash" text,
	"pin_hash" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_ck" CHECK (role IN ('ADMIN', 'STAFF'))
);
--> statement-breakpoint
ALTER TABLE "current_stock" ADD CONSTRAINT "current_stock_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "current_stock" ADD CONSTRAINT "current_stock_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_barcode_id_product_barcodes_id_fk" FOREIGN KEY ("barcode_id") REFERENCES "public"."product_barcodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reverses_id_stock_movements_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."stock_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "current_stock_tenant_idx" ON "current_stock" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_tenant_code_uq" ON "locations" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "barcodes_tenant_barcode_uq" ON "product_barcodes" USING btree ("tenant_id","barcode");--> statement-breakpoint
CREATE INDEX "barcodes_product_idx" ON "product_barcodes" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_sku_uq" ON "products" USING btree ("tenant_id","sku");--> statement-breakpoint
CREATE INDEX "products_tenant_idx" ON "products" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "movements_tenant_idem_uq" ON "stock_movements" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "movements_tenant_created_idx" ON "stock_movements" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "movements_tenant_product_created_idx" ON "stock_movements" USING btree ("tenant_id","product_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "movements_tenant_user_created_idx" ON "stock_movements" USING btree ("tenant_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_uq" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");