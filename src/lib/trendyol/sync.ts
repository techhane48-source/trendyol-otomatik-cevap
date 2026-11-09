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

export interface SyncOptions {
  /** Varsayılan: TRENDYOL_SELLER_ID */
  sellerId?: string | bigint;
  /** Varsayılan: WAITING_FOR_ANSWER */
  status?: string;
  startDate?: Date;
  endDate?: Date;
  pageSize?: number;
  maxPages?: number;
  statusAllPages?: boolean;
  trigger?: string;
}

export interface SyncResult {
  syncRunId: string;
  storeId: string;
  status: SyncStatus;
  fetchedCount: number;
  savedCount: number;
  pagesFetched: number;
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
  const queryStatus = options.status ?? "WAITING_FOR_ANSWER";
  const pageSize = options.pageSize ?? env.SYNC_PAGE_SIZE;
  const maxPages = options.maxPages ?? env.SYNC_MAX_PAGES;
  const trigger = options.trigger ?? "manual";

  validateDateRange(options.startDate, options.endDate);

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
        status: queryStatus,
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

  try {
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
      lastPageIndex = pageIndex;
      fetchedCount += questions.length;

      for (const question of questions) {
        await persistQuestion(prisma, store.id, question);
        savedCount += 1;
      }

      log.info("Sayfa işlendi", {
        page: pageIndex,
        received: questions.length,
        totalPages: page.totalPages ?? null,
        savedSoFar: savedCount,
      });

      if (isLastPage(page, pageIndex, questions.length, pageSize)) break;
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "SUCCESS",
        finishedAt,
        durationMs,
        fetchedCount,
        savedCount,
        pagesFetched,
      },
    });

    log.info("Senkronizasyon tamamlandı", { syncRunId: syncRun.id, fetchedCount, savedCount });

    return {
      syncRunId: syncRun.id,
      storeId: store.id,
      status: "SUCCESS",
      fetchedCount,
      savedCount,
      pagesFetched,
      errorCode: null,
      errorMessage: null,
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
      errorCode,
      errorMessage,
      durationMs,
    };
  }
}

/** Hata nesnesini loglanabilir/güvenli koda çevirir (gizli bilgi içermez). */
export function describeError(error: unknown): { errorCode: string; errorMessage: string } {
  if (error instanceof TrendyolApiError) {
    return { errorCode: error.code, errorMessage: error.message };
  }
  if (error instanceof InvalidDateRangeError) {
    return { errorCode: "INVALID_DATE_RANGE", errorMessage: error.message };
  }
  if (error instanceof Error) {
    return { errorCode: "INTERNAL_ERROR", errorMessage: error.message.slice(0, 300) };
  }
  return { errorCode: "UNKNOWN_ERROR", errorMessage: "Bilinmeyen hata" };
}
