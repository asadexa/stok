-- ============================================================================
-- T88 — FİYAT DEFTERİ / KASA AÇIĞI KONTROLÜ
--
-- Defter bugüne kadar "kaç tane"yi kaydediyordu, "kaça"yı kaydetmiyordu.
-- `unit_cost` sütunu vardı ve `createMovement` kabul ediyordu, ama arayüz
-- alanı hiç sormuyordu: uygulamadan girilen her hareketin değeri NULL'du.
--
-- RENAME, DROP+ADD DEĞİL. Sütunda seed'in yazdığı gerçek fiyat verisi var ve
-- drop+create onu sessizce silerdi. drizzle-kit bu ayrımı etkileşimli soruyor;
-- cevaplanamayan bir ortamda üretilen migration veri kaybettirir. Bu dosyanın
-- elle yazılmasının sebebi bu.
-- ============================================================================

-- Anlam genişliyor: yön belirler (giriş = alış maliyeti, çıkış = satış
-- hasılatı). Çıkışta hasılat tutan bir sütuna "maliyet" demek kalıcı bir
-- yalan olur ve ilk muhasebeciyi yanıltır.
ALTER TABLE "stock_movements" RENAME COLUMN "unit_cost" TO "unit_price";--> statement-breakpoint

-- O günkü liste fiyatı, harekete DONDURULUYOR. Bu olmadan kontrol çürür:
-- products.sale_price sonradan 110 -> 120 olursa geçmişteki 10 TL'lik kasa
-- açığı geriye dönük 20 TL'ye dönüşür. Defter zaten bunun için append-only.
ALTER TABLE "stock_movements" ADD COLUMN "list_price" numeric(12, 2);--> statement-breakpoint

-- İstemcinin okutma anında GÖRDÜĞÜ fiyat. Sunucununkiyle farklıysa hareket
-- işaretlenir. Çevrimdışı senkronda (T28) satış günü ile senkron günü
-- arasında fiyat değişmişse fark sessiz kalmasın diye.
ALTER TABLE "stock_movements" ADD COLUMN "client_list_price" numeric(12, 2);--> statement-breakpoint

-- Fiyatın ait olduğu EKONOMİK an; created_at'ten ayrı olmak zorunda. 5 yıldır
-- elde tutulan mal bugün girilirken hareket bugün oluşur, fiyat 5 yıl
-- öncesine aittir. Tarihsiz fiyat enflasyona göre düzeltilemez (T89, T90).
ALTER TABLE "stock_movements" ADD COLUMN "price_date" date;--> statement-breakpoint

-- Fiyat nereden geldi. Fiş entegrasyonu geldiğinde şema hazır olsun diye
-- bugünden duruyor: sonradan eklenirse eski satırların kaynağı sonsuza
-- kadar bilinmez kalır.
ALTER TABLE "stock_movements" ADD COLUMN "price_source" text;--> statement-breakpoint

-- Sapma sebebi. Serbest metin DEĞİL, listeden: takip toplanabilirlik demek,
-- serbest metin "bu ay tanıdık indirimine kaç lira gitti"yi cevaplayamaz.
ALTER TABLE "stock_movements" ADD COLUMN "price_override_reason" text;--> statement-breakpoint

-- KONTROLÜN KALBİ. Sapma sebepsiz olamaz. Kural burada çünkü satırı kimin
-- yazdığından bağımsız korunmalı: uygulama, seed, /api/v1, elle SQL.
-- EPSİLON YOK (D6 iptal): fiyat elle yazılmıyor, barkoddan geliyor; otorite
-- sistemde olduğu için kazara sapma yok, bilinçli kararın toleransı olmaz.
ALTER TABLE "stock_movements" ADD CONSTRAINT "movements_price_override_ck" CHECK (unit_price IS NULL OR list_price IS NULL
          OR unit_price = list_price
          OR price_override_reason IS NOT NULL);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "movements_price_reason_ck" CHECK (price_override_reason IS NULL OR price_override_reason IN ('TANIDIK', 'TOPTAN', 'KAMPANYA', 'HASARLI', 'ESKI_STOK', 'YUVARLAMA', 'YONETICI_ONAYLI', 'DIGER'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "movements_price_source_ck" CHECK (price_source IS NULL OR price_source IN ('LIST', 'MANUAL', 'RECEIPT', 'INDEXED', 'ESTIMATED'));
