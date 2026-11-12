"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { LlmNotConfiguredError, LlmRequestError } from "@/lib/llm/types";
import {
  QualityAccessError,
  QualityError,
  createQualitySet,
  scoreQualityItem,
  startQualityRun,
} from "@/lib/quality/service";

/**
 * Kalite paneli sunucu eylemleri.
 *
 * Her eylem `ty_access` kapısından geçer. Değerlendirme yalnızca yerel veritabanındaki
 * soruları okur; Trendyol'a hiçbir istek gönderilmez, hiçbir cevap yazılmaz.
 */

async function requireActorName(): Promise<string> {
  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) throw new QualityAccessError();
  return getEnv().ADMIN_ACTOR_NAME;
}

async function errorCodeFor(error: unknown): Promise<string> {
  if (error instanceof QualityAccessError) return "yetkisiz";
  if (error instanceof QualityError) return error.code.toLowerCase().replace(/_/g, "-");
  if (error instanceof LlmNotConfiguredError) return "llm-yapilandirilmadi";
  if (error instanceof LlmRequestError) return "llm-hatasi";
  return "beklenmeyen-hata";
}

export async function createSetAction(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const sampleCount = Number(formData.get("sampleCount") ?? 30);

  let failure: string | null = null;
  let okMessage = "set-olusturuldu";

  try {
    const actor = { name: await requireActorName() };
    await createQualitySet({ storeId: (await requireUser()).storeId, name, sampleCount, actor });
  } catch (error) {
    failure = await errorCodeFor(error);
  }

  revalidatePath("/quality");
  redirect(failure ? `/quality?hata=${failure}` : `/quality?ok=${okMessage}`);
}

export async function startRunAction(formData: FormData): Promise<void> {
  const setId = String(formData.get("setId") ?? "");

  let failure: string | null = null;
  let runId: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    const result = await startQualityRun({ setId, actor });
    runId = result.runId;
  } catch (error) {
    failure = await errorCodeFor(error);
  }

  revalidatePath("/quality");
  redirect(failure ? `/quality?hata=${failure}` : `/quality?ok=degerlendirme-bitti&run=${runId}`);
}

export async function scoreItemAction(formData: FormData): Promise<void> {
  const itemId = String(formData.get("itemId") ?? "");
  const runId = String(formData.get("runId") ?? "");
  const score = Number(formData.get("score") ?? 0);
  const note = String(formData.get("note") ?? "").trim();

  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await scoreQualityItem({ itemId, score, note: note || null, actor });
  } catch (error) {
    failure = await errorCodeFor(error);
  }

  revalidatePath("/quality");
  const target = `/quality?run=${runId}`;
  redirect(failure ? `${target}&hata=${failure}` : `${target}&ok=puan-kaydedildi`);
}
