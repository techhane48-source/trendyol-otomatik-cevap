import type { AppEnv } from "@/lib/env";

/**
 * Token ve maliyet ölçümü.
 *
 * Kural: sağlayıcı gerçek `usage` değeri verdiyse o kullanılır; vermediyse
 * tahmini token sayısı üretilir ve kayıt `estimated = true` olarak işaretlenir.
 * Fiyatlar sabit kodlanmaz; ortam değişkenlerinden okunur (0 ise maliyet 0 görünür).
 */

export interface LlmUsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export interface LlmPricing {
  inputPer1kUSD: number;
  outputPer1kUSD: number;
}

/** Kaba tahmin: ~4 karakter ≈ 1 token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateUsage(system: string, user: string, completion: string): LlmUsageInfo {
  const inputTokens = estimateTokens(`${system}\n${user}`);
  const outputTokens = estimateTokens(completion);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true };
}

/** OpenAI uyumlu `usage` alanını okur. */
export function parseUsage(payload: unknown): LlmUsageInfo | null {
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return null;

  const record = usage as Record<string, unknown>;
  const input = typeof record.prompt_tokens === "number" ? record.prompt_tokens : undefined;
  const output = typeof record.completion_tokens === "number" ? record.completion_tokens : undefined;
  const total = typeof record.total_tokens === "number" ? record.total_tokens : undefined;

  if (input === undefined && output === undefined && total === undefined) return null;

  const inputTokens = input ?? total ?? 0;
  const outputTokens = output ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: total ?? inputTokens + outputTokens,
    estimated: false,
  };
}

export function resolvePricing(env: AppEnv): LlmPricing {
  return {
    inputPer1kUSD: env.LLM_INPUT_COST_PER_1K ?? 0,
    outputPer1kUSD: env.LLM_OUTPUT_COST_PER_1K ?? 0,
  };
}

/** USD maliyet; fiyat tanımlı değilse 0 döner (sabit fiyat varsayılmaz). */
export function computeCostUSD(usage: LlmUsageInfo, pricing: LlmPricing): number {
  const cost =
    (usage.inputTokens / 1_000) * pricing.inputPer1kUSD + (usage.outputTokens / 1_000) * pricing.outputPer1kUSD;
  return Math.round(cost * 1e8) / 1e8;
}
