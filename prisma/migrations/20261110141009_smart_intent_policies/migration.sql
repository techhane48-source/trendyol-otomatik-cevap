-- DropIndex
DROP INDEX "questions_answerText_trgm_idx";

-- DropIndex
DROP INDEX "questions_text_trgm_idx";

-- AlterTable
ALTER TABLE "answer_drafts" ADD COLUMN     "intent" TEXT,
ADD COLUMN     "policiesUsed" JSONB,
ADD COLUMN     "requiresHumanReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "strategy" TEXT;

-- CreateTable
CREATE TABLE "store_policies" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_policies_storeId_key_key" ON "store_policies"("storeId", "key");

-- AddForeignKey
ALTER TABLE "store_policies" ADD CONSTRAINT "store_policies_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
