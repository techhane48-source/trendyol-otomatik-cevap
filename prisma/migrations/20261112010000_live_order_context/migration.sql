-- GÖREV 016: canlı sipariş bağlamı alanları (hepsi nullable, veri kaybı yok)
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cargoProviderName" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cargoTrackingNumber" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cargoTrackingLink" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "estimatedDeliveryStart" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "estimatedDeliveryEnd" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "agreedDeliveryDate" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "lastModifiedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fetchedAt" TIMESTAMP(3);
