"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentUser } from "@/lib/auth/session";
import type { WorkActor } from "@/lib/work-queue/service";
import {
  approveWorkItem,
  completeWorkItem,
  ensureWorkItems,
  rejectWorkItem,
  setProductionStage,
  startWorkReview,
} from "@/lib/work-queue/service";

/**
 * İş kuyruğu sunucu aksiyonları (GÖREV 018).
 *
 * Oturumdaki kullanıcının mağazası zorunludur; başka mağazanın iş kaydı
 * kimliği bilinse bile servis `storeId` filtresi nedeniyle erişim reddedilir.
 * Rol eşlemesi: OWNER/ADMIN → ADMIN, SUPPORT → SUPPORT.
 */

async function context(): Promise<{ storeId: string; actor: WorkActor } | null> {
  const user = await currentUser();
  if (!user) return null;
  return {
    storeId: user.storeId,
    actor: { name: user.email, role: user.role === "SUPPORT" ? "SUPPORT" : "ADMIN" },
  };
}

export async function ensureQueueAction(): Promise<void> {
  const ctx = await context();
  if (!ctx) redirect("/giris");
  try {
    await ensureWorkItems({ storeId: ctx.storeId });
  } catch {
    // sayfa mesaj gösterir
  }
  revalidatePath("/work-queue");
}

async function withContext(formData: FormData, run: (storeId: string, workItemId: string, actor: WorkActor) => Promise<unknown>) {
  const ctx = await context();
  if (!ctx) redirect("/giris");
  const workItemId = String(formData.get("id") ?? "");
  try {
    await run(ctx.storeId, workItemId, ctx.actor);
  } catch {
    // yetkisiz/geçişsiz durumda sessiz kal; sayfa yenilenir
  }
  revalidatePath("/work-queue");
}

export async function startReviewAction(formData: FormData): Promise<void> {
  await withContext(formData, (storeId, workItemId, actor) => startWorkReview({ storeId, workItemId, actor }));
}

export async function approveAction(formData: FormData): Promise<void> {
  const note = String(formData.get("note") ?? "") || undefined;
  await withContext(formData, (storeId, workItemId, actor) => approveWorkItem({ storeId, workItemId, actor, note }));
}

export async function rejectAction(formData: FormData): Promise<void> {
  const note = String(formData.get("note") ?? "") || undefined;
  await withContext(formData, (storeId, workItemId, actor) => rejectWorkItem({ storeId, workItemId, actor, note }));
}

export async function completeAction(formData: FormData): Promise<void> {
  const note = String(formData.get("note") ?? "") || undefined;
  await withContext(formData, (storeId, workItemId, actor) => completeWorkItem({ storeId, workItemId, actor, note }));
}

export async function stageAction(formData: FormData): Promise<void> {
  const stage = String(formData.get("stage") ?? "") as "NOT_STARTED" | "CUTTING" | "SEWING" | "PACKED" | "SHIPPED";
  await withContext(formData, (storeId, workItemId, actor) => setProductionStage({ storeId, workItemId, actor, stage }));
}
