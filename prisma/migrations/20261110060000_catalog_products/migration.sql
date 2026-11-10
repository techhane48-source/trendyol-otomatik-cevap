-- Trendyol kataloğundan salt okunur ürün anlık görüntüsü.
CREATE TABLE IF NOT EXISTS "catalog_products" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "productMainId" TEXT NOT NULL,
  "title" TEXT,
  "brand" TEXT,
  "categoryName" TEXT,
  "description" TEXT,
  "barcodeSample" TEXT,
  "variantCount" INTEGER NOT NULL DEFAULT 0,
  "truncated" BOOLEAN NOT NULL DEFAULT false,
  "attributes" JSONB,
  "attributeNames" JSONB,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  CONSTRAINT "catalog_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "catalog_products_storeId_productMainId_key"
  ON "catalog_products"("storeId", "productMainId");
CREATE INDEX IF NOT EXISTS "catalog_products_storeId_idx" ON "catalog_products"("storeId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'catalog_products_storeId_fkey'
  ) THEN
    ALTER TABLE "catalog_products"
      ADD CONSTRAINT "catalog_products_storeId_fkey"
      FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
