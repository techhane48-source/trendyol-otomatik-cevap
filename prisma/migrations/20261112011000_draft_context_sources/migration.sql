ALTER TABLE "answer_drafts" ADD COLUMN IF NOT EXISTS "contextSources" JSONB;
ALTER TABLE "answer_drafts" ADD COLUMN IF NOT EXISTS "orderMatch" TEXT;
