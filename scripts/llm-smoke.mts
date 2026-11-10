import "dotenv/config";

import { getEnv } from "../src/lib/env";
import { assertBudget, estimateRunCostUSD, hasPricing } from "../src/lib/llm/budget";
import { buildDraftMessages } from "../src/lib/llm/prompt";
import { createLlmProvider, normalizeBaseUrl } from "../src/lib/llm/provider";
import { LlmRequestError } from "../src/lib/llm/types";
import { computeCostUSD, resolvePricing } from "../src/lib/llm/usage";
import { getPrisma } from "../src/lib/prisma";

/**
 * `npm run llm:smoke` — TEK çağrılık canlı bağlantı testi.
 *
 * - Anahtar yoksa hiç istek atılmaz (exit 3).
 * - Yalnızca 1 istek; tahmini üst maliyet yazdırılır.
 * - Anahtar hiçbir çıktıya yazılmaz (yalnızca host ve model adı görünür).
 * - Müşteri verisi gönderilmez; sabit, kişisel veri içermeyen bir metin kullanılır.
 */

const env = getEnv();
const pricing = resolvePricing(env);
const MAX_TOKENS = Math.min(env.LLM_MAX_TOKENS, 120);
const APPROX_INPUT_TOKENS = 400;
const APPROX_OUTPUT_TOKENS = MAX_TOKENS;

if (env.LLM_PROVIDER === "disabled" || !env.LLM_API_KEY) {
  console.error("ATLANDI: LLM_PROVIDER / LLM_API_KEY tanımlı değil. Canlı istek atılmadı.");
  process.exit(3);
}

const endpoint = `${normalizeBaseUrl(env.LLM_BASE_URL)}/chat/completions`;

console.log("— Canlı bağlantı testi planı —");
console.log(`sağlayıcı : ${env.LLM_PROVIDER}`);
console.log(`uç nokta : ${endpoint}`);
console.log(`model     : ${env.LLM_MODEL}`);
console.log(`istek     : 1 (tek çağrı)`);
console.log(`max token : ${MAX_TOKENS}`);
console.log(
  `fiyat     : ${hasPricing(pricing) ? `girdi $${pricing.inputPer1kUSD}/1K · çıktı $${pricing.outputPer1kUSD}/1K` : "TANIMSIZ (maliyet 0 raporlanır)"}`,
);
console.log(
  `tahmini üst maliyet: $${estimateRunCostUSD({
    calls: 1,
    approxInputTokensPerCall: APPROX_INPUT_TOKENS,
    approxOutputTokensPerCall: APPROX_OUTPUT_TOKENS,
    pricing,
  })} (bütçe: $${env.LLM_SMOKE_MAX_COST_USD})`,
);

assertBudget({
  calls: 1,
  approxInputTokensPerCall: APPROX_INPUT_TOKENS,
  approxOutputTokensPerCall: APPROX_OUTPUT_TOKENS,
  pricing,
  budgetUSD: env.LLM_SMOKE_MAX_COST_USD,
  allowUnknownPricing: true,
});

const provider = createLlmProvider(env);
const messages = buildDraftMessages({
  questionText: "Bu ürünün kumaş türü nedir?",
  productName: "Test Ürünü",
  productMainId: "SMOKE-1",
  productInfo: "Kumaş: Bambu dokulu tül",
  storeName: null,
  tone: null,
});

const startedAt = Date.now();

try {
  const completion = await provider.complete(messages);
  const cost = computeCostUSD(completion.usage, pricing);
  const prisma = getPrisma();

  await prisma.llmUsage.create({
    data: {
      provider: completion.provider,
      model: completion.model,
      promptVersion: completion.promptVersion,
      outcome: "SUCCESS",
      durationMs: completion.durationMs,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      totalTokens: completion.usage.totalTokens,
      estimated: completion.usage.estimated,
      estimatedCostUSD: cost,
      purpose: "smoke",
    },
  });
  await prisma.$disconnect();

  console.log("\n— Sonuç —");
  console.log(`durum          : BAŞARILI`);
  console.log(`http durumu    : ${completion.httpStatus ?? "?"}`);
  console.log(`model (yanıt)  : ${completion.model}`);
  console.log(`süre           : ${completion.durationMs} ms (toplam ${Date.now() - startedAt} ms)`);
  console.log(`token          : girdi ${completion.usage.inputTokens} · çıktı ${completion.usage.outputTokens} · toplam ${completion.usage.totalTokens}${completion.usage.estimated ? " (tahmini)" : " (sağlayıcıdan)"}`);
  console.log(`tahmini maliyet: $${cost}`);
  console.log(`yanıt (ilk 200): ${completion.text.slice(0, 200)}`);
} catch (error) {
  const code = error instanceof LlmRequestError ? error.code : "UNKNOWN";
  const prisma = getPrisma();
  try {
    await prisma.llmUsage.create({
      data: {
        provider: provider.name,
        model: provider.model,
        promptVersion: env.LLM_PROMPT_VERSION,
        outcome: "ERROR",
        errorCode: code,
        durationMs: Date.now() - startedAt,
        estimated: true,
        estimatedCostUSD: 0,
        purpose: "smoke",
      },
    });
  } finally {
    await prisma.$disconnect();
  }
  console.error("");
  console.error(`BAŞARISIZ: ${code}`);
  console.error(error instanceof Error ? error.message : "Bilinmeyen hata");
  console.error("Bu çağrı için ücret oluşmadı; başarısız kayıt llm_usages tablosuna yazıldı.");
  process.exit(2);
}
