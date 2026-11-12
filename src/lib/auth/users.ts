import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import bcrypt from "bcryptjs";

import { getPrisma } from "@/lib/prisma";

/**
 * Kullanıcı ve giriş yönetimi (GÖREV 018).
 *
 * - Şifreler bcrypt (12 tur) ile hash'lenir; düz metin hiçbir yerde saklanmaz.
 * - Giriş denemeleri sayılır: 15 dakikada 5 başarısız denemeden sonra kilit.
 * - E-posta deneme kaydında SHA-256 özetiyle tutulur (düz metin log yok).
 */

export type UserRole = "OWNER" | "ADMIN" | "SUPPORT";

export const ROLE_LABELS: Record<UserRole, string> = {
  OWNER: "Mağaza sahibi",
  ADMIN: "Mağaza yöneticisi",
  SUPPORT: "Müşteri temsilcisi",
};

const BCRYPT_ROUNDS = 12;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLocaleLowerCase("tr")).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

export function validatePassword(password: string): string | null {
  if (password.length < 10) return "Şifre en az 10 karakter olmalı.";
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return "Şifre harf ve rakam içermeli.";
  return null;
}

export interface SessionUser {
  id: string;
  storeId: string;
  storeName: string | null;
  email: string;
  name: string | null;
  role: UserRole;
}

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; error: "INVALID" | "LOCKED" | "DISABLED" | "RATE_LIMITED" };

export async function login(email: string, password: string): Promise<LoginResult> {
  const prisma = getPrisma();
  const normalized = email.trim().toLocaleLowerCase("tr");
  const emailHash = hashEmail(normalized);

  const recentFailures = await prisma.loginAttempt.count({
    where: { emailHash, success: false, createdAt: { gte: new Date(Date.now() - WINDOW_MS) } },
  });
  if (recentFailures >= MAX_ATTEMPTS) return { ok: false, error: "RATE_LIMITED" };

  const user = await prisma.user.findFirst({ where: { email: normalized }, include: { store: true } });
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;

  await prisma.loginAttempt.create({
    data: { emailHash, userId: user?.id ?? null, success: valid },
  });

  if (!user || !valid) return { ok: false, error: "INVALID" };
  if (!user.active) return { ok: false, error: "DISABLED" };

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return {
    ok: true,
    user: {
      id: user.id,
      storeId: user.storeId,
      storeName: user.store.name,
      email: user.email,
      name: user.name,
      role: user.role as UserRole,
    },
  };
}

export async function listUsers(storeId: string) {
  const prisma = getPrisma();
  return prisma.user.findMany({
    where: { storeId },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true },
  });
}

export async function createUser(input: {
  storeId: string;
  email: string;
  password: string;
  name?: string;
  role: UserRole;
}) {
  const prisma = getPrisma();
  const passwordError = validatePassword(input.password);
  if (passwordError) throw new AuthError("WEAK_PASSWORD", passwordError);

  const email = input.email.trim().toLocaleLowerCase("tr");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError("INVALID_EMAIL", "Geçerli bir e-posta girin.");

  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) throw new AuthError("EMAIL_TAKEN", "Bu e-posta zaten kayıtlı.");

  return prisma.user.create({
    data: {
      storeId: input.storeId,
      email,
      passwordHash: await hashPassword(input.password),
      name: input.name?.trim() || null,
      role: input.role,
    },
  });
}

export async function updateUser(input: {
  storeId: string;
  userId: string;
  role?: UserRole;
  active?: boolean;
}) {
  const prisma = getPrisma();
  const user = await prisma.user.findFirst({ where: { id: input.userId, storeId: input.storeId } });
  if (!user) throw new AuthError("NOT_FOUND", "Kullanıcı bulunamadı.");

  if (user.role === "OWNER" && (input.role && input.role !== "OWNER")) {
    const owners = await prisma.user.count({ where: { storeId: input.storeId, role: "OWNER", active: true } });
    if (owners <= 1) throw new AuthError("LAST_OWNER", "Mağazanın son sahibi rolü düşürülemez.");
  }
  if (user.role === "OWNER" && input.active === false) {
    const owners = await prisma.user.count({ where: { storeId: input.storeId, role: "OWNER", active: true } });
    if (owners <= 1) throw new AuthError("LAST_OWNER", "Mağazanın son sahibi devre dışı bırakılamaz.");
  }

  return prisma.user.update({
    where: { id: user.id },
    data: {
      ...(input.role ? { role: input.role } : {}),
      ...(typeof input.active === "boolean" ? { active: input.active } : {}),
    },
  });
}

export async function resetPassword(input: { storeId: string; userId: string; password: string }) {
  const prisma = getPrisma();
  const passwordError = validatePassword(input.password);
  if (passwordError) throw new AuthError("WEAK_PASSWORD", passwordError);

  const user = await prisma.user.findFirst({ where: { id: input.userId, storeId: input.storeId } });
  if (!user) throw new AuthError("NOT_FOUND", "Kullanıcı bulunamadı.");

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(input.password) },
  });
  // Şifre değişince mevcut oturumlar kapanır.
  await prisma.session.deleteMany({ where: { userId: user.id } });
}

export class AuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/** Sabit zamanlı token karşılaştırması (oturum çerezleri için). */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length || bufferA.length === 0) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
