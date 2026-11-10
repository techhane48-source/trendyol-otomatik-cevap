import type { AppEnv } from "@/lib/env";
import { getEnv } from "@/lib/env";

import { PROMPT_VERSION } from "./prompt";
import {
  LlmNotConfiguredError,
  LlmRequestError,
  type LlmCompletion,
  type LlmMessage,
  type LlmProvider,
} from "./types";
import { estimateUsage, parseUsage, type LlmUsageInfo } from "./usage";

/**
 * Sağlayıcı katmanı.
 *
 * `openai-compatible`: OpenAI `/v1/chat/completions` sözleşmesini konuşan her sunucu
 * (OpenAI, uyumlu geçitler, yerel vLLM/Ollama proxy'leri) ile çalışır.
 *
 * Güvenlik ve sağlamlık:
 * - Anahtar yalnızca ortam değişkeninden okunur; hata mesajına/loga/DB'ye yazılmaz.
 * - Sağlayıcı hata GÖVDESİ okunmaz (anahtar parçası veya kişisel veri içerebilir).
 * - 429 / 5xx / ağ hatası: sınırlı tekrar + üstel bekleme (Retry-After'a uyulur).
 * - 400 / 401 / 403 / 404: tekrar denenmez.
 * - Bozuk JSON yanıtı `INVALID_JSON` olarak raporlanır.
 * - `usage` alanı yoksa token sayısı tahmin edilir ve `estimated = true` işaretlenir.
 */

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  maxRetries?: number;
  retryBaseMs?: number;
  /** OpenAI `store` bayrağı; varsayılan false (istek saklanmaz). */
  store?: boolean;
  promptVersion?: string;
  /** Testlerde enjekte edilir. */
  fetchImpl?: typeof fetch;
  /** Testlerde beklemesiz çalışmak için. */
  sleepImpl?: (ms: number) => Promise<void>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: unknown; refusal?: unknown };
    text?: unknown;
    finish_reason?: unknown;
  }>;
  model?: string;
  usage?: unknown;
}

type RetryMeta = { retryable?: boolean; retryAfter?: number | null };

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Base URL normalizasyonu: sonda `/chat/completions` varsa kaldırılır,
 * tekrarlanmış `/v1/v1` düzeltilir, sonda `/` bırakılmaz. Böylece URL
 * iki kez `/v1` içermez ve yol iki kez eklenmez.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw ?? "").trim();
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/chat\/completions$/i, "");
  url = url.replace(/\/v1\/v1(?=\/|$)/gi, "/v1");
  return url.replace(/\/+$/, "");
}

/** Muhakeme (reasoning) modelleri `max_tokens` ve `temperature` kabul etmez. */
export function isReasoningModel(model: string): boolean {
  return /^(?:o[1-9]|gpt-5)/i.test((model ?? "").trim());
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, 5_000) : null;
}

/** İstek gövdesi: model yeteneklerine göre parametreler seçilir. */
export function buildRequestBody(
  options: Pick<OpenAiCompatibleOptions, "model" | "maxTokens" | "temperature" | "store">,
  messages: LlmMessage,
): Record<string, unknown> {
  const reasoning = isReasoningModel(options.model);
  const body: Record<string, unknown> = {
    model: options.model,
    store: options.store ?? false,
    messages: [
      { role: "system", content: messages.system },
      { role: "user", content: messages.user },
    ],
  };

  if (reasoning) {
    // Muhakeme modelleri: `temperature` gönderilmez, `max_tokens` yerine `max_completion_tokens`.
    body.max_completion_tokens = options.maxTokens;
  } else {
    body.temperature = clamp(options.temperature, 0, 2);
    body.max_tokens = options.maxTokens;
  }

  return body;
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): LlmProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 1;
  const retryBaseMs = options.retryBaseMs ?? 400;
  const promptVersion = options.promptVersion ?? PROMPT_VERSION;
  const endpoint = `${normalizeBaseUrl(options.baseUrl)}/chat/completions`;

  async function attempt(
    messages: LlmMessage,
  ): Promise<{ text: string; model: string; usage: LlmUsageInfo; status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(options, messages)),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Gövde bilinçli olarak okunmaz/yansıtılmaz.
        const error = new LlmRequestError(
          `HTTP_${response.status}`,
          `LLM sağlayıcısı isteği reddetti (HTTP ${response.status}).`,
        ) as LlmRequestError & RetryMeta;
        error.retryable = RETRYABLE_STATUS.has(response.status);
        error.retryAfter = retryAfterMs(response);
        throw error;
      }

      let payload: ChatCompletionResponse;
      try {
        payload = (await response.json()) as ChatCompletionResponse;
      } catch {
        throw new LlmRequestError("INVALID_JSON", "LLM yanıtı geçerli JSON değil.");
      }

      const choice = payload.choices?.[0];
      const refusal = (choice?.message as { refusal?: unknown } | undefined)?.refusal;
      if (typeof refusal === "string" && refusal.trim().length > 0) {
        throw new LlmRequestError("REFUSAL", "Model isteği güvenlik gerekçesiyle reddetti.");
      }

      const finishReason = (payload.choices?.[0] as { finish_reason?: unknown } | undefined)?.finish_reason;
      if (finishReason === "length") {
        throw new LlmRequestError(
          "TRUNCATED",
          "Model yanıtı token sınırında kesildi (finish_reason=length). Taslak kaydedilmedi.",
        );
      }
      if (finishReason === "content_filter") {
        throw new LlmRequestError("CONTENT_FILTER", "Yanıt içerik filtresine takıldı.");
      }

      const content = choice?.message?.content ?? choice?.text;
      const text = typeof content === "string" ? content.trim() : "";

      if (text.length === 0) {
        throw new LlmRequestError("EMPTY_RESPONSE", "LLM boş yanıt döndü.");
      }

      const usage = parseUsage(payload) ?? estimateUsage(messages.system, messages.user, text);
      return { text, model: payload.model ?? options.model, usage, status: response.status };
    } catch (error) {
      if (error instanceof LlmRequestError) throw error;

      if (error instanceof Error && error.name === "AbortError") {
        const timeout = new LlmRequestError(
          "TIMEOUT",
          "LLM isteği zaman aşımına uğradı.",
        ) as LlmRequestError & RetryMeta;
        timeout.retryable = true;
        throw timeout;
      }

      const network = new LlmRequestError(
        "NETWORK",
        "LLM sağlayıcısına ulaşılamadı.",
      ) as LlmRequestError & RetryMeta;
      network.retryable = true;
      throw network;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "openai-compatible",
    model: options.model,
    async complete(messages: LlmMessage): Promise<LlmCompletion> {
      const startedAt = Date.now();
      let lastError: LlmRequestError | null = null;

      for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
        try {
          const result = await attempt(messages);
          return {
            text: result.text,
            provider: "openai-compatible",
            model: result.model,
            promptVersion,
            durationMs: Date.now() - startedAt,
            usage: result.usage,
            httpStatus: result.status,
          };
        } catch (error) {
          if (!(error instanceof LlmRequestError)) throw error;
          lastError = error;

          const meta = error as LlmRequestError & RetryMeta;
          if (meta.retryable !== true || attemptIndex === maxRetries) throw error;

          const waitMs = meta.retryAfter ?? retryBaseMs * Math.pow(2, attemptIndex);
          await sleep(Math.min(waitMs, 5_000));
        }
      }

      throw lastError ?? new LlmRequestError("UNKNOWN", "LLM isteği başarısız oldu.");
    },
  };
}

/**
 * Sahte (mock) sağlayıcı — testler ve AI anahtarı olmayan geliştirme için.
 * Verilen doğrulanmış bilgi yoksa somut özellik uydurmayan bir cevap üretir.
 */
export function createMockProvider(
  generator: (messages: LlmMessage) => string = defaultMockGenerator,
): LlmProvider {
  return {
    name: "mock",
    model: "mock-model",
    async complete(messages: LlmMessage): Promise<LlmCompletion> {
      const startedAt = Date.now();
      const text = generator(messages).trim();
      if (text.length === 0) throw new LlmRequestError("EMPTY_RESPONSE", "LLM boş yanıt döndü.");
      return {
        text,
        provider: "mock",
        model: "mock-model",
        promptVersion: PROMPT_VERSION,
        durationMs: Date.now() - startedAt,
        usage: estimateUsage(messages.system, messages.user, text),
        httpStatus: 200,
      };
    },
  };
}

function defaultMockGenerator(messages: LlmMessage): string {
  const unknownInfo = messages.user.includes("Ek ürün bilgisi: VERİLMEDİ");
  return unknownInfo
    ? "Sorunuz için teşekkür ederiz. Bu ürünle ilgili ayrıntılı bilgiyi kontrol edip size en kısa sürede ileteceğiz."
    : "Sorunuz için teşekkür ederiz. Paylaştığınız bilgiler doğrultusunda ürünle ilgili detayları iletiyoruz.";
}

/** Ortam değişkenlerine göre sağlayıcı oluşturur. */
export function createLlmProvider(env: AppEnv = getEnv()): LlmProvider {
  if (env.LLM_PROVIDER === "disabled") {
    throw new LlmNotConfiguredError(
      "AI taslak üretimi kapalı. LLM_PROVIDER ve LLM_API_KEY ortam değişkenlerini ayarlayın.",
    );
  }

  if (env.LLM_PROVIDER === "mock") {
    return createMockProvider();
  }

  if (!env.LLM_API_KEY) {
    throw new LlmNotConfiguredError(
      "LLM_API_KEY tanımlı değil. Anahtarı yalnızca .env dosyasına ekleyin.",
    );
  }

  return createOpenAiCompatibleProvider({
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxTokens: env.LLM_MAX_TOKENS,
    temperature: env.LLM_TEMPERATURE,
    maxRetries: env.LLM_MAX_RETRIES,
    retryBaseMs: env.LLM_RETRY_BASE_MS,
    store: env.LLM_STORE,
    promptVersion: env.LLM_PROMPT_VERSION,
  });
}
