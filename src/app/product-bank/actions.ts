"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { BankError, bulkSetField, importCsv, setField, unverifyField, verifyField } from "@/lib/products/bank";
import { acceptSuggestion, generateSuggestions, rejectSuggestion } from "@/lib/products/suggestions";

async function requireActor(): Promise<string> {
  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) redirect("/product-bank?hata=yetkisiz");
  return getEnv().ADMIN_ACTOR_NAME;
}

function code(error: unknown): string {
  if (error instanceof BankError) return error.code.toLowerCase().replace(/_/g, "-");
  return "beklenmeyen-hata";
}

function storeIdOf(formData: FormData): string {
  return String(formData.get("storeId") ?? "");
}

function backUrl(formData: FormData): string {
  const main = String(formData.get("productMainId") ?? "");
  return main ? `/product-bank?main=${encodeURIComponent(main)}` : "/product-bank";
}

export async function setFieldAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = storeIdOf(formData);
  const productMainId = String(formData.get("productMainId") ?? "");
  const fieldKey = String(formData.get("fieldKey") ?? "");
  const value = String(formData.get("value") ?? "");
  let failure: string | null = null;

  try {
    await setField({ storeId, productMainId, fieldKey, value, actor, source: "MANUAL" });
  } catch (error) {
    failure = code(error);
  }

  revalidatePath("/product-bank");
  redirect(failure ? `${backUrl(formData)}&hata=${failure}` : `${backUrl(formData)}&ok=alan-kaydedildi`);
}

export async function verifyFieldAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = storeIdOf(formData);
  const productMainId = String(formData.get("productMainId") ?? "");
  const fieldKey = String(formData.get("fieldKey") ?? "");
  const value = String(formData.get("value") ?? "");
  let failure: string | null = null;

  try {
    if (value.trim() !== "") {
      await setField({ storeId, productMainId, fieldKey, value, actor, source: "MANUAL" });
    }
    await verifyField({ storeId, productMainId, fieldKey, actor });
  } catch (error) {
    failure = code(error);
  }

  revalidatePath("/product-bank");
  redirect(failure ? `${backUrl(formData)}&hata=${failure}` : `${backUrl(formData)}&ok=alan-dogrulandi`);
}

export async function unverifyFieldAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let failure: string | null = null;

  try {
    await unverifyField({
      storeId: storeIdOf(formData),
      productMainId: String(formData.get("productMainId") ?? ""),
      fieldKey: String(formData.get("fieldKey") ?? ""),
      actor,
    });
  } catch (error) {
    failure = code(error);
  }

  revalidatePath("/product-bank");
  redirect(failure ? `${backUrl(formData)}&hata=${failure}` : `${backUrl(formData)}&ok=alan-dogrulama-kaldirildi`);
}

export async function bulkFieldAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = storeIdOf(formData);
  const fieldKey = String(formData.get("fieldKey") ?? "");
  const value = String(formData.get("value") ?? "");
  const productMainIds = formData.getAll("productMainIds").map(String).filter(Boolean);
  let failure: string | null = null;

  try {
    if (productMainIds.length === 0) throw new BankError("NO_PRODUCT", "Ürün seçilmedi.");
    await bulkSetField({ storeId, productMainIds, fieldKey, value, actor });
  } catch (error) {
    failure = code(error);
  }

  revalidatePath("/product-bank");
  redirect(failure ? `/product-bank?hata=${failure}` : `/product-bank?ok=toplu-guncellendi`);
}

export async function importCsvAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = storeIdOf(formData);
  const csv = String(formData.get("csv") ?? "");
  let failure: string | null = null;
  let summary = "";

  try {
    const result = await importCsv({ storeId, csv, actor });
    summary = encodeURIComponent(`${result.rows} satır · ${result.updated} alan yazıldı · ${result.skipped} atlandı (doğrulanmamış)`);
  } catch (error) {
    failure = code(error);
  }

  revalidatePath("/product-bank");
  redirect(failure ? `/product-bank?hata=${failure}` : `/product-bank?ok=csv-iceri&ozet=${summary}`);
}

export async function generateSuggestionsAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let failure: string | null = null;
  let summary = "";

  try {
    const result = await generateSuggestions({ storeId: storeIdOf(formData), actor });
    summary = encodeURIComponent(`${result.products} ürün · ${result.created} yeni öneri · ${result.conflicts} çelişki`);
  } catch (error) {
    failure = code(error);
  }

  revalidatePath("/product-bank");
  redirect(failure ? `/product-bank?hata=${failure}` : `/product-bank?ok=oneri-uretildi&ozet=${summary}`);
}

export async function acceptSuggestionAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let failure: string | null = null;

  try {
    await acceptSuggestion({ suggestionId: String(formData.get("suggestionId") ?? ""), actor });
  } catch (error) {
    failure = code(error);
  }

  revalidatePath("/product-bank");
  redirect(failure ? `/product-bank?hata=${failure}` : "/product-bank?ok=oneri-kabul");
}

export async function rejectSuggestionAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let failure: string | null = null;

  try {
    await rejectSuggestion({
      suggestionId: String(formData.get("suggestionId") ?? ""),
      actor,
      note: String(formData.get("note") ?? ""),
    });
  } catch (error) {
    failure = code(error);
  }

  revalidatePath("/product-bank");
  redirect(failure ? `/product-bank?hata=${failure}` : "/product-bank?ok=oneri-reddedildi");
}
