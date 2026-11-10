"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { savePolicy, unverifyPolicy, verifyPolicy } from "@/lib/policies/service";

async function requireActor(): Promise<string> {
  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) redirect("/policies?hata=yetkisiz");
  return getEnv().ADMIN_ACTOR_NAME;
}

export async function savePolicyAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = String(formData.get("storeId") ?? "");
  const key = String(formData.get("key") ?? "");
  const value = String(formData.get("value") ?? "");

  try {
    const result = await savePolicy({ storeId, key, value, actor });
    redirect(result.changed ? `/policies?ok=kaydedildi&key=${encodeURIComponent(key)}` : "/policies?ok=degisiklik-yok");
  } catch {
    redirect("/policies?hata=kaydedilemedi");
  }
}

export async function verifyPolicyAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await verifyPolicy({
      storeId: String(formData.get("storeId") ?? ""),
      key: String(formData.get("key") ?? ""),
      value: "",
      actor,
    });
    redirect("/policies?ok=dogrulandi");
  } catch {
    redirect("/policies?hata=dogrulanamadi");
  }
}

export async function unverifyPolicyAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await unverifyPolicy({
      storeId: String(formData.get("storeId") ?? ""),
      key: String(formData.get("key") ?? ""),
      actor,
    });
    redirect("/policies?ok=dogrulama-kaldirildi");
  } catch {
    redirect("/policies?hata=dogrulanamadi");
  }
}
