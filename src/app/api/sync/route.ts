import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ACCESS_COOKIE_NAME, checkRequestAccess } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import {
  InvalidDateRangeError,
  SUPPORTED_QUESTION_STATUSES,
  UnsupportedQuestionStatusError,
  syncQuestions,
  validateDateRange,
} from "@/lib/trendyol/sync";

const log = createLogger("api.sync");

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Gövde şeması.
 * `status` yalnızca Trendyol'un desteklenen soru durumlarıyla sınırlıdır;
 * `pageSize` / `maxPages` üst sınırları (200 / 500) korunur.
 */
const bodySchema = z.object({
  status: z.enum(SUPPORTED_QUESTION_STATUSES).optional(),
  /** Birden fazla durum: sonradan cevaplanan soruların yerel durumu da güncellenir. */
  statuses: z.array(z.enum(SUPPORTED_QUESTION_STATUSES)).min(1).max(3).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  maxPages: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * Varsayılan tarama: bekleyen sorular + cevaplananlar.
 * İkinci durum, daha önce yerelde "WAITING_FOR_ANSWER" kalmış bir sorunun
 * Trendyol'da cevaplanması durumunda yerel kaydın güncellenmesini sağlar (mutabakat).
 */
const DEFAULT_STATUSES = ["WAITING_FOR_ANSWER", "ANSWERED"] as const;

function issueMessages(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(kök)"}: ${issue.message}`);
}

function errorResponse(status: number, error: string, issues?: string[]) {
  return NextResponse.json(
    { error, ...(issues && issues.length > 0 ? { issues } : {}) },
    { status },
  );
}

/**
 * Soruları Trendyol'dan çeker ve veritabanına kaydeder.
 * Trendyol'a YAZMA isteği göndermez; yalnızca GET /questions/filter çağırır.
 */
export async function POST(request: NextRequest) {
  const access = checkRequestAccess({
    authorization: request.headers.get("authorization"),
    cookieToken: request.cookies?.get(ACCESS_COOKIE_NAME)?.value ?? null,
  });

  if (!access.ok) {
    return errorResponse(access.status, access.error);
  }

  // Gövde tek seferde okunur: geçersiz JSON sessizce boş nesneye dönüşmez.
  const rawBody = await request.text();
  let payload: unknown = {};

  if (rawBody.trim().length > 0) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return errorResponse(400, "Geçersiz JSON gövdesi");
    }
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse(400, "İstek gövdesi bir JSON nesnesi olmalı");
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(400, "Geçersiz istek gövdesi", issueMessages(parsed.error));
  }

  // Tarih aralığı senkronizasyon başlamadan doğrulanır (bu durumda SyncRun kaydı oluşmaz).
  try {
    validateDateRange(parsed.data.startDate, parsed.data.endDate);
  } catch (error) {
    if (error instanceof InvalidDateRangeError) {
      return errorResponse(400, error.message);
    }
    throw error;
  }

  try {
    const { status, statuses, ...rest } = parsed.data;
    const effectiveStatuses = statuses ?? (status ? [status] : [...DEFAULT_STATUSES]);

    const result = await syncQuestions({
      ...rest,
      statuses: effectiveStatuses,
      trigger: "api",
    });

    // Eksik senkronizasyon yanıt gövdesinde `complete: false`, `status: "PARTIAL"` ve
    // `incompleteReason` alanlarıyla açıkça bildirilir.
    return NextResponse.json(result, { status: result.status === "FAILED" ? 502 : 200 });
  } catch (error) {
    if (error instanceof InvalidDateRangeError || error instanceof UnsupportedQuestionStatusError) {
      return errorResponse(400, error.message);
    }

    log.error("Senkronizasyon başlatılamadı", { error });
    return errorResponse(500, "Senkronizasyon başlatılamadı");
  }
}
