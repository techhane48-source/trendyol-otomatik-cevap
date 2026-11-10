import { describe, expect, it, vi } from "vitest";

import { BudgetError, assertBudget, estimateRunCostUSD, hasPricing } from "@/lib/llm/budget";
import { buildRequestBody, createOpenAiCompatibleProvider, isReasoningModel, normalizeBaseUrl } from "@/lib/llm/provider";

const API_KEY = "sk-test-gizli-anahtar";

function providerWith(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return createOpenAiCompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: API_KEY,
    model: "gpt-4o-mini",
    timeoutMs: 5_000,
    maxTokens: 128,
    temperature: 0.2,
    maxRetries: 0,
    fetchImpl,
    sleepImpl: async () => {},
    ...overrides,
  });
}

function okResponse(choice: Record<string, unknown>, usage?: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ choices: [choice], model: "gpt-4o-mini", usage }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const messages = { system: "sistem", user: "soru" };

describe("base URL normalizasyonu", () => {
  it("sonda /chat/completions varsa kaldırır", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1");
  });

  it("tekrarlanmış /v1/v1 düzeltir ve sondaki / kaldırılır", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1/v1/")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("https://api.openai.com/v1///")).toBe("https://api.openai.com/v1");
  });

  it("istek URL'si /v1 yolunu iki kez içermez", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ message: { content: "cevap" } })) as unknown as typeof fetch;
    await providerWith(fetchImpl, { baseUrl: "https://api.openai.com/v1/chat/completions" }).complete(messages);

    const url = String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(url.match(/\/v1/g)?.length).toBe(1);
  });
});

describe("istek gövdesi", () => {
  it("store=false ve standart modelde temperature + max_tokens gönderir", () => {
    const body = buildRequestBody({ model: "gpt-4o-mini", maxTokens: 200, temperature: 0.3, store: false }, messages);
    expect(body.store).toBe(false);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(200);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("store tanımlı değilse false olur", () => {
    const body = buildRequestBody({ model: "gpt-4o-mini", maxTokens: 100, temperature: 0 }, messages);
    expect(body.store).toBe(false);
  });

  it("temperature 0–2 aralığına kırpılır", () => {
    expect(buildRequestBody({ model: "gpt-4o-mini", maxTokens: 10, temperature: 9 }, messages).temperature).toBe(2);
    expect(buildRequestBody({ model: "gpt-4o-mini", maxTokens: 10, temperature: -3 }, messages).temperature).toBe(0);
  });

  it("muhakeme modelinde max_completion_tokens kullanır, temperature göndermez", () => {
    expect(isReasoningModel("o3-mini")).toBe(true);
    expect(isReasoningModel("gpt-5")).toBe(true);
    expect(isReasoningModel("gpt-4o-mini")).toBe(false);

    const body = buildRequestBody({ model: "o3-mini", maxTokens: 300, temperature: 0.5 }, messages);
    expect(body.max_completion_tokens).toBe(300);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it("gerçek istek anahtarı başlıkta taşır ama gövdeye yazmaz", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ message: { content: "cevap" } })) as unknown as typeof fetch;
    await providerWith(fetchImpl).complete(messages);

    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
    expect(String(init.body)).not.toContain(API_KEY);
  });
});

describe("yanıt durumları", () => {
  it("finish_reason=length → TRUNCATED", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse({ message: { content: "yarım kalan" }, finish_reason: "length" })) as unknown as typeof fetch;
    await expect(providerWith(fetchImpl).complete(messages)).rejects.toMatchObject({ code: "TRUNCATED" });
  });

  it("content_filter → CONTENT_FILTER", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse({ message: { content: "" }, finish_reason: "content_filter" })) as unknown as typeof fetch;
    await expect(providerWith(fetchImpl).complete(messages)).rejects.toMatchObject({ code: "CONTENT_FILTER" });
  });

  it("refusal alanı doluysa REFUSAL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse({ message: { content: null, refusal: "veremem" } })) as unknown as typeof fetch;
    await expect(providerWith(fetchImpl).complete(messages)).rejects.toMatchObject({ code: "REFUSAL" });
  });

  it("gerçek usage değerleri korunur", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        okResponse(
          { message: { content: "cevap" }, finish_reason: "stop" },
          { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        ),
      ) as unknown as typeof fetch;

    const completion = await providerWith(fetchImpl).complete(messages);
    expect(completion.usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150, estimated: false });
  });
});

describe("bütçe koruması", () => {
  const pricing = { inputPer1kUSD: 0.15, outputPer1kUSD: 0.6 };

  it("10 çağrı için maliyet tahmini hesaplar", () => {
    expect(
      estimateRunCostUSD({ calls: 10, approxInputTokensPerCall: 700, approxOutputTokensPerCall: 250, pricing }),
    ).toBeCloseTo(2.55, 5);
  });

  it("fiyat tanımsızsa ücretli toplu testi reddeder", () => {
    expect(hasPricing({ inputPer1kUSD: 0, outputPer1kUSD: 0 })).toBe(false);
    expect(() =>
      assertBudget({
        calls: 10,
        approxInputTokensPerCall: 700,
        approxOutputTokensPerCall: 250,
        pricing: { inputPer1kUSD: 0, outputPer1kUSD: 0 },
        budgetUSD: 2,
      }),
    ).toThrowError(BudgetError);
  });

  it("tahmini maliyet bütçeyi aşarsa başlatmaz", () => {
    expect(() =>
      assertBudget({
        calls: 10,
        approxInputTokensPerCall: 700,
        approxOutputTokensPerCall: 250,
        pricing,
        budgetUSD: 2,
      }),
    ).toThrowError(/bütçe üst sınırını/);
  });

  it("bütçe içindeki çağrıyı onaylar", () => {
    const estimate = assertBudget({
      calls: 10,
      approxInputTokensPerCall: 100,
      approxOutputTokensPerCall: 50,
      pricing,
      budgetUSD: 2,
    });
    expect(estimate).toBeCloseTo(0.45, 5);
  });

  it("smoke testi fiyat tanımsızken izin verir (tek çağrı)", () => {
    expect(
      assertBudget({
        calls: 1,
        approxInputTokensPerCall: 100,
        approxOutputTokensPerCall: 50,
        pricing: { inputPer1kUSD: 0, outputPer1kUSD: 0 },
        budgetUSD: 0.05,
        allowUnknownPricing: true,
      }),
    ).toBe(0);
  });
});
