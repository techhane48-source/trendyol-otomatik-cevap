-- CreateEnum
CREATE TYPE "OrderChangeStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_VERIFICATION', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "OrderChangeAction" AS ENUM ('CREATED', 'APPROVED', 'REJECTED', 'INVALIDATED', 'VERIFICATION_REQUIRED', 'NOTE');

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "shipmentPackageId" BIGINT,
    "status" TEXT NOT NULL,
    "rawStatus" TEXT,
    "orderedAt" TIMESTAMP(3),
    "customerRef" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "productId" TEXT,
    "productMainId" TEXT,
    "productName" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_change_requests" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "questionId" TEXT,
    "orderId" TEXT,
    "orderNumber" TEXT NOT NULL,
    "shipmentPackageId" BIGINT,
    "lineId" TEXT,
    "originalWidthCm" INTEGER,
    "originalHeightCm" INTEGER,
    "requestedWidthCm" INTEGER,
    "requestedHeightCm" INTEGER,
    "orientationUncertain" BOOLEAN NOT NULL DEFAULT false,
    "status" "OrderChangeStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "orderStatusAtRequest" TEXT,
    "orderStatusAtApproval" TEXT,
    "ownershipVerified" BOOLEAN NOT NULL DEFAULT false,
    "matchNote" TEXT,
    "createdBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_change_events" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "action" "OrderChangeAction" NOT NULL,
    "actor" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_change_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orders_storeId_status_idx" ON "orders"("storeId", "status");

-- CreateIndex
CREATE INDEX "orders_orderNumber_idx" ON "orders"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_storeId_orderNumber_shipmentPackageId_key" ON "orders"("storeId", "orderNumber", "shipmentPackageId");

-- CreateIndex
CREATE INDEX "order_lines_productMainId_idx" ON "order_lines"("productMainId");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_orderId_lineId_key" ON "order_lines"("orderId", "lineId");

-- CreateIndex
CREATE INDEX "order_change_requests_storeId_status_idx" ON "order_change_requests"("storeId", "status");

-- CreateIndex
CREATE INDEX "order_change_requests_orderNumber_idx" ON "order_change_requests"("orderNumber");

-- CreateIndex
CREATE INDEX "order_change_requests_questionId_idx" ON "order_change_requests"("questionId");

-- CreateIndex
CREATE INDEX "order_change_events_requestId_createdAt_idx" ON "order_change_events"("requestId", "createdAt");

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_change_requests" ADD CONSTRAINT "order_change_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_change_requests" ADD CONSTRAINT "order_change_requests_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_change_events" ADD CONSTRAINT "order_change_events_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "order_change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
