import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getPrisma } from "@/lib/prisma";
import { ACCESS_COOKIE_NAME, checkAccess, extractBearerToken } from "@/lib/auth";
import { hashToken, newSessionToken, type SessionUser } from "@/lib/auth/users";

/**
 * Oturum yönetimi (GÖREV 018).
 *
 * - Ham token yalnızca HttpOnly çerezde; veritabanında SHA-256 özeti.
 * - Ömür 7 gün, 12 saatten uzun hareketsizlikte oturum düşer.
 * - Eski paylaşımlı anahtar (`ty_access`) geçiş döneminde desteklenir; oturum
 *   yoksa ve anahtar geçerliyse ilk mağazanın ADMIN'i sayılır (geçiş planı README).
 */

export const SESSION_COOKIE = "ty_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDLE_MS = 12 * 60 * 60 * 1000;

export async function createSession(userId: string, meta: { userAgent?: string | null; ipHash?: string | null } = {}) {
  const prisma = getPrisma();
  const token = newSessionToken();
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ipHash: meta.ipHash ?? null,
    },
  });
  return token;
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function destroyCurrentSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const prisma = getPrisma();
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  await clearSessionCookie();
}

/**
 * Eski paylaşımlı anahtar yalnızca mağazada aktif OWNER hesabı YOKKEN çalışır.
 * Gerçek sahip hesabı açıldığı anda anahtar yolu kendiliğinden kapanır.
 */
export async function hasActiveOwner(): Promise<boolean> {
  const prisma = getPrisma();
  const owners = await prisma.user.count({ where: { role: "OWNER", active: true } });
  return owners > 0;
}

export async function legacyLoginAllowed(): Promise<boolean> {
  const mode = (process.env.LEGACY_LOGIN ?? "").toLowerCase();
  // Acil durum anahtarı: bilinçli olarak "on" yapılmadıkça kapalıdır.
  if (mode === "off") return false;
  if (mode === "on") return true;
  return !(await hasActiveOwner());
}

export async function sessionUserFromToken(token: string | null | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const prisma = getPrisma();
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { store: true } } },
  });
  if (!session) return null;

  const now = Date.now();
  if (session.expiresAt.getTime() < now) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => null);
    return null;
  }
  if (now - session.lastSeenAt.getTime() > IDLE_MS) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => null);
    return null;
  }
  if (!session.user.active) return null;

  // Hareketsizlik penceresi için son görülme güncellenir (her istekte yazmamak için 5 dk eşik).
  if (now - session.lastSeenAt.getTime() > 5 * 60 * 1000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => null);
  }

  return {
    id: session.user.id,
    storeId: session.user.storeId,
    storeName: session.user.store.name,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role as SessionUser["role"],
  };
}

/**
 * Geçiş dönemi köprüsü: oturum yoksa eski paylaşımlı anahtar kabul edilir ve
 * ilk mağazanın ADMIN kullanıcısı gibi davranılır. Anahtar kaldırıldığında bu
 * yol da kendiliğinden kapanır (fail-closed).
 */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const session = await sessionUserFromToken(store.get(SESSION_COOKIE)?.value);
  if (session) return session;

  if (!(await legacyLoginAllowed())) return null;

  const legacy = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value);
  if (!legacy.ok) return null;

  const prisma = getPrisma();
  const firstStore = await prisma.store.findFirst({ orderBy: { createdAt: "asc" } });
  if (!firstStore) return null;

  return {
    id: "legacy-token",
    storeId: firstStore.id,
    storeName: firstStore.name,
    email: "legacy@token",
    name: "Eski anahtar",
    role: "ADMIN",
  };
}

/**
 * API route'ları için mağaza kapsamı: oturum varsa onun mağazası, yoksa geçiş
 * döneminde eski anahtarın bağlı olduğu ilk mağaza (yalnızca tek mağazalı kurulum).
 */
export async function apiScope(): Promise<{ storeId: string; role: SessionUser["role"]; legacy: boolean } | null> {
  const store = await cookies();
  const session = await sessionUserFromToken(store.get(SESSION_COOKIE)?.value);
  if (session) return { storeId: session.storeId, role: session.role, legacy: false };

  if (!(await legacyLoginAllowed())) return null;
  const legacy = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value);
  if (!legacy.ok) return null;

  const prisma = getPrisma();
  const firstStore = await prisma.store.findFirst({ orderBy: { createdAt: "asc" } });
  if (!firstStore) return null;
  return { storeId: firstStore.id, role: "ADMIN", legacy: true };
}

/** Route handler'lar için çerezleri Request başlığından okuyan kapsam çözümü. */
export async function apiScopeFromRequest(request: Request): Promise<{ storeId: string; role: SessionUser["role"]; legacy: boolean } | null> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const readCookie = (name: string): string | null => {
    for (const part of cookieHeader.split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key === name) return decodeURIComponent(rest.join("="));
    }
    return null;
  };

  const session = await sessionUserFromToken(readCookie(SESSION_COOKIE));
  if (session) return { storeId: session.storeId, role: session.role, legacy: false };

  if (!(await legacyLoginAllowed())) return null;
  const cookieToken = readCookie(ACCESS_COOKIE_NAME);
  const bearer = extractBearerToken(request.headers.get("authorization"));
  let legacy = checkAccess(cookieToken && cookieToken.length > 0 ? cookieToken : null);
  if (!legacy.ok && bearer) legacy = checkAccess(bearer);
  if (!legacy.ok) return null;

  const prisma = getPrisma();
  const firstStore = await prisma.store.findFirst({ orderBy: { createdAt: "asc" } });
  if (!firstStore) return null;
  return { storeId: firstStore.id, role: "ADMIN", legacy: true };
}

export async function requireUser(roles?: SessionUser["role"][]): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/giris");
  if (roles && !roles.includes(user.role)) redirect("/yetkisiz");
  return user;
}

export async function requireApiUser(roles?: SessionUser["role"][]): Promise<SessionUser | null> {
  const user = await currentUser();
  if (!user) return null;
  if (roles && !roles.includes(user.role)) return null;
  return user;
}
