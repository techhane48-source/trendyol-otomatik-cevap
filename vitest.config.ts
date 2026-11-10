import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { TEST_PG, connectionUrl } from "./scripts/embedded-pg";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    // Veritabanı testleri aynı PostgreSQL örneğini paylaştığı için sıralı çalışır.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: connectionUrl(TEST_PG),
      TRENDYOL_BASE_URL: "https://apigw.trendyol.test/integration/qna",
      TRENDYOL_SELLER_ID: "123456",
      TRENDYOL_API_KEY: "test-api-key",
      TRENDYOL_API_SECRET: "test-api-secret",
      SYNC_PAGE_SIZE: "50",
      SYNC_MAX_PAGES: "10",
      SYNC_MAX_RETRIES: "2",
      SYNC_RETRY_BASE_MS: "0",
      TRENDYOL_TIMEOUT_MS: "2000",
      LOG_LEVEL: "error",
      // Erişim kapısı artık her ortamda fail-closed; API testleri anahtarla çalışır.
      APP_ACCESS_TOKEN: "test-access-token-1234567890",
    },
  },
});
