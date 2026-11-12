import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ACCESS_COOKIE_NAME, checkRequestAccess } from "@/lib/auth";
import { apiScopeFromRequest } from "@/lib/auth/session";
import { getPrisma } from "@/lib/prisma";
import { createLogger } from "@/lib/logger";

const log = createLogger("api.questions");

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["WAITING_FOR_ANSWER", "ANSWERED", "REJECTED", "UNKNOWN"]).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  storeId: z.string().min(1).optional(),
});

/** Veritabanındaki soruları sayfalı olarak listeler (salt okunur). */
export async function GET(request: NextRequest) {
  const access = checkRequestAccess({
    authorization: request.headers.get("authorization"),
    cookieToken: request.cookies?.get(ACCESS_COOKIE_NAME)?.value ?? null,
  });

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Geçersiz sorgu parametreleri",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(kök)"}: ${issue.message}`),
      },
      { status: 400 },
    );
  }

  // GÖREV 019: mağaza kapsamı oturumdan gelir; istemcinin storeId parametresi yok sayılır.
  const scope = await apiScopeFromRequest(request);
  if (!scope) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  if (parsed.data.storeId && parsed.data.storeId !== scope.storeId) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 403 });
  }

  const { status, page, limit } = parsed.data;
  const where = {
    storeId: scope.storeId,
    ...(status ? { status } : {}),
  };

  try {
    const prisma = getPrisma();
    const [items, total] = await Promise.all([
      prisma.question.findMany({
        where,
        orderBy: [{ askedAt: "desc" }, { firstSeenAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          trendyolQuestionId: true,
          text: true,
          status: true,
          rawStatus: true,
          productName: true,
          productMainId: true,
          askedAt: true,
          answeredAt: true,
          lastSyncedAt: true,
          storeId: true,
        },
      }),
      prisma.question.count({ where }),
    ]);

    return NextResponse.json({
      items: items.map((item) => ({
        ...item,
        // BigInt JSON'a doğrudan yazılamaz
        trendyolQuestionId: item.trendyolQuestionId.toString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasMore: page * limit < total,
      },
    });
  } catch (error) {
    log.error("Soru listesi alınamadı", { error });
    return NextResponse.json({ error: "Sorular getirilemedi" }, { status: 500 });
  }
}
