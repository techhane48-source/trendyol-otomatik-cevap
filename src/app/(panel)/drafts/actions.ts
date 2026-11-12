"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import {
  DraftError,
  DraftWarningsUnacknowledgedError,
  approveDraft,
  createAiDraft,
  editDraft,
  rejectDraft,
} from "@/lib/drafts/service";
import { getEnv } from "@/lib/env";
import { LlmNotConfiguredError, LlmRequestError } from "@/lib/llm/types";

/**
 * Taslak paneli sunucu eylemleri.
 *
 * Her eylem erişim kapısından geçer (`ty_access` çerezi). Onaylama yalnızca
 * veritabanı durumunu değiştirir — Trendyol'a hiçbir istek gönderilmez.
 */

async function requireActorName(): Promise<string> {
  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) throw new Error("UNAUTHORIZED");
  return getEnv().ADMIN_ACTOR_NAME;
}

/** Hata kodunu panele taşır (anahtar/değer sızdırmaz). */
function errorCodeFor(error: unknown): string {
  if (error instanceof DraftWarningsUnacknowledgedError) return "uyari-kabul-edilmedi";
  if (error instanceof DraftError) return error.code.toLowerCase().replace(/_/g, "-");
  if (error instanceof LlmNotConfiguredError) return "llm-yapilandirilmadi";
  if (error instanceof LlmRequestError) return "llm-hatasi";
  return "beklenmeyen-hata";
}

export async function createDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const storeId = user.storeId;
  const questionId = String(formData.get("questionId") ?? "");
  const productInfoRaw = formData.get("productInfo");
  const productInfo = typeof productInfoRaw === "string" ? productInfoRaw.trim() : "";

  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await createAiDraft({ questionId, storeId, actor, productInfo: productInfo || null });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/drafts");
  redirect(failure ? `/drafts?hata=${failure}` : "/drafts?ok=taslak-olusturuldu");
}

export async function editDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const storeId = user.storeId;
  const draftId = String(formData.get("draftId") ?? "");
  const text = String(formData.get("text") ?? "");
  const noteRaw = formData.get("note");
  const note = typeof noteRaw === "string" ? noteRaw.trim() : "";

  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await editDraft({ draftId, storeId, text, actor, note: note || null });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/drafts");
  redirect(failure ? `/drafts?hata=${failure}` : "/drafts?ok=revizyon-kaydedildi");
}

export async function approveDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const storeId = user.storeId;
  const draftId = String(formData.get("draftId") ?? "");
  const noteRaw = formData.get("note");
  const note = typeof noteRaw === "string" ? noteRaw.trim() : "";
  const acknowledgeWarnings = formData.get("acknowledgeWarnings") === "on";

  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await approveDraft({ draftId, storeId, actor, note: note || null, acknowledgeWarnings });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/drafts");
  redirect(failure ? `/drafts?hata=${failure}` : "/drafts?ok=onaylandi");
}

export async function rejectDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const storeId = user.storeId;
  const draftId = String(formData.get("draftId") ?? "");
  const noteRaw = formData.get("note");
  const note = typeof noteRaw === "string" ? noteRaw.trim() : "";

  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await rejectDraft({ draftId, storeId, actor, note: note || null });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/drafts");
  redirect(failure ? `/drafts?hata=${failure}` : "/drafts?ok=reddedildi");
}
