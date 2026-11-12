-- GÖREV 018: çok mağazalı SaaS altyapısı
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'SUPPORT');

ALTER TYPE "WorkCategory" ADD VALUE IF NOT EXISTS 'HUMAN_REVIEW';
ALTER TYPE "WorkCategory" ADD VALUE IF NOT EXISTS 'ACTION_REQUEST';

CREATE TABLE "users" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "name" TEXT,
  "role" "UserRole" NOT NULL DEFAULT 'SUPPORT',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_storeId_email_key" ON "users"("storeId", "email");
CREATE INDEX "users_email_idx" ON "users"("email");

CREATE TABLE "sessions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userAgent" TEXT,
  "ipHash" TEXT,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "login_attempts" (
  "id" TEXT NOT NULL,
  "emailHash" TEXT NOT NULL,
  "userId" TEXT,
  "success" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "login_attempts_emailHash_createdAt_idx" ON "login_attempts"("emailHash", "createdAt");
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "store_settings" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "workflow" JSONB,
  "requestTypes" JSONB,
  "orderRules" JSONB,
  "modules" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "store_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_settings_storeId_key" ON "store_settings"("storeId");
ALTER TABLE "store_settings" ADD CONSTRAINT "store_settings_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_items" ADD COLUMN "requestTypeKey" TEXT;

-- Mevcut iş kayıtlarını yeni kategori yapısına taşı (veri kaybı yok).
UPDATE "work_items" SET "category" = 'HUMAN_REVIEW' WHERE "category" = 'SUPPORT';
UPDATE "work_items" SET "category" = 'ACTION_REQUEST' WHERE "category" = 'WORKSHOP';
UPDATE "work_items" SET "team" = 'Müşteri Temsilcisi' WHERE "team" = 'Atölye';
UPDATE "work_items" SET "requestTypeKey" = 'measure_change' WHERE "category" = 'ACTION_REQUEST';

-- Tüm mevcut mağazalar için varsayılan genel yapılandırma (sektörden bağımsız).
INSERT INTO "store_settings" ("id", "storeId", "workflow", "requestTypes", "orderRules", "modules", "createdAt", "updatedAt")
SELECT
  'set_' || s."id",
  s."id",
  '[{"key":"auto_candidate","label":"Otomatik cevap adayı","category":"AUTO_CANDIDATE","team":"AI"},
    {"key":"human_review","label":"İnsan incelemesi","category":"HUMAN_REVIEW","team":"Müşteri Temsilcisi"},
    {"key":"action_request","label":"İşlem talebi","category":"ACTION_REQUEST","team":"İşlem Ekibi"},
    {"key":"needs_info","label":"Bilgi eksik","category":"NEEDS_INFO","team":"Müşteri Temsilcisi"}]'::jsonb,
  '[{"key":"generic_action","label":"Genel işlem talebi"}]'::jsonb,
  '{"changeRequest":{"allowedStatuses":[],"blockedStatuses":["Cancelled","Returned"],"unknown":"HUMAN_REVIEW","humanReviewOnUnknown":true}}'::jsonb,
  '{"showcase":true,"catalog":true,"changeRequests":true,"workQueue":true}'::jsonb,
  now(), now()
FROM "stores" s
ON CONFLICT ("storeId") DO NOTHING;
