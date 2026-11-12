-- GÖREV 019: kalite/kullanım kayıtlarına mağaza kapsamı
ALTER TABLE "quality_sets" ADD COLUMN "storeId" TEXT;
ALTER TABLE "quality_runs" ADD COLUMN "storeId" TEXT;
ALTER TABLE "llm_usages" ADD COLUMN "storeId" TEXT;

-- Mevcut kayıtlar tek mağazalı kurulumun mağazasına bağlanır (veri kaybı yok).
UPDATE "quality_sets" SET "storeId" = (SELECT "id" FROM "stores" ORDER BY "createdAt" ASC LIMIT 1) WHERE "storeId" IS NULL;
UPDATE "quality_runs" SET "storeId" = COALESCE((SELECT s."storeId" FROM "quality_sets" s WHERE s."id" = "quality_runs"."setId"), (SELECT "id" FROM "stores" ORDER BY "createdAt" ASC LIMIT 1)) WHERE "storeId" IS NULL;
UPDATE "llm_usages" SET "storeId" = (SELECT "id" FROM "stores" ORDER BY "createdAt" ASC LIMIT 1) WHERE "storeId" IS NULL;

CREATE INDEX "quality_sets_storeId_idx" ON "quality_sets"("storeId");
CREATE INDEX "quality_runs_storeId_idx" ON "quality_runs"("storeId");
CREATE INDEX "llm_usages_storeId_idx" ON "llm_usages"("storeId");
