import type { LlmPricing } from "./usage";

/**
 * Maliyet bütçesi koruması.
 *
 * Ücretli canlı testler, tahmini maliyet bütçeyi aşacaksa BAŞLATILMAZ.
 * Fiyat tarifesi tanımlı değilse (0) maliyet hesaplanamaz — bu durumda da
 * ücretli toplu test başlatılmaz.
 */

export class BudgetError extends Error {
  code: "NO_PRICING" | "BUDGET_EXCEEDED" | "INVALID_BUDGET";
  constructor(code: BudgetError["code"], message: string) {
    super(message);
    this.name = "BudgetError";
    this.code = code;
  }
}

export interface RunCostEstimateInput {
  calls: number;
  approxInputTokensPerCall: number;
  approxOutputTokensPerCall: number;
  pricing: LlmPricing;
}

/** Kaba üst sınır tahmini (USD). */
export function estimateRunCostUSD(input: RunCostEstimateInput): number {
  const inputCost = (input.calls * input.approxInputTokensPerCall * input.pricing.inputPer1kUSD) / 1_000;
  const outputCost = (input.calls * input.approxOutputTokensPerCall * input.pricing.outputPer1kUSD) / 1_000;
  return Math.round((inputCost + outputCost) * 1e6) / 1e6;
}

export function hasPricing(pricing: LlmPricing): boolean {
  return pricing.inputPer1kUSD > 0 || pricing.outputPer1kUSD > 0;
}

/**
 * Bütçe kontrolü. Fiyat tanımlı değilse veya tahmin bütçeyi aşıyorsa hata verir.
 * `allowUnknownPricing` yalnızca maliyeti önemsiz tek çağrılık smoke testinde kullanılır.
 */
export function assertBudget(
  input: RunCostEstimateInput & { budgetUSD: number; allowUnknownPricing?: boolean },
): number {
  if (!Number.isFinite(input.budgetUSD) || input.budgetUSD <= 0) {
    throw new BudgetError("INVALID_BUDGET", "Bütçe üst sınırı geçersiz.");
  }

  if (!hasPricing(input.pricing)) {
    if (!input.allowUnknownPricing) {
      throw new BudgetError(
        "NO_PRICING",
        "Maliyet tarifesi tanımlı değil (LLM_INPUT_COST_PER_1K / LLM_OUTPUT_COST_PER_1K = 0). Ücretli toplu test başlatılmadı.",
      );
    }
    return 0;
  }

  const estimate = estimateRunCostUSD(input);
  if (estimate > input.budgetUSD) {
    throw new BudgetError(
      "BUDGET_EXCEEDED",
      `Tahmini maliyet $${estimate} bütçe üst sınırını ($${input.budgetUSD}) aşıyor. Test başlatılmadı.`,
    );
  }

  return estimate;
}
