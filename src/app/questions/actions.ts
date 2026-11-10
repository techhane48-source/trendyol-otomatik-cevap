"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";

/**
 * Tek kiracılı erişim kapısı: paylaşılan anahtar doğruysa httpOnly çerez yazılır.
 * Anahtar loglanmaz; hata durumunda yalnızca "hata=1" sorgusu ile geri dönülür.
 */
export async function signInAction(formData: FormData): Promise<void> {
  const raw = formData.get("token");
  const token = typeof raw === "string" ? raw.trim() : "";

  const access = checkAccess(token);
  if (!access.ok) {
    redirect("/questions?hata=1");
  }

  if (token.length > 0) {
    const store = await cookies();
    store.set(ACCESS_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 12,
    });
  }

  redirect("/questions");
}

/** Çerezi siler. */
export async function signOutAction(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_COOKIE_NAME);
  redirect("/questions");
}
