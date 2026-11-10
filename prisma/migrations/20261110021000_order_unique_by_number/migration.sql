-- Sipariş tekilliği sipariş numarası bazına alınır: aynı sipariş birden fazla paket
-- içerebilir, bu yüzden (storeId, orderNumber) tekil; paket kimliği ayrı indekstir.

DROP INDEX IF EXISTS "orders_storeId_orderNumber_shipmentPackageId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "orders_storeId_orderNumber_key"
  ON "orders" ("storeId", "orderNumber");

CREATE INDEX IF NOT EXISTS "orders_shipmentPackageId_idx"
  ON "orders" ("shipmentPackageId");
