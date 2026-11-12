CREATE TYPE "IntegrationStatus" AS ENUM ('UNCONFIGURED', 'CONNECTED', 'ERROR', 'DISABLED');

CREATE TABLE "store_integrations" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "sellerId" BIGINT NOT NULL,
  "apiKeyEnc" TEXT NOT NULL,
  "apiSecretEnc" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "status" "IntegrationStatus" NOT NULL DEFAULT 'UNCONFIGURED',
  "lastCheckAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastError" TEXT,
  "lastSyncAt" TIMESTAMP(3),
  "lastSyncStatus" TEXT,
  "lastSyncError" TEXT,
  "syncLockedAt" TIMESTAMP(3),
  "disabledAt" TIMESTAMP(3),
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "store_integrations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_integrations_storeId_key" ON "store_integrations"("storeId");
ALTER TABLE "store_integrations" ADD CONSTRAINT "store_integrations_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
