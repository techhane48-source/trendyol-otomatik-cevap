import { describe, expect, it, vi } from "vitest";

import type { AppEnv } from "@/lib/env";
import { detectUnverifiedClaims, normalizeDraftText } from "@/lib/llm/guardrails";
import { PROMPT_VERSION, SYSTEM_PROMPT, buildDraftMessages } from "@/lib/llm/prompt";
import {
  createLlmProvider,
  createMockProvider,
  createOpenAiCompatibleProvider,
} from "@/lib/llm/provider";
import { LlmNotConfiguredError, LlmRequestError } from "@/lib/llm/types";

function envOf(overrides: Partial<AppEnv>): AppEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test@localhost:1/test",
    TRENDYOL_BASE_URL: "https://apigw.trendyol.com/integration/qna",
    TRENDYOL_SELLER_ID: "1",
    TRENDYOL_API_KEY: "test",
    TRENDYOL_API_SECRET: "test",
    SYNC_PAGE_SIZE: 50,
    SYNC_MAX_PAGES: 100,
    SYNC_MAX_RETRIES: 3,
    SYNC_RETRY_BASE_MS: 10,
    TRENDYOL_TIMEOUT_MS: 5_000,
    LOG_LEVEL: "error",
    LLM_PROVIDER: "disabled",
    LLM_BASE_URL: "https://api.openai.com/v1",
    LLM_MODEL: "gpt-4o-mini",
    LLM_TIMEOUT_MS: 5_000,
    LLM_MAX_TOKENS: 200,
    LLM_TEMPERATURE: 0.2,
    LLM_PROMPT_VERSION: "v1",
    ADMIN_ACTOR_NAME: "admin",
    ...overrides,
  } as AppEnv;
}

describe("prompt — uydurma yasağı", () => {
  it("sistem promptu somut özellik uydurmayı açıkça yasaklar", () => {
    expect(SYSTEM_PROMPT).toContain("KESİN KURALLAR");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("uydurma");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("ölçü");
  });

  it("ürün bilgisi yoksa prompt VERİLMEDİ işaretini ve uyarıyı içerir", () => {
    const messages = buildDraftMessages({
      questionText: "Yatak ölçüsü nedir?",
      productName: "Nevresim Takımı",
      productMainId: "MAIN-1",
      productInfo: null,
    });

    expect(messages.user).toContain("Ek ürün bilgisi: VERİLMEDİ");
    expect(messages.user).toContain("doğrulanmış ek bilgi YOK");
    expect(messages.system).toBe(SYSTEM_PROMPT);
  });

  it("ürün bilgisi verildiğinde prompt uyarısı kalkar ve bilgi modele aktarılır", () => {
    const messages = buildDraftMessages({
      questionText: "Kumaşı nedir?",
      productName: "Nevresim Takımı",
      productMainId: "MAIN-1",
      productInfo: "%100 pamuk, 200x220 cm",
    });

    expect(messages.user).toContain("%100 pamuk, 200x220 cm");
    expect(messages.user).not.toContain("doğrulanmış ek bilgi YOK");
  });
});

describe("guardrail — doğrulanmamış iddialar", () => {
  it("ürün bilgisi yokken ölçü/garanti/kargo iddialarını yakalar", () => {
    const warnings = detectUnverifiedClaims(
      "Ürün 200 cm genişliğindedir, 2 yıl garantilidir ve ücretsiz kargo ile gönderilir.",
      "",
    );

    const kinds = warnings.map((warning) => warning.kind);
    expect(kinds).toContain("MEASUREMENT");
    expect(kinds).toContain("WARRANTY");
    expect(kinds).toContain("SHIPPING");
  });

  it("doğrulanmış bilgide geçen ifadeler için uyarı üretmez", () => {
    const warnings = detectUnverifiedClaims("Ürün 200 cm genişliğindedir.", "200 cm genişlik");
    expect(warnings).toHaveLength(0);
  });

  it("sayısal olmayan metinde uyarı çıkmaz", () => {
    expect(detectUnverifiedClaims("Bilgiyi kontrol edip size ileteceğiz.", "")).toHaveLength(0);
  });

  it("aynı ifadeyi iki kez raporlamaz", () => {
    const warnings = detectUnverifiedClaims("200 cm, yine 200 cm", "");
    expect(warnings.filter((warning) => warning.phrase === "200 cm")).toHaveLength(1);
  });
});

describe("normalizeDraftText", () => {
  it("kod bloğu, cevap öneki ve tırnakları temizler", () => {
    expect(normalizeDraftText("```text\nCevap: \"Ürün stokta.\"\n```")).toBe("Ürün stokta.");
  });

  it("fazla boşlukları sadeleştirir", () => {
    expect(normalizeDraftText("  Merhaba   dünya  ")).toBe("Merhaba dünya");
  });
});

describe("sağlayıcı fabrikası", () => {
  it("LLM_PROVIDER=disabled iken açık hata verir", () => {
    expect(() => createLlmProvider(envOf({ LLM_PROVIDER: "disabled" }))).toThrow(LlmNotConfiguredError);
  });

  it("openai-compatible seçiliyken anahtar yoksa hata verir", () => {
    expect(() =>
      createLlmProvider(envOf({ LLM_PROVIDER: "openai-compatible", LLM_API_KEY: undefined })),
    ).toThrow(LlmNotConfiguredError);
  });

  it("mock sağlayıcı ürün bilgisi yokken somut özellik uydurmaz", async () => {
    const provider = createLlmProvider(envOf({ LLM_PROVIDER: "mock" }));
    const messages = buildDraftMessages({
      questionText: "Ölçüsü nedir?",
      productName: null,
      productMainId: null,
      productInfo: null,
    });

    const completion = await provider.complete(messages);

    expect(completion.provider).toBe("mock");
    expect(completion.promptVersion).toBe(PROMPT_VERSION);
    expect(detectUnverifiedClaims(completion.text, "")).toHaveLength(0);
  });
});

describe("openai-compatible istemci", () => {
  const baseOptions = {
    baseUrl: "https://llm.example/v1",
    apiKey: "sahte-anahtar-123",
    model: "test-model",
    timeoutMs: 2_000,
    maxTokens: 128,
    temperature: 0.1,
  };

  it("doğru uç noktaya, doğru gövdeyle istek atar", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ model: "test-model", choices: [{ message: { content: "Merhaba" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const provider = createOpenAiCompatibleProvider({ ...baseOptions, fetchImpl });
    const completion = await provider.complete({ system: "S", user: "U" });

    expect(completion.text).toBe("Merhaba");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.example/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("test-model");
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
  });

  it("HTTP hatasında anahtar içermeyen güvenli hata fırlatır", async () => {
    const fetchImpl = vi.fn(async () => new Response("kullanıcıya gösterilmemeli", { status: 401 }));
    const provider = createOpenAiCompatibleProvider({ ...baseOptions, fetchImpl });

    await expect(provider.complete({ system: "S", user: "U" })).rejects.toMatchObject({
      code: "HTTP_401",
    });

    await provider.complete({ system: "S", user: "U" }).catch((error: Error) => {
      expect(error.message).not.toContain("sahte-anahtar-123");
      expect(error.message).not.toContain("kullanıcıya gösterilmemeli");
    });
  });

  it("boş yanıtı hata olarak bildirir", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }), { status: 200 }),
    );
    const provider = createOpenAiCompatibleProvider({ ...baseOptions, fetchImpl });

    await expect(provider.complete({ system: "S", user: "U" })).rejects.toBeInstanceOf(LlmRequestError);
  });

  it("ağ hatasını NETWORK koduyla bildirir", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const provider = createOpenAiCompatibleProvider({ ...baseOptions, fetchImpl });

    await expect(provider.complete({ system: "S", user: "U" })).rejects.toMatchObject({
      code: "NETWORK",
    });
  });

  it("mock sağlayıcı enjekte edilebilir ve deterministiktir", async () => {
    const provider = createMockProvider(() => "Sabit cevap");
    const first = await provider.complete({ system: "S", user: "U" });
    const second = await provider.complete({ system: "S", user: "U" });

    expect(first.text).toBe("Sabit cevap");
    expect(second.text).toBe(first.text);
  });
});
