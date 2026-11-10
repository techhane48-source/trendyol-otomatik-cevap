import { getPrisma } from "@/lib/prisma";
import type { PrismaClient } from "@/generated/prisma/client";
import { classifyQuestion, type QuestionCategory } from "@/lib/history/categories";
import { maskPii } from "@/lib/llm/sanitize";

/**
 * Ürün bilgi bankası: en çok soru gelen ürünler, alan bazında doğrulama, toplu düzenleme,
 * CSV içe/dışa aktarma.
 *
 * KURAL: Bir alanın doğrulanması diğer alanları doğrulamaz. Kart `VERIFIED` olsa bile
 * alan bazında `verified=false` işaretli değerler AI'ya "doğrulanmış gerçek" olarak girmez.
 * CSV ile gelen değerler **doğrulanmamış** kabul edilir.
 */

export const FIELD_DEFS = [
  { key: "fabric", label: "Kumaş türü" },
  { key: "pleat", label: "Pile oranı" },
  { key: "sewing", label: "Dikim şekli" },
  { key: "blackout", label: "Karartma seviyesi" },
  { key: "weightedHem", label: "Kurşunlu etek" },
  { key: "care", label: "Ütü / yıkama" },
  { key: "mounting", label: "Montaj" },
  { key: "customSize", label: "Özel ölçü" },
  { key: "colors", label: "Renkler" },
  { key: "description", label: "Açıklama" },
] as const;

export type FieldKey = (typeof FIELD_DEFS)[number]["key"];

export interface BankAttribute {
  key: string;
  label: string;
  value: string;
  /** Alan bazında doğrulama. `true` değilse AI'ya doğrulanmış bilgi olarak girmez. */
  verified?: boolean;
  source?: "MANUAL" | "CSV" | "SUGGESTION" | "CARD";
  verifiedAt?: string | null;
  verifiedBy?: string | null;
}

export class BankError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BankError";
  }
}

export interface TopProduct {
  productMainId: string;
  productName: string | null;
  variants: string[];
  questionCount: number;
  answeredCount: number;
  hasCard: boolean;
  verifiedFields: number;
  /** En son soru tarihi */
  lastAskedAt: Date | null;
}

function labelOf(key: string): string {
  return FIELD_DEFS.find((field) => field.key === key)?.label ?? key;
}

export function isFieldKey(value: string): value is FieldKey {
  return FIELD_DEFS.some((field) => field.key === value);
}

/** Kart özelliklerinden yalnızca doğrulanmış olanları döndürür. */
export function verifiedAttributes(attributes: unknown, cardStatus: "DRAFT" | "VERIFIED"): BankAttribute[] {
  if (!Array.isArray(attributes)) return [];
  return (attributes as BankAttribute[]).filter((attribute) => {
    if (!attribute?.label || !attribute?.value) return false;
    if (attribute.verified === true) return true;
    // Eski kayıtlar: alan bazında işaret yoksa kartın durumu belirleyicidir.
    if (attribute.verified === undefined) return cardStatus === "VERIFIED";
    return false;
  });
}

export async function listTopProducts(
  input: { storeId?: string; limit?: number } = {},
  deps: { prisma?: PrismaClient } = {},
): Promise<TopProduct[]> {
  const prisma = deps.prisma ?? getPrisma();
  const rows = await prisma.question.groupBy({
    by: ["productMainId"],
    where: { productMainId: { not: null }, ...(input.storeId ? { storeId: input.storeId } : {}) },
    _count: { _all: true },
    orderBy: { _count: { productMainId: "desc" } },
    take: Math.min(input.limit ?? 10, 50),
  });

  const products: TopProduct[] = [];
  for (const row of rows) {
    const productMainId = row.productMainId;
    if (!productMainId) continue;

    const [questions, card] = await Promise.all([
      prisma.question.findMany({
        where: { productMainId, ...(input.storeId ? { storeId: input.storeId } : {}) },
        select: { productId: true, productName: true, answerText: true, askedAt: true, storeId: true },
      }),
      prisma.productInfo.findFirst({
        where: { productMainId, productId: null, ...(input.storeId ? { storeId: input.storeId } : {}) },
        select: { id: true, status: true, attributes: true },
      }),
    ]);

    const variants = [...new Set(questions.map((question) => question.productId).filter((value): value is string => Boolean(value)))];
    const names = questions.map((question) => question.productName).filter((value): value is string => Boolean(value));

    products.push({
      productMainId,
      productName: names[0] ?? null,
      variants,
      questionCount: row._count._all,
      answeredCount: questions.filter((question) => question.answerText).length,
      hasCard: Boolean(card),
      verifiedFields: card ? verifiedAttributes(card.attributes, card.status as "DRAFT" | "VERIFIED").length : 0,
      lastAskedAt: questions.reduce<Date | null>((latest, question) => {
        if (!question.askedAt) return latest;
        return !latest || question.askedAt > latest ? question.askedAt : latest;
      }, null),
    });
  }

  return products.sort((a, b) => b.questionCount - a.questionCount);
}

export interface QuestionHint {
  category: QuestionCategory;
  text: string;
  answerText: string | null;
  askedAt: Date | null;
}

/**
 * Kart doldurmayı kolaylaştıran soru ipuçları: aynı ürünün geçmiş soruları,
 * kategori bazında en yeniler. Metinler PII'den arındırılır; cevaplar "kesin bilgi"
 * olarak sunulmaz, yalnızca hatırlatıcıdır.
 */
export async function getProductQuestionHints(
  input: { storeId: string; productMainId: string; perCategory?: number },
  deps: { prisma?: PrismaClient } = {},
): Promise<QuestionHint[]> {
  const prisma = deps.prisma ?? getPrisma();
  const rows = await prisma.question.findMany({
    where: { storeId: input.storeId, productMainId: input.productMainId },
    orderBy: { askedAt: "desc" },
    take: 60,
    select: { text: true, answerText: true, askedAt: true },
  });

  const perCategory = Math.min(Math.max(input.perCategory ?? 2, 1), 5);
  const counts = new Map<QuestionCategory, number>();
  const hints: QuestionHint[] = [];

  for (const row of rows) {
    const category = classifyQuestion(row.text);
    const used = counts.get(category) ?? 0;
    if (used >= perCategory) continue;
    counts.set(category, used + 1);
    hints.push({
      category,
      text: maskPii(row.text),
      answerText: row.answerText ? maskPii(row.answerText) : null,
      askedAt: row.askedAt,
    });
  }

  return hints;
}

export interface CardFields {
  productMainId: string;
  productId: string | null;
  title: string | null;
  status: "DRAFT" | "VERIFIED";
  verifiedBy: string | null;
  verifiedAt: Date | null;
  fields: Array<BankAttribute & { verified: boolean }>;
  missingFields: FieldKey[];
}

export async function getCardFields(
  input: { storeId?: string; productMainId: string; productId?: string | null },
  deps: { prisma?: PrismaClient } = {},
): Promise<CardFields> {
  const prisma = deps.prisma ?? getPrisma();
  const card = await prisma.productInfo.findFirst({
    where: {
      productMainId: input.productMainId,
      productId: input.productId ?? null,
      ...(input.storeId ? { storeId: input.storeId } : {}),
    },
  });

  const attributes = Array.isArray(card?.attributes) ? (card?.attributes as unknown as BankAttribute[]) : [];
  const byKey = new Map(attributes.map((attribute) => [attribute.key ?? attribute.label, attribute]));

  const fields = FIELD_DEFS.map((field) => {
    const attribute = byKey.get(field.key);
    return {
      key: field.key,
      label: field.label,
      value: attribute?.value ?? "",
      verified: attribute?.verified === true,
      source: attribute?.source,
      verifiedAt: attribute?.verifiedAt ?? null,
      verifiedBy: attribute?.verifiedBy ?? null,
    };
  });

  return {
    productMainId: input.productMainId,
    productId: input.productId ?? null,
    title: card?.title ?? null,
    status: (card?.status as "DRAFT" | "VERIFIED") ?? "DRAFT",
    verifiedBy: card?.verifiedBy ?? null,
    verifiedAt: card?.verifiedAt ?? null,
    fields,
    missingFields: fields.filter((field) => field.value.trim() === "").map((field) => field.key),
  };
}

async function ensureCard(
  prisma: PrismaClient,
  input: { storeId: string; productMainId: string; productId?: string | null; title?: string | null; actor: string },
): Promise<{ id: string; storeId: string; attributes: BankAttribute[] }> {
  const existing = await prisma.productInfo.findFirst({
    where: { storeId: input.storeId, productMainId: input.productMainId, productId: input.productId ?? null },
  });

  if (existing) {
    return {
      id: existing.id,
      storeId: existing.storeId,
      attributes: Array.isArray(existing.attributes) ? (existing.attributes as unknown as BankAttribute[]) : [],
    };
  }

  const created = await prisma.productInfo.create({
    data: {
      storeId: input.storeId,
      productMainId: input.productMainId,
      productId: input.productId ?? null,
      title: input.title ?? null,
      attributes: [],
      status: "DRAFT",
      createdBy: input.actor,
    },
  });

  await prisma.productInfoEvent.create({
    data: { productInfoId: created.id, action: "CREATED", actor: input.actor, changes: { source: "product-bank" } },
  });

  return { id: created.id, storeId: created.storeId, attributes: [] };
}

function mergeAttribute(attributes: BankAttribute[], next: BankAttribute): BankAttribute[] {
  const index = attributes.findIndex((attribute) => (attribute.key ?? attribute.label) === (next.key ?? next.label));
  const copy = [...attributes];
  if (index >= 0) copy[index] = next;
  else copy.push(next);
  return copy;
}

/** Alanı yazar; doğrulama durumu KORUNMAZ (değer değişince yeniden doğrulanmalıdır). */
export async function setField(
  input: {
    storeId: string;
    productMainId: string;
    productId?: string | null;
    fieldKey: string;
    value: string;
    actor: string;
    source?: BankAttribute["source"];
    title?: string | null;
  },
  deps: { prisma?: PrismaClient } = {},
): Promise<{ productInfoId: string; fieldKey: string; verified: boolean }> {
  if (!isFieldKey(input.fieldKey)) throw new BankError("UNKNOWN_FIELD", "Bilinmeyen alan.");
  const prisma = deps.prisma ?? getPrisma();
  const card = await ensureCard(prisma, input);

  const next = mergeAttribute(card.attributes, {
    key: input.fieldKey,
    label: labelOf(input.fieldKey),
    value: input.value.trim(),
    verified: false,
    source: input.source ?? "MANUAL",
  });

  await prisma.productInfo.update({
    where: { id: card.id },
    data: { attributes: next as unknown as object, ...(input.title ? { title: input.title } : {}) },
  });

  await prisma.productInfoEvent.create({
    data: {
      productInfoId: card.id,
      action: "UPDATED",
      actor: input.actor,
      changes: { fieldKey: input.fieldKey, value: next.find((item) => item.key === input.fieldKey)?.value ?? null, verified: false },
    },
  });

  return { productInfoId: card.id, fieldKey: input.fieldKey, verified: false };
}

/** Tek alanı doğrular. Diğer alanlar etkilenmez. */
export async function verifyField(
  input: { storeId: string; productMainId: string; productId?: string | null; fieldKey: string; actor: string; value?: string },
  deps: { prisma?: PrismaClient } = {},
): Promise<{ productInfoId: string; fieldKey: string; verified: boolean }> {
  if (!isFieldKey(input.fieldKey)) throw new BankError("UNKNOWN_FIELD", "Bilinmeyen alan.");
  const prisma = deps.prisma ?? getPrisma();
  const card = await ensureCard(prisma, input);

  const current = card.attributes.find((attribute) => (attribute.key ?? attribute.label) === input.fieldKey);
  const value = (input.value ?? current?.value ?? "").trim();
  if (value === "") throw new BankError("EMPTY_FIELD", "Boş alan doğrulanamaz.");

  const next = mergeAttribute(card.attributes, {
    key: input.fieldKey,
    label: labelOf(input.fieldKey),
    value,
    verified: true,
    source: current?.source ?? "MANUAL",
    verifiedAt: new Date().toISOString(),
    verifiedBy: input.actor,
  });

  await prisma.productInfo.update({ where: { id: card.id }, data: { attributes: next as unknown as object } });
  await prisma.productInfoEvent.create({
    data: { productInfoId: card.id, action: "VERIFIED", actor: input.actor, changes: { fieldKey: input.fieldKey, value } },
  });

  return { productInfoId: card.id, fieldKey: input.fieldKey, verified: true };
}

export async function unverifyField(
  input: { storeId: string; productMainId: string; productId?: string | null; fieldKey: string; actor: string },
  deps: { prisma?: PrismaClient } = {},
): Promise<void> {
  const prisma = deps.prisma ?? getPrisma();
  const card = await prisma.productInfo.findFirst({
    where: { storeId: input.storeId, productMainId: input.productMainId, productId: input.productId ?? null },
  });
  if (!card) throw new BankError("CARD_NOT_FOUND", "Ürün kartı bulunamadı.");

  const attributes = Array.isArray(card.attributes) ? (card.attributes as unknown as BankAttribute[]) : [];
  const next = attributes.map((attribute) =>
    (attribute.key ?? attribute.label) === input.fieldKey
      ? { ...attribute, verified: false, verifiedAt: null, verifiedBy: null }
      : attribute,
  );

  await prisma.productInfo.update({ where: { id: card.id }, data: { attributes: next as unknown as object } });
  await prisma.productInfoEvent.create({
    data: { productInfoId: card.id, action: "UNVERIFIED", actor: input.actor, changes: { fieldKey: input.fieldKey } },
  });
}

/** Birden fazla ürüne aynı alanı yazar (doğrulanmamış). */
export async function bulkSetField(
  input: { storeId: string; productMainIds: string[]; fieldKey: string; value: string; actor: string },
  deps: { prisma?: PrismaClient } = {},
): Promise<{ updated: number }> {
  if (!isFieldKey(input.fieldKey)) throw new BankError("UNKNOWN_FIELD", "Bilinmeyen alan.");
  const prisma = deps.prisma ?? getPrisma();
  let updated = 0;

  for (const productMainId of input.productMainIds) {
    await setField(
      {
        storeId: input.storeId,
        productMainId,
        fieldKey: input.fieldKey,
        value: input.value,
        actor: input.actor,
        source: "MANUAL",
      },
      { prisma },
    );
    updated += 1;
  }

  return { updated };
}

const CSV_COLUMNS = ["productMainId", "productId", ...FIELD_DEFS.map((field) => field.key)] as const;

function csvEscape(value: string): string {
  return /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Tüm kartları CSV olarak dışa aktarır. */
export async function exportCsv(
  input: { storeId?: string } = {},
  deps: { prisma?: PrismaClient } = {},
): Promise<string> {
  const prisma = deps.prisma ?? getPrisma();
  const cards = await prisma.productInfo.findMany({
    where: input.storeId ? { storeId: input.storeId } : {},
    orderBy: { productMainId: "asc" },
  });

  const lines = [CSV_COLUMNS.join(",")];

  for (const card of cards) {
    const attributes = Array.isArray(card.attributes) ? (card.attributes as unknown as BankAttribute[]) : [];
    const byKey = new Map(attributes.map((attribute) => [attribute.key ?? attribute.label, attribute.value]));
    lines.push(
      [
        card.productMainId,
        card.productId ?? "",
        ...FIELD_DEFS.map((field) => csvEscape(byKey.get(field.key) ?? "")),
      ].join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

export interface CsvImportResult {
  rows: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** CSV içe aktarma. Gelen değerler DOĞRULANMAMIŞ olarak yazılır. */
export async function importCsv(
  input: { storeId: string; csv: string; actor: string },
  deps: { prisma?: PrismaClient } = {},
): Promise<CsvImportResult> {
  const prisma = deps.prisma ?? getPrisma();
  const [headerLine, ...rows] = input.csv.replace(/\r/g, "").split("\n").filter((line) => line.trim() !== "");
  if (!headerLine) throw new BankError("EMPTY_CSV", "CSV boş.");

  const header = headerLine.split(",").map((cell) => cell.trim());
  if (!header.includes("productMainId")) throw new BankError("INVALID_CSV", "productMainId kolonu zorunlu.");

  const result: CsvImportResult = { rows: 0, updated: 0, skipped: 0, errors: [] };

  for (const [index, line] of rows.entries()) {
    const cells = splitCsvLine(line);
    const record = new Map(header.map((column, cellIndex) => [column, cells[cellIndex] ?? ""]));
    const productMainId = record.get("productMainId")?.trim() ?? "";
    if (!productMainId) {
      result.skipped += 1;
      result.errors.push(`satır ${index + 2}: productMainId yok`);
      continue;
    }

    result.rows += 1;
    for (const field of FIELD_DEFS) {
      const value = record.get(field.key)?.trim() ?? "";
      if (value === "") continue;
      await setField(
        {
          storeId: input.storeId,
          productMainId,
          productId: record.get("productId")?.trim() || null,
          fieldKey: field.key,
          value,
          actor: input.actor,
          source: "CSV",
        },
        { prisma },
      );
      result.updated += 1;
    }
  }

  return result;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}
