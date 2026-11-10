import { timingSafeEqual } from "node:crypto";

/**
 * Tek kiracılı (single-tenant) erişim kapısı.
 *
 * Bu projede çok kullanıcılı kimlik doğrulama YOK ve bilinçli olarak eklenmedi.
 * Amaç, müşteri sorularını ve Trendyol kimlik bilgilerini kullanan uç noktaların
 * üretimde herkese açık olmasını engellemektir. Paylaşılan tek bir erişim
 * anahtarı (`APP_ACCESS_TOKEN`) yeterli ve denetlenebilir bir çözümdür.
 *
 * Davranış:
 * - `APP_ACCESS_TOKEN` tanımlıysa: Bearer başlığı veya `ty_access` çerezi eşleşmelidir.
 * - Tanımlı değilse: **her ortamda fail-closed** (503). Geliştirme ortamında da açık
 *   kapı YOKTUR; gerçek müşteri verilerine anahtarsız erişilemez.
 *
 * Anahtar değeri hiçbir log, hata mesajı veya yanıt gövdesinde yer almaz.
 */

export const ACCESS_COOKIE_NAME = "ty_access";
export const ACCESS_TOKEN_ENV = "APP_ACCESS_TOKEN";

export type AccessMode = "enforced" | "misconfigured";

export type AccessCheck =
  | { ok: true; mode: AccessMode }
  | { ok: false; mode: AccessMode; status: 401 | 503; error: string };

export function getAccessToken(): string | null {
  const value = process.env[ACCESS_TOKEN_ENV]?.trim();
  return value && value.length > 0 ? value : null;
}

export function getAccessMode(): AccessMode {
  if (getAccessToken()) return "enforced";
  return "misconfigured";
}

/** Sabit zamanlı karşılaştırma (zamanlama sızıntısını önler). */
export function tokensMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>` başlığından anahtarı çıkarır. */
export function extractBearerToken(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match ? match[1].trim() : null;
}

/** İstek sahibinin erişim hakkı var mı? */
export function checkAccess(candidate: string | null | undefined): AccessCheck {
  const mode = getAccessMode();

  if (mode === "misconfigured") {
    return {
      ok: false,
      mode,
      status: 503,
      error: `Erişim anahtarı yapılandırılmamış (${ACCESS_TOKEN_ENV}). Üretimde erişim kapalıdır.`,
    };
  }

  const expected = getAccessToken() as string;
  if (!candidate) {
    return { ok: false, mode, status: 401, error: "Yetkilendirme gerekli" };
  }

  return tokensMatch(candidate, expected)
    ? { ok: true, mode }
    : { ok: false, mode, status: 401, error: "Geçersiz erişim anahtarı" };
}

/**
 * API istekleri için erişim kontrolü: Bearer başlığı ya da (tarayıcı için) çerez.
 * Sorgu parametresiyle anahtar kabul EDİLMEZ — URL'ler loglara düşer.
 */
export function checkRequestAccess(input: {
  authorization?: string | null;
  cookieToken?: string | null;
}): AccessCheck {
  const bearer = extractBearerToken(input.authorization ?? null);
  return checkAccess(bearer ?? input.cookieToken ?? null);
}
