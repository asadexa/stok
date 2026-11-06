-- T223 — depo transferi (atanmamış stoğu depoya atama). Yalnız ekleme ve CHECK
-- GENİŞLETME: boş olabilen `transfer_id` sütunu, yeni TRANSFER_IN/TRANSFER_OUT
-- sebepleri ve "transfer sebebi ⇔ transfer_id dolu" kuralı. Eski satırların
-- sebebi yeni listenin alt kümesi ve `transfer_id`'leri boş; yeniden eklenen
-- CHECK'ler onları reddetmiyor. Defter satırı güncellenmiyor (INV-2).
-- GERİ DÖNÜŞ SINIRI: transfer satırı yazıldıktan sonra bu sürümden önceki web
-- imajı yeni sebebi tanımıyor (runbook L.3).
ALTER TABLE "stock_movements" DROP CONSTRAINT "movements_reason_ck";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "transfer_id" uuid;--> statement-breakpoint
CREATE INDEX "movements_transfer_idx" ON "stock_movements" USING btree ("tenant_id","transfer_id") WHERE transfer_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "movements_transfer_id_ck" CHECK ((reason IN ('TRANSFER_IN', 'TRANSFER_OUT')) = (transfer_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "movements_reason_ck" CHECK (reason IN ('PURCHASE', 'RETURN_IN', 'OPENING', 'OTHER_IN', 'COUNT_ADJUST_UP', 'TRANSFER_IN', 'SALE', 'DAMAGE', 'RETURN_OUT', 'USAGE', 'OTHER_OUT', 'COUNT_ADJUST_DOWN', 'TRANSFER_OUT'));