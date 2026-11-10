-- AlterEnum
ALTER TYPE "DraftStatus" ADD VALUE 'NEEDS_INFO';

-- AlterTable
ALTER TABLE "answer_drafts" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "estimatedCostUSD" DOUBLE PRECISION,
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "totalTokens" INTEGER,
ADD COLUMN     "usageEstimated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "llm_usages" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "durationMs" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "estimatedCostUSD" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "draftId" TEXT,
    "questionId" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_sets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "sampleQuestionIds" JSONB,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_runs" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "totalCostUSD" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "quality_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_items" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "questionId" TEXT,
    "questionMasked" TEXT NOT NULL,
    "answerText" TEXT NOT NULL,
    "autoChecks" JSONB,
    "outcome" TEXT NOT NULL DEFAULT 'OK',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUSD" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "humanScore" INTEGER,
    "humanNote" TEXT,
    "evaluatedBy" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_usages_createdAt_idx" ON "llm_usages"("createdAt");

-- CreateIndex
CREATE INDEX "llm_usages_provider_model_idx" ON "llm_usages"("provider", "model");

-- CreateIndex
CREATE INDEX "llm_usages_purpose_idx" ON "llm_usages"("purpose");

-- CreateIndex
CREATE INDEX "quality_runs_setId_startedAt_idx" ON "quality_runs"("setId", "startedAt");

-- CreateIndex
CREATE INDEX "quality_items_runId_idx" ON "quality_items"("runId");

-- AddForeignKey
ALTER TABLE "quality_runs" ADD CONSTRAINT "quality_runs_setId_fkey" FOREIGN KEY ("setId") REFERENCES "quality_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_items" ADD CONSTRAINT "quality_items_runId_fkey" FOREIGN KEY ("runId") REFERENCES "quality_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
