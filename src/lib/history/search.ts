import { getPrisma } from "@/lib/prisma";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Geçmiş cevap araması (Türkçe, trigram + kelime örtüşmesi + ürün önceliği).
 *
 * Tasarım kararı: PostgreSQL `pg_trgm` Türkçe ekleri köklemediği için benzerlik tek başına
 * yeterli değil. Bu yüzden üç sinyal birleştirilir:
 *   1) aynı ürün (`productMainId`) → öncelik,
 *   2) trigram benzerliği (`similarity`),
 *   3) anahtar kelime örtüşmesi (ekleri kaba biçimde kırpar).
 * Embedding altyapısı opsiyoneldir: arayüz aynı kaldığı için `searchHistoricalAnswers`
 * içindeki sıralama bir vektör skoruyla değiştirilebilir (bkz. README).
 */

export interface HistoryMatch {
  questionId: string;
  trendyolQuestionId: string;
  text: string;
  answerText: string;
  similarity: number;
  keywordOverlap: number;
  score: number;
  productMatch: boolean;
  reviewStatus: "VERIFIED" | "UNREVIEWED";
  askedAt: Date | null;
  reason: string;
}

export interface SearchInput {
  storeId: string;
  text: string;
  productMainId?: string | null;
  excludeQuestionId?: string | null;
  limit?: number;
  minScore?: number;
}

const STOPWORDS = new Set([
  "acaba","ama","ancak","bana","bende","beni","bir","biraz","bu","bunu","çok","da","daha","de","diye","en","fakat",
  "gibi","hem","hep","hangi","hangi","hakkında","için","ile","ise","keşke","ki","kim","mı","mi","mu","mü","nasıl",
  "ne","neden","nerede","nereye","niçin","o","olarak","oldu","olur","siz","sizin","şey","şu","ve","veya","ya","yani",
  "selam","merhaba","teşekkür","teşekkürler","rica","ederim","efendim","kolay","gelsin",
]);

/** Türkçe metni arama için normalleştirir (ek kırpma kaba ama deterministik). */
export function normalize(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(word: string): string {
  let value = word;
  for (const suffix of ["lar","ler","dan","den","tan","ten","nin","nun","nın","nün","da","de","ta","te","ya","ye","ı","i","u","ü","a","e"]) {
    if (value.length - suffix.length >= 4 && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  return value;
}

export function extractKeywords(text: string): string[] {
  const words = normalize(text)
    .split(" ")
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
  const stems = words.map(stem).filter((word) => word.length >= 4);
  return [...new Set(stems)].slice(0, 12);
}

function overlap(keywords: string[], text: string): number {
  if (keywords.length === 0) return 0;
  const haystack = normalize(text);
  const hits = keywords.filter((keyword) => haystack.includes(keyword)).length;
  return hits / keywords.length;
}

interface Row {
  id: string;
  trendyolQuestionId: bigint;
  text: string;
  answerText: string;
  answerReviewStatus: "VERIFIED" | "UNREVIEWED";
  productMainId: string | null;
  askedAt: Date | null;
  similarity: number;
}

export async function searchHistoricalAnswers(
  input: SearchInput,
  deps: { prisma?: PrismaClient } = {},
): Promise<HistoryMatch[]> {
  const prisma = deps.prisma ?? getPrisma();
  const keywords = extractKeywords(input.text);
  const patterns = keywords.map((keyword) => `%${keyword}%`);

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "id", "trendyolQuestionId", "text", "answerText", "answerReviewStatus",
           "productMainId", "askedAt",
           similarity("text", ${input.text}) AS "similarity"
    FROM "questions"
    WHERE "storeId" = ${input.storeId}
      AND "answerText" IS NOT NULL AND btrim("answerText") <> ''
      AND "answerReviewStatus" IN ('VERIFIED', 'UNREVIEWED')
      AND (${input.excludeQuestionId ?? null}::text IS NULL OR "id" <> ${input.excludeQuestionId ?? null})
      AND (
        similarity("text", ${input.text}) > 0.1
        OR (${input.productMainId ?? null}::text IS NOT NULL AND "productMainId" = ${input.productMainId ?? null})
        OR (${patterns.length}::int > 0 AND "text" ILIKE ANY(${patterns}::text[]))
      )
    ORDER BY
      (CASE WHEN "productMainId" = ${input.productMainId ?? null} THEN 1 ELSE 0 END) DESC,
      (CASE WHEN "answerReviewStatus" = 'VERIFIED' THEN 1 ELSE 0 END) DESC,
      "similarity" DESC,
      "askedAt" DESC NULLS LAST
    LIMIT 40
  `;

  const minScore = input.minScore ?? 0.12;
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);

  const scored: HistoryMatch[] = rows
    .map((row) => {
      const keywordOverlap = overlap(keywords, row.text);
      const productMatch = Boolean(input.productMainId) && row.productMainId === input.productMainId;
      const base = Number(row.similarity ?? 0);
      const score = base + keywordOverlap * 0.35 + (productMatch ? 0.25 : 0) + (row.answerReviewStatus === "VERIFIED" ? 0.1 : 0);
      const reasons: string[] = [];
      if (productMatch) reasons.push("aynı ürün");
      if (base >= 0.3) reasons.push("yüksek metin benzerliği");
      else if (base >= 0.1) reasons.push("kısmi metin benzerliği");
      if (keywordOverlap >= 0.3) reasons.push(`kelime örtüşmesi %${Math.round(keywordOverlap * 100)}`);
      if (row.answerReviewStatus === "VERIFIED") reasons.push("doğrulanmış cevap");

      return {
        questionId: row.id,
        trendyolQuestionId: String(row.trendyolQuestionId),
        text: row.text,
        answerText: row.answerText,
        similarity: Number(base.toFixed(3)),
        keywordOverlap: Number(keywordOverlap.toFixed(2)),
        score: Number(score.toFixed(3)),
        productMatch,
        reviewStatus: row.answerReviewStatus,
        askedAt: row.askedAt,
        reason: reasons.join(" · ") || "zayıf eşleşme",
      };
    })
    .filter((match) => match.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

/** Panelde gösterilecek kısa kimlik (müşteri metni yerine). */
export function historyRef(match: HistoryMatch): string {
  return `#${match.trendyolQuestionId}`;
}
