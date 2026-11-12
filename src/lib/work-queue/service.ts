import type { PrismaClient } from "@/generated/prisma/client";

import { getPrisma } from "@/lib/prisma";
import { detectIntents } from "@/lib/intents/taxonomy";
import { maskPii } from "@/lib/llm/sanitize";
import { extractOrderNumber } from "@/lib/orders/decision";
import { classifyWork, type ClassifyInput, type WorkCategory, type WorkPriority } from "./classify";
import { getStoreSettings, teamForCategory } from "@/lib/store/settings";

/**
 * İş kuyruğu servisi (GÖREV 017).
 *
 * - Trendyol'a hiçbir yazma yapılmaz; yalnızca yerel iş kaydı ve geçmiş tutulur.
 * - Aynı soru için tek iş kaydı (questionId unique) — tekrar çalıştırma çoğaltmaz.
 * - Onay/ret/tamamlama yalnızca yetkili rolle yapılır; AI kendi kendine onay veremez.
 * - Atölye üretim aşaması elle işaretlenir; Trendyol durumundan türetilmez.
 */

export type WorkRole = "ADMIN" | "WORKSHOP" | "SUPPORT";

export interface WorkActor {
  name: string;
  role: WorkRole;
}

export class WorkAccessError extends Error {
  constructor(message = "Bu işlem için yetkiniz yok.") {
    super(message);
    this.name = "WorkAccessError";
  }
}

export class WorkError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkError";
    this.code = code;
  }
}

export interface WorkDeps {
  prisma?: PrismaClient;
}

function requireActor(actor: WorkActor | undefined | null): WorkActor {
  const name = actor?.name?.trim();
  if (!name || !actor) throw new WorkAccessError("Aktör bilgisi yok.");
  const workshopAllow = (process.env.WORK_QUEUE_WORKSHOP_ACTORS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (actor.role === "WORKSHOP" && workshopAllow.length > 0 && !workshopAllow.includes(name)) {
    throw new WorkAccessError("Bu kullanıcı atölye onayı veremez.");
  }
  return actor;
}

function assertRole(actor: WorkActor, allowed: WorkRole[]): void {
  if (!allowed.includes(actor.role)) throw new WorkAccessError();
}

const STATUS_ORDER: Record<string, string[]> = {
  NEW: ["IN_REVIEW"],
  IN_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["DONE"],
  REJECTED: ["DONE"],
  DONE: [],
};

function guessRequestType(text: string, types: Array<{ key: string; label: string }>): string {
  const lower = text.toLocaleLowerCase("tr");
  if (/ölçü|en[ib]?\s|boyu|boy\s/.test(lower) && types.some((type) => type.key === "measure_change")) return "measure_change";
  if (/dikim|pile|ku[şs]ak|aksesuar|ponpon/.test(lower)) {
    const sewing = types.find((type) => type.key === "sewing_change" || type.key === "accessory_add");
    if (sewing) return sewing.key;
  }
  return types[0]?.key ?? "generic_action";
}

export async function ensureWorkItems(
  input: { storeId?: string; questionIds?: string[] },
  deps: WorkDeps = {},
): Promise<{ created: number; existing: number }> {
  const prisma = deps.prisma ?? getPrisma();
  const store = input.storeId
    ? await prisma.store.findUniqueOrThrow({ where: { id: input.storeId } })
    : await prisma.store.findFirstOrThrow();

  const questions = await prisma.question.findMany({
    where: {
      storeId: store.id,
      ...(input.questionIds && input.questionIds.length > 0 ? { id: { in: input.questionIds } } : {}),
    },
    select: { id: true, text: true, productMainId: true },
    orderBy: { askedAt: "desc" },
  });

  let created = 0;
  let existing = 0;

  for (const question of questions) {
    const current = await prisma.workItem.findUnique({ where: { questionId: question.id }, select: { id: true } });
    if (current) {
      existing += 1;
      continue;
    }

    const draft = await prisma.answerDraft.findFirst({
      where: { questionId: question.id },
      orderBy: { revision: "desc" },
      select: {
        id: true,
        intent: true,
        strategy: true,
        resolution: true,
        requiresHumanReview: true,
        usedFacts: true,
        policiesUsed: true,
        orderMatch: true,
        contextSources: true,
      },
    });

    const intents = detectIntents(question.text);
    const orderNumber = extractOrderNumber(question.text).value;
    const order = orderNumber
      ? await prisma.order.findUnique({
          where: { storeId_orderNumber: { storeId: store.id, orderNumber } },
          select: { status: true, cargoProviderName: true, estimatedDeliveryEnd: true },
        })
      : null;

    const usedFacts = Array.isArray(draft?.usedFacts) ? (draft!.usedFacts as unknown[]) : [];
    const policies = Array.isArray(draft?.policiesUsed) ? (draft!.policiesUsed as unknown[]) : [];

    // Doğrulanmış ürün bilgisi sayısı taslaktan değil, bilgi bankasından okunur.
    const verifiedInfo = question.productMainId
      ? await prisma.productInfo.findMany({
          where: { storeId: store.id, productMainId: question.productMainId, status: "VERIFIED" },
          select: { attributes: true },
        })
      : [];
    const verifiedFieldCount = verifiedInfo.reduce((sum, info) => {
      const attributes = Array.isArray(info.attributes) ? (info.attributes as unknown[]) : [];
      return sum + attributes.length;
    }, 0);
    const verifiedPolicyCount = await prisma.storePolicy.count({ where: { storeId: store.id, verified: true } });

    const classifyInput: ClassifyInput = {
      text: question.text,
      intent: (draft?.intent as ClassifyInput["intent"]) ?? intents.primary,
      intents: intents.all,
      strategy: draft?.strategy ?? "ASK_DETAIL",
      resolution: draft?.resolution ?? "NEEDS_INFO",
      requiresHumanReview: draft?.requiresHumanReview ?? true,
      orderNumber,
      orderMatch: (draft?.orderMatch as string | null) ?? null,
      orderStatus: order?.status ?? null,
      coveredFields: Math.max(usedFacts.length, verifiedFieldCount),
      coveredPolicies: Math.max(policies.length, verifiedPolicyCount),
    };

    const result = classifyWork(classifyInput);
    const settings = await getStoreSettings(store.id);
    const requestTypeKey = result.category === "ACTION_REQUEST" ? guessRequestType(question.text, settings.requestTypes) : null;

    await prisma.workItem.create({
      data: {
        storeId: store.id,
        questionId: question.id,
        category: result.category,
        team: teamForCategory(settings, result.category) || result.team,
        priority: result.priority,
        reasons: result.reasons as unknown as object,
        orderNumber,
        orderMatch: classifyInput.orderMatch,
        orderStatusAtClassify: order?.status ?? null,
        sources: (Array.isArray(draft?.contextSources) ? draft!.contextSources : []) as unknown as object,
        draftId: draft?.id ?? null,
        requestTypeKey,
        events: {
          create: {
            action: "CREATED",
            actor: "sistem",
            role: "SYSTEM",
            note: `${result.category} · ${result.priority}`,
          },
        },
      },
    });
    created += 1;
  }

  return { created, existing };
}

const TEMPLATES = {
  APPROVED:
    "Talep ettiğiniz ölçü değişikliği üretim ekibimiz tarafından onaylanmıştır. Üretim planınıza işlenmiştir; kargo bilgisi sipariş detayınızda görünecektir.",
  REJECTED:
    "Ürününüzün üretim aşaması nedeniyle ölçü değişikliği talebiniz gerçekleştirilememektedir. Dilerseniz sipariş detayınızdan farklı bir varyant için bize yazabilirsiniz.",
} as const;

async function createResultDraft(
  prisma: PrismaClient,
  item: { questionId: string; storeId: string; id: string; orderMatch: string | null; orderNumber: string | null },
  outcome: "APPROVED" | "REJECTED",
  actor: WorkActor,
): Promise<string> {
  const previous = await prisma.answerDraft.findFirst({
    where: { questionId: item.questionId },
    orderBy: { revision: "desc" },
    select: { id: true, revision: true, intent: true },
  });

  const question = await prisma.question.findUnique({ where: { id: item.questionId }, select: { text: true } });
  const intents = detectIntents(question?.text ?? "");
  const draft = await prisma.answerDraft.create({
    data: {
      questionId: item.questionId,
      storeId: item.storeId,
      revision: (previous?.revision ?? 0) + 1,
      status: "PENDING",
      source: "AI",
      text: TEMPLATES[outcome],
      model: null,
      promptVersion: "work-queue-template-v1",
      resolution: "ANSWERED",
      requiresHumanReview: false,
      intent: (previous?.intent as never) ?? (intents.primary as never),
      strategy: "DIRECT",
      contextSources: [
        {
          type: "WORK_ITEM",
          label: outcome === "APPROVED" ? "Atölye onayı (kayıtlı işlem)" : "Atölye reddi (kayıtlı işlem)",
          at: new Date().toISOString(),
        },
      ] as unknown as object,
      orderMatch: item.orderMatch ?? undefined,
      createdBy: actor.name,
    },
  });
  return draft.id;
}

export interface WorkItemView {
  id: string;
  questionId: string;
  questionText: string;
  productName: string | null;
  category: string;
  team: string;
  priority: WorkPriority;
  status: string;
  reasons: string[];
  orderNumber: string | null;
  orderMatch: string | null;
  orderStatusAtClassify: string | null;
  sources: Array<{ type: string; label: string; at: string | null }>;
  draftId: string | null;
  draftText: string | null;
  productionStage: string | null;
  productionStageAt: Date | null;
  productionStageBy: string | null;
  assignedTo: string | null;
  firstReviewAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  events: Array<{ action: string; actor: string; role: string; note: string | null; createdAt: Date }>;
}

export async function listWorkItems(
  storeId: string,
  filters: { category?: string; status?: string; priority?: string; team?: string; search?: string; limit?: number } = {},
  deps: WorkDeps = {},
): Promise<WorkItemView[]> {
  const prisma = deps.prisma ?? getPrisma();
  const rows = await prisma.workItem.findMany({
    where: {
      storeId,
      ...(filters.category ? { category: filters.category as never } : {}),
      ...(filters.status ? { status: filters.status as never } : {}),
      ...(filters.priority ? { priority: filters.priority as never } : {}),
      ...(filters.team ? { team: filters.team } : {}),
    },
    orderBy: [
      { status: "asc" },
      { priority: "desc" },
      { createdAt: "desc" },
    ],
    take: filters.limit ?? 200,
    include: {
      events: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });

  const questionIds = rows.map((row) => row.questionId);
  const [questions, drafts] = await Promise.all([
    prisma.question.findMany({ where: { id: { in: questionIds } }, select: { id: true, text: true, productName: true } }),
    prisma.answerDraft.findMany({
      where: { id: { in: rows.map((row) => row.draftId).filter(Boolean) as string[] } },
      select: { id: true, text: true },
    }),
  ]);

  const questionById = new Map(questions.map((question) => [question.id, question]));
  const draftById = new Map(drafts.map((draft) => [draft.id, draft]));

  const search = filters.search?.trim().toLocaleLowerCase("tr");

  return rows
    .map((row) => {
      const question = questionById.get(row.questionId);
      return {
        id: row.id,
        questionId: row.questionId,
        questionText: question?.text ?? "",
        productName: question?.productName ?? null,
        category: row.category,
        team: row.team,
        priority: row.priority,
        status: row.status,
        reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
        orderNumber: row.orderNumber,
        orderMatch: row.orderMatch,
        orderStatusAtClassify: row.orderStatusAtClassify,
        sources: Array.isArray(row.sources) ? (row.sources as WorkItemView["sources"]) : [],
        draftId: row.draftId,
        draftText: row.draftId ? (draftById.get(row.draftId)?.text ?? null) : null,
        productionStage: row.productionStage,
        productionStageAt: row.productionStageAt,
        productionStageBy: row.productionStageBy,
        assignedTo: row.assignedTo,
        firstReviewAt: row.firstReviewAt,
        closedAt: row.closedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        events: row.events.map((event) => ({
          action: event.action,
          actor: event.actor,
          role: event.role,
          note: event.note,
          createdAt: event.createdAt,
        })),
      };
    })
    .filter((item) => {
      if (!search) return true;
      const haystack = `${item.questionText} ${item.productName ?? ""} ${maskPii(item.orderNumber ?? "")}`.toLocaleLowerCase("tr");
      return haystack.includes(search);
    });
}

async function loadItem(prisma: PrismaClient, id: string, storeId: string) {
  const item = await prisma.workItem.findFirst({ where: { id, storeId } });
  if (!item) throw new WorkError("NOT_FOUND", "İş kaydı bulunamadı.");
  return item;
}

function assertTransition(from: string, to: string): void {
  const allowed = STATUS_ORDER[from] ?? [];
  if (!allowed.includes(to)) {
    throw new WorkError("INVALID_TRANSITION", `${from} durumundan ${to} durumuna geçilemez.`);
  }
}

export async function startWorkReview(input: { storeId: string; workItemId: string; actor: WorkActor; note?: string }, deps: WorkDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const actor = requireActor(input.actor);
  const item = await loadItem(prisma, input.workItemId, input.storeId);
  assertTransition(item.status, "IN_REVIEW");

  return prisma.workItem.update({
    where: { id: item.id },
    data: {
      status: "IN_REVIEW",
      firstReviewAt: item.firstReviewAt ?? new Date(),
      assignedTo: actor.name,
      events: { create: { action: "START_REVIEW", actor: actor.name, role: actor.role, note: input.note ?? null } },
    },
  });
}

export async function approveWorkItem(input: { storeId: string; workItemId: string; actor: WorkActor; note?: string }, deps: WorkDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const actor = requireActor(input.actor);
  assertRole(actor, ["ADMIN", "WORKSHOP"]);

  const item = await loadItem(prisma, input.workItemId, input.storeId);
  assertTransition(item.status, "APPROVED");

  const draftId = await createResultDraft(prisma, item, "APPROVED", actor);

  return prisma.workItem.update({
    where: { id: item.id },
    data: {
      status: "APPROVED",
      draftId,
      events: {
        create: { action: "APPROVED", actor: actor.name, role: actor.role, note: input.note ?? null },
      },
    },
  });
}

export async function rejectWorkItem(input: { storeId: string; workItemId: string; actor: WorkActor; note?: string }, deps: WorkDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const actor = requireActor(input.actor);
  assertRole(actor, ["ADMIN", "WORKSHOP"]);

  const item = await loadItem(prisma, input.workItemId, input.storeId);
  assertTransition(item.status, "REJECTED");

  const draftId = await createResultDraft(prisma, item, "REJECTED", actor);

  return prisma.workItem.update({
    where: { id: item.id },
    data: {
      status: "REJECTED",
      draftId,
      events: { create: { action: "REJECTED", actor: actor.name, role: actor.role, note: input.note ?? null } },
    },
  });
}

export async function completeWorkItem(input: { storeId: string; workItemId: string; actor: WorkActor; note?: string }, deps: WorkDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const actor = requireActor(input.actor);
  assertRole(actor, ["ADMIN", "WORKSHOP"]);

  const item = await loadItem(prisma, input.workItemId, input.storeId);
  assertTransition(item.status, "DONE");

  return prisma.workItem.update({
    where: { id: item.id },
    data: {
      status: "DONE",
      closedAt: new Date(),
      events: { create: { action: "COMPLETED", actor: actor.name, role: actor.role, note: input.note ?? null } },
    },
  });
}

export async function setProductionStage(
  input: { storeId: string; workItemId: string; actor: WorkActor; stage: "NOT_STARTED" | "CUTTING" | "SEWING" | "PACKED" | "SHIPPED"; note?: string },
  deps: WorkDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma();
  const actor = requireActor(input.actor);
  assertRole(actor, ["ADMIN", "WORKSHOP"]);

  const item = await loadItem(prisma, input.workItemId, input.storeId);

  return prisma.workItem.update({
    where: { id: item.id },
    data: {
      productionStage: input.stage,
      productionStageAt: new Date(),
      productionStageBy: actor.name,
      events: {
        create: { action: "STAGE_CHANGED", actor: actor.name, role: actor.role, note: `${input.stage}${input.note ? ` · ${input.note}` : ""}` },
      },
    },
  });
}

export interface WorkMetrics {
  total: number;
  autoCandidate: number;
  support: number;
  workshop: number;
  needsInfo: number;
  pending: number;
  completed: number;
  averageResolutionMinutes: number | null;
}

export async function getWorkMetrics(storeId: string, deps: WorkDeps = {}): Promise<WorkMetrics> {
  const prisma = deps.prisma ?? getPrisma();
  const [total, autoCandidate, support, workshop, needsInfo, pending, closed] = await Promise.all([
    prisma.workItem.count({ where: { storeId } }),
    prisma.workItem.count({ where: { storeId, category: "AUTO_CANDIDATE" } }),
    prisma.workItem.count({ where: { storeId, category: { in: ["SUPPORT", "HUMAN_REVIEW"] } } }),
    prisma.workItem.count({ where: { storeId, category: { in: ["WORKSHOP", "ACTION_REQUEST"] } } }),
    prisma.workItem.count({ where: { storeId, category: "NEEDS_INFO" } }),
    prisma.workItem.count({ where: { storeId, status: { in: ["NEW", "IN_REVIEW", "APPROVED", "REJECTED"] } } }),
    prisma.workItem.findMany({ where: { storeId, status: "DONE", closedAt: { not: null } }, select: { createdAt: true, closedAt: true } }),
  ]);

  const durations = closed
    .map((item) => (item.closedAt ? item.closedAt.getTime() - item.createdAt.getTime() : null))
    .filter((value): value is number => value !== null && value >= 0);

  const averageResolutionMinutes =
    durations.length > 0 ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length / 60000) : null;

  return { total, autoCandidate, support, workshop, needsInfo, pending, completed: closed.length, averageResolutionMinutes };
}
