-- T218 — envanter dosyası aktarımı. Yalnız ekleme ve CHECK GENİŞLETME: mevcut
-- aktarım kayıtları `kind` = 'PRODUCT' alıyor (sabit varsayılan, tablo yeniden
-- yazılmıyor) ve eski durum/karar değerleri yeni listelerin alt kümesi, yani
-- yeniden eklenen CHECK'ler eski satırları reddetmiyor. Ürün, stok ve defter
-- tablolarına dokunulmuyor.
ALTER TABLE "import_run_rows" DROP CONSTRAINT "import_run_rows_status_ck";--> statement-breakpoint
ALTER TABLE "import_run_rows" DROP CONSTRAINT "import_run_rows_action_ck";--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "kind" text DEFAULT 'PRODUCT' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "import_run_rows" ADD CONSTRAINT "import_run_rows_status_ck" CHECK (status IN ('PENDING', 'IN_PROGRESS', 'DONE', 'INVALID', 'FAILED', 'CONFLICT', 'UNCERTAIN', 'SKIPPED'));--> statement-breakpoint
ALTER TABLE "import_run_rows" ADD CONSTRAINT "import_run_rows_action_ck" CHECK ((action IS NULL OR action IN ('create', 'update', 'error', 'unchanged', 'unassigned')));--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_kind_ck" CHECK (kind IN ('PRODUCT', 'INVENTORY'));