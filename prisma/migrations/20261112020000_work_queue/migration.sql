CREATE TYPE "WorkCategory" AS ENUM ('AUTO_CANDIDATE', 'SUPPORT', 'WORKSHOP', 'NEEDS_INFO');
CREATE TYPE "WorkStatus" AS ENUM ('NEW', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'DONE');
CREATE TYPE "WorkPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "ProductionStage" AS ENUM ('NOT_STARTED', 'CUTTING', 'SEWING', 'PACKED', 'SHIPPED');

CREATE TABLE "work_items" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "category" "WorkCategory" NOT NULL,
  "team" TEXT NOT NULL,
  "priority" "WorkPriority" NOT NULL DEFAULT 'NORMAL',
  "status" "WorkStatus" NOT NULL DEFAULT 'NEW',
  "reasons" JSONB,
  "orderNumber" TEXT,
  "orderMatch" TEXT,
  "orderStatusAtClassify" TEXT,
  "sources" JSONB,
  "draftId" TEXT,
  "assignedTo" TEXT,
  "productionStage" "ProductionStage",
  "productionStageAt" TIMESTAMP(3),
  "productionStageBy" TEXT,
  "firstReviewAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "work_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_items_questionId_key" ON "work_items"("questionId");
CREATE INDEX "work_items_storeId_status_idx" ON "work_items"("storeId", "status");
CREATE INDEX "work_items_storeId_category_idx" ON "work_items"("storeId", "category");
CREATE INDEX "work_items_storeId_priority_idx" ON "work_items"("storeId", "priority");

CREATE TABLE "work_item_events" (
  "id" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_item_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "work_item_events_workItemId_createdAt_idx" ON "work_item_events"("workItemId", "createdAt");
ALTER TABLE "work_item_events" ADD CONSTRAINT "work_item_events_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
