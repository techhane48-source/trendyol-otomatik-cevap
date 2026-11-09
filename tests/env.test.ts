import { afterEach, describe, expect, it } from "vitest";

import { EnvValidationError, getEnv, resolveUserAgent, resetEnvCache } from "@/lib/env";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCache();
});

describe("ortam değişkeni doğrulaması", () => {
  it("geçerli değişkenlerle env döner ve varsayılanları uygular", () => {
    delete process.env.SYNC_PAGE_SIZE;

    const env = getEnv();

    expect(env.TRENDYOL_SELLER_ID).toBe("123456");
    expect(env.SYNC_PAGE_SIZE).toBe(50);
    expect(env.TRENDYOL_BASE_URL).toContain("trendyol");
  });

  it("sayısal olmayan sellerId reddedilir", () => {
    process.env.TRENDYOL_SELLER_ID = "abc";
    resetEnvCache();

    expect(() => getEnv()).toThrow(EnvValidationError);
  });

  it("eksik API anahtarında alan adı bildirilir, gizli değer sızdırılmaz", () => {
    delete process.env.TRENDYOL_API_SECRET;
    resetEnvCache();

    let caught: unknown;
    try {
      getEnv();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvValidationError);
    const message = (caught as Error).message;
    expect(message).toContain("TRENDYOL_API_SECRET");
    // Diğer gizli değerlerin içeriği mesaja sızmamalı
    expect(message).not.toContain(String(process.env.TRENDYOL_API_KEY));
  });

  it("User-Agent dokümana uygun varsayılanla üretilir", () => {
    const env = getEnv();
    expect(resolveUserAgent(env)).toBe("123456 - SelfIntegration");
  });
});
