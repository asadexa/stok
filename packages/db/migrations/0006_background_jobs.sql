CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" uuid,
	"notify_email" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"result" jsonb,
	"dedupe_key" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_kind_ck" CHECK (kind IN ('STOCK_EXPORT', 'MOVEMENT_EXPORT', 'DAILY_REPORT', 'LOW_STOCK_SCAN')),
	CONSTRAINT "jobs_status_ck" CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
	CONSTRAINT "jobs_attempts_ck" CHECK (attempts >= 0 AND attempts <= max_attempts)
);
--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_tenant_status_idx" ON "background_jobs" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "jobs_tenant_created_idx" ON "background_jobs" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_tenant_dedupe_uq" ON "background_jobs" USING btree ("tenant_id","dedupe_key") WHERE dedupe_key IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Drizzle RLS ifadesi üretmiyor; elle ekliyoruz. Bu tablo TENANT KAPSAMLI:
-- bir müşterinin başarısız gün sonu raporu başka müşterinin panelinde
-- görünemez. T46'nın "her tabloda RLS açık ve zorlanıyor" testi bu satırlar
-- unutulursa kırmızı yanar.
-- ---------------------------------------------------------------------------
ALTER TABLE background_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE background_jobs FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON background_jobs
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
