-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "DraftSource" AS ENUM ('AI', 'HUMAN_EDIT');

-- CreateEnum
CREATE TYPE "DraftAction" AS ENUM ('CREATED', 'EDITED', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "answer_drafts" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'PENDING',
    "source" "DraftSource" NOT NULL DEFAULT 'AI',
    "text" TEXT NOT NULL,
    "warnings" JSONB,
    "model" TEXT,
    "promptVersion" TEXT,
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "answer_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_events" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "action" "DraftAction" NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "answer_drafts_questionId_status_idx" ON "answer_drafts"("questionId", "status");

-- CreateIndex
CREATE INDEX "answer_drafts_storeId_status_idx" ON "answer_drafts"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "answer_drafts_questionId_revision_key" ON "answer_drafts"("questionId", "revision");

-- CreateIndex
CREATE INDEX "draft_events_draftId_createdAt_idx" ON "draft_events"("draftId", "createdAt");

-- AddForeignKey
ALTER TABLE "answer_drafts" ADD CONSTRAINT "answer_drafts_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_events" ADD CONSTRAINT "draft_events_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "answer_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
