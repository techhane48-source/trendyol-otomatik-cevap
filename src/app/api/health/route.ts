import { NextResponse } from "next/server";

import { getPrisma } from "@/lib/prisma";
import { createLogger } from "@/lib/logger";

const log = createLogger("api.health");

export const dynamic = "force-dynamic";

/** Uygulama ve veritabanı ayakta mı? Gizli değer döndürmez. */
export async function GET() {
  const startedAt = Date.now();

  let dbOk = false;
  let dbError: string | null = null;

  try {
    await getPrisma().$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (error) {
    dbError = error instanceof Error ? error.name : "Bilinmeyen hata";
    log.error("Veritabanı sağlık kontrolü başarısız", { error });
  }

  const trendyolConfigured = ["TRENDYOL_SELLER_ID", "TRENDYOL_API_KEY", "TRENDYOL_API_SECRET"].every(
    (key) => Boolean(process.env[key]),
  );

  const body = {
    status: dbOk ? "ok" : "degraded",
    checks: {
      database: dbOk ? "up" : "down",
      trendyolCredentials: trendyolConfigured ? "configured" : "missing",
    },
    ...(dbError ? { databaseError: dbError } : {}),
    latencyMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
