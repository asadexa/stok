-- ============================================================================
-- SISTEM SAĞLIĞI ALARMI İŞ TÜRÜ (T36)
--
-- `background_jobs.kind` bir CHECK kısıtıyla sınırlı ve liste TEK KAYNAKTAN
-- (packages/shared/src/jobs.ts → JOB_KINDS) üretiliyor. Yeni tür eklemek
-- kısıtı da güncellemeyi gerektiriyor; kısıt olmasaydı yazım hatası olan bir
-- `kind` sessizce satır olur ve o iş HİÇ işlenmezdi — kuyrukta sonsuza kadar
-- bekleyen, kimsenin fark etmediği bir kayıt (G4).
--
-- Kısıt DÜŞÜRÜLÜP yeniden kuruluyor: PostgreSQL'de CHECK'i yerinde
-- değiştirmenin yolu yok. Tabloda veri varken de güvenli — yeni liste
-- eskisinin üst kümesi, yani var olan hiçbir satır kısıtı ihlal etmiyor.
-- ============================================================================

ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS jobs_kind_ck;
--> statement-breakpoint

ALTER TABLE background_jobs ADD CONSTRAINT jobs_kind_ck
  CHECK (kind IN ('STOCK_EXPORT', 'MOVEMENT_EXPORT', 'DAILY_REPORT', 'LOW_STOCK_SCAN', 'HEALTH_ALARM'));
