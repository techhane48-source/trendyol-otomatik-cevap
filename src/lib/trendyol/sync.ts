import type { PrismaClient } from "@/generated/prisma/client";
import { createLogger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { TrendyolApiError, createTrendyolClient, type QuestionsQuery, type TrendyolQnaClient } from "./client";
import { mapQuestionStatus, type NormalizedQuestion } from "./schemas";

const log = createLogger("trendyol.sync");

/** Trendyol tarih filtrelerinde izin verilen en geniş aralık: 14 gün. */
export const MAX_DATE_RANGE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SyncStatus = "RUNNING" | "SUCCESS" | "PARTIAL" | "FAILED";

/** Senkronizasyonun nasıl sonlandığı. */
export type SyncStopReason = "COMPLETED" | "PAGE_LIMIT" | "ERROR";

/** `status` alanı için desteklenen Trendyol soru durumları. */
export const SUPPORTED_QUESTION_STATUSES = ["WAITING_FOR_ANSWER", "ANSWERED", "REJECTED"] as const;
export type SupportedQuestionStatus = (typeof SUPPORTED_QUESTION_STATUSES)[number];

export interface SyncOptions {
  /** Varsayılan: TRENDYOL_SELLER_ID */
  sellerId?: string | bigint;
  /** Tek durum filtresi (eski API uyumluluğu). */
  status?: string;
  /**
   * Birden fazla durum için sırayla senkronizasyon.
   * Örn. `["WAITING_FOR_ANSWER", "ANSWERED"]` → sonradan cevaplanan soruların
   * yerel durumu da güncellenir (mutabakat).
   */
  statuses?: string[];
  startDate?: Date;
  endDate?: Date;
  pageSize?: number;
  maxPages?: number;
  statusAllPages?: boolean;
  trigger?: string;
}

/** Tek bir durum geçişinin sayfa istatistikleri. */
export interface SyncStatusBreakdown {
  status: string;
  fetchedCount: number;
  savedCount: number;
  pagesFetched: number;
  complete: boolean;
}

export interface SyncResult {
  syncRunId: string;
  storeId: string;
  status: SyncStatus;
  fetchedCount: number;
  savedCount: number;
  pagesFetched: number;
  /** Bu çalıştırmada taranan durumlar. */
  statuses: string[];
  /** Durum bazlı döküm. */
  breakdown: SyncStatusBreakdown[];
  /** Tüm sayfalar gerçekten tamamlandı mı? */
  complete: boolean;
  stopReason: SyncStopReason;
  /** `complete === false` ise neden tamamlanmadığı (gizli bilgi içermez). */
  incompleteReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
}

export interface SyncDeps {
  prisma?: PrismaClient;
  client?: TrendyolQnaClient;
}

export class InvalidDateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDateRangeError";
  }
}

export class UnsupportedQuestionStatusError extends Error {
  constructor(status: string) {
    super(
      `Desteklenmeyen soru durumu: "${status}". Desteklenenler: ${SUPPORTED_QUESTION_STATUSES.join(", ")}`,
    );
    this.name = "UnsupportedQuestionStatusError";
  }
}

/**
 * Verilen tarih aralığını doğrular: başlangıç bitişten önce olmalı ve aralık
 * en fazla 14 gün olmalıdır (Trendyol kuralı).
 */
export function validateDateRange(startDate?: Date, endDate?: Date): void {
  if (!startDate && !endDate) return;

  if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
    throw new InvalidDateRangeError("startDate, endDate'ten sonra olamaz");
  }

  if (startDate && endDate) {
    const diff = endDate.getTime() - startDate.getTime();
    if (diff > MAX_DATE_RANGE_DAYS * DAY_MS) {
      throw new InvalidDateRangeError(
        `Tarih aralığı en fazla ${MAX_DATE_RANGE_DAYS} gün olabilir (Trendyol sınırı)`,
      );
    }
  }
}

function toSellerId(value: string | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!/^\d+$/.test(value)) {
    throw new Error("sellerId sayısal olmalı");
  }
  return BigInt(value);
}

/** Sayfalama bitti mi? `last`, boş sayfa, kısa sayfa ve totalPages kontrolleri. */
export function isLastPage(
  page: { last?: boolean | null; empty?: boolean | null; totalPages?: number | null },
  pageIndex: number,
  received: number,
  requestedSize: number,
): boolean {
  if (page.last === true) return true;
  if (page.empty === true) return true;
  if (received === 0) return true;
  if (received < requestedSize) return true;
  if (typeof page.totalPages === "number" && pageIndex + 1 >= page.totalPages) return true;
  return false;
}

async function persistQuestion(
  prisma: PrismaClient,
  storeId: string,
  question: NormalizedQuestion,
): Promise<void> {
  const { status, rawStatus } = mapQuestionStatus(question.rawStatus);
  const now = new Date();

  await prisma.question.upsert({
    where: {
      storeId_trendyolQuestionId: {
        storeId,
        trendyolQuestionId: question.trendyolQuestionId,
      },
    },
    create: {
      storeId,
      trendyolQuestionId: question.trendyolQuestionId,
      text: question.text,
      status,
      rawStatus,
      productName: question.productName,
      productMainId: question.productMainId,
      productId: question.productId,
      customerId: question.customerId,
      answerText: question.answerText,
      askedAt: question.askedAt,
      answeredAt: question.answeredAt,
      raw: question.raw as never,
      lastSyncedAt: now,
    },
    update: {
      text: question.text,
      status,
      rawStatus,
      productName: question.productName,
      productMainId: question.productMainId,
      productId: question.productId,
      customerId: question.customerId,
      answerText: question.answerText,
      askedAt: question.askedAt,
      answeredAt: question.answeredAt,
      raw: question.raw as never,
      lastSyncedAt: now,
    },
  });
}

/**
 * Trendyol'dan soruları çeker ve veritabanına upsert eder.
 * Salt okunur: Trendyol'a hiçbir yazma isteği gönderilmez.
 */
export async function syncQuestions(
  options: SyncOptions = {},
  deps: SyncDeps = {},
): Promise<SyncResult> {
  const env = getEnv();
  const prisma = deps.prisma ?? getPrisma();
  const client = deps.client ?? createTrendyolClient();

  const sellerId = toSellerId(options.sellerId ?? env.TRENDYOL_SELLER_ID);
  const pageSize = options.pageSize ?? env.SYNC_PAGE_SIZE;
  const maxPages = options.maxPages ?? env.SYNC_MAX_PAGES;
  const trigger = options.trigger ?? "manual";

  // Taranacak durumlar: `statuses` > `status` > varsayılan tek durum.
  const requestedStatuses =
    options.statuses && options.statuses.length > 0
      ? [...new Set(options.statuses)]
      : options.status !== undefined
        ? [options.status]
        : ["WAITING_FOR_ANSWER"];

  validateDateRange(options.startDate, options.endDate);

  for (const requestedStatus of requestedStatuses) {
    if (!SUPPORTED_QUESTION_STATUSES.includes(requestedStatus as SupportedQuestionStatus)) {
      throw new UnsupportedQuestionStatusError(requestedStatus);
    }
  }

  const store = await prisma.store.upsert({
    where: { sellerId },
    create: { sellerId },
    update: {},
  });

  const startedAt = new Date();
  const syncRun = await prisma.syncRun.create({
    data: {
      storeId: store.id,
      status: "RUNNING",
      trigger,
      startedAt,
      params: {
        statuses: requestedStatuses,
        pageSize,
        maxPages,
        startDate: options.startDate?.toISOString() ?? null,
        endDate: options.endDate?.toISOString() ?? null,
      },
    },
  });

  let fetchedCount = 0;
  let savedCount = 0;
  let pagesFetched = 0;
  let lastPageIndex = -1;
  const breakdown: SyncStatusBreakdown[] = [];
  /** Tüm durumların sayfaları doğal olarak tamamlandı mı? */
  let reachedEndForAll = true;
  let pageLimitStatus: string | null = null;

  try {
    for (const queryStatus of requestedStatuses) {
      let statusFetched = 0;
      let statusSaved = 0;
      let statusPages = 0;
      let statusComplete = false;

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const query: QuestionsQuery = {
          page: pageIndex,
          size: pageSize,
          status: queryStatus,
          orderByField: "CreatedDate",
          orderByDirection: "ASC",
        };

        if (options.startDate) query.startDate = options.startDate.getTime();
        if (options.endDate) query.endDate = options.endDate.getTime();

        const { page, questions } = await client.fetchQuestionsPage(query);

        pagesFetched += 1;
        statusPages += 1;
        lastPageIndex = pageIndex;
        fetchedCount += questions.length;
        statusFetched += questions.length;

        for (const question of questions) {
          await persistQuestion(prisma, store.id, question);
          savedCount += 1;
          statusSaved += 1;
        }

        log.info("Sayfa işlendi", {
          status: queryStatus,
          page: pageIndex,
          received: questions.length,
          totalPages: page.totalPages ?? null,
          savedSoFar: savedCount,
        });

        if (isLastPage(page, pageIndex, questions.length, pageSize)) {
          statusComplete = true;
          break;
        }
      }

      breakdown.push({
        status: queryStatus,
        fetchedCount: statusFetched,
        savedCount: statusSaved,
        pagesFetched: statusPages,
        complete: statusComplete,
      });

      if (!statusComplete) {
        // Bu durum için sayfa sınırına takıldık: veri eksik, kalan durumlara geçilmez.
        reachedEndForAll = false;
        pageLimitStatus = queryStatus;
        break;
      }
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    // maxPages sınırına takıldıysak sayfaların tamamı çekilmemiştir:
    // eksik veri SUCCESS olarak raporlanmaz.
    const status: SyncStatus = reachedEndForAll ? "SUCCESS" : "PARTIAL";
    const errorCode = reachedEndForAll ? null : "PAGE_LIMIT";
    const incompleteReason = reachedEndForAll
      ? null
      : `Sayfa sınırına ulaşıldı (maxPages=${maxPages}, status=${pageLimitStatus}); tüm sorular çekilmedi.`;

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status,
        finishedAt,
        durationMs,
        fetchedCount,
        savedCount,
        pagesFetched,
        errorCode,
        errorMessage: incompleteReason,
      },
    });

    if (reachedEndForAll) {
      log.info("Senkronizasyon tamamlandı", {
        syncRunId: syncRun.id,
        statuses: requestedStatuses,
        fetchedCount,
        savedCount,
      });
    } else {
      log.warn("Senkronizasyon sayfa sınırında durdu", {
        syncRunId: syncRun.id,
        pagesFetched,
        maxPages,
        pageLimitStatus,
      });
    }

    return {
      syncRunId: syncRun.id,
      storeId: store.id,
      status,
      fetchedCount,
      savedCount,
      pagesFetched,
      statuses: requestedStatuses,
      breakdown,
      complete: reachedEndForAll,
      stopReason: reachedEndForAll ? "COMPLETED" : "PAGE_LIMIT",
      incompleteReason,
      errorCode,
      errorMessage: incompleteReason,
      durationMs,
    };
  } catch (error) {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const { errorCode, errorMessage } = describeError(error);
    const status: SyncStatus = pagesFetched > 0 ? "PARTIAL" : "FAILED";

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status,
        finishedAt,
        durationMs,
        fetchedCount,
        savedCount,
        pagesFetched,
        errorCode,
        errorMessage,
      },
    });

    log.error("Senkronizasyon başarısız", {
      syncRunId: syncRun.id,
      pagesFetched,
      lastPageIndex,
      errorCode,
      errorMessage,
    });

    return {
      syncRunId: syncRun.id,
      storeId: store.id,
      status,
      fetchedCount,
      savedCount,
      pagesFetched,
      statuses: requestedStatuses,
      breakdown,
      complete: false,
      stopReason: "ERROR",
      incompleteReason: errorMessage,
      errorCode,
      errorMessage,
      durationMs,
    };
  }
}

/** Beklenmeyen iç hatalar için dışarıya verilen sabit metin. */
export const GENERIC_ERROR_MESSAGE = "Beklenmeyen bir dahili hata oluştu. Ayrıntı sunucu loglarındadır.";

/**
 * Metin içinde geçebilecek hassas bilgileri maskeler:
 * bağlantı adresleri (parola içerebilir), Basic/Bearer kimlik bilgileri,
 * `key=`, `secret=`, `password=`, `token=` biçimindeki değerler.
 */
export function sanitizeMessage(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://***")
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/gi, "$1 ***")
    .replace(/\b(api[-_]?key|api[-_]?secret|secret|password|passwd|token)\b\s*[=:]\s*[^\s,;&]+/gi, "$1=***")
    .slice(0, 300);
}

/** Hata nesnesini loglanabilir/güvenli koda çevirir (gizli bilgi içermez). */
export function describeError(error: unknown): { errorCode: string; errorMessage: string } {
  if (error instanceof TrendyolApiError) {
    return { errorCode: error.code, errorMessage: sanitizeMessage(error.message) };
  }
  if (error instanceof InvalidDateRangeError) {
    return { errorCode: "INVALID_DATE_RANGE", errorMessage: sanitizeMessage(error.message) };
  }
  if (error instanceof UnsupportedQuestionStatusError) {
    return { errorCode: "UNSUPPORTED_STATUS", errorMessage: sanitizeMessage(error.message) };
  }
  // Bilinmeyen iç hataların mesajı dışarı verilmez: Prisma/pg hataları bağlantı
  // adresi (dolayısıyla parola) veya müşteri verisi içerebilir. Ayrıntı yalnızca
  // sunucu loguna yazılır (bkz. syncQuestions catch bloğu).
  if (error instanceof Error) {
    return { errorCode: "INTERNAL_ERROR", errorMessage: GENERIC_ERROR_MESSAGE };
  }
  return { errorCode: "UNKNOWN_ERROR", errorMessage: GENERIC_ERROR_MESSAGE };
}
