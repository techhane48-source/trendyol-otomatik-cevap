"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireApiUser } from "@/lib/auth/session";
import { AuthError, createUser, resetPassword, updateUser, type UserRole } from "@/lib/auth/users";

async function guard() {
  return requireApiUser(["OWNER", "ADMIN"]);
}

function code(error: unknown): string {
  return error instanceof AuthError ? error.code.toLowerCase() : "error";
}

export async function createUserAction(formData: FormData): Promise<void> {
  const user = await guard();
  if (!user) redirect("/giris");

  try {
    await createUser({
      storeId: user.storeId,
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      name: String(formData.get("name") ?? ""),
      role: (String(formData.get("role") ?? "SUPPORT") as UserRole),
    });
  } catch (error) {
    redirect(`/kullanicilar?hata=${code(error)}`);
  }
  revalidatePath("/kullanicilar");
}

export async function updateUserAction(formData: FormData): Promise<void> {
  const user = await guard();
  if (!user) redirect("/giris");
  const userId = String(formData.get("userId") ?? "");
  const role = formData.get("role") ? (String(formData.get("role")) as UserRole) : undefined;
  const active = formData.get("active") === "on";

  try {
    await updateUser({ storeId: user.storeId, userId, role, active });
  } catch (error) {
    redirect(`/kullanicilar?hata=${code(error)}`);
  }
  revalidatePath("/kullanicilar");
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const user = await guard();
  if (!user) redirect("/giris");

  try {
    await resetPassword({
      storeId: user.storeId,
      userId: String(formData.get("userId") ?? ""),
      password: String(formData.get("password") ?? ""),
    });
  } catch (error) {
    redirect(`/kullanicilar?hata=${code(error)}`);
  }
  revalidatePath("/kullanicilar");
}
