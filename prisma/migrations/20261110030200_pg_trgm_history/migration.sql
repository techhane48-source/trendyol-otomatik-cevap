-- Türkçe anlamsal benzerlik için trigram altyapısı.
-- Not: pg_trgm Türkçe ekleri köklemez; bu yüzden arama, trigram + kelime örtüşmesi ve
-- ürün önceliği birlikte kullanılarak yapılır (bkz. src/lib/history/search.ts).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "questions_text_trgm_idx" ON "questions" USING GIN ("text" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "questions_answerText_trgm_idx" ON "questions" USING GIN ("answerText" gin_trgm_ops);
