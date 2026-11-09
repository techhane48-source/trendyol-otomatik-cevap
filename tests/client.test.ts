import { describe, expect, it, vi } from "vitest";

import { TrendyolApiError, TrendyolQnaClient, type TrendyolClientConfig } from "@/lib/trendyol/client";

const baseConfig: TrendyolClientConfig = {
  baseUrl: "https://apigw.trendyol.test/integration/qna",
  sellerId: "123456",
  apiKey: "key-abcd",
  apiSecret: "secret-xyz",
  userAgent: "123456 - SelfIntegration",
  timeoutMs: 2_000,
  maxRetries: 2,
  retryBaseMs: 10,
  jitter: () => 0,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const pageBody = (overrides: Record<string, unknown> = {}) => ({
  content: [
    {
      id: 1,
      text: "Kargo ne zaman gelir?",
      creationDate: 1_700_000_000_000,
      status: "WAITING_FOR_ANSWER",
      productName: "Nevresim",
    },
  ],
  totalPages: 1,
  last: true,
  size: 50,
  number: 0,
  ...overrides,
});

function createClient(overrides: Partial<TrendyolClientConfig> = {}) {
  const sleeps: number[] = [];
  const fetchImpl = vi.fn();
  const client = new TrendyolQnaClient({
    ...baseConfig,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
    ...overrides,
  });

  return { client, fetchImpl, sleeps };
}

describe("TrendyolQnaClient — istek biçimi", () => {
  it("Basic Auth ve User-Agent başlıklarını doğru gönderir", async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValueOnce(jsonResponse(pageBody()));

    await client.fetchQuestionsPage({ page: 0, size: 50, status: "WAITING_FOR_ANSWER" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(url).toBe(
      "https://apigw.trendyol.test/integration/qna/sellers/123456/questions/filter?page=0&size=50&status=WAITING_FOR_ANSWER",
    );
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("key-abcd:secret-xyz").toString("base64")}`);
    expect(headers["User-Agent"]).toBe("123456 - SelfIntegration");
    expect(init.method).toBe("GET");
  });

  it("tarih filtresi ve sıralama parametrelerini ekler", async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValueOnce(jsonResponse(pageBody()));

    await client.fetchQuestionsPage({
      page: 1,
      size: 50,
      status: "WAITING_FOR_ANSWER",
      startDate: 1_700_000_000_000,
      endDate: 1_700_600_000_000,
      orderByField: "CreatedDate",
      orderByDirection: "ASC",
    });

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("page=1");
    expect(url).toContain("size=50");
    expect(url).toContain("startDate=1700000000000");
    expect(url).toContain("endDate=1700600000000");
    expect(url).toContain("orderByField=CreatedDate");
    expect(url).toContain("orderByDirection=ASC");
  });
});

describe("TrendyolQnaClient — hata yönetimi", () => {
  it("401 durumunda tekrar denemez", async () => {
    const { client, fetchImpl, sleeps } = createClient();
    fetchImpl.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

    await expect(client.fetchQuestionsPage()).rejects.toMatchObject({
      kind: "auth",
      status: 401,
      code: "401",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(0);
  });

  it("403 durumunda tekrar denemez", async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(jsonResponse({ error: "forbidden" }, 403));

    await expect(client.fetchQuestionsPage()).rejects.toMatchObject({ kind: "forbidden", code: "403" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("429 durumunda bekleyip tekrar dener (Retry-After'a uyar)", async () => {
    const { client, fetchImpl, sleeps } = createClient();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ error: "rate limited" }, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse(pageBody()));

    const result = await client.fetchQuestionsPage();

    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([2_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("5xx durumunda sınırlı sayıda tekrar dener ve sonunda hata verir", async () => {
    const { client, fetchImpl, sleeps } = createClient();
    fetchImpl.mockResolvedValue(jsonResponse({ error: "boom" }, 503));

    await expect(client.fetchQuestionsPage()).rejects.toMatchObject({ kind: "server", status: 503 });
    // maxRetries=2 → toplam 3 deneme, 2 bekleme
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
  });

  it("5xx sonrası ikinci denemede başarılı olur", async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 502))
      .mockResolvedValueOnce(jsonResponse(pageBody()));

    const result = await client.fetchQuestionsPage();
    expect(result.questions).toHaveLength(1);
    expect(result.attempts).toBe(2);
  });

  it("zaman aşımında tekrar dener, sonra TIMEOUT kodu döner", async () => {
    const { client, fetchImpl } = createClient({ maxRetries: 1 });
    const timeoutError = new Error("timeout");
    timeoutError.name = "TimeoutError";
    fetchImpl.mockRejectedValue(timeoutError);

    await expect(client.fetchQuestionsPage()).rejects.toMatchObject({ kind: "timeout", code: "TIMEOUT" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bozuk JSON yanıtını doğrulama hatası olarak bildirir", async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValueOnce(new Response("bozuk", { status: 200 }));

    await expect(client.fetchQuestionsPage()).rejects.toMatchObject({ kind: "validation", code: "VALIDATION" });
  });

  it("şemaya uymayan yanıtı validation hatası olarak bildirir", async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValueOnce(jsonResponse({ content: [{ id: "x" }] }));

    await expect(client.fetchQuestionsPage()).rejects.toBeInstanceOf(TrendyolApiError);
  });
});
