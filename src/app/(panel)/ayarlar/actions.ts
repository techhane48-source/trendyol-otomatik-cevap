"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireApiUser } from "@/lib/auth/session";
import { saveModules, saveOrderRule, saveWorkflow, getStoreSettings, type OrderRule } from "@/lib/store/settings";

async function guard() {
  return requireApiUser(["OWNER", "ADMIN"]);
}

function lines(value: string): string[][] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("|").map((part) => part.trim()));
}

export async function saveSettingsAction(formData: FormData): Promise<void> {
  const user = await guard();
  if (!user) redirect("/giris");
  const settings = await getStoreSettings(user.storeId);

  // Modüller
  await saveModules(user.storeId, {
    showcase: formData.get("showcase") === "on",
    catalog: formData.get("catalog") === "on",
    changeRequests: formData.get("changeRequests") === "on",
    workQueue: formData.get("workQueue") === "on",
  });

  // Kategori etiketleri ve ekipler (sabit 4 kategori; etiket/ekip mağazaya özel)
  const workflow = settings.workflow.map((entry) => ({
    ...entry,
    label: String(formData.get(`label_${entry.category}`) ?? entry.label).trim() || entry.label,
    team: String(formData.get(`team_${entry.category}`) ?? entry.team).trim() || entry.team,
  }));
  const requestTypes = lines(String(formData.get("requestTypes") ?? ""))
    .filter((parts) => parts[0])
    .map((parts) => ({ key: parts[0], label: parts[1] ?? parts[0] }));
  await saveWorkflow(user.storeId, workflow, requestTypes.length > 0 ? requestTypes : settings.requestTypes);

  // Sipariş kuralı
  const allowed = String(formData.get("allowedStatuses") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const blocked = String(formData.get("blockedStatuses") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = String(formData.get("unknownDecision") ?? "HUMAN_REVIEW") as OrderRule["unknown"];

  const rule: OrderRule | null =
    allowed.length === 0 && blocked.length === 0
      ? null
      : { allowedStatuses: allowed, blockedStatuses: blocked, unknown, humanReviewOnUnknown: unknown === "HUMAN_REVIEW" };

  await saveOrderRule(user.storeId, rule);
  revalidatePath("/ayarlar");
  revalidatePath("/work-queue");
}
