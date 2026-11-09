-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('WAITING_FOR_ANSWER', 'ANSWERED', 'REJECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "stores" (
    "id" TEXT NOT NULL,
    "sellerId" BIGINT NOT NULL,
    "name" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "trendyolQuestionId" BIGINT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "QuestionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "rawStatus" TEXT,
    "productName" TEXT,
    "productMainId" TEXT,
    "productId" TEXT,
    "customerId" TEXT,
    "answerText" TEXT,
    "askedAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "raw" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "status" "SyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "fetchedCount" INTEGER NOT NULL DEFAULT 0,
    "savedCount" INTEGER NOT NULL DEFAULT 0,
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "params" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stores_sellerId_key" ON "stores"("sellerId");

-- CreateIndex
CREATE INDEX "questions_storeId_status_idx" ON "questions"("storeId", "status");

-- CreateIndex
CREATE INDEX "questions_askedAt_idx" ON "questions"("askedAt");

-- CreateIndex
CREATE UNIQUE INDEX "questions_storeId_trendyolQuestionId_key" ON "questions"("storeId", "trendyolQuestionId");

-- CreateIndex
CREATE INDEX "sync_runs_storeId_startedAt_idx" ON "sync_runs"("storeId", "startedAt");

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
