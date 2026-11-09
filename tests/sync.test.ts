import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { disconnectPrisma, getPrisma } from "@/lib/prisma";
import { TrendyolApiError, TrendyolQnaClient, type TrendyolClientConfig } from "@/lib/trendyol/client";
import {
  InvalidDateRangeError,
  isLastPage,
  syncQuestions,
  validateDateRange,
} from "@/lib/trendyol/sync";
import { parseQuestionsPage } from "@/lib/trendyol/schemas";
import type { QuestionsPageResult, TrendyolQnaClient as ClientType } from "@/lib/trendyol/client";

const prisma = getPrisma();

function questionItem(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    text: `Soru ${id}`,
    creationDate: 1_700_000_000_000 + id * 1_000,
    status: "WAITING_FOR_ANSWER",
    productName: `Ürün ${id}`,
    productMainId: `MAIN-${id}`,
    productId: String(1000 + id),
    customerId: String(2000 + id),
    ...extra,
  };
}

function pageResult(
  questions: unknown[],
  extras: { last?: boolean; totalPages?: number; empty?: boolean } = {},
): QuestionsPageResult {
  // Sahte istemci de gerçek istemci gibi doğrulama/normalize adımından geçer.
  const { page, questions: normalized } = parseQuestionsPage({
    content: questions,
    last: extras.last ?? questions.length === 0,
    totalPages: extras.totalPages ?? 1,
    empty: extras.empty ?? questions.length === 0,
    number: 0,
    size: 2,
    totalElements: questions.length,
  });

  return { page, questions: normalized, attempts: 1 };
}

/** Gerçek istemci yerine sıralı sayfa döndüren sahte istemci. */
function stubClient(
  handler: (query: { page?: number }) => QuestionsPageResult | Promise<QuestionsPageResult>,
): ClientType {
  return { fetchQuestionsPage: handler } as unknown as ClientType;
}

async function resetDatabase() {
  await prisma.syncRun.deleteMany();
  await prisma.question.deleteMany();
  await prisma.store.deleteMany();
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await disconnectPrisma();
});

describe("sayfalama yardımcıları", () => {
  it("last=true son sayfayı bitirir", () => {
    expect(isLastPage({ last: true }, 0, 2, 2)).toBe(true);
  });

  it("boş sayfa sonlandırır", () => {
    expect(isLastPage({ empty: true }, 0, 0, 50)).toBe(true);
  });

  it("eksik dolu sayfa (kısa sayfa) sonlandırır", () => {
    expect(isLastPage({ last: false }, 3, 7, 50)).toBe(true);
  });

  it("tam sayfa ve devam eden totalPages ile devam eder", () => {
    expect(isLastPage({ last: false, totalPages: 5 }, 1, 50, 50)).toBe(false);
  });

  it("totalPages sınırında durur", () => {
    expect(isLastPage({ last: false, totalPages: 2 }, 1, 50, 50)).toBe(true);
  });
});

describe("tarih aralığı doğrulaması", () => {
  it("14 günden uzun aralığı reddeder", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-16T00:00:00Z");
    expect(() => validateDateRange(start, end)).toThrow(InvalidDateRangeError);
  });

  it("tam 14 günlük aralığı kabul eder", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-15T00:00:00Z");
    expect(() => validateDateRange(start, end)).not.toThrow();
  });

  it("başlangıç bitişten sonra olamaz", () => {
    expect(() =>
      validateDateRange(new Date("2026-01-10T00:00:00Z"), new Date("2026-01-01T00:00:00Z")),
    ).toThrow(InvalidDateRangeError);
  });

  it("uzun aralık sync başlamadan reddedilir ve SyncRun oluşmaz", async () => {
    await expect(
      syncQuestions(
        {
          startDate: new Date("2026-01-01T00:00:00Z"),
          endDate: new Date("2026-02-01T00:00:00Z"),
        },
        { prisma, client: stubClient(() => pageResult([])) },
      ),
    ).rejects.toThrow(InvalidDateRangeError);

    expect(await prisma.syncRun.count()).toBe(0);
  });
});

describe("senkronizasyon — sayfalama ve upsert", () => {
  it("birden fazla sayfayı gezer ve tüm soruları kaydeder", async () => {
    const requestedPages: number[] = [];

    const result = await syncQuestions(
      { pageSize: 2 },
      {
        prisma,
        client: stubClient((query) => {
          const page = query.page ?? 0;
          requestedPages.push(page);
          if (page === 0) {
            return pageResult([questionItem(1), questionItem(2)], { last: false, totalPages: 2 });
          }
          return pageResult([questionItem(3), questionItem(4)], { last: true, totalPages: 2 });
        }),
      },
    );

    expect(requestedPages).toEqual([0, 1]);
    expect(result.status).toBe("SUCCESS");
    expect(result.fetchedCount).toBe(4);
    expect(result.savedCount).toBe(4);
    expect(result.pagesFetched).toBe(2);
    expect(await prisma.question.count()).toBe(4);

    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } });
    expect(run.status).toBe("SUCCESS");
    expect(run.fetchedCount).toBe(4);
    expect(run.savedCount).toBe(4);
    expect(run.pagesFetched).toBe(2);
    expect(run.finishedAt).not.toBeNull();
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("aynı sorular tekrar çekildiğinde kopya oluşturmaz", async () => {
    const handler = () =>
      pageResult([questionItem(1), questionItem(2)], { last: true, totalPages: 1 });

    const first = await syncQuestions({ pageSize: 2 }, { prisma, client: stubClient(handler) });
    const second = await syncQuestions({ pageSize: 2 }, { prisma, client: stubClient(handler) });

    expect(first.savedCount).toBe(2);
    expect(second.savedCount).toBe(2);
    expect(await prisma.question.count()).toBe(2);

    // Aynı soru, mağaza bazında tek kayıt
    const questions = await prisma.question.findMany({ orderBy: { trendyolQuestionId: "asc" } });
    expect(questions.map((q) => q.trendyolQuestionId.toString())).toEqual(["1", "2"]);

    // İkinci çalıştırma ayrı bir SyncRun kaydı üretir
    expect(await prisma.syncRun.count()).toBe(2);
  });

  it("güncellenen soru bilgilerini upsert ile tazeler", async () => {
    await syncQuestions(
      { pageSize: 1 },
      { prisma, client: stubClient(() => pageResult([questionItem(1)], { last: true })) },
    );

    await syncQuestions(
      { pageSize: 1 },
      {
        prisma,
        client: stubClient(() =>
          pageResult([questionItem(1, { status: "ANSWERED", text: "Güncel soru metni" })], {
            last: true,
          }),
        ),
      },
    );

    const question = await prisma.question.findFirstOrThrow();
    expect(question.status).toBe("ANSWERED");
    expect(question.text).toBe("Güncel soru metni");
    expect(await prisma.question.count()).toBe(1);
  });

  it("durum eşlemesini ve ham durumu saklar", async () => {
    await syncQuestions(
      { pageSize: 2 },
      {
        prisma,
        client: stubClient(() =>
          pageResult(
            [
              questionItem(1, { status: "WAITING_FOR_ANSWER" }),
              questionItem(2, { status: "YENI_BIR_DURUM" }),
            ],
            { last: true },
          ),
        ),
      },
    );

    const rows = await prisma.question.findMany({ orderBy: { trendyolQuestionId: "asc" } });
    expect(rows[0].status).toBe("WAITING_FOR_ANSWER");
    expect(rows[1].status).toBe("UNKNOWN");
    expect(rows[1].rawStatus).toBe("YENI_BIR_DURUM");
  });

  it("maxPages sınırına ulaşınca durur", async () => {
    let calls = 0;
    const result = await syncQuestions(
      { pageSize: 1, maxPages: 2 },
      {
        prisma,
        client: stubClient(() => {
          calls += 1;
          return pageResult([questionItem(calls)], { last: false, totalPages: 99 });
        }),
      },
    );

    expect(calls).toBe(2);
    expect(result.pagesFetched).toBe(2);
    expect(result.savedCount).toBe(2);
  });
});

describe("senkronizasyon — hata yönetimi", () => {
  it("ilk sayfada 401 gelirse FAILED kaydı oluşur, soru kaydedilmez", async () => {
    const result = await syncQuestions(
      {},
      {
        prisma,
        client: stubClient(() => {
          throw new TrendyolApiError("kimlik doğrulama başarısız", {
            kind: "auth",
            status: 401,
            retryable: false,
          });
        }),
      },
    );

    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("401");
    expect(result.savedCount).toBe(0);
    expect(await prisma.question.count()).toBe(0);

    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } });
    expect(run.status).toBe("FAILED");
    expect(run.errorCode).toBe("401");
    expect(run.finishedAt).not.toBeNull();
  });

  it("ikinci sayfada hata olursa PARTIAL olarak işaretlenir, ilk sayfa korunur", async () => {
    const result = await syncQuestions(
      { pageSize: 2 },
      {
        prisma,
        client: stubClient((query) => {
          if ((query.page ?? 0) === 0) {
            return pageResult([questionItem(1), questionItem(2)], { last: false, totalPages: 3 });
          }
          throw new TrendyolApiError("hız sınırı", {
            kind: "rate_limit",
            status: 429,
            retryable: true,
            retryAfterMs: 1000,
          });
        }),
      },
    );

    expect(result.status).toBe("PARTIAL");
    expect(result.errorCode).toBe("429");
    expect(result.savedCount).toBe(2);
    expect(result.pagesFetched).toBe(1);
    expect(await prisma.question.count()).toBe(2);
  });

  it("hata mesajı gizli bilgi içermez", async () => {
    const result = await syncQuestions(
      {},
      {
        prisma,
        client: stubClient(() => {
          throw new TrendyolApiError("Trendyol kimlik doğrulaması başarısız (401)", {
            kind: "auth",
            status: 401,
          });
        }),
      },
    );

    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } });
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain("test-api-key");
    expect(serialized).not.toContain("test-api-secret");
    expect(serialized).not.toContain("Basic ");
  });
});

describe("uçtan uca: HTTP katmanı + veritabanı", () => {
  it("sahte HTTP yanıtlarından soruları çekip veritabanına yazar", async () => {
    const responses = [
      {
        content: [questionItem(11), questionItem(12)],
        totalPages: 2,
        last: false,
        size: 2,
        number: 0,
      },
      {
        content: [questionItem(13), questionItem(14)],
        totalPages: 2,
        last: true,
        size: 2,
        number: 1,
      },
    ];

    const fetchImpl = (async () =>
      new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const config: TrendyolClientConfig = {
      baseUrl: "https://apigw.trendyol.test/integration/qna",
      sellerId: "123456",
      apiKey: "test-api-key",
      apiSecret: "test-api-secret",
      userAgent: "123456 - SelfIntegration",
      timeoutMs: 2_000,
      maxRetries: 1,
      retryBaseMs: 0,
      jitter: () => 0,
      fetchImpl,
      sleepImpl: async () => {},
    };

    const result = await syncQuestions(
      { pageSize: 2 },
      { prisma, client: new TrendyolQnaClient(config) },
    );

    expect(result.status).toBe("SUCCESS");
    expect(result.fetchedCount).toBe(4);
    expect(await prisma.question.count()).toBe(4);

    const store = await prisma.store.findFirstOrThrow();
    expect(store.sellerId).toBe(123456n);
  });
});
