import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { detectUnverifiedClaims, normalizeDraftText, type DraftWarning } from "@/lib/llm/guardrails";
import { buildDraftMessages } from "@/lib/llm/prompt";
import { createLlmProvider } from "@/lib/llm/provider";
import { sanitizeQuestion } from "@/lib/llm/sanitize";
import { PROMPT_VERSION } from "@/lib/llm/prompt";
import { LlmNotConfiguredError, LlmRequestError, type LlmProvider } from "@/lib/llm/types";
import { computeCostUSD, resolvePricing } from "@/lib/llm/usage";
import { isUsableForDraft, matchProductInfo } from "@/lib/products/matching";
import { findProductInfoForQuestion } from "@/lib/products/service";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Kalite değerlendirme servisi.
 *
 * İlkeler:
 * - **Salt okunur**: yalnızca yerel soruları okur, Trendyol'a hiçbir istek/cevap gitmez.
 * - **Kişisel veri yok**: saklanan soru metni maskelenmiştir (telefon/e-posta/IBAN/sipariş no).
 * - **Otomatik toplu çağrı yok**: değerlendirme yalnızca yönetici "başlat" dediğinde çalışır.
 * - **Otomatik kontrol insan yerine geçmez**: puan ve not insan tarafından girilir.
 */

export interface QualityActor {
  name: string;
}

export class QualityAccessError extends Error {
  constructor(message = "Bu işlem için yönetici yetkisi gerekir.") {
    super(message);
    this.name = "QualityAccessError";
  }
}

export class QualityError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "QualityError";
    this.code = code;
  }
}

export interface QualityDeps {
  prisma?: PrismaClient;
  provider?: LlmProvider;
}

/** Değerlendirme seti için izin verilen örnek sayısı. */
export const MIN_SAMPLES = 30;
export const MAX_SAMPLES = 50;

function requireActor(actor: QualityActor | undefined | null): string {
  const name = actor?.name?.trim();
  if (!name) throw new QualityAccessError();
  return name;
}

/** Gerçek sorulardan (kişisel verisi maskelenmiş) değerlendirme seti oluşturur. */
export async function createQualitySet(
  input: { name?: string; sampleCount: number; actor: QualityActor },
  deps: QualityDeps = {},
): Promise<{ id: string; name: string; sampleCount: number }> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const requested = Math.trunc(input.sampleCount);
  if (!Number.isFinite(requested) || requested < MIN_SAMPLES || requested > MAX_SAMPLES) {
    throw new QualityError(
      "INVALID_SAMPLE_COUNT",
      `Örnek sayısı ${MIN_SAMPLES}–${MAX_SAMPLES} arasında olmalı.`,
    );
  }

  const questions = await prisma.question.findMany({
    orderBy: { createdAt: "desc" },
    take: requested,
    select: { id: true },
  });

  if (questions.length === 0) {
    throw new QualityError("NO_QUESTIONS", "Değerlendirme için kayıtlı soru bulunamadı.");
  }

  const name = input.name?.trim() || `Değerlendirme seti ${new Date().toISOString().slice(0, 10)}`;

  const created = await prisma.qualitySet.create({
    data: {
      name,
      createdBy: actorName,
      sampleQuestionIds: questions.map((item) => item.id) as unknown as object,
      sampleCount: questions.length,
    },
  });

  return { id: created.id, name: created.name, sampleCount: created.sampleCount };
}

export interface AutoChecks {
  /** Guardrail uyarıları (doğrulanmamış iddia) */
  warnings: DraftWarning[];
  warningCount: number;
  /** Doğrulanmış bilgi hiç yok mu? */
  noVerifiedInfo: boolean;
  /** Cevap metni boş mu? */
  empty: boolean;
  /** Kısa/uzun cevap (üslup ve açıklık göstergesi) */
  characterCount: number;
  sentenceCount: number;
  /** Üslup: selamlama/imza/emoji gibi istenmeyen kalıplar */
  hasGreeting: boolean;
  hasEmoji: boolean;
  /** Otomatik değerlendirmenin insan müdahalesi önerip önermediği */
  needsHuman: boolean;
}

export function evaluateAnswer(text: string, verifiedInfoAvailable: boolean): AutoChecks {
  const normalized = normalizeDraftText(text);
  const warnings = detectUnverifiedClaims(normalized, verifiedInfoAvailable ? "ürün bilgisi" : "");
  const characters = normalized.length;
  const sentences = normalized.split(/[.!?]+/).filter((part) => part.trim().length > 0).length;

  const hasGreeting = /^(merhaba|selam|iyi günler|iyi akşamlar|değerli müşterimiz)/i.test(normalized);
  const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(normalized);

  return {
    warnings,
    warningCount: warnings.length,
    noVerifiedInfo: !verifiedInfoAvailable,
    empty: normalized.length === 0,
    characterCount: characters,
    sentenceCount: sentences,
    hasGreeting,
    hasEmoji,
    needsHuman: warnings.length > 0 || characters === 0 || sentences === 0 || characters > 700,
  };
}

export interface QualityRunSummary {
  runId: string;
  setId: string;
  setName: string;
  promptVersion: string;
  provider: string;
  model: string;
  status: string;
  itemCount: number;
  totalCostUSD: number;
  totalTokens: number;
  startedAt: Date;
  finishedAt: Date | null;
  avgHumanScore: number | null;
  scoredCount: number;
  warningRate: number;
  needsInfoRate: number;
}

/** Mevcut bir seti (aynı sorularla) yeniden değerlendirir. */
export async function startQualityRun(
  input: { setId: string; actor: QualityActor },
  deps: QualityDeps = {},
): Promise<{ runId: string; itemCount: number }> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();
  const env = getEnv();
  const provider = deps.provider ?? createLlmProvider(env);
  const pricing = resolvePricing(env);

  const set = await prisma.qualitySet.findUnique({ where: { id: input.setId } });
  if (!set) throw new QualityError("SET_NOT_FOUND", "Değerlendirme seti bulunamadı.");

  const ids = Array.isArray(set.sampleQuestionIds) ? (set.sampleQuestionIds as string[]) : [];
  if (ids.length === 0) throw new QualityError("EMPTY_SET", "Bu sette örnek soru yok.");

  const questions = await prisma.question.findMany({
    where: { id: { in: ids } },
    orderBy: { createdAt: "desc" },
  });

  if (questions.length === 0) {
    throw new QualityError("QUESTIONS_MISSING", "Setteki sorular artık veritabanında yok.");
  }

  const run = await prisma.qualityRun.create({
    data: {
      setId: set.id,
      promptVersion: env.LLM_PROMPT_VERSION,
      provider: provider.name,
      model: provider.model,
      startedBy: actorName,
      status: "RUNNING",
    },
  });

  let totalCost = 0;
  let totalTokens = 0;
  let itemCount = 0;
  let failed = 0;

  for (const question of questions) {
    const sanitized = sanitizeQuestion(question.text);

    // Doğrulanmış ürün bilgisi varsa modele verilir (AI taslağıyla aynı kural).
    const candidates = await findProductInfoForQuestion(
      {
        storeId: question.storeId,
        productMainId: question.productMainId,
        productId: question.productId,
      },
      { prisma },
    );
    const match = matchProductInfo(
      {
        storeId: question.storeId,
        productMainId: question.productMainId,
        productId: question.productId,
      },
      candidates,
    );
    const usable = (match.kind === "EXACT_VARIANT" || match.kind === "MAIN_PRODUCT") && isUsableForDraft(match);
    const card = usable ? candidates.find((candidate) => candidate.id === match.product.id) : undefined;
    const facts =
      card && Array.isArray(card.attributes)
        ? (card.attributes as unknown as Array<{ label: string; value: string }>)
        : [];
    const productInfoText = facts.length > 0 ? facts.map((f) => `${f.label}: ${f.value}`).join("\n") : null;

    const messages = buildDraftMessages({
      questionText: sanitized.text,
      productName: question.productName,
      productMainId: question.productMainId,
      productInfo: productInfoText,
      storeName: null,
      tone: null,
    });

    let answerText = "";
    let outcome = "OK";
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    let durationMs = 0;

    try {
      const completion = await provider.complete(messages);
      answerText = normalizeDraftText(completion.text);
      inputTokens = completion.usage.inputTokens;
      outputTokens = completion.usage.outputTokens;
      durationMs = completion.durationMs;
      cost = computeCostUSD(completion.usage, pricing);
      if (answerText.length === 0) outcome = "EMPTY";
    } catch (error) {
      failed += 1;
      outcome = "ERROR";
      await prisma.llmUsage.create({
        data: {
          provider: provider.name,
          model: provider.model,
          promptVersion: env.LLM_PROMPT_VERSION,
          outcome: "ERROR",
          errorCode: error instanceof LlmRequestError ? error.code : "UNKNOWN",
          durationMs: 0,
          estimated: true,
          estimatedCostUSD: 0,
          questionId: question.id,
          purpose: "quality",
        },
      });
    }

    const checks = evaluateAnswer(answerText, facts.length > 0);
    if (outcome === "OK" && checks.warnings.length > 0 && facts.length === 0) outcome = "NEEDS_INFO";

    totalCost += cost;
    totalTokens += inputTokens + outputTokens;
    itemCount += 1;

    await prisma.qualityItem.create({
      data: {
        runId: run.id,
        questionId: question.id,
        questionMasked: sanitized.text,
        answerText,
        autoChecks: checks as unknown as object,
        outcome,
        inputTokens,
        outputTokens,
        costUSD: cost,
        durationMs,
      },
    });

    // Sağlayıcıya/maliyete dair kayıt (başarılı çağrı)
    if (outcome !== "ERROR") {
      await prisma.llmUsage.create({
        data: {
          provider: provider.name,
          model: provider.model,
          promptVersion: env.LLM_PROMPT_VERSION,
          outcome: "SUCCESS",
          durationMs,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          estimated: true,
          estimatedCostUSD: cost,
          questionId: question.id,
          purpose: "quality",
        },
      });
    }
  }

  await prisma.qualityRun.update({
    where: { id: run.id },
    data: {
      status: failed === questions.length ? "FAILED" : failed > 0 ? "PARTIAL" : "COMPLETED",
      finishedAt: new Date(),
      totalCostUSD: totalCost,
      totalTokens,
      itemCount,
    },
  });

  return { runId: run.id, itemCount };
}

/** İnsan değerlendirmesi (1–5 + not). Otomatik kontrollerin yerine geçmez. */
export async function scoreQualityItem(
  input: { itemId: string; score: number; note?: string | null; actor: QualityActor },
  deps: QualityDeps = {},
): Promise<{ itemId: string; humanScore: number }> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const score = Math.trunc(input.score);
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    throw new QualityError("INVALID_SCORE", "Puan 1–5 arasında olmalı.");
  }

  const item = await prisma.qualityItem.findUnique({ where: { id: input.itemId } });
  if (!item) throw new QualityError("ITEM_NOT_FOUND", "Değerlendirme örneği bulunamadı.");

  await prisma.qualityItem.update({
    where: { id: item.id },
    data: {
      humanScore: score,
      humanNote: input.note?.trim() || null,
      evaluatedBy: actorName,
      evaluatedAt: new Date(),
    },
  });

  return { itemId: item.id, humanScore: score };
}

/** Koşu özetleri + panel metrikleri. */
export async function listQualityRuns(deps: QualityDeps = {}): Promise<QualityRunSummary[]> {
  const prisma = deps.prisma ?? getPrisma();

  const runs = await prisma.qualityRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 20,
    include: { set: { select: { name: true } }, items: true },
  });

  return runs.map((run) => {
    const items = run.items;
    const scored = items.filter((item) => item.humanScore !== null);
    const avg = scored.length > 0 ? scored.reduce((sum, item) => sum + (item.humanScore ?? 0), 0) / scored.length : null;

    const warningCount = items.filter((item) => {
      const checks = item.autoChecks as { warningCount?: number } | null;
      return (checks?.warningCount ?? 0) > 0;
    }).length;

    const needsInfoCount = items.filter((item) => item.outcome === "NEEDS_INFO").length;

    return {
      runId: run.id,
      setId: run.setId,
      setName: run.set.name,
      promptVersion: run.promptVersion,
      provider: run.provider,
      model: run.model,
      status: run.status,
      itemCount: run.itemCount,
      totalCostUSD: run.totalCostUSD,
      totalTokens: run.totalTokens,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      avgHumanScore: avg === null ? null : Math.round(avg * 100) / 100,
      scoredCount: scored.length,
      warningRate: items.length > 0 ? Math.round((warningCount / items.length) * 100) : 0,
      needsInfoRate: items.length > 0 ? Math.round((needsInfoCount / items.length) * 100) : 0,
    };
  });
}

export interface QualityItemView {
  id: string;
  questionMasked: string;
  answerText: string;
  outcome: string;
  checks: AutoChecks | null;
  costUSD: number;
  durationMs: number;
  humanScore: number | null;
  humanNote: string | null;
}

export async function listRunItems(runId: string, deps: QualityDeps = {}): Promise<QualityItemView[]> {
  const prisma = deps.prisma ?? getPrisma();
  const items = await prisma.qualityItem.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });

  return items.map((item) => ({
    id: item.id,
    questionMasked: item.questionMasked,
    answerText: item.answerText,
    outcome: item.outcome,
    checks: (item.autoChecks as unknown as AutoChecks) ?? null,
    costUSD: item.costUSD,
    durationMs: item.durationMs,
    humanScore: item.humanScore,
    humanNote: item.humanNote,
  }));
}

export async function listQualitySets(deps: QualityDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  return prisma.qualitySet.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
}

/** Günlük ve toplam kullanım/maliyet raporu (başarısız çağrılar dahil). */
export async function getUsageReport(deps: QualityDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();

  const [total, failures, successAgg, daily] = await Promise.all([
    prisma.llmUsage.count(),
    prisma.llmUsage.count({ where: { outcome: "ERROR" } }),
    prisma.llmUsage.aggregate({
      where: { outcome: "SUCCESS" },
      _sum: { totalTokens: true, estimatedCostUSD: true, durationMs: true },
      _avg: { durationMs: true },
      _count: true,
    }),
    prisma.$queryRaw<Array<{ day: Date; calls: bigint; tokens: bigint; cost: number }>>`
      SELECT date_trunc('day', "createdAt") AS day,
             COUNT(*)::bigint AS calls,
             COALESCE(SUM("totalTokens"), 0)::bigint AS tokens,
             COALESCE(SUM("estimatedCostUSD"), 0)::float8 AS cost
      FROM llm_usages
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 14
    `,
  ]);

  return {
    totalCalls: total,
    failedCalls: failures,
    successCalls: successAgg._count,
    totalTokens: successAgg._sum.totalTokens ?? 0,
    totalCostUSD: successAgg._sum.estimatedCostUSD ?? 0,
    avgDurationMs: successAgg._avg.durationMs ? Math.round(successAgg._avg.durationMs) : 0,
    daily: daily.map((row) => ({
      day: row.day,
      calls: Number(row.calls),
      tokens: Number(row.tokens),
      costUSD: row.cost,
    })),
  };
}

export { LlmNotConfiguredError, PROMPT_VERSION };
