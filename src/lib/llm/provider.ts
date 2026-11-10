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

/**
 * Sağlayıcı katmanı.
 *
 * `openai-compatible`: OpenAI /v1/chat/completions sözleşmesini konuşan her sunucu
 * (OpenAI, Azure OpenAI uyumlu geçitler, yerel vLLM/Ollama proxy'leri) ile çalışır.
 * Anahtar yalnızca ortam değişkeninden okunur; hiçbir yere yazılmaz ve hata
 * mesajlarına eklenmez.
 */

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  /** Testlerde enjekte edilir. */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
  model?: string;
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): LlmProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    name: "openai-compatible",
    model: options.model,
    async complete(messages: LlmMessage): Promise<LlmCompletion> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);

      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            temperature: options.temperature,
            max_tokens: options.maxTokens,
            messages: [
              { role: "system", content: messages.system },
              { role: "user", content: messages.user },
            ],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // Yanıt gövdesi bilinçli olarak okunmaz/yansıtılmaz: sağlayıcı hata
          // mesajları anahtar parçası veya istek içeriği barındırabilir.
          throw new LlmRequestError(
            `HTTP_${response.status}`,
            `LLM sağlayıcısı isteği reddetti (HTTP ${response.status}).`,
          );
        }

        const payload = (await response.json()) as ChatCompletionResponse;
        const content = payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text;
        const text = typeof content === "string" ? content.trim() : "";

        if (text.length === 0) {
          throw new LlmRequestError("EMPTY_RESPONSE", "LLM boş yanıt döndü.");
        }

        return {
          text,
          provider: "openai-compatible",
          model: payload.model ?? options.model,
          promptVersion: PROMPT_VERSION,
        };
      } catch (error) {
        if (error instanceof LlmRequestError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
          throw new LlmRequestError("TIMEOUT", "LLM isteği zaman aşımına uğradı.");
        }
        throw new LlmRequestError("NETWORK", "LLM sağlayıcısına ulaşılamadı.");
      } finally {
        clearTimeout(timer);
      }
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
      const text = generator(messages).trim();
      if (text.length === 0) throw new LlmRequestError("EMPTY_RESPONSE", "LLM boş yanıt döndü.");
      return { text, provider: "mock", model: "mock-model", promptVersion: PROMPT_VERSION };
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
  });
}
