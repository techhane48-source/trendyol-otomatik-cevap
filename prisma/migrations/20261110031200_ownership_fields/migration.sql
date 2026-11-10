ALTER TABLE "order_change_requests"
  ADD COLUMN IF NOT EXISTS "ownershipVerifiedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "ownershipVerifiedAt" TIMESTAMP(3);
