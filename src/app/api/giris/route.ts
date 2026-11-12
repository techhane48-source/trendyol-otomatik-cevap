import { NextResponse } from "next/server";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { login } from "@/lib/auth/users";

/**
 * Panel girişi (GÖREV 018).
 *
 * POST /api/giris
 *   - email + şifre  → kullanıcı oturumu (HttpOnly `ty_session`, DB'de hash)
 *   - token          → geçiş dönemi paylaşımlı anahtar (HttpOnly `ty_access`)
 * GET /api/giris?cikis=1 → çerezleri siler.
 *
 * Şifre ve anahtar değerleri hiçbir yanıt gövdesine, log'a veya URL'ye yazılmaz.
 * Hatalı girişte tek bir genel mesaj döner (anahtarın varlığı/yokluğu sızdırılmaz).
 */
const LEGACY_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;

function redirectTo(path: string, base: string): NextResponse {
  // Yönlendirme isteğin kendi origin'ine yapılır; sabit host kullanılmaz (port kaybolmasın).
  return NextResponse.redirect(new URL(path, base), { status: 303 });
}

export async function POST(request: Request): Promise<NextResponse> {
  let email = "";
  let password = "";
  let token = "";

  try {
    const form = await request.formData();
    email = String(form.get("email") ?? "").trim();
    password = String(form.get("password") ?? "");
    token = String(form.get("token") ?? "").trim();
  } catch {
    return redirectTo("/giris?hata=1", request.url);
  }

  // Kullanıcı girişi (asıl yol): e-posta + şifre
  if (email && password) {
    const result = await login(email, password);
    if (!result.ok) {
      const code = result.error === "RATE_LIMITED" ? "3" : result.error === "DISABLED" ? "4" : "1";
      return redirectTo(`/giris?hata=${code}`, request.url);
    }
    const sessionToken = await createSession(result.user.id, { userAgent: request.headers.get("user-agent") });
    await setSessionCookie(sessionToken);
    return redirectTo("/", request.url);
  }

  // Geçiş dönemi: paylaşımlı anahtar (kullanımdan kaldırılacak)
  if (token) {
    const access = checkAccess(token);
    if (!access.ok) {
      return redirectTo(access.status === 503 ? "/giris?hata=2" : "/giris?hata=1", request.url);
    }
    const response = redirectTo("/", request.url);
    response.cookies.set(ACCESS_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: LEGACY_COOKIE_MAX_AGE_SECONDS,
    });
    return response;
  }

  return redirectTo("/giris?hata=1", request.url);
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  if (url.searchParams.get("cikis") === "1") {
    const response = redirectTo("/giris", request.url);
    response.cookies.set(ACCESS_COOKIE_NAME, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax" });
    response.cookies.set("ty_session", "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax" });
    return response;
  }
  return redirectTo("/giris", request.url);
}
