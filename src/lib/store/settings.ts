import { getPrisma } from "@/lib/prisma";

/**
 * Mağaza bazlı yapılandırma (GÖREV 018).
 *
 * Kategoriler, işlem türleri, sipariş kuralları ve modüller mağazaya aittir;
 * sektöre özel terimler çekirdeğe sabitlenmez. Aura Perde'nin ölçü kuralı
 * yalnızca o mağazanın `orderRules` kaydında durur.
 */

export interface WorkflowCategory {
  key: string;
  label: string;
  category: "AUTO_CANDIDATE" | "HUMAN_REVIEW" | "ACTION_REQUEST" | "NEEDS_INFO";
  team: string;
}

export interface RequestType {
  key: string;
  label: string;
}

export interface OrderRule {
  allowedStatuses: string[];
  blockedStatuses: string[];
  unknown: "HUMAN_REVIEW" | "ALLOW" | "DENY";
  humanReviewOnUnknown: boolean;
}

export interface StoreModules {
  showcase: boolean;
  catalog: boolean;
  changeRequests: boolean;
  workQueue: boolean;
}

export interface StoreSettingsView {
  workflow: WorkflowCategory[];
  requestTypes: RequestType[];
  orderRules: { changeRequest: OrderRule } | null;
  modules: StoreModules;
}

export const DEFAULT_WORKFLOW: WorkflowCategory[] = [
  { key: "auto_candidate", label: "Otomatik cevap adayı", category: "AUTO_CANDIDATE", team: "AI" },
  { key: "human_review", label: "İnsan incelemesi", category: "HUMAN_REVIEW", team: "Müşteri Temsilcisi" },
  { key: "action_request", label: "İşlem talebi", category: "ACTION_REQUEST", team: "İşlem Ekibi" },
  { key: "needs_info", label: "Bilgi eksik", category: "NEEDS_INFO", team: "Müşteri Temsilcisi" },
];

export const DEFAULT_REQUEST_TYPES: RequestType[] = [{ key: "generic_action", label: "Genel işlem talebi" }];

export const DEFAULT_MODULES: StoreModules = {
  showcase: true,
  catalog: true,
  changeRequests: true,
  workQueue: true,
};

export async function getStoreSettings(storeId: string): Promise<StoreSettingsView> {
  const prisma = getPrisma();
  let row = await prisma.storeSettings.findUnique({ where: { storeId } });
  if (!row) {
    // Yeni mağaza: varsayılan (sektörden bağımsız) yapılandırma ile başlar.
    row = await prisma.storeSettings.create({
      data: {
        storeId,
        workflow: DEFAULT_WORKFLOW as unknown as object,
        requestTypes: DEFAULT_REQUEST_TYPES as unknown as object,
        modules: DEFAULT_MODULES as unknown as object,
      },
    });
  }
  const workflow = Array.isArray(row?.workflow) ? (row!.workflow as unknown as WorkflowCategory[]) : DEFAULT_WORKFLOW;
  const requestTypes = Array.isArray(row?.requestTypes) ? (row!.requestTypes as unknown as RequestType[]) : DEFAULT_REQUEST_TYPES;
  const orderRules = row?.orderRules && typeof row.orderRules === "object"
    ? (row.orderRules as unknown as { changeRequest?: OrderRule })
    : null;
  const modules = row?.modules && typeof row.modules === "object" ? { ...DEFAULT_MODULES, ...(row.modules as object) } : DEFAULT_MODULES;

  return {
    workflow,
    requestTypes,
    orderRules: orderRules?.changeRequest ? { changeRequest: orderRules.changeRequest } : null,
    modules: modules as StoreModules,
  };
}

export function teamForCategory(settings: StoreSettingsView, category: string): string {
  return settings.workflow.find((entry) => entry.category === category)?.team ?? "Müşteri Temsilcisi";
}

export function labelForCategory(settings: StoreSettingsView, category: string): string {
  return settings.workflow.find((entry) => entry.category === category)?.label ?? category;
}

export async function saveWorkflow(storeId: string, workflow: WorkflowCategory[], requestTypes: RequestType[]) {
  const prisma = getPrisma();
  await prisma.storeSettings.upsert({
    where: { storeId },
    create: { storeId, workflow: workflow as unknown as object, requestTypes: requestTypes as unknown as object, modules: DEFAULT_MODULES as unknown as object },
    update: { workflow: workflow as unknown as object, requestTypes: requestTypes as unknown as object },
  });
}

export async function saveModules(storeId: string, modules: StoreModules) {
  const prisma = getPrisma();
  await prisma.storeSettings.upsert({
    where: { storeId },
    create: { storeId, modules: modules as unknown as object },
    update: { modules: modules as unknown as object },
  });
}

export async function saveOrderRule(storeId: string, rule: OrderRule | null) {
  const prisma = getPrisma();
  const value = rule ? { changeRequest: rule } : {};
  await prisma.storeSettings.upsert({
    where: { storeId },
    create: { storeId, orderRules: value as unknown as object },
    update: { orderRules: value as unknown as object },
  });
}

export type ChangeRuleDecision = "ALLOW" | "DENY" | "HUMAN_REVIEW";

/**
 * Sipariş durumuna göre ölçü/işlem talebi kuralı. Kural yoksa `null` döner ve
 * çağıran taraf genel davranışı uygular (başka mağazaya Aura kuralı uygulanmaz).
 */
export function evaluateChangeRule(
  settings: StoreSettingsView,
  orderStatus: string | null,
): { decision: ChangeRuleDecision; reason: string } | null {
  const rule = settings.orderRules?.changeRequest;
  if (!rule) return null;

  if (!orderStatus) {
    return {
      decision: rule.unknown === "ALLOW" ? "ALLOW" : rule.unknown === "DENY" ? "DENY" : "HUMAN_REVIEW",
      reason: "Sipariş durumu bilinmiyor; kural insan incelemesi istiyor.",
    };
  }

  const status = orderStatus.trim();
  if (rule.blockedStatuses.some((entry) => entry.toLowerCase() === status.toLowerCase())) {
    return { decision: "DENY", reason: `Sipariş durumu (${status}) bu mağazada değişiklik talebine kapalı.` };
  }
  if (rule.allowedStatuses.some((entry) => entry.toLowerCase() === status.toLowerCase())) {
    return { decision: "ALLOW", reason: `Sipariş durumu (${status}) değişiklik talebine açık.` };
  }
  return {
    decision: rule.unknown === "ALLOW" ? "ALLOW" : rule.unknown === "DENY" ? "DENY" : "HUMAN_REVIEW",
    reason: `Sipariş durumu (${status}) bu mağazanın kuralında tanımlı değil.`,
  };
}
