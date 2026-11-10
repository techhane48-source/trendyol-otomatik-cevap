import type { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { getPrisma } from "@/lib/prisma";

import { detectUnverifiedClaims, normalizeDraftText, type DraftWarning } from "./../llm/guardrails";
import { buildDraftMessages } from "./../llm/prompt";
import { createLlmProvider } from "./../llm/provider";
import { LlmNotConfiguredError, type LlmProvider } from "./../llm/types";
import { isUsableForDraft, matchProductInfo } from "@/lib/products/matching";
import { findProductInfoForQuestion, type ProductAttribute } from "@/lib/products/service";

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
  status: "PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED";
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
  };
}

/**
 * Soru için AI taslağı üretir. Ürün bilgisi yoksa model uydurmamaya yönlendirilir,
 * üretilen metin ayrıca guardrail ile denetlenir.
 */
export async function createAiDraft(
  input: { questionId: string; actor: Actor; productInfo?: string | null },
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

  if ((match.kind === "EXACT_VARIANT" || match.kind === "MAIN_PRODUCT") && isUsableForDraft(match)) {
    matchedProductId = match.product.id;
    const card = candidates.find((candidate) => candidate.id === match.product.id);
    cardFacts = Array.isArray(card?.attributes) ? (card.attributes as unknown as ProductAttribute[]) : [];
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

  const productInfoText =
    usedFacts.length > 0 ? usedFacts.map((fact) => `${fact.label}: ${fact.value}`).join("\n") : null;

  const messages = buildDraftMessages({
    questionText: question.text,
    productName: question.productName,
    productMainId: question.productMainId,
    productInfo: productInfoText,
    storeName: null,
    tone: null,
  });

  const completion = await provider.complete(messages);
  const text = normalizeDraftText(completion.text);
  if (text.length === 0) throw new DraftError("EMPTY_DRAFT", "Model boş taslak döndü.");

  const warnings = detectUnverifiedClaims(
    text,
    [question.productName, question.productMainId, productInfoText].filter(Boolean).join(" "),
  );

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
        status: "PENDING",
        source: "AI",
        text,
        warnings: warnings.length > 0 ? (warnings as unknown as object) : undefined,
        model: completion.model,
        promptVersion: completion.promptVersion,
        productInfoId: matchedProductId,
        productMatch: match.kind,
        usedFacts: usedFacts.length > 0 ? (usedFacts as unknown as object) : undefined,
        missingInfo: missingInfo.length > 0 ? (missingInfo as unknown as object) : undefined,
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
