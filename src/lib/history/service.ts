import { getPrisma } from "@/lib/prisma";
import type { PrismaClient } from "@/generated/prisma/client";
import type { AnswerReviewStatus } from "@/generated/prisma/enums";

/**
 * Geçmiş cevap hafızası yönetimi: listeleme, insan doğrulaması ve istatistik.
 *
 * Doğrulama durumları:
 * - UNREVIEWED: senkronize edildi, insan bakmadı → AI'ya "referans" olarak girebilir, asla kanıt sayılmaz.
 * - VERIFIED:   insan doğruladı → hâlâ güncel gerçek değildir; fiyat/stok/teslimat için kullanılmaz.
 * - WRONG:      hatalı → AI bağlamına girmez.
 * - OUTDATED:   güncelliğini yitirdi → AI bağlamına girmez (yalnızca geçmiş bilgisi olarak listelenir).
 */

export class HistoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HistoryError";
  }
}

export interface AnswerMemoryRow {
  questionId: string;
  trendyolQuestionId: string;
  text: string;
  answerText: string;
  reviewStatus: AnswerReviewStatus;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  productName: string | null;
  productMainId: string | null;
  askedAt: Date | null;
  answeredAt: Date | null;
}

export async function listAnswerMemory(
  input: { storeId?: string; q?: string; review?: AnswerReviewStatus; limit?: number } = {},
  deps: { prisma?: PrismaClient } = {},
): Promise<AnswerMemoryRow[]> {
  const prisma = deps.prisma ?? getPrisma();
  const rows = await prisma.question.findMany({
    where: {
      ...(input.storeId ? { storeId: input.storeId } : {}),
      ...(input.review ? { answerReviewStatus: input.review } : {}),
      answerText: { not: null },
      ...(input.q
        ? {
            OR: [{ text: { contains: input.q, mode: "insensitive" } }, { answerText: { contains: input.q, mode: "insensitive" } }],
          }
        : {}),
    },
    orderBy: [{ answeredAt: "desc" }, { askedAt: "desc" }],
    take: Math.min(input.limit ?? 100, 300),
  });

  return rows.map((row) => ({
    questionId: row.id,
    trendyolQuestionId: String(row.trendyolQuestionId),
    text: row.text,
    answerText: row.answerText ?? "",
    reviewStatus: row.answerReviewStatus,
    reviewNote: row.answerReviewNote,
    reviewedBy: row.answerReviewedBy,
    reviewedAt: row.answerReviewedAt,
    productName: row.productName,
    productMainId: row.productMainId,
    askedAt: row.askedAt,
    answeredAt: row.answeredAt,
  }));
}

/** İnsan değerlendirmesi. Otomatik hiçbir süreç bu durumu kendiliğinden değiştirmez. */
export async function reviewAnswer(
  input: { questionId: string; status: AnswerReviewStatus; actor: string; note?: string | null },
  deps: { prisma?: PrismaClient } = {},
): Promise<{ questionId: string; status: AnswerReviewStatus }> {
  const prisma = deps.prisma ?? getPrisma();
  const actor = input.actor?.trim();
  if (!actor) throw new HistoryError("UNAUTHORIZED", "Doğrulama için yönetici kimliği gerekir.");

  const question = await prisma.question.findUnique({ where: { id: input.questionId } });
  if (!question) throw new HistoryError("QUESTION_NOT_FOUND", "Soru bulunamadı.");
  if (!question.answerText || question.answerText.trim() === "") {
    throw new HistoryError("ANSWER_MISSING", "Cevabı olmayan soru doğrulanamaz.");
  }

  const updated = await prisma.question.update({
    where: { id: input.questionId },
    data: {
      answerReviewStatus: input.status,
      answerReviewNote: input.note?.trim() || null,
      answerReviewedBy: actor,
      answerReviewedAt: new Date(),
    },
  });

  return { questionId: updated.id, status: updated.answerReviewStatus };
}

export interface AnswerMemoryStats {
  total: number;
  verified: number;
  unreviewed: number;
  wrong: number;
  outdated: number;
  usableForAi: number;
}

export async function answerMemoryStats(deps: { prisma?: PrismaClient } = {}): Promise<AnswerMemoryStats> {
  const prisma = deps.prisma ?? getPrisma();
  const [total, verified, unreviewed, wrong, outdated] = await Promise.all([
    prisma.question.count({ where: { answerText: { not: null } } }),
    prisma.question.count({ where: { answerText: { not: null }, answerReviewStatus: "VERIFIED" } }),
    prisma.question.count({ where: { answerText: { not: null }, answerReviewStatus: "UNREVIEWED" } }),
    prisma.question.count({ where: { answerText: { not: null }, answerReviewStatus: "WRONG" } }),
    prisma.question.count({ where: { answerText: { not: null }, answerReviewStatus: "OUTDATED" } }),
  ]);

  return { total, verified, unreviewed, wrong, outdated, usableForAi: verified + unreviewed };
}
