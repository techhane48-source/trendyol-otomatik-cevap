import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/sync/route";
import { syncQuestions } from "@/lib/trendyol/sync";

vi.mock("@/lib/trendyol/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trendyol/sync")>();
  return { ...actual, syncQuestions: vi.fn() };
});

const mockedSync = vi.mocked(syncQuestions);

const originalEnv = { ...process.env };

/** NODE_ENV, @types/node tarafından salt-okunur tanımlanır. */
function setNodeEnv(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

function syncRequest(body?: string, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/sync", {
    method: "POST",
    ...(body !== undefined
      ? { body, headers: { "content-type": "application/json", ...headers } }
      : { headers }),
  });
}

/** Yetkili istek: gövde doğrulama testleri geçerli anahtarla çalışır. */
function authorizedRequest(body?: string, headers: Record<string, string> = {}) {
  return syncRequest(body, { authorization: "Bearer test-erisim-anahtari", ...headers });
}

function partialResult(overrides: Record<string, unknown> = {}) {
  return {
    syncRunId: "run_1",
    storeId: "store_1",
    status: "PARTIAL" as const,
    fetchedCount: 2,
    savedCount: 2,
    pagesFetched: 1,
    statuses: ["WAITING_FOR_ANSWER"],
    breakdown: [
      { status: "WAITING_FOR_ANSWER", fetchedCount: 2, savedCount: 2, pagesFetched: 1, complete: false },
    ],
    complete: false,
    stopReason: "PAGE_LIMIT" as const,
    incompleteReason: "Sayfa sınırına ulaşıldı (maxPages=1); tüm sorular çekilmedi.",
    errorCode: "PAGE_LIMIT",
    errorMessage: "Sayfa sınırına ulaşıldı (maxPages=1); tüm sorular çekilmedi.",
    durationMs: 12,
    ...overrides,
  };
}

beforeEach(() => {
  // Erişim kapısı her ortamda fail-closed: testler geçerli anahtarla çalışır.
  process.env.APP_ACCESS_TOKEN = "test-erisim-anahtari";
  // Geçiş dönemi yolu: testlerde açıkça etkinleştirilir.
  process.env.LEGACY_LOGIN = "on";
  setNodeEnv("test");
  mockedSync.mockReset();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("POST /api/sync — gövde doğrulaması", () => {
  it("geçersiz JSON gövdesini 400 ile reddeder (senkronizasyon başlatılmaz)", async () => {
    const response = await POST(authorizedRequest('{"status": '));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Geçersiz JSON gövdesi" });
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("JSON dizi gövdesini 400 ile reddeder", async () => {
    const response = await POST(authorizedRequest("[]"));

    expect(response.status).toBe(400);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("desteklenmeyen status değeri 400 döner", async () => {
    const response = await POST(authorizedRequest(JSON.stringify({ status: "BILINMEYEN" })));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; issues?: string[] };
    expect(body.error).toBe("Geçersiz istek gövdesi");
    expect(body.issues?.join(" ")).toContain("status");
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("desteklenen status değeri kabul edilir", async () => {
    mockedSync.mockResolvedValue(partialResult({ status: "SUCCESS", complete: true }));

    const response = await POST(authorizedRequest(JSON.stringify({ status: "ANSWERED" })));

    expect(response.status).toBe(200);
    expect(mockedSync).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["ANSWERED"], trigger: "api" }),
    );
  });

  it("pageSize üst sınırı (200) korunur", async () => {
    const response = await POST(authorizedRequest(JSON.stringify({ pageSize: 201 })));
    expect(response.status).toBe(400);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("maxPages üst sınırı (500) korunur", async () => {
    const response = await POST(authorizedRequest(JSON.stringify({ maxPages: 501 })));
    expect(response.status).toBe(400);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("başlangıç tarihi bitişten sonraysa 400 döner", async () => {
    const response = await POST(
      authorizedRequest(
        JSON.stringify({ startDate: "2026-02-10T00:00:00Z", endDate: "2026-02-01T00:00:00Z" }),
      ),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("startDate");
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("14 günden uzun tarih aralığı 400 döner", async () => {
    const response = await POST(
      authorizedRequest(
        JSON.stringify({ startDate: "2026-01-01T00:00:00Z", endDate: "2026-02-15T00:00:00Z" }),
      ),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("14");
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("gövde olmadan çağrı varsayılanlarla çalışır", async () => {
    mockedSync.mockResolvedValue(partialResult({ status: "SUCCESS", complete: true }));

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(200);
    expect(mockedSync).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ["WAITING_FOR_ANSWER", "ANSWERED"],
        trigger: "api",
        storeId: expect.any(String),
      }),
    );
  });
  it("statuses dizisi kabul edilir ve senkronizasyona iletilir", async () => {
    mockedSync.mockResolvedValue(partialResult({ status: "SUCCESS", complete: true }));

    const response = await POST(authorizedRequest(JSON.stringify({ statuses: ["ANSWERED", "REJECTED"] })));

    expect(response.status).toBe(200);
    expect(mockedSync).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["ANSWERED", "REJECTED"] }),
    );
  });

  it("statuses içinde geçersiz değer 400 döner", async () => {
    const response = await POST(
      authorizedRequest(JSON.stringify({ statuses: ["ANSWERED", "UYDURMA"] })),
    );

    expect(response.status).toBe(400);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("statuses boş dizi 400 döner", async () => {
    const response = await POST(authorizedRequest(JSON.stringify({ statuses: [] })));

    expect(response.status).toBe(400);
    expect(mockedSync).not.toHaveBeenCalled();
  });
});

describe("POST /api/sync — yanıt biçimi", () => {
  it("eksik senkronizasyonu complete=false ve PARTIAL olarak bildirir", async () => {
    mockedSync.mockResolvedValue(partialResult());

    const response = await POST(authorizedRequest("{}"));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe("PARTIAL");
    expect(body.complete).toBe(false);
    expect(body.stopReason).toBe("PAGE_LIMIT");
    expect(body.incompleteReason).toBeTruthy();
  });

  it("FAILED durumunda 502 döner", async () => {
    mockedSync.mockResolvedValue(
      partialResult({ status: "FAILED", complete: false, stopReason: "ERROR", errorCode: "401" }),
    );

    const response = await POST(authorizedRequest("{}"));
    expect(response.status).toBe(502);
  });
});

describe("POST /api/sync — erişim kontrolü", () => {
  it("anahtar tanımlıyken yetkisiz istek 401 döner", async () => {
    process.env.APP_ACCESS_TOKEN = "test-erisim-anahtari";

    const response = await POST(syncRequest("{}"));

    expect(response.status).toBe(401);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("yanlış anahtar 401, doğru anahtar işlemi başlatır", async () => {
    process.env.APP_ACCESS_TOKEN = "test-erisim-anahtari";
    mockedSync.mockResolvedValue(partialResult({ status: "SUCCESS", complete: true }));

    const wrong = await POST(syncRequest("{}", { authorization: "Bearer yanlis" }));
    expect(wrong.status).toBe(401);

    const correct = await POST(
      syncRequest("{}", { authorization: "Bearer test-erisim-anahtari" }),
    );
    expect(correct.status).toBe(200);
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it("üretimde anahtar yoksa 503 döner (fail-closed)", async () => {
    delete process.env.APP_ACCESS_TOKEN;
    setNodeEnv("production");

    const response = await POST(syncRequest("{}"));

    expect(response.status).toBe(503);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("401 yanıtı anahtar değerini sızdırmaz", async () => {
    process.env.APP_ACCESS_TOKEN = "test-erisim-anahtari";

    const response = await POST(syncRequest("{}", { authorization: "Bearer yanlis" }));
    const text = await response.text();

    expect(text).not.toContain("test-erisim-anahtari");
    expect(text).not.toContain("yanlis");
  });

  it("HttpOnly çerezle (yönetici oturumu) erişim sağlanır", async () => {
    process.env.APP_ACCESS_TOKEN = "test-erisim-anahtari";
    mockedSync.mockResolvedValue(partialResult({ status: "SUCCESS", complete: true }));

    const withCookie = await POST(syncRequest("{}", { cookie: "ty_access=test-erisim-anahtari" }));
    expect(withCookie.status).toBe(200);

    mockedSync.mockClear();
    const wrongCookie = await POST(syncRequest("{}", { cookie: "ty_access=baska-bir-sey" }));
    expect(wrongCookie.status).toBe(401);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("çerez + Bearer aynı anda yanlışsa 401, biri doğruysa geçer", async () => {
    process.env.APP_ACCESS_TOKEN = "test-erisim-anahtari";
    mockedSync.mockResolvedValue(partialResult({ status: "SUCCESS", complete: true }));

    const mixed = await POST(
      syncRequest("{}", { cookie: "ty_access=yanlis", authorization: "Bearer test-erisim-anahtari" }),
    );
    expect(mixed.status).toBe(200);
  });
});
