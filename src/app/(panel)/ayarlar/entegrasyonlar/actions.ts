"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireApiUser } from "@/lib/auth/session";
import {
  IntegrationError,
  assertCanManageIntegration,
  disableIntegration,
  enableIntegration,
  saveIntegration,
  testIntegration,
} from "@/lib/integrations/service";

/**
 * Trendyol entegrasyon yönetimi (GÖREV 020).
 * Yalnızca OWNER/ADMIN; SUPPORT ne görür ne değiştirir (sayfa ve aksiyon düzeyinde).
 */

async function guard() {
  const user = await requireApiUser(["OWNER", "ADMIN"]);
  if (user) assertCanManageIntegration(user.role);
  return user;
}

function code(error: unknown): string {
  if (error instanceof IntegrationError) return error.code.toLowerCase();
  return "error";
}

export async function saveIntegrationAction(formData: FormData): Promise<void> {
  const user = await guard();
  if (!user) redirect("/yetkisiz");

  const sellerId = String(formData.get("sellerId") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const apiSecret = String(formData.get("apiSecret") ?? "").trim();

  try {
    await saveIntegration({
      storeId: user.storeId,
      sellerId,
      apiKey,
      apiSecret,
      actor: user.email,
    });
  } catch (error) {
    redirect(`/ayarlar/entegrasyonlar?hata=${code(error)}`);
  }

  revalidatePath("/ayarlar/entegrasyonlar");
  redirect("/ayarlar/entegrasyonlar?ok=kaydedildi");
}

export async function testIntegrationAction(): Promise<void> {
  const user = await guard();
  if (!user) redirect("/yetkisiz");

  const result = await testIntegration(user.storeId);
  revalidatePath("/ayarlar/entegrasyonlar");
  redirect(result.ok ? "/ayarlar/entegrasyonlar?ok=baglanti-dogrulandi" : "/ayarlar/entegrasyonlar?hata=baglanti-basarisiz");
}

export async function disableIntegrationAction(): Promise<void> {
  const user = await guard();
  if (!user) redirect("/yetkisiz");
  await disableIntegration(user.storeId, user.email);
  revalidatePath("/ayarlar/entegrasyonlar");
  redirect("/ayarlar/entegrasyonlar?ok=devre-disi");
}

export async function enableIntegrationAction(): Promise<void> {
  const user = await guard();
  if (!user) redirect("/yetkisiz");
  await enableIntegration(user.storeId, user.email);
  revalidatePath("/ayarlar/entegrasyonlar");
  redirect("/ayarlar/entegrasyonlar?ok=etkin");
}
