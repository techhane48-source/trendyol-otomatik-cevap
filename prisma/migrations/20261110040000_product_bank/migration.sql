-- Ürün bilgi bankası: taslak çözüm sınıfı + geçmiş cevaplardan alan önerileri.

CREATE TYPE "DraftResolution" AS ENUM ('RESOLVED', 'NEEDS_INFO', 'GENERIC');
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

ALTER TABLE "answer_drafts" ADD COLUMN "resolution" "DraftResolution";

CREATE TABLE "product_field_suggestions" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "productMainId" TEXT NOT NULL,
  "productId" TEXT,
  "fieldKey" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "sourceQuestionIds" JSONB NOT NULL,
  "conflict" BOOLEAN NOT NULL DEFAULT false,
  "conflictValues" JSONB,
  "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_field_suggestions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_field_suggestions_storeId_productMainId_status_idx"
  ON "product_field_suggestions"("storeId", "productMainId", "status");

ALTER TABLE "product_field_suggestions"
  ADD CONSTRAINT "product_field_suggestions_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
