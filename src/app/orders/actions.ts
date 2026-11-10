"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import {
  OrderAccessError,
  OrderError,
  approveChangeRequest,
  createChangeRequestFromQuestion,
  markOwnershipVerified,
  rejectChangeRequest,
  syncOrders,
} from "@/lib/orders/service";

/**
 * Sipariş / ölçü değişikliği panellerinin sunucu eylemleri.
 *
 * Tüm eylemler yönetici oturumundan geçer. Onay yalnızca yerel kayıt üretir ve
 * öncesinde siparişin CANLI durumunu yeniden doğrular; Trendyol'a yazma yapılmaz.
 */

async function requireActorName(): Promise<string> {
  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) throw new OrderAccessError();
  return getEnv().ADMIN_ACTOR_NAME;
}

function errorCodeFor(error: unknown): string {
  if (error instanceof OrderAccessError) return "yetkisiz";
  if (error instanceof OrderError) return error.code.toLowerCase().replace(/_/g, "-");
  return "beklenmeyen-hata";
}

export async function syncOrdersAction(): Promise<void> {
  let failure: string | null = null;
  let summary = "";

  try {
    await requireActorName();
    const result = await syncOrders({ query: { status: "Created", size: 50 } });
    summary = `${result.saved} paket / ${result.lines} kalem`;
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/orders");
  redirect(failure ? `/orders?hata=${failure}` : `/orders?ok=senkron&ozet=${encodeURIComponent(summary)}`);
}

export async function createChangeRequestAction(formData: FormData): Promise<void> {
  const questionId = String(formData.get("questionId") ?? "");
  const width = Number(formData.get("widthCm") ?? 0) || null;
  const height = Number(formData.get("heightCm") ?? 0) || null;

  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await createChangeRequestFromQuestion({
      questionId,
      actor,
      requestedWidthCm: width,
      requestedHeightCm: height,
    });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/change-requests");
  redirect(failure ? `/change-requests?hata=${failure}` : "/change-requests?ok=talep-olusturuldu");
}

export async function approveChangeRequestAction(formData: FormData): Promise<void> {
  const requestId = String(formData.get("requestId") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await approveChangeRequest({ requestId, actor, note: note || null });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/change-requests");
  redirect(failure ? `/change-requests?hata=${failure}` : "/change-requests?ok=onaylandi");
}

export async function markOwnershipAction(formData: FormData): Promise<void> {
  const requestId = String(formData.get("requestId") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await markOwnershipVerified({ requestId, actor, note: note || null });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/change-requests");
  redirect(failure ? `/change-requests?hata=${failure}` : "/change-requests?ok=sahiplik-dogrulandi");
}

export async function rejectChangeRequestAction(formData: FormData): Promise<void> {
  const requestId = String(formData.get("requestId") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await rejectChangeRequest({ requestId, actor, note: note || null });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/change-requests");
  redirect(failure ? `/change-requests?hata=${failure}` : "/change-requests?ok=reddedildi");
}
