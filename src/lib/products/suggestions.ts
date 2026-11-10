import { getPrisma } from "@/lib/prisma";
import type { PrismaClient } from "@/generated/prisma/client";
import { classifyQuestion, isFeatureCategory, type QuestionCategory } from "@/lib/history/categories";
import { detectStaleClaims } from "@/lib/history/guard";
import { evaluateGroup } from "./value-semantics";

import { setField, type FieldKey } from "./bank";

/**
 * Geçmiş satıcı cevaplarından ürün alanı **adayı** çıkarır.
 *
 * Kurallar:
 * - Yalnızca özellik kategorileri (ölçü, pile, kumaş, renk, yıkama, montaj) kullanılır.
 * - Sipariş / fiyat / stok / teslimat / iade ifadeleri kalıcı ürün özelliğine DÖNÜŞTÜRÜLMEZ.
 * - Aynı alan için farklı değerler varsa çelişki işaretlenir.
 * - Öneri kabul edilse bile kart alanı **doğrulanmamış** yazılır; insan alan doğrulaması gerekir.
 */

const CATEGORY_TO_FIELD: Partial<Record<QuestionCategory, FieldKey>> = {
  MEASURE: "customSize",
  PLEAT: "pleat",
  FABRIC: "fabric",
  COLOR: "colors",
  WASH: "care",
  MOUNT: "mounting",
};

export interface SuggestionCandidate {
  fieldKey: FieldKey;
  value: string;
  sourceQuestionIds: string[];
  conflict: boolean;
  /** Çelişki yok ama değer belirsiz: insan incelemesi */
  needsReview: boolean;
  conflictValues: string[];
}

/** Cevabı alan değerine indirger: selamlama/kişi eklerini temizler, uzunluğu sınırlar. */
export function normalizeFieldValue(answer: string, fieldKey?: string): string {
  const cleaned = answer
    .replace(/\b(efendim|merhaba|merhabalar|selam|teşekkürler|teşekkür ederim|rica ederim)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0);
  const relevant = fieldKey
    ? sentences.find((sentence) => evaluateGroup(fieldKey, [sentence]).needsReview || /\d|[üu]t[üu]|pile|kur[şs]un|karartma|makine|dikim/i.test(sentence))
    : undefined;
  const value = (relevant ?? sentences[0] ?? cleaned).trim();
  return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}

/**
 * Tek kelimelik / boilerplate cevaplar ("Evet", "Teşekkürler", "Sık sorulan sorular")
 * alan değeri olamaz; bunlar kart doldurmaya yardımcı olmaz.
 */
const BOILERPLATE = [
  /s[ıi]k\s*sorulan/i,
  /sorular[ıi]n[ıi]z/i,
  /te[şs]ekk[üu]r/i,
  /merhaba|iyi\s*g[üu]nler/i,
  /^\s*(evet|hay[ıi]r|tamam|olur|yok|var)\b/i,
];

export function isUsableSuggestionValue(value: string): boolean {
  if (BOILERPLATE.some((pattern) => pattern.test(value))) return false;
  return value.replace(/\s+/g, "").length >= 8;
}

export function extractFeatureCandidates(
  answers: Array<{ questionId: string; trendyolQuestionId: string; text: string; answerText: string }>,
): SuggestionCandidate[] {
  const grouped = new Map<FieldKey, Map<string, string[]>>();

  for (const answer of answers) {
    const category = classifyQuestion(answer.text);
    if (!isFeatureCategory(category)) continue;

    // Fiyat/stok/teslimat/iade geçen cevap kalıcı özellik olmaz.
    if (detectStaleClaims(answer.answerText).length > 0) continue;

    const fieldKey = CATEGORY_TO_FIELD[category];
    if (!fieldKey) continue;

    const value = normalizeFieldValue(answer.answerText, CATEGORY_TO_FIELD[category]);
    if (!isUsableSuggestionValue(value)) continue;

    const perValue = grouped.get(fieldKey) ?? new Map<string, string[]>();
    const sources = perValue.get(value) ?? [];
    sources.push(answer.trendyolQuestionId);
    perValue.set(value, sources);
    grouped.set(fieldKey, perValue);
  }

  const candidates: SuggestionCandidate[] = [];

  for (const [fieldKey, values] of grouped) {
    const entries = [...values.entries()];
    const verdict = evaluateGroup(fieldKey, entries.map(([value]) => value));

    for (const [value, sourceQuestionIds] of entries) {
      // Yalnızca birbirini dışlayan değerler "çelişki" sayılır; farklı cümleler değil.
      const conflicting = verdict.conflict && verdict.conflictValues.includes(value);
      candidates.push({
        fieldKey,
        value,
        sourceQuestionIds,
        conflict: conflicting,
        needsReview: verdict.needsReview && !conflicting,
        conflictValues: conflicting ? verdict.conflictValues.filter((item) => item !== value) : [],
      });
    }
  }

  return candidates.sort((a, b) => b.sourceQuestionIds.length - a.sourceQuestionIds.length);
}

export interface SuggestionRow {
  id: string;
  productMainId: string;
  fieldKey: string;
  value: string;
  sourceQuestionIds: string[];
  conflict: boolean;
  needsReview: boolean;
  conflictValues: string[];
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

function toRow(row: {
  id: string;
  productMainId: string;
  fieldKey: string;
  value: string;
  sourceQuestionIds: unknown;
  conflict: boolean;
  needsReview: boolean;
  conflictValues: unknown;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}): SuggestionRow {
  return {
    id: row.id,
    productMainId: row.productMainId,
    fieldKey: row.fieldKey,
    value: row.value,
    sourceQuestionIds: Array.isArray(row.sourceQuestionIds) ? (row.sourceQuestionIds as string[]) : [],
    conflict: row.conflict,
    needsReview: row.needsReview,
    conflictValues: Array.isArray(row.conflictValues) ? (row.conflictValues as string[]) : [],
    status: row.status as SuggestionRow["status"],
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
  };
}

/** En çok soru gelen ürünler için adayları üretir ve PENDING olarak saklar. */
export async function generateSuggestions(
  input: { storeId: string; limit?: number; actor: string },
  deps: { prisma?: PrismaClient } = {},
): Promise<{ created: number; conflicts: number; products: number }> {
  const prisma = deps.prisma ?? getPrisma();

  const groups = await prisma.question.groupBy({
    by: ["productMainId"],
    where: { storeId: input.storeId, productMainId: { not: null }, answerText: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { productMainId: "desc" } },
    take: Math.min(input.limit ?? 10, 50),
  });

  let created = 0;
  let conflicts = 0;

  for (const group of groups) {
    const productMainId = group.productMainId;
    if (!productMainId) continue;

    const answers = await prisma.question.findMany({
      where: { storeId: input.storeId, productMainId, answerText: { not: null } },
      select: { id: true, trendyolQuestionId: true, text: true, answerText: true },
    });

    const candidates = extractFeatureCandidates(
      answers.map((answer) => ({
        questionId: answer.id,
        trendyolQuestionId: String(answer.trendyolQuestionId),
        text: answer.text,
        answerText: answer.answerText ?? "",
      })),
    );

    for (const candidate of candidates) {
      const existing = await prisma.productFieldSuggestion.findFirst({
        where: { storeId: input.storeId, productMainId, fieldKey: candidate.fieldKey, value: candidate.value },
      });
      if (existing) continue;

      await prisma.productFieldSuggestion.create({
        data: {
          storeId: input.storeId,
          productMainId,
          fieldKey: candidate.fieldKey,
          value: candidate.value,
          sourceQuestionIds: candidate.sourceQuestionIds as unknown as object,
          conflict: candidate.conflict,
          needsReview: candidate.needsReview,
          conflictValues: candidate.conflictValues as unknown as object,
        },
      });

      created += 1;
      if (candidate.conflict) conflicts += 1;
    }
  }

  return { created, conflicts, products: groups.length };
}

export async function listSuggestions(
  input: { storeId?: string; productMainId?: string; status?: "PENDING" | "ACCEPTED" | "REJECTED"; limit?: number } = {},
  deps: { prisma?: PrismaClient } = {},
): Promise<SuggestionRow[]> {
  const prisma = deps.prisma ?? getPrisma();
  const rows = await prisma.productFieldSuggestion.findMany({
    where: {
      ...(input.storeId ? { storeId: input.storeId } : {}),
      ...(input.productMainId ? { productMainId: input.productMainId } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: [{ conflict: "desc" }, { createdAt: "desc" }],
    take: Math.min(input.limit ?? 100, 300),
  });

  return rows.map(toRow);
}

/** Öneriyi kabul eder: alan değeri yazılır ama DOĞRULANMIŞ sayılmaz. */
export async function acceptSuggestion(
  input: { suggestionId: string; actor: string },
  deps: { prisma?: PrismaClient } = {},
): Promise<{ fieldKey: string; verified: boolean }> {
  const prisma = deps.prisma ?? getPrisma();
  const suggestion = await prisma.productFieldSuggestion.findUnique({ where: { id: input.suggestionId } });
  if (!suggestion) throw new Error("Öneri bulunamadı.");
  if (suggestion.status === "ACCEPTED") return { fieldKey: suggestion.fieldKey, verified: false };

  await setField(
    {
      storeId: suggestion.storeId,
      productMainId: suggestion.productMainId,
      productId: suggestion.productId,
      fieldKey: suggestion.fieldKey,
      value: suggestion.value,
      actor: input.actor,
      source: "SUGGESTION",
    },
    { prisma },
  );

  await prisma.productFieldSuggestion.update({
    where: { id: suggestion.id },
    data: { status: "ACCEPTED", reviewedBy: input.actor, reviewedAt: new Date() },
  });

  return { fieldKey: suggestion.fieldKey, verified: false };
}

export async function rejectSuggestion(
  input: { suggestionId: string; actor: string; note?: string | null },
  deps: { prisma?: PrismaClient } = {},
): Promise<void> {
  const prisma = deps.prisma ?? getPrisma();
  const suggestion = await prisma.productFieldSuggestion.findUnique({ where: { id: input.suggestionId } });
  if (!suggestion) throw new Error("Öneri bulunamadı.");

  await prisma.productFieldSuggestion.update({
    where: { id: suggestion.id },
    data: { status: "REJECTED", reviewedBy: input.actor, reviewedAt: new Date(), note: input.note?.trim() || null },
  });
}
