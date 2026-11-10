-- CreateEnum
CREATE TYPE "ProductInfoStatus" AS ENUM ('DRAFT', 'VERIFIED');

-- CreateEnum
CREATE TYPE "ProductInfoAction" AS ENUM ('CREATED', 'UPDATED', 'VERIFIED', 'UNVERIFIED');

-- AlterTable
ALTER TABLE "answer_drafts" ADD COLUMN     "missingInfo" JSONB,
ADD COLUMN     "productInfoId" TEXT,
ADD COLUMN     "productMatch" TEXT,
ADD COLUMN     "usedFacts" JSONB;

-- CreateTable
CREATE TABLE "product_infos" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productMainId" TEXT NOT NULL,
    "productId" TEXT,
    "title" TEXT,
    "attributes" JSONB,
    "notes" TEXT,
    "status" "ProductInfoStatus" NOT NULL DEFAULT 'DRAFT',
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_infos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_info_events" (
    "id" TEXT NOT NULL,
    "productInfoId" TEXT NOT NULL,
    "action" "ProductInfoAction" NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_info_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_infos_storeId_status_idx" ON "product_infos"("storeId", "status");

-- CreateIndex
CREATE INDEX "product_infos_productMainId_idx" ON "product_infos"("productMainId");

-- CreateIndex
CREATE UNIQUE INDEX "product_infos_storeId_productMainId_productId_key" ON "product_infos"("storeId", "productMainId", "productId");

-- CreateIndex
CREATE INDEX "product_info_events_productInfoId_createdAt_idx" ON "product_info_events"("productInfoId", "createdAt");

-- AddForeignKey
ALTER TABLE "product_infos" ADD CONSTRAINT "product_infos_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_info_events" ADD CONSTRAINT "product_info_events_productInfoId_fkey" FOREIGN KEY ("productInfoId") REFERENCES "product_infos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_drafts" ADD CONSTRAINT "answer_drafts_productInfoId_fkey" FOREIGN KEY ("productInfoId") REFERENCES "product_infos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
