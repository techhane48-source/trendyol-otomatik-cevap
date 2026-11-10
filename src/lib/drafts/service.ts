import type { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { getPrisma } from "@/lib/prisma";

import { detectUnverifiedClaims, normalizeDraftText, type DraftWarning } from "./../llm/guardrails";
import { buildDraftMessages } from "./../llm/prompt";
import { createLlmProvider } from "./../llm/provider";
import { maskPii, sanitizeQuestion } from "./../llm/sanitize";
import { evaluateHistoryUsage } from "@/lib/history/guard";
import { searchHistoricalAnswers, type HistoryMatch } from "@/lib/history/search";
import { LlmNotConfiguredError, LlmRequestError, type LlmProvider } from "./../llm/types";
import { computeCostUSD, resolvePricing } from "./../llm/usage";
import { buildOrderGuidance, detectOrderClaimViolations, type OrderChangeState } from "@/lib/orders/ai-guidance";
import { isUsableForDraft, matchProductInfo } from "@/lib/products/matching";
import { findProductInfoForQuestion, type ProductAttribute } from "@/lib/products/service";
import { FIELD_DEFS, verifiedAttributes } from "@/lib/products/bank";

/**
 * Taslak (AI önerisi + insan onayı) servisi.
 *
 * KURAL: bu katman Trendyol'a HİÇBİR şey göndermez. `approveDraft` yalnızca
 * veritabanındaki taslağın durumunu, onaylayanı ve zamanını yazar.
 *
 * Geçmiş korunur: düzenleme mevcut satırı değiştirmez; yeni bir revizyon açar ve
 * eski revizyon `SUPERSEDED` olarak işaretlenir. Hiçbir revizyon silinmez.
 */

const log = createLogger("drafts");

export class DraftError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DraftError";
    this.code = code;
  }
}

export class DraftAccessError extends DraftError {
  constructor(message = "Bu işlem için yetkilendirme gerekli.") {
    super("UNAUTHORIZED", message);
  }
}

export class DraftWarningsUnacknowledgedError extends DraftError {
  readonly warnings: DraftWarning[];

  constructor(warnings: DraftWarning[]) {
    super(
      "WARNINGS_UNACKNOWLEDGED",
      "Taslakta doğrulanmamış somut ifadeler var. Onaylamadan önce düzenleyin veya uyarıları açıkça kabul edin.",
    );
    this.warnings = warnings;
  }
}

export interface Actor {
  /** İşlemi yapan kişi (tek kiracılı kurulumda `ADMIN_ACTOR_NAME`). */
  name: string;
}

export interface DraftDeps {
  prisma?: PrismaClient;
  /** Testlerde sahte sağlayıcı enjekte edilir. */
  provider?: LlmProvider;
}

export interface DraftView {
  id: string;
  revision: number;
  status: "PENDING" | "NEEDS_INFO" | "APPROVED" | "REJECTED" | "SUPERSEDED";
  source: "AI" | "HUMAN_EDIT";
  text: string;
  warnings: DraftWarning[];
  model: string | null;
  promptVersion: string | null;
  /** Kullanılan ürün bilgi kartı (varsa) */
  productInfoId: string | null;
  /** Eşleştirme sonucu: EXACT_VARIANT | MAIN_PRODUCT | AMBIGUOUS | MISSING */
  productMatch: string | null;
  /** Taslakta kullanılan doğrulanmış bilgiler */
  usedFacts: Array<{ label: string; value: string; source?: string }>;
  /** Eksik/doğrulanmamış bilgiler */
  missingInfo: string[];
  /** Üretim ölçümleri */
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCostUSD: number | null;
  usageEstimated: boolean;
  /** RESOLVED: doğrulanmış bilgiyle cevaplandı · GENERIC: bilgi yok · NEEDS_INFO: onaya kapalı */
  resolution: "RESOLVED" | "NEEDS_INFO" | "GENERIC";
  /** Taslakta yararlanılan geçmiş cevaplar (soru kimliği + gerekçe) */
  historyUsed: Array<{
    questionId: string;
    trendyolQuestionId: string;
    reviewStatus: string;
    score: number;
    similarity: number;
    productMatch: boolean;
    reason: string;
  }>;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
}

export interface DraftWithHistory extends DraftView {
  questionId: string;
  history: Array<{
    action: "CREATED" | "EDITED" | "APPROVED" | "REJECTED" | "SUPERSEDED";
    actor: string;
    note: string | null;
    createdAt: Date;
  }>;
}

/** Panel/ara katman için ham Prisma satırını görünüm nesnesine çevirir. */
export function toDraftView(draft: Parameters<typeof toView>[0]): DraftView {
  return toView(draft);
}

function toWarnings(value: unknown): DraftWarning[] {
  return Array.isArray(value) ? (value as DraftWarning[]) : [];
}

function requireActor(actor: Actor | undefined): string {
  const name = actor?.name?.trim();
  if (!name) throw new DraftAccessError();
  return name;
}

function toView(draft: {
  id: string;
  revision: number;
  status: DraftView["status"];
  source: DraftView["source"];
  text: string;
  warnings: unknown;
  model: string | null;
  promptVersion: string | null;
  productInfoId?: string | null;
  productMatch?: string | null;
  usedFacts?: unknown;
  missingInfo?: unknown;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  estimatedCostUSD?: number | null;
  usageEstimated?: boolean | null;
  historyUsed?: unknown;
  resolution?: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
}): DraftView {
  return {
    ...draft,
    warnings: toWarnings(draft.warnings),
    productInfoId: draft.productInfoId ?? null,
    productMatch: draft.productMatch ?? null,
    usedFacts: Array.isArray(draft.usedFacts)
      ? (draft.usedFacts as Array<{ label: string; value: string; source?: string }>)
      : [],
    missingInfo: Array.isArray(draft.missingInfo) ? (draft.missingInfo as string[]) : [],
    durationMs: draft.durationMs ?? null,
    inputTokens: draft.inputTokens ?? null,
    outputTokens: draft.outputTokens ?? null,
    totalTokens: draft.totalTokens ?? null,
    estimatedCostUSD: draft.estimatedCostUSD ?? null,
    usageEstimated: draft.usageEstimated ?? false,
    historyUsed: Array.isArray(draft.historyUsed) ? (draft.historyUsed as DraftView["historyUsed"]) : [],
    resolution: (draft.resolution as DraftView["resolution"]) ?? "GENERIC",
  };
}

/**
 * Soru için AI taslağı üretir. Ürün bilgisi yoksa model uydurmamaya yönlendirilir,
 * üretilen metin ayrıca guardrail ile denetlenir.
 */
export async function createAiDraft(
  input: {
    questionId: string;
    actor: Actor;
    productInfo?: string | null;
    /** Geçmiş cevap hafızasını kullan (karşılaştırma ölçümü için kapatılabilir). */
    includeHistory?: boolean;
  },
  deps: DraftDeps = {},
): Promise<DraftView> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();
  const env = getEnv();

  const question = await prisma.question.findUnique({ where: { id: input.questionId } });
  if (!question) throw new DraftError("QUESTION_NOT_FOUND", "Soru bulunamadı.");

  // Sağlayıcı yoksa hiçbir satır yazılmaz; panel net hata gösterir.
  const provider = deps.provider ?? createLlmProvider(env);
  const manualInfo = input.productInfo?.trim() || null;

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

  // Yalnızca doğrulanmış (VERIFIED) ve kesin eşleşen kart kullanılır.
  let matchedProductId: string | null = null;
  let cardFacts: ProductAttribute[] = [];

  if (match.kind === "EXACT_VARIANT" || match.kind === "MAIN_PRODUCT") {
    const card = candidates.find((candidate) => candidate.id === match.product.id);
    // Alan bazında doğrulama: yalnızca `verified=true` alanlar (veya eski kayıtlarda
    // kart düzeyinde VERIFIED) doğrulanmış bilgi sayılır. Alan doğrulanmışsa kart
    // DRAFT olsa bile o alan kullanılabilir (kısmi doğrulama).
    const verified = verifiedAttributes(card?.attributes, (card?.status as "DRAFT" | "VERIFIED") ?? "DRAFT");
    if (isUsableForDraft(match) || verified.length > 0) {
      matchedProductId = match.product.id;
      cardFacts = verified.map((attribute) => ({ label: attribute.label, value: attribute.value }));
    }
  }

  const usedFacts = [
    ...cardFacts.map((fact) => ({ ...fact, source: "VERIFIED_CARD" as const })),
    ...(manualInfo ? [{ label: "Elle girilen bilgi", value: manualInfo, source: "MANUAL" as const }] : []),
  ];

  const missingInfo: string[] = [];
  if (match.kind === "MISSING") missingInfo.push("Ürün için kayıtlı bilgi kartı yok.");
  if (match.kind === "AMBIGUOUS") {
    missingInfo.push("Varyant belirsiz: aynı ana ürün altında birden fazla kayıt var; bilgi kullanılmadı.");
  }
  if ((match.kind === "EXACT_VARIANT" || match.kind === "MAIN_PRODUCT") && !isUsableForDraft(match)) {
    missingInfo.push("Ürün bilgi kartı doğrulanmamış (DRAFT); bilgi kullanılmadı.");
  }
  if (usedFacts.length === 0) missingInfo.push("Doğrulanmış ürün özelliği bulunmuyor.");

  // Alan bazlı eksikler: doğrulanmış kartta hangi alanlar boş/doğrulanmamış?
  if (matchedProductId) {
    const card = candidates.find((candidate) => candidate.id === matchedProductId);
    const attributes = Array.isArray(card?.attributes) ? (card!.attributes as unknown as Array<{ key?: string; label?: string; verified?: boolean; value?: string }>) : [];
    const verifiedLabels = new Set(
      attributes.filter((attribute) => attribute.verified === true).map((attribute) => attribute.key ?? attribute.label),
    );
    const missingFields = FIELD_DEFS.filter((field) => {
      const attribute = attributes.find((item) => (item.key ?? item.label) === field.key);
      return !attribute || !attribute.value || !verifiedLabels.has(field.key);
    }).map((field) => field.label);

    if (missingFields.length > 0) {
      missingInfo.push(`Doğrulanmamış alanlar: ${missingFields.join(", ")}.`);
    }
  }

  const productInfoText =
    usedFacts.length > 0 ? usedFacts.map((fact) => `${fact.label}: ${fact.value}`).join("\n") : null;

  // Sipariş/ölçü değişikliği bağlamı: AI kendi başına onay iddiası üretemez.
  const latestChange = await prisma.orderChangeRequest.findFirst({
    where: { questionId: question.id },
    orderBy: { createdAt: "desc" },
    select: { status: true, orderNumber: true, matchNote: true },
  });

  const orderState: OrderChangeState = !latestChange
    ? { kind: "NONE" }
    : latestChange.status === "APPROVED"
      ? { kind: "APPROVED", orderNumber: latestChange.orderNumber }
      : latestChange.status === "PENDING_REVIEW"
        ? { kind: "PENDING_REVIEW", orderNumber: latestChange.orderNumber, status: latestChange.status }
        : latestChange.status === "NEEDS_VERIFICATION"
          ? { kind: "NEEDS_VERIFICATION", reason: latestChange.matchNote }
          : latestChange.status === "INVALIDATED"
            ? { kind: "INVALIDATED", orderNumber: latestChange.orderNumber }
            : { kind: "REJECTED", reason: latestChange.matchNote };

  const orderGuidance = buildOrderGuidance(orderState);

  const sanitized = sanitizeQuestion(question.text);

  // Geçmiş cevap hafızası: yalnızca aynı mağaza, cevabı olan ve WRONG/OUTDATED olmayan kayıtlar.
  // Metinler PII'den arındırılır; ham müşteri kimliği bağlama girmez.
  let historyMatches: HistoryMatch[] = [];
  if (input.includeHistory !== false) {
    try {
      historyMatches = await searchHistoricalAnswers(
        {
          storeId: question.storeId,
          text: question.text,
          productMainId: question.productMainId,
          excludeQuestionId: question.id,
          limit: 4,
        },
        { prisma },
      );
    } catch {
      // Arama altyapısı (pg_trgm) yoksa taslak üretimi durmaz; hafızasız devam edilir.
      historyMatches = [];
    }
  }

  const historyForPrompt = historyMatches.map((match) => ({
    ref: `#${match.trendyolQuestionId}`,
    question: maskPii(match.text),
    answer: maskPii(match.answerText),
    reviewStatus: match.reviewStatus,
    reason: match.reason,
  }));

  const messages = buildDraftMessages({
    questionText: sanitized.text,
    productName: question.productName,
    productMainId: question.productMainId,
    productInfo: productInfoText,
    storeName: null,
    tone: null,
    history: historyForPrompt.length > 0 ? historyForPrompt : null,
    orderGuidance: `${orderGuidance.instruction}${orderGuidance.suggestedPhrase ? ` Örnek cümle: "${orderGuidance.suggestedPhrase}"` : ""}`,
  });

  const llmStartedAt = Date.now();
  let completion;
  try {
    completion = await provider.complete(messages);
  } catch (error) {
    // Başarısız çağrı da kaydedilir (anahtar/prompt/müşteri verisi YAZILMAZ).
    await prisma.llmUsage.create({
      data: {
        provider: provider.name,
        model: provider.model,
        promptVersion: env.LLM_PROMPT_VERSION,
        outcome: "ERROR",
        errorCode: error instanceof LlmRequestError ? error.code : "UNKNOWN",
        durationMs: Date.now() - llmStartedAt,
        estimated: true,
        estimatedCostUSD: 0,
        questionId: question.id,
        purpose: "draft",
      },
    });
    throw error;
  }

  const text = normalizeDraftText(completion.text);
  if (text.length === 0) throw new DraftError("EMPTY_DRAFT", "Model boş taslak döndü.");

  const costUSD = computeCostUSD(completion.usage, resolvePricing(env));

  const warnings = detectUnverifiedClaims(
    text,
    [question.productName, question.productMainId, productInfoText].filter(Boolean).join(" "),
  );

  const orderViolations = detectOrderClaimViolations(text, orderState);
  for (const violation of orderViolations) {
    if (!warnings.some((warning) => warning.phrase === violation.phrase)) warnings.push(violation);
  }

  const historyUsage = evaluateHistoryUsage(text, historyMatches, {
    verifiedCardUsed: usedFacts.length > 0,
    liveOrderVerified: orderState.kind === "APPROVED",
  });
  for (const message of historyUsage.messages) {
    if (!warnings.some((warning) => warning.phrase === message)) {
      warnings.push({ kind: "STALE", phrase: message });
    }
  }
  if (historyMatches.length > 0) {
    missingInfo.push(
      `Geçmiş cevaplardan ${historyMatches.length} kayıt referans alındı (doğrulanmış gerçek değildir).`,
    );
  }

  if (sanitized.injectionSuspected) {
    missingInfo.push("Soru metninde talimat benzeri ifade tespit edildi; güvenilmeyen veri olarak işlendi.");
  }

  // Doğrulanmış bilgi yokken KESİN VAAT (PROMISE) üretildiyse taslak onaya açılmaz:
  // NEEDS_INFO, insan müdahalesi (düzenleme) gerektiğini açıkça gösterir. Sıradan
  // ölçü/malzeme uyarıları mevcut "uyarıyı kabul et" akışıyla onaylanabilir kalır.
  const hasUnverifiedPromise =
    warnings.some((warning) => warning.kind === "PROMISE") ||
    (orderViolations.length > 0 && orderState.kind !== "APPROVED");
  const needsInfo = (hasUnverifiedPromise && usedFacts.length === 0) || historyUsage.blocksApproval;
  const draftStatus = needsInfo ? "NEEDS_INFO" : "PENDING";

  // Çözüm sınıfı: doğrulanmış bilgiyle ve vaat/uyarı olmadan cevaplandıysa RESOLVED.
  const blockingWarnings = warnings.filter((warning) => warning.kind === "PROMISE" || warning.kind === "STALE");
  const resolution: "RESOLVED" | "NEEDS_INFO" | "GENERIC" =
    draftStatus === "NEEDS_INFO"
      ? "NEEDS_INFO"
      : usedFacts.length > 0 && blockingWarnings.length === 0
        ? "RESOLVED"
        : "GENERIC";

  const draft = await prisma.$transaction(async (tx) => {
    const last = await tx.answerDraft.findFirst({
      where: { questionId: question.id },
      orderBy: { revision: "desc" },
      select: { revision: true },
    });

    const revision = (last?.revision ?? 0) + 1;

    // Aynı sorunun bekleyen eski taslakları geçersiz kılınır (silinmez).
    const superseded = await tx.answerDraft.findMany({
      where: { questionId: question.id, status: "PENDING" },
      select: { id: true },
    });

    for (const item of superseded) {
      await tx.answerDraft.update({ where: { id: item.id }, data: { status: "SUPERSEDED" } });
      await tx.draftEvent.create({
        data: { draftId: item.id, action: "SUPERSEDED", actor: actorName, note: `Yeni revizyon: ${revision}` },
      });
    }

    const created = await tx.answerDraft.create({
      data: {
        questionId: question.id,
        storeId: question.storeId,
        revision,
        status: draftStatus,
        source: "AI",
        text,
        warnings: warnings.length > 0 ? (warnings as unknown as object) : undefined,
        model: completion.model,
        promptVersion: completion.promptVersion,
        productInfoId: matchedProductId,
        productMatch: match.kind,
        usedFacts: usedFacts.length > 0 ? (usedFacts as unknown as object) : undefined,
        missingInfo: missingInfo.length > 0 ? (missingInfo as unknown as object) : undefined,
        durationMs: completion.durationMs,
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        totalTokens: completion.usage.totalTokens,
        estimatedCostUSD: costUSD,
        usageEstimated: completion.usage.estimated,
        resolution,
        historyUsed:
          historyMatches.length > 0
            ? (historyMatches.map((match) => ({
                questionId: match.questionId,
                trendyolQuestionId: match.trendyolQuestionId,
                reviewStatus: match.reviewStatus,
                score: match.score,
                similarity: match.similarity,
                productMatch: match.productMatch,
                reason: match.reason,
              })) as unknown as object)
            : undefined,
        createdBy: actorName,
      },
    });

    await tx.draftEvent.create({
      data: {
        draftId: created.id,
        action: "CREATED",
        actor: actorName,
        note: warnings.length > 0 ? `${warnings.length} guardrail uyarısı` : null,
      },
    });

    return created;
  });

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
      estimatedCostUSD: costUSD,
      draftId: draft.id,
      questionId: question.id,
      purpose: "draft",
    },
  });

  log.info("AI taslağı oluşturuldu", {
    draftId: draft.id,
    revision: draft.revision,
    warnings: warnings.length,
    provider: completion.provider,
  });

  return toView(draft);
}

/** Taslağı düzenler: YENİ revizyon oluşturur, eski revizyon korunur. */
export async function editDraft(
  input: { draftId: string; text: string; actor: Actor; note?: string | null },
  deps: DraftDeps = {},
): Promise<DraftView> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const text = normalizeDraftText(input.text);
  if (text.length < 5) throw new DraftError("INVALID_TEXT", "Taslak metni en az 5 karakter olmalı.");
  if (text.length > 2_000) throw new DraftError("INVALID_TEXT", "Taslak metni 2000 karakteri aşamaz.");

  const base = await prisma.answerDraft.findUnique({ where: { id: input.draftId } });
  if (!base) throw new DraftError("DRAFT_NOT_FOUND", "Taslak bulunamadı.");
  if (base.status === "APPROVED" || base.status === "REJECTED") {
    throw new DraftError("DRAFT_LOCKED", "Onaylanmış veya reddedilmiş taslak düzenlenemez; yeni taslak oluşturun.");
  }

  const warnings = detectUnverifiedClaims(text, "");

  const draft = await prisma.$transaction(async (tx) => {
    const last = await tx.answerDraft.findFirst({
      where: { questionId: base.questionId },
      orderBy: { revision: "desc" },
      select: { revision: true },
    });
    const revision = (last?.revision ?? 0) + 1;

    await tx.answerDraft.update({ where: { id: base.id }, data: { status: "SUPERSEDED" } });
    await tx.draftEvent.create({
      data: {
        draftId: base.id,
        action: "SUPERSEDED",
        actor: actorName,
        note: `Düzenlendi → revizyon ${revision}`,
      },
    });

    const created = await tx.answerDraft.create({
      data: {
        questionId: base.questionId,
        storeId: base.storeId,
        revision,
        status: "PENDING",
        source: "HUMAN_EDIT",
        text,
        warnings: warnings.length > 0 ? (warnings as unknown as object) : undefined,
        model: base.model,
        promptVersion: base.promptVersion,
        productInfoId: base.productInfoId,
        productMatch: base.productMatch,
        usedFacts: base.usedFacts ?? undefined,
        missingInfo: base.missingInfo ?? undefined,
        createdBy: actorName,
        reviewNote: input.note?.trim() || null,
      },
    });

    await tx.draftEvent.create({
      data: {
        draftId: created.id,
        action: "EDITED",
        actor: actorName,
        note: input.note?.trim() || null,
      },
    });

    return created;
  });

  return toView(draft);
}

/**
 * Taslağı onaylar. Trendyol'a hiçbir istek gitmez; yalnızca yerel durum,
 * onaylayan ve onay zamanı yazılır. Guardrail uyarıları varsa açık kabul gerekir.
 */
export async function approveDraft(
  input: { draftId: string; actor: Actor; note?: string | null; acknowledgeWarnings?: boolean },
  deps: DraftDeps = {},
): Promise<DraftView> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const draft = await prisma.answerDraft.findUnique({ where: { id: input.draftId } });
  if (!draft) throw new DraftError("DRAFT_NOT_FOUND", "Taslak bulunamadı.");
  if (draft.status === "APPROVED") throw new DraftError("ALREADY_APPROVED", "Taslak zaten onaylanmış.");
  if (draft.status === "REJECTED") throw new DraftError("DRAFT_REJECTED", "Reddedilmiş taslak onaylanamaz.");
  if (draft.status === "SUPERSEDED") {
    throw new DraftError("DRAFT_SUPERSEDED", "Daha yeni bir revizyon var; onaylamak için son revizyonu kullanın.");
  }
  if (draft.status === "NEEDS_INFO") {
    throw new DraftError(
      "DRAFT_NEEDS_INFO",
      "Bu taslak doğrulanmış bilgi olmadan somut iddia içeriyor. Önce düzenleyip bilgiyi doğrulayın, sonra onaylayın.",
    );
  }

  const warnings = toWarnings(draft.warnings);
  if (warnings.length > 0 && !input.acknowledgeWarnings) {
    throw new DraftWarningsUnacknowledgedError(warnings);
  }

  const note =
    [input.note?.trim() || null, warnings.length > 0 ? `${warnings.length} guardrail uyarısı kabul edildi` : null]
      .filter(Boolean)
      .join(" | ") || null;

  const approved = await prisma.$transaction(async (tx) => {
    // Aynı soruda daha önce onaylanmış taslak varsa geçersiz kılınır (geçmiş korunur).
    const previous = await tx.answerDraft.findMany({
      where: { questionId: draft.questionId, status: "APPROVED", id: { not: draft.id } },
      select: { id: true },
    });

    for (const item of previous) {
      await tx.answerDraft.update({
        where: { id: item.id },
        data: { status: "SUPERSEDED" },
      });
      await tx.draftEvent.create({
        data: {
          draftId: item.id,
          action: "SUPERSEDED",
          actor: actorName,
          note: `Revizyon ${draft.revision} onaylandı`,
        },
      });
    }

    const updated = await tx.answerDraft.update({
      where: { id: draft.id },
      data: {
        status: "APPROVED",
        approvedBy: actorName,
        approvedAt: new Date(),
        reviewNote: note,
      },
    });

    await tx.draftEvent.create({
      data: { draftId: draft.id, action: "APPROVED", actor: actorName, note },
    });

    return updated;
  });

  log.info("Taslak onaylandı (yalnızca yerel kayıt)", {
    draftId: approved.id,
    revision: approved.revision,
    approvedBy: actorName,
  });

  return toView(approved);
}

/** Taslağı reddeder (geçmiş ve metin korunur). */
export async function rejectDraft(
  input: { draftId: string; actor: Actor; note?: string | null },
  deps: DraftDeps = {},
): Promise<DraftView> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const draft = await prisma.answerDraft.findUnique({ where: { id: input.draftId } });
  if (!draft) throw new DraftError("DRAFT_NOT_FOUND", "Taslak bulunamadı.");
  if (draft.status === "APPROVED") throw new DraftError("ALREADY_APPROVED", "Onaylanmış taslak reddedilemez.");
  if (draft.status === "REJECTED") throw new DraftError("ALREADY_REJECTED", "Taslak zaten reddedilmiş.");
  if (draft.status === "SUPERSEDED") {
    throw new DraftError("DRAFT_SUPERSEDED", "Daha yeni bir revizyon var; onu reddedin.");
  }

  const note = input.note?.trim() || null;

  const rejected = await prisma.$transaction(async (tx) => {
    const updated = await tx.answerDraft.update({
      where: { id: draft.id },
      data: { status: "REJECTED", rejectedBy: actorName, rejectedAt: new Date(), reviewNote: note },
    });

    await tx.draftEvent.create({
      data: { draftId: draft.id, action: "REJECTED", actor: actorName, note },
    });

    return updated;
  });

  log.info("Taslak reddedildi", { draftId: rejected.id, rejectedBy: actorName });

  return toView(rejected);
}

/** Soru bazında tüm revizyonlar + denetim kaydı (geçmiş korunur). */
export async function getDraftHistory(
  questionId: string,
  deps: DraftDeps = {},
): Promise<DraftWithHistory[]> {
  const prisma = deps.prisma ?? getPrisma();

  const drafts = await prisma.answerDraft.findMany({
    where: { questionId },
    orderBy: { revision: "asc" },
    include: { events: { orderBy: { createdAt: "asc" } } },
  });

  return drafts.map((draft) => ({
    ...toView(draft),
    questionId: draft.questionId,
    history: draft.events.map((event) => ({
      action: event.action,
      actor: event.actor,
      note: event.note,
      createdAt: event.createdAt,
    })),
  }));
}

/** Panel için: son revizyonu ve durumu ile birlikte sorular. */
export async function listQuestionsForDrafting(
  options: { limit?: number; status?: "WAITING_FOR_ANSWER" | "ANSWERED" | "REJECTED" | "UNKNOWN" } = {},
  deps: DraftDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma();
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

  return prisma.question.findMany({
    where: options.status ? { status: options.status } : undefined,
    orderBy: [{ status: "asc" }, { askedAt: "desc" }],
    take: limit,
    include: {
      drafts: { orderBy: { revision: "desc" }, take: 1 },
    },
  });
}

export { LlmNotConfiguredError };
