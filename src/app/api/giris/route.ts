import { NextResponse } from "next/server";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";

/**
 * Panel girişi.
 *
 * POST /api/giris  (form: token) → doğruysa HttpOnly `ty_access` çerezi kurar ve `/` sayfasına gider.
 * GET  /api/giris?cikis=1        → çerezi siler.
 *
 * Anahtar değeri hiçbir yanıt gövdesine, log'a veya URL'ye yazılmaz.
 * Hatalı girişte tek bir genel mesaj döner (anahtarın varlığı/yokluğu sızdırılmaz).
 */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;

function redirectTo(path: string, base: string): NextResponse {
  // Yönlendirme isteğin kendi origin'ine yapılır; sabit host kullanılmaz (port kaybolmasın).
  return NextResponse.redirect(new URL(path, base), { status: 303 });
}

export async function POST(request: Request): Promise<NextResponse> {
  let token = "";
  try {
    const form = await request.formData();
    token = String(form.get("token") ?? "").trim();
  } catch {
    return redirectTo("/giris?hata=1", request.url);
  }

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
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });

  return response;
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  if (url.searchParams.get("cikis") === "1") {
    const response = redirectTo("/giris", request.url);
    response.cookies.set(ACCESS_COOKIE_NAME, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax" });
    return response;
  }
  return redirectTo("/giris", request.url);
}
