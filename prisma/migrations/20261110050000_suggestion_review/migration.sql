-- Çelişki ile belirsizliği ayır: yanlış çelişki tespitini düzeltmek için ayrı bayrak.
ALTER TABLE "product_field_suggestions"
  ADD COLUMN IF NOT EXISTS "needsReview" BOOLEAN NOT NULL DEFAULT false;
