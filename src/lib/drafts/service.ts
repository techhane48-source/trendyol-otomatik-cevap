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
import { extractOrderNumber } from "@/lib/orders/decision";
import { describeLiveOrder, getLiveOrder, type LiveOrderResult } from "@/lib/orders/live";
import { createClaimsClient, describeClaims, type ClaimsClient } from "@/lib/trendyol/claims-client";
import type { OrdersClient } from "@/lib/trendyol/orders-client";
import { isUsableForDraft, matchProductInfo } from "@/lib/products/matching";
import { findProductInfoForQuestion, type ProductAttribute } from "@/lib/products/service";
import { FIELD_DEFS, verifiedAttributes } from "@/lib/products/bank";
import { classifyQuestion, type QuestionCategory } from "@/lib/history/categories";
import {
  INTENT_FIELDS,
  INTENT_LABELS,
  INTENT_POLICIES,
  PRODUCT_INTENTS,
  decideStrategy,
  detectIntents,
  type AnswerStrategy,
  type Intent,
} from "@/lib/intents/taxonomy";
import { getPolicyContext, policyLabelOf } from "@/lib/policies/service";
import { getAutoFactsForQuestion, usableAutoFacts, type AutoFact } from "@/lib/products/auto-facts";
import { analyzeRequestedSize, describeSizeAmbiguity, describeSizeAnalysis, getVariantSizesForQuestion, parseSizeRequest, sizeLabelsIn } from "@/lib/products/sizes";
import { evaluateAnswerQuality } from "@/lib/drafts/resolution";

/** Soru kategorisinin gerektirdiği doğrulanmış ürün alanları. */
const CATEGORY_FIELDS: Partial<Record<QuestionCategory, Array<(typeof FIELD_DEFS)[number]["key"]>>> = {
  FABRIC: ["fabric", "blackout"],
  PLEAT: ["pleat", "sewing"],
  MEASURE: ["customSize", "description"],
  COLOR: ["colors"],
  WASH: ["care"],
  MOUNT: ["mounting"],
};

/** Ürün bilgisiyle cevaplanması gereken kategoriler. */
const PRODUCT_CATEGORIES: QuestionCategory[] = ["FABRIC", "PLEAT", "MEASURE", "COLOR", "WASH", "MOUNT", "OTHER"];

/** Sipariş sorusu ölçü içeriyorsa ürün bilgisi gerekir (ör. "300 en 240 boy için hangi ölçüyü seçmeliyim"). */
const ORDER_WITH_MEASURE = /öl[çc][üu]|\d{2,4}\s*[x×-]\s*\d{2,4}/i;

/** "Kontrol edip ileteceğim" gibi kaçamak cevaplar RESOLVED sayılmaz. */
export const EVASIVE_PATTERNS: RegExp[] = [
  /kontrol edip/i,
  /kontrol edece/i,
  /bilgi verece/i,
  /iletece[ğg]im/i,
  /iletece[ğg]iz/i,
  /de[ğg]erlendirece[ğg]iz/i,
  /d[öo]n[üu][şs] yapaca/i,
  /ara[şs]t[ıi]r[ıi]p/i,
];

export function isEvasiveAnswer(text: string): boolean {
  return EVASIVE_PATTERNS.some((pattern) => pattern.test(text));
}

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
  /** GÖREV 016: testlerde sahte sipariş/iade istemcisi enjekte edilir. */
  ordersClient?: Pick<OrdersClient, "fetchOrdersPage">;
  claimsClient?: Pick<ClaimsClient, "fetchClaims">;
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
  /** GÖREV 015: ANSWERED | PARTIAL | NEEDS_INFO | HUMAN_REVIEW (eski kayıtlarda RESOLVED/GENERIC) */
  resolution: "ANSWERED" | "PARTIAL" | "NEEDS_INFO" | "HUMAN_REVIEW" | "RESOLVED" | "GENERIC";
  /** GÖREV 012 — algılanan soru niyeti */
  intent: Intent;
  /** Niyet etiketi (Türkçe) */
  intentLabel: string;
  /** Cevap stratejisi */
  strategy: AnswerStrategy;
  /** Canlı fiyat/sipariş verisi gerektiriyor → insan incelemesi (otomatik onaya uygun değil) */
  requiresHumanReview: boolean;
  /** Cevapta kullanılan doğrulanmış mağaza politikaları */
  policiesUsed: Array<{ key: string; label: string; value: string }>;
  /** Bu soru için gerçekten gerekli ama doğrulanmamış alan/politika etiketleri */
  missingForIntent: string[];
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
  /** GÖREV 016: taslakta kullanılan gerçek veri kaynakları */
  contextSources: Array<{ type: string; label: string; at: string | null }>;
  /** GÖREV 016: sipariş eşleşmesi (güvenli değilse uyarı gösterilir) */
  orderMatch: "MATCHED" | "MISMATCH" | "UNVERIFIED" | "NOT_FOUND" | "UNAVAILABLE" | null;
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
  contextSources?: unknown;
  orderMatch?: string | null;
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
  intent?: string | null;
  strategy?: string | null;
  requiresHumanReview?: boolean | null;
  policiesUsed?: unknown;
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
    contextSources: Array.isArray(draft.contextSources)
      ? (draft.contextSources as Array<{ type: string; label: string; at: string | null }>)
      : [],
    orderMatch: (draft.orderMatch as DraftView["orderMatch"]) ?? null,
    intent: ((draft.intent as Intent | null) ?? "OTHER") as Intent,
    intentLabel: INTENT_LABELS[((draft.intent as Intent | null) ?? "OTHER") as Intent] ?? INTENT_LABELS.OTHER,
    strategy: ((draft.strategy as AnswerStrategy | null) ?? "ASK_DETAIL") as AnswerStrategy,
    requiresHumanReview: draft.requiresHumanReview ?? false,
    policiesUsed: Array.isArray(draft.policiesUsed)
      ? (draft.policiesUsed as Array<{ key: string; label: string; value: string }>)
      : [],
    missingForIntent: Array.isArray(draft.missingInfo)
      ? (draft.missingInfo as string[]).filter((item) => item.startsWith("Eksik:"))
      : [],
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
    /** GÖREV 014: risk bazlı otomatik güven (A sınıfı katalog bilgisi) kullanılsın mı? Ölçüm için kapatılabilir. */
    autoTrust?: boolean;
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
  let verifiedFieldKeys = new Set<string>();

  if (match.kind === "EXACT_VARIANT" || match.kind === "MAIN_PRODUCT") {
    const card = candidates.find((candidate) => candidate.id === match.product.id);
    // Alan bazında doğrulama: yalnızca `verified=true` alanlar (veya eski kayıtlarda
    // kart düzeyinde VERIFIED) doğrulanmış bilgi sayılır. Alan doğrulanmışsa kart
    // DRAFT olsa bile o alan kullanılabilir (kısmi doğrulama).
    const verified = verifiedAttributes(card?.attributes, (card?.status as "DRAFT" | "VERIFIED") ?? "DRAFT");
    if (isUsableForDraft(match) || verified.length > 0) {
      matchedProductId = match.product.id;
      cardFacts = verified.map((attribute) => ({ label: attribute.label, value: attribute.value }));
      verifiedFieldKeys = new Set(
        verified.map((attribute) => attribute.key ?? FIELD_DEFS.find((field) => field.label === attribute.label)?.key ?? ""),
      );
    }
  }

  const usedFacts: Array<{ label: string; value: string; source: "VERIFIED_CARD" | "MANUAL" | "CATALOG_AUTO" }> = [
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

  let productInfoText =
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
  const contextSources: Array<{ type: string; label: string; at: string | null }> = [];

  // ---- GÖREV 016: canlı sipariş bağlamı (salt okunur GET, müşteri eşleşmesi zorunlu) ----
  const orderNumber = extractOrderNumber(question.text).value;
  let liveOrder: LiveOrderResult | null = null;
  let liveOrderText: string | null = null;
  let claimsText: string | null = null;
  let orderMatch: DraftView["orderMatch"] = null;
  const orderNotices: string[] = [];

  if (orderNumber && (deps.ordersClient || getEnv().LIVE_ORDER_LOOKUP !== "0")) {
    try {
      liveOrder = await getLiveOrder(
        { storeId: question.storeId, orderNumber, questionCustomerId: question.customerId },
        { prisma, client: deps.ordersClient },
      );
    } catch {
      liveOrder = { kind: "UNAVAILABLE", reason: "Sipariş verisi alınamadı." };
    }
    orderMatch = liveOrder.kind === "NOT_FOUND" ? "NOT_FOUND" : liveOrder.kind;

    if (liveOrder.kind === "MATCHED") {
      liveOrderText = describeLiveOrder(liveOrder.order);
      contextSources.push({
        type: liveOrder.order.source === "REMOTE" ? "TRENDYOL_ORDER" : "ORDER_CACHE",
        label:
          liveOrder.order.source === "REMOTE"
            ? "Trendyol sipariş API (canlı)"
            : "Yerel sipariş kopyası (10 dk içinde çekildi)",
        at: liveOrder.order.fetchedAt.toISOString(),
      });
    } else if (liveOrder.kind === "MISMATCH") {
      orderNotices.push("Sipariş, soruyu soran müşteriyle eşleşmedi; kişisel sipariş detayı kullanılmadı.");
    } else if (liveOrder.kind === "UNVERIFIED") {
      orderNotices.push("Siparişin bu müşteriye ait olduğu doğrulanamadı; kişisel sipariş detayı kullanılmadı.");
    } else if (liveOrder.kind === "UNAVAILABLE") {
      orderNotices.push("Sipariş API'sine ulaşılamadı; güncel sipariş durumu iddiası kurulmadı.");
    }
  }

  // İade/para sorularında claim kaydı yalnızca bağlam olarak eklenir; para hareketi iddiası kurulmaz.
  const refundQuestion = /iade|para(?:y[ıi])?\s*geri|geri\s*[öo]deme|[üu]cret iadesi/i.test(question.text);
  if (orderNumber && refundQuestion && liveOrder?.kind !== "UNAVAILABLE") {
    try {
      const claims = await (deps.claimsClient ?? createClaimsClient()).fetchClaims({ orderNumber });
      claimsText = describeClaims(claims);
    } catch {
      claimsText = "- İade kaydı sorgulanamadı; iade durumu hakkında kesin bilgi verme.";
    }
  }

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

  // ---- GÖREV 012: niyet tespiti ve mağaza politikaları ----
  const intentInfo = detectIntents(sanitized.text);
  const intent = intentInfo.primary;
  const intentLabel = INTENT_LABELS[intent];
  const requiredFieldKeys = [...new Set(intentInfo.all.flatMap((item) => INTENT_FIELDS[item]))];
  const requiredPolicyKeys = [...new Set(intentInfo.all.flatMap((item) => INTENT_POLICIES[item]))];

  // Politika okunamazsa taslak üretimi durmaz; politika yokmuş gibi davranılır.
  let verifiedPolicies: Array<{ key: string; label: string; value: string }> = [];
  try {
    const policyContext = await getPolicyContext({ storeId: question.storeId }, { prisma });
    verifiedPolicies = policyContext.verified.map((policy) => ({
      key: policy.key,
      label: policy.label,
      value: policy.value,
    }));
  } catch {
    verifiedPolicies = [];
  }

  const relevantPolicies = verifiedPolicies.filter((policy) => requiredPolicyKeys.includes(policy.key));
  const coveredFieldKeys = requiredFieldKeys.filter((key) => verifiedFieldKeys.has(key));
  const coveredPolicyKeys = relevantPolicies.map((policy) => policy.key);

  let strategy: AnswerStrategy = decideStrategy({
    intent,
    requiredFields: requiredFieldKeys,
    coveredFields: coveredFieldKeys,
    requiredPolicies: requiredPolicyKeys,
    coveredPolicies: coveredPolicyKeys,
  });

  // ---- GÖREV 014: risk bazlı otomatik güven (A sınıfı katalog bilgisi) ----
  // İnsan yalnızca istisnaları inceler: A sınıfı bilgi tek tek onay beklemeden kullanılır,
  // B sınıfı prompt'a kesin bilgi olarak girmez, C sınıfı insan incelemesine düşer.
  let autoFacts: AutoFact[] = [];
  try {
    if (input.autoTrust === false) throw new Error("SKIP");
    autoFacts = usableAutoFacts(
      await getAutoFactsForQuestion({ storeId: question.storeId, productMainId: question.productMainId }, { prisma }),
    );
  } catch {
    autoFacts = [];
  }

  for (const fact of autoFacts) {
    if (verifiedFieldKeys.has(fact.fieldKey)) continue;
    if (!requiredFieldKeys.includes(fact.fieldKey)) continue;
    usedFacts.push({ label: fact.label, value: fact.value, source: "CATALOG_AUTO" });
    verifiedFieldKeys.add(fact.fieldKey);
  }
  productInfoText =
    usedFacts.length > 0 ? usedFacts.map((fact) => `${fact.label}: ${fact.value}`).join("\n") : null;

  const missingForIntent = [
    ...requiredFieldKeys
      .filter((key) => !verifiedFieldKeys.has(key))
      .map((key) => FIELD_DEFS.find((field) => field.key === key)?.label ?? key),
    ...requiredPolicyKeys
      .filter((key) => !coveredPolicyKeys.includes(key))
      .map((key) => policyLabelOf(key)),
  ];

  // ---- GÖREV 013/015: Türkçe ölçü anlama + katalogdaki gerçek varyantlarla karşılaştırma ----
  let sizeGuidance: string | null = null;
  let sizeExactMatch = false;
  let providedSize = false;
  // Ürünün gerçek katalog ölçüleri: cevapta geçen ölçülerin kaynağı sayılır.
  let catalogSizeLabels: string[] = [];
  if (question.productMainId) {
    try {
      const catalogSizes = await getVariantSizesForQuestion(
        { storeId: question.storeId, productMainId: question.productMainId },
        { prisma },
      );
      catalogSizeLabels = catalogSizes.map((size) => `${size.width}x${size.height}`);
    } catch {
      catalogSizeLabels = [];
    }
  }
  if (intentInfo.all.includes("CUSTOM_SIZE") || intentInfo.all.includes("ORDER_CHANGE")) {
    const sizeRequest = parseSizeRequest(sanitized.text);
    providedSize = Boolean(sizeRequest.requested || sizeRequest.single || sizeRequest.current);

    if (sizeRequest.requested) {
      try {
        const sizes = await getVariantSizesForQuestion(
          { storeId: question.storeId, productMainId: question.productMainId },
          { prisma },
        );
        const analysis = analyzeRequestedSize(sizes, sizeRequest.requested);
        sizeExactMatch = analysis.exact !== null;
        sizeGuidance = describeSizeAnalysis(analysis);
      } catch {
        // Katalog okunamazsa ölçü iddiası üretilmez; taslak yine oluşturulur.
        sizeGuidance = null;
      }
    }

    const ambiguity = describeSizeAmbiguity(sizeRequest);
    if (ambiguity) sizeGuidance = [sizeGuidance, ambiguity].filter(Boolean).join("\n");
  }

  // Eşleşmiş canlı sipariş varsa durum/kargo sorusu doğrudan cevaplanabilir.
  if (liveOrder?.kind === "MATCHED" && (intent === "ORDER_STATUS" || intent === "SHIPPING") && strategy !== "DIRECT") {
    strategy = "DIRECT";
  }

  // Katalogda birebir aynı varyant varsa bu doğrulanmış bilgidir: doğrudan cevap verilebilir.
  if (sizeExactMatch && intent === "CUSTOM_SIZE" && strategy !== "DIRECT") {
    strategy = "DIRECT";
  }

  const productQuestion = intentInfo.all.some((item) => PRODUCT_INTENTS.includes(item));
  // Onaylanmış sipariş değişikliği veya eşleşmiş canlı sipariş geçerli kaynaktır.
  const liveOrderSource = orderState.kind === "APPROVED" || liveOrder?.kind === "MATCHED";
  const noRelevantSource = coveredFieldKeys.length === 0 && coveredPolicyKeys.length === 0 && !liveOrderSource;
  const requiresHumanReview =
    strategy === "HUMAN_REVIEW" ||
    (!productQuestion && intent !== "OTHER" && noRelevantSource) ||
    (intent === "PRICE" && noRelevantSource);

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
    intent,
    intentLabel,
    strategy,
    sizeGuidance,
    orderNumberProvided: /\d{9,12}/.test(question.text ?? ""),
    liveOrderText,
    liveOrderAt: liveOrder?.kind === "MATCHED" ? liveOrder.order.fetchedAt.toISOString() : null,
    claimsText,
    policies: relevantPolicies.map((policy) => ({ label: policy.label, value: policy.value })),
    missingForIntent,
    requiresHumanReview,
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

  for (const notice of orderNotices) warnings.push({ kind: "ORDER", phrase: notice });

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

  // ---- GÖREV 012: çözüm sınıfı ve insan incelemesi ----

  // Doğrulanmış bilgi yokken KESİN VAAT (PROMISE) üretildiyse taslak onaya açılmaz.
  const hasUnverifiedPromise =
    warnings.some((warning) => warning.kind === "PROMISE") ||
    (orderViolations.length > 0 && orderState.kind !== "APPROVED");

  // Fiyat iddiası: canlı fiyat verisi yok. "Zam geldi / fiyat arttı" gibi ifadeler
  // yalnızca doğrulanmış fiyat politikası varsa ve buna dayanıyorsa kabul edilir.
  const PRICE_CHANGE_CLAIM = /(zam\s*(geldi|yapıldı|var)|fiyat\w*\s*(arttı|yükseldi|değişti|güncellendi)|indirim\s*(yaptık|uyguladık))/i;
  if (intent === "PRICE" && PRICE_CHANGE_CLAIM.test(text) && !coveredPolicyKeys.includes("price")) {
    warnings.push({
      kind: "PROMISE",
      phrase: "Fiyat değişimi iddiası — doğrulanmış fiyat verisi yok.",
    });
  }

  const evasive = isEvasiveAnswer(text);
  const blockingWarnings = warnings.filter((warning) => warning.kind === "PROMISE" || warning.kind === "STALE");

  const needsInfo =
    (hasUnverifiedPromise && usedFacts.length === 0 && coveredPolicyKeys.length === 0) ||
    historyUsage.blocksApproval ||
    (productQuestion && noRelevantSource);

  const draftStatus = needsInfo ? "NEEDS_INFO" : "PENDING";

  // GÖREV 015: "politika kullanıldı" tek başına çözüm sayılmaz. Cevabın içeriği değerlendirilir.
  const quality = evaluateAnswerQuality({
    question: sanitized.text,
    answer: text,
    intent,
    requiresHumanReview,
    coveredFields: coveredFieldKeys.length,
    coveredPolicies: coveredPolicyKeys.length,
    blockingWarnings: blockingWarnings.length,
    liveOrderVerified: liveOrderSource,
    providedOrderNumber: /\d{9,12}/.test(question.text ?? ""),
    providedSize,
    factValues: usedFacts.map((fact) => fact.value),
    evasive,
    refundQuestion: /iade|para(?:y[ıi])?\s*geri|geri\s*[öo]deme|[üu]cret iadesi/i.test(question.text),
    paymentVerified: false,
    fabricatedSizes: sizeLabelsIn(text).filter(
      (label) =>
        !sizeLabelsIn(sanitized.text).includes(label) &&
        !catalogSizeLabels.includes(label) &&
        !sizeLabelsIn(sizeGuidance ?? "").includes(label) &&
        !usedFacts.some((fact) => fact.value.replace(/\s/g, "").includes(label)),
    ),
  });
  // Onaya kapalı taslak (NEEDS_INFO) çözülmüş sayılmaz; insan incelemesi ayrı kalır.
  const resolution: DraftView["resolution"] =
    draftStatus === "NEEDS_INFO" && quality.quality !== "HUMAN_REVIEW" ? "NEEDS_INFO" : quality.quality;

  if (missingForIntent.length > 0) {
    missingInfo.push(`Eksik: ${missingForIntent.join(", ")}.`);
  }
  if (requiresHumanReview) {
    missingInfo.push(
      intent === "PRICE"
        ? "Fiyat/kampanya karşılaştırması için insan incelemesi gerekir (canlı fiyat verisi yok)."
        : "Bu soru için insan incelemesi gerekir.",
    );
  }

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
        contextSources: contextSources.length > 0 ? (contextSources as unknown as object) : undefined,
        orderMatch: orderMatch ?? undefined,
        resolution,
        intent,
        strategy,
        requiresHumanReview,
        policiesUsed:
          relevantPolicies.length > 0
            ? (relevantPolicies.map((policy) => ({ key: policy.key, label: policy.label, value: policy.value })) as unknown as object)
            : undefined,
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
