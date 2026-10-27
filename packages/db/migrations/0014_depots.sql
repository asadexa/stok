CREATE TABLE "depots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text GENERATED ALWAYS AS (tr_norm(regexp_replace(btrim(name), '\s+', ' ', 'g'))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "depots_name_ck" CHECK (char_length(btrim(name)) BETWEEN 1 AND 100 AND name !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "depot_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "import_run_id" uuid;--> statement-breakpoint
ALTER TABLE "depots" ADD CONSTRAINT "depots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "depots_tenant_name_key_uq" ON "depots" USING btree ("tenant_id","name_key");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_depot_id_depots_id_fk" FOREIGN KEY ("depot_id") REFERENCES "public"."depots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Elle sıralandı: drizzle-kit tekil indeksi yabancı anahtardan SONRA yazıyor,
-- PostgreSQL ise anahtarın hedefinde tekillik arıyor ve migration patlıyordu.
CREATE UNIQUE INDEX "import_runs_tenant_id_uq" ON "import_runs" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "movements_import_run_fk" FOREIGN KEY ("tenant_id","import_run_id") REFERENCES "public"."import_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "movements_import_run_idx" ON "stock_movements" USING btree ("tenant_id","import_run_id") WHERE import_run_id IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- KİRACI İZOLASYONU (INV-4, ADR-002). Depo adları işletmeye özel: bir
-- işletmenin deposu başka işletmenin hareket formunda görünemez.
-- `rls.test.ts`'in FORCE taraması bu satırlar unutulursa kırmızı yanar.
--
-- Mevcut hareketlere dokunulmuyor: `depot_id` ve `import_run_id` NULL
-- kalıyor. Eski stoğun deposu tahmin edilmiyor (NULL = depoya atanmamış).
-- ---------------------------------------------------------------------------
ALTER TABLE depots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE depots FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON depots
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());