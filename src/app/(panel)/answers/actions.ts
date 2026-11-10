"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { HistoryError, reviewAnswer } from "@/lib/history/service";
import type { AnswerReviewStatus } from "@/generated/prisma/enums";

/**
 * Geçmiş cevap doğrulama eylemleri.
 * Yalnızca insan çalıştırır; otomatik hiçbir süreç doğrulama durumunu değiştirmez.
 */

const ALLOWED: AnswerReviewStatus[] = ["UNREVIEWED", "VERIFIED", "WRONG", "OUTDATED"];

export async function reviewAnswerAction(formData: FormData): Promise<void> {
  const questionId = String(formData.get("questionId") ?? "");
  const status = String(formData.get("status") ?? "") as AnswerReviewStatus;
  const note = String(formData.get("note") ?? "").trim();

  let failure: string | null = null;

  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) {
    redirect("/answers?hata=yetkisiz");
  }

  if (!ALLOWED.includes(status)) {
    redirect("/answers?hata=gecersiz-durum");
  }

  try {
    await reviewAnswer({ questionId, status, actor: getEnv().ADMIN_ACTOR_NAME, note: note || null });
  } catch (error) {
    failure = error instanceof HistoryError ? error.code.toLowerCase().replace(/_/g, "-") : "beklenmeyen-hata";
  }

  revalidatePath("/answers");
  revalidatePath("/drafts");
  redirect(failure ? `/answers?hata=${failure}` : "/answers?ok=isaretlendi");
}
