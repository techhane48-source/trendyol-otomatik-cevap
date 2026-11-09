import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { syncQuestions } from "@/lib/trendyol/sync";

const log = createLogger("api.sync");

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z
  .object({
    status: z.string().min(1).max(64).optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
    maxPages: z.coerce.number().int().min(1).max(500).optional(),
  })
  .default({});

/**
 * Soruları Trendyol'dan çeker ve veritabanına kaydeder.
 * Trendyol'a YAZMA isteği göndermez; yalnızca GET /questions/filter çağırır.
 */
export async function POST(request: NextRequest) {
  let payload: unknown = {};

  if (request.headers.get("content-length") !== "0") {
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }
  }

  const parsed = bodySchema.safeParse(payload ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Geçersiz istek gövdesi",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(kök)"}: ${issue.message}`),
      },
      { status: 400 },
    );
  }

  try {
    const result = await syncQuestions({ ...parsed.data, trigger: "api" });

    return NextResponse.json(result, { status: result.status === "FAILED" ? 502 : 200 });
  } catch (error) {
    log.error("Senkronizasyon başlatılamadı", { error });
    const message = error instanceof Error ? error.message : "Bilinmeyen hata";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
