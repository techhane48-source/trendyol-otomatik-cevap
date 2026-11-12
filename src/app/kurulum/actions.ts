"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { createUser, AuthError } from "@/lib/auth/users";
import { getPrisma } from "@/lib/prisma";

/**
 * İlk kurulum: mağaza sahibi (OWNER) hesabı.
 *
 * Kurallar:
 * - Yalnızca hiç kullanıcı yokken çalışır; sonrasında kendiliğinden kapanır.
 * - Yerel makineden veya geçerli eski erişim anahtarıyla yapılabilir.
 * - Şifre yalnızca hash olarak saklanır; ekrana/loga yazılmaz.
 */
export async function createOwnerAction(formData: FormData): Promise<void> {
  const prisma = getPrisma();
  const existing = await prisma.user.count();
  if (existing > 0) redirect("/giris");

  const headerStore = await headers();
  const host = (headerStore.get("host") ?? "").split(":")[0];
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";

  const cookieStore = await cookies();
  const legacyOk = checkAccess(cookieStore.get(ACCESS_COOKIE_NAME)?.value).ok;
  if (!isLocal && !legacyOk) redirect("/giris?hata=1");

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  const store = await prisma.store.findFirst({ orderBy: { createdAt: "asc" } });
  if (!store) redirect("/kurulum?hata=store");

  try {
    const user = await createUser({ storeId: store.id, email, password, name, role: "OWNER" });
    const token = await createSession(user.id, { userAgent: headerStore.get("user-agent") });
    await setSessionCookie(token);
  } catch (error) {
    const code = error instanceof AuthError ? error.code.toLowerCase() : "error";
    redirect(`/kurulum?hata=${code}`);
  }

  redirect("/");
}
