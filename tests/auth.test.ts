import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACCESS_COOKIE_NAME,
  checkAccess,
  checkRequestAccess,
  extractBearerToken,
  getAccessMode,
  getAccessToken,
  tokensMatch,
} from "@/lib/auth";

const originalEnv = { ...process.env };

/** NODE_ENV, @types/node tarafından salt-okunur tanımlanır. */
function setNodeEnv(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

beforeEach(() => {
  delete process.env.APP_ACCESS_TOKEN;
  setNodeEnv("test");
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("erişim kapısı — yapılandırma", () => {
  it("anahtar tanımlı olduğunda mod 'enforced'", () => {
    process.env.APP_ACCESS_TOKEN = "0123456789abcdef";
    expect(getAccessToken()).toBe("0123456789abcdef");
    expect(getAccessMode()).toBe("enforced");
  });

  it("boş/anlamsız anahtar tanımsız sayılır", () => {
    process.env.APP_ACCESS_TOKEN = "   ";
    expect(getAccessToken()).toBeNull();
  });

  it("geliştirmede anahtar yoksa erişim açık", () => {
    setNodeEnv("development");
    expect(getAccessMode()).toBe("open-dev");
    expect(checkAccess(null)).toEqual({ ok: true, mode: "open-dev" });
  });

  it("üretimde anahtar yoksa fail-closed (503)", () => {
    setNodeEnv("production");
    expect(getAccessMode()).toBe("misconfigured");

    const result = checkAccess("herhangi-bir-anahtar");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toContain("APP_ACCESS_TOKEN");
    }
  });
});

describe("erişim kapısı — doğrulama", () => {
  beforeEach(() => {
    process.env.APP_ACCESS_TOKEN = "dogru-anahtar-123456";
  });

  it("anahtarsız istek 401", () => {
    const result = checkAccess(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("yanlış anahtar 401", () => {
    const result = checkAccess("yanlis-anahtar-12345");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("doğru anahtar kabul edilir", () => {
    expect(checkAccess("dogru-anahtar-123456").ok).toBe(true);
  });

  it("Bearer başlığı ayrıştırılır ve kabul edilir", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("Token abc")).toBeNull();
    expect(extractBearerToken(null)).toBeNull();

    expect(
      checkRequestAccess({ authorization: "Bearer dogru-anahtar-123456", cookieToken: null }).ok,
    ).toBe(true);
  });

  it("çerez üzerinden gelen anahtar kabul edilir", () => {
    expect(
      checkRequestAccess({ authorization: null, cookieToken: "dogru-anahtar-123456" }).ok,
    ).toBe(true);
    expect(ACCESS_COOKIE_NAME).toBe("ty_access");
  });

  it("hata mesajı anahtarın kendisini içermez", () => {
    const result = checkAccess("yanlis-anahtar-12345");
    if (!result.ok) {
      expect(result.error).not.toContain("dogru-anahtar-123456");
    }
  });

  it("sabit zamanlı karşılaştırma farklı uzunlukta false döner", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch("", "")).toBe(false);
  });
});
