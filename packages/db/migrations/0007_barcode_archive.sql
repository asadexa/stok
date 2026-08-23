-- ============================================================================
-- BARKOD ARŞİVLEME + İKİ YÖNLÜ ÇARPAN KURALI (T21)
--
-- 1) product_barcodes.archived_at
--    Barkod yönetimi "sil" düğmesi istiyor ama gerçek DELETE burada
--    çalışmaz: stock_movements.barcode_id bu satıra FK ile bağlı ("koli mi
--    birim mi okutuldu" bilgisi denetimde aranıyor) ve hareketi olan bir
--    barkodun silinmesi 23503 ile patlar — kullanıcı 500 görür. Ürünlerde
--    verilen kararın aynısı: silme yok, arşivleme var.
--
-- 2) barcodes_tenant_barcode_uq artık KISMİ (WHERE archived_at IS NULL)
--    Tam index kalsaydı, yanlış ürüne bağlanmış bir barkod arşivlendikten
--    sonra doğru ürüne bir daha eklenemezdi. Etiket rafın üstünde duruyor;
--    onu doğru ürüne bağlayamamak kabul edilemez.
--
-- 3) barcodes_case_multiplier_ck iki yönlü oldu
--    Eskiden sadece "koli çarpanı > 1" zorlanıyordu. Ters yönü de kapatıldı:
--    tekli/EAN/dahili barkodun çarpanı tam olarak 1 olmalı. Çarpanı 12 olan
--    bir TEKLİ barkod, tek kalem okutulduğunda stoğu 12 artırırdı ve sayı
--    makul göründüğü için kimse fark etmezdi — D7'nin aynadaki hali.
--    Mevcut veri bu kuralı zaten sağlıyor (UNIT satırlarının hepsi 1).
-- ============================================================================

ALTER TABLE "product_barcodes" DROP CONSTRAINT "barcodes_case_multiplier_ck";--> statement-breakpoint
DROP INDEX "barcodes_tenant_barcode_uq";--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "barcodes_tenant_barcode_uq" ON "product_barcodes" USING btree ("tenant_id","barcode") WHERE archived_at IS NULL;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "barcodes_case_multiplier_ck" CHECK (CASE WHEN kind IN ('CASE') THEN qty_multiplier > 1 ELSE qty_multiplier = 1 END);