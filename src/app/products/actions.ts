"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import {
  ProductInfoError,
  createProductInfo,
  parseAttributesText,
  unverifyProductInfo,
  updateProductInfo,
  verifyProductInfo,
} from "@/lib/products/service";

/**
 * /products paneli sunucu eylemleri.
 * Tümü oturum (`ty_access`) gerektirir; Trendyol'a hiçbir istek atılmaz.
 */

async function requireActorName(): Promise<string> {
  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) throw new Error("UNAUTHORIZED");
  return getEnv().ADMIN_ACTOR_NAME;
}

function errorCodeFor(error: unknown): string {
  if (error instanceof ProductInfoError) return error.code.toLowerCase().replace(/_/g, "-");
  return "beklenmeyen-hata";
}

function str(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createProductAction(formData: FormData): Promise<void> {
  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await createProductInfo({
      sellerId: str(formData, "sellerId") || null,
      productMainId: str(formData, "productMainId"),
      productId: str(formData, "productId") || null,
      title: str(formData, "title") || null,
      attributes: parseAttributesText(str(formData, "attributes")),
      notes: str(formData, "notes") || null,
      actor,
    });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/products");
  redirect(failure ? `/products?hata=${failure}` : "/products?ok=olusturuldu");
}

export async function updateProductAction(formData: FormData): Promise<void> {
  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await updateProductInfo({
      id: str(formData, "id"),
      title: str(formData, "title") || null,
      productId: str(formData, "productId") || null,
      attributes: parseAttributesText(str(formData, "attributes")),
      notes: str(formData, "notes") || null,
      actor,
    });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/products");
  redirect(failure ? `/products?hata=${failure}` : "/products?ok=guncellendi");
}

export async function verifyProductAction(formData: FormData): Promise<void> {
  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await verifyProductInfo({ id: str(formData, "id"), actor, note: str(formData, "note") || null });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/products");
  redirect(failure ? `/products?hata=${failure}` : "/products?ok=dogrulandi");
}

export async function unverifyProductAction(formData: FormData): Promise<void> {
  let failure: string | null = null;

  try {
    const actor = { name: await requireActorName() };
    await unverifyProductInfo({ id: str(formData, "id"), actor, note: str(formData, "note") || null });
  } catch (error) {
    failure = errorCodeFor(error);
  }

  revalidatePath("/products");
  redirect(failure ? `/products?hata=${failure}` : "/products?ok=dogrulama-kaldirildi");
}
