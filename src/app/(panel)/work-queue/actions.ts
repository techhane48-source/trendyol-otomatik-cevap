"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import {
  approveWorkItem,
  completeWorkItem,
  ensureWorkItems,
  rejectWorkItem,
  setProductionStage,
  startWorkReview,
  WorkAccessError,
  WorkError,
} from "@/lib/work-queue/service";

/**
 * İş kuyruğu sunucu aksiyonları (GÖREV 017).
 *
 * Panel erişimi tek paylaşımlı anahtarla korunur; oturum açmış panel kullanıcısı
 * ADMIN rolüyle işlem yapar. Gerçek kullanıcı/rol altyapısı yok — bu sınırlama
 * README'de ve iş kuyruğu sayfasında açıkça yazılıdır.
 */

async function guard(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE_NAME)?.value;
  if (!checkAccess(token)) return "yetkisiz";
  return null;
}

function actor() {
  return { name: process.env.ADMIN_ACTOR_NAME?.trim() || "panel", role: "ADMIN" as const };
}

function failure(error: unknown): string {
  if (error instanceof WorkAccessError) return "yetkisiz";
  if (error instanceof WorkError) return error.code.toLowerCase();
  return "hata";
}

export async function ensureQueueAction(): Promise<void> {
  if (await guard()) return;
  try {
    await ensureWorkItems({});
  } catch {
    // sessiz: sayfa mesaj gösterir
  }
  revalidatePath("/work-queue");
}

export async function startReviewAction(formData: FormData): Promise<void> {
  if (await guard()) return;
  const workItemId = String(formData.get("id") ?? "");
  try {
    await startWorkReview({ workItemId, actor: actor() });
  } catch {
    // durum değişmediyse sayfa yeniden yüklenir
  }
  revalidatePath("/work-queue");
}

export async function approveAction(formData: FormData): Promise<void> {
  if (await guard()) return;
  const workItemId = String(formData.get("id") ?? "");
  try {
    await approveWorkItem({ workItemId, actor: actor(), note: String(formData.get("note") ?? "") || undefined });
  } catch {
    // yetkisiz/geçişsiz durumda sessiz kal
  }
  revalidatePath("/work-queue");
}

export async function rejectAction(formData: FormData): Promise<void> {
  if (await guard()) return;
  const workItemId = String(formData.get("id") ?? "");
  try {
    await rejectWorkItem({ workItemId, actor: actor(), note: String(formData.get("note") ?? "") || undefined });
  } catch {
    // sessiz
  }
  revalidatePath("/work-queue");
}

export async function completeAction(formData: FormData): Promise<void> {
  if (await guard()) return;
  const workItemId = String(formData.get("id") ?? "");
  try {
    await completeWorkItem({ workItemId, actor: actor(), note: String(formData.get("note") ?? "") || undefined });
  } catch {
    // sessiz
  }
  revalidatePath("/work-queue");
}

export async function stageAction(formData: FormData): Promise<void> {
  if (await guard()) return;
  const workItemId = String(formData.get("id") ?? "");
  const stage = String(formData.get("stage") ?? "") as "NOT_STARTED" | "CUTTING" | "SEWING" | "PACKED" | "SHIPPED";
  try {
    await setProductionStage({ workItemId, actor: actor(), stage });
  } catch (error) {
    failure(error);
  }
  revalidatePath("/work-queue");
}
