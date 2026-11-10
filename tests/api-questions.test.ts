import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/questions/route";

const originalEnv = { ...process.env };

/** NODE_ENV, @types/node tarafından salt-okunur tanımlanır. */
function setNodeEnv(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

function questionsRequest(
  url = "http://localhost:3000/api/questions",
  token?: string,
  cookie?: string,
) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;

  return new NextRequest(url, { method: "GET", headers });
}

beforeEach(() => {
  // Erişim kapısı her ortamda fail-closed: testler geçerli anahtarla çalışır.
  process.env.APP_ACCESS_TOKEN = "test-erisim-anahtari";
  setNodeEnv("test");
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("GET /api/questions — erişim kontrolü", () => {
  it("anahtar tanımlıyken yetkisiz istek 401 döner", async () => {
    process.env.APP_ACCESS_TOKEN = "test-erisim-anahtari";

    const response = await GET(questionsRequest());

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Yetkilendirme gerekli");
  });

  it("doğru anahtarla geçersiz sorgu parametresi 400 döner", async () => {
    process.env.APP_ACCESS_TOKEN = "test-erisim-anahtari";

    const response = await GET(
      questionsRequest("http://localhost:3000/api/questions?status=FOO", "test-erisim-anahtari"),
    );

    expect(response.status).toBe(400);
  });

  it("üretimde anahtar yoksa 503 döner (fail-closed)", async () => {
    delete process.env.APP_ACCESS_TOKEN;
    setNodeEnv("production");

    const response = await GET(questionsRequest());

    expect(response.status).toBe(503);
  });

  it("HttpOnly çerez (yönetici oturumu) ile yetkilendirilir", async () => {
    process.env.APP_ACCESS_TOKEN = "test-erisim-anahtari";

    const wrong = await GET(questionsRequest(undefined, undefined, "ty_access=yanlis"));
    expect(wrong.status).toBe(401);

    const right = await GET(
      questionsRequest("http://localhost:3000/api/questions?status=FOO", undefined, "ty_access=test-erisim-anahtari"),
    );
    // Erişim geçti: sorgu doğrulamasına ulaştı (400), 401 değil.
    expect(right.status).toBe(400);
  });

  it("çerez adı büyük/küçük harf duyarsız okunur, başka çerezle karışmaz", async () => {
    process.env.APP_ACCESS_TOKEN = "test-erisim-anahtari";

    const response = await GET(
      questionsRequest(undefined, undefined, "diger=1; ty_access=test-erisim-anahtari"),
    );

    expect(response.status).not.toBe(401);
  });
});
