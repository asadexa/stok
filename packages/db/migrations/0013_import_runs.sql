CREATE TABLE "import_run_rows" (
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"cells" jsonb NOT NULL,
	"action" text,
	"sku" text,
	"name" text,
	"issues" jsonb,
	"warnings" jsonb,
	"data" jsonb,
	"product_id" uuid,
	"product_version" text,
	"opening" jsonb,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"opening_outcome" text,
	"message" text,
	"claimed_at" timestamp with time zone,
	"claim_token" uuid,
	"processed_at" timestamp with time zone,
	CONSTRAINT "import_run_rows_run_id_row_number_pk" PRIMARY KEY("run_id","row_number"),
	CONSTRAINT "import_run_rows_status_ck" CHECK (status IN ('PENDING', 'IN_PROGRESS', 'DONE', 'INVALID', 'FAILED', 'CONFLICT', 'UNCERTAIN')),
	CONSTRAINT "import_run_rows_action_ck" CHECK ((action IS NULL OR action IN ('create', 'update', 'error'))),
	CONSTRAINT "import_run_rows_opening_outcome_ck" CHECK ((opening_outcome IS NULL OR opening_outcome IN ('WRITTEN', 'SKIPPED', 'FAILED')))
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_bytes" integer NOT NULL,
	"status" text DEFAULT 'UPLOADING' NOT NULL,
	"total_rows" integer NOT NULL,
	"columns" jsonb NOT NULL,
	"notices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previewed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "import_runs_status_ck" CHECK (status IN ('UPLOADING', 'PREVIEWED', 'RUNNING', 'DONE', 'CANCELLED')),
	CONSTRAINT "import_runs_total_rows_ck" CHECK (total_rows >= 0)
);
--> statement-breakpoint
ALTER TABLE "import_run_rows" ADD CONSTRAINT "import_run_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run_rows" ADD CONSTRAINT "import_run_rows_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_run_rows_status_idx" ON "import_run_rows" USING btree ("run_id","status","row_number");--> statement-breakpoint
CREATE INDEX "import_runs_tenant_created_idx" ON "import_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- KİRACI İZOLASYONU (INV-4, ADR-002). Aktarım satırları alış fiyatı içeriyor:
-- bir işletmenin dosyası başka işletmede görünemez. `rls.test.ts`'in FORCE
-- taraması bu satırlar unutulursa kırmızı yanar.
--
-- UPDATE ve DELETE uygulama rolünde KALIYOR (varsayılan yetkiler,
-- db/init/01-roles.sql): bu tablolar defter değil geçici iş kaydı; satır
-- durumları güncelleniyor ve 30 günlük temizlik siliyor (T171, K4).
-- ---------------------------------------------------------------------------
ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_runs FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON import_runs
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE import_run_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_run_rows FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON import_run_rows
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());