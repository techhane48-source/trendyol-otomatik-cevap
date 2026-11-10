-- Ana ürün kartları için kısmi (partial) benzersizlik:
-- aynı mağazada aynı productMainId için yalnızca BİR adet productId IS NULL kartı olabilir.
--
-- Önce mükerrer kayıt kontrolü yapılır. Mükerrer varsa migration DURUR:
-- otomatik silme/birleştirme YAPILMAZ, yönetici karar verir.

DO $$
DECLARE
  duplicate RECORD;
BEGIN
  SELECT "storeId", "productMainId", COUNT(*) AS adet
    INTO duplicate
    FROM product_infos
   WHERE "productId" IS NULL
   GROUP BY "storeId", "productMainId"
  HAVING COUNT(*) > 1
   LIMIT 1;

  IF duplicate.adet IS NOT NULL THEN
    RAISE EXCEPTION
      'Mukerrer ana urun karti bulundu: storeId=%, productMainId=%, adet=%. Otomatik silme yapilmadi; kayitlari elle birlestirin veya silin, sonra migration tekrar calistirin.',
      duplicate."storeId", duplicate."productMainId", duplicate.adet;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS product_infos_main_unique
  ON product_infos ("storeId", "productMainId")
  WHERE "productId" IS NULL;
