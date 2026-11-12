-- Aura Perde'ye özel işlem türleri ve sipariş kuralları (yalnızca bu mağaza).
UPDATE "store_settings" SET
  "requestTypes" = '[{"key":"measure_change","label":"Ölçü değişikliği"},{"key":"sewing_change","label":"Dikim değişikliği"},{"key":"accessory_add","label":"Aksesuar ekleme"}]'::jsonb,
  "orderRules" = '{"changeRequest":{"allowedStatuses":["Created"],"blockedStatuses":["Picking","Invoiced","Shipped","Delivered","Cancelled","Returned","UnSupplied"],"unknown":"HUMAN_REVIEW","humanReviewOnUnknown":true}}'::jsonb,
  "updatedAt" = now()
WHERE "storeId" IN (SELECT "id" FROM "stores" WHERE "sellerId" = 1081168);
