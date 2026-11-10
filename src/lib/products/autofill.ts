import type { PrismaClient } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  FIELD_DEFS,
  type BankAttribute,
  type FieldKey,
  isFieldKey,
  setField,
} from "./bank";
import { compareValues } from "./value-semantics";
import { extractFromCatalog, type CatalogCandidate } from "./catalog-extract";
import type { CatalogProductDto } from "@/lib/trendyol/catalog-client";

/**
 * Katalog + geçmiş cevaplardan ürün kartlarını otomatik TASLAK doldurma (GÖREV 010).
 *
 * Kurallar:
 * - Otomatik doldurulan hiçbir alan `verified` olmaz; doğrulama insan tıklamasıdır.
 * - Doğrulanmış alan asla ezilmez.
 * - Katalog ile geçmiş cevap çelişirse alan `needsReview` olur.
 * - Geçmiş cevabı `Onayla` tek tıkla doğrulanmaz; kaynağı HISTORY_ANSWER olan alanlar
 *   ancak tek tek veya açık `includeHistory` tercihiyle doğrulanır.
 */

export interface AutoFillField {
  key: FieldKey;
  label: string;
  value: string | null;
  source: BankAttribute["source"] | null;
  confidence: NonNullable<BankAttribute["confidence"]> | null;
  evidence: string | null;
  alternatives: string[];
  needsReview: boolean;
  verified: boolean;
  /** "FILLED" yeni dolduruldu · "KEPT" doğrulanmış korundu · "REVIEW" inceleme gerekir · "EMPTY" bilgi yok */
  state: "FILLED" | "KEPT" | "REVIEW" | "EMPTY";
}

export interface AutoFillPlan {
  productMainId: string;
  title: string | null;
  variants: number;
  truncated: boolean;
  hasCatalog: boolean;
  fields: AutoFillField[];
  filledCount: number;
  reviewCount: number;
  missingCount: number;
}

function parseCardAttributes(value: unknown): BankAttribute[] {
  if (!Array.isArray(value)) return [];
  return (value as BankAttribute[]).filter((item) => item && typeof item.label === "string");
}

/** DB'deki düz özellik satırlarını barkod bazında ürünlere böler. */
function toCatalogItems(attributes: unknown): CatalogProductDto[] {
  if (!Array.isArray(attributes)) return [];
  const byBarcode = new Map<string, CatalogProductDto>();

  for (const row of attributes as Array<{ name?: string; value?: string; barcode?: string }>) {
    if (!row?.name || !row?.value) continue;
    const barcode = row.barcode ?? "unknown";
    const item = byBarcode.get(barcode) ?? {
      id: barcode,
      barcode,
      productMainId: null,
      title: null,
      description: null,
      brand: null,
      categoryName: null,
      approved: true,
      archived: false,
      attributes: [],
    };
    item.attributes.push({ attributeId: 0, attributeName: row.name, attributeValue: row.value });
    byBarcode.set(barcode, item);
  }

  return [...byBarcode.values()];
}

export async function buildAutoFillPlan(
  input: { storeId: string; productMainId?: string },
  deps: { prisma?: PrismaClient } = {},
): Promise<AutoFillPlan[]> {
  const prisma = deps.prisma ?? getPrisma();

  const catalogRows = await prisma.catalogProduct.findMany({
    where: {
      storeId: input.storeId,
      ...(input.productMainId ? { productMainId: input.productMainId } : {}),
    },
  });
  if (catalogRows.length === 0) return [];

  const cards = await prisma.productInfo.findMany({
    where: { storeId: input.storeId, productId: null },
    select: { productMainId: true, attributes: true, title: true },
  });
  const cardByMain = new Map(cards.map((card) => [card.productMainId, card]));

  const suggestions = await prisma.productFieldSuggestion.findMany({
    where: {
      storeId: input.storeId,
      status: "PENDING",
      ...(input.productMainId ? { productMainId: input.productMainId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  const plans: AutoFillPlan[] = [];

  for (const row of catalogRows) {
    const items = toCatalogItems(row.attributes);
    const candidates = extractFromCatalog({
      items,
      description: row.description,
      truncated: row.truncated,
    });

    const card = cardByMain.get(row.productMainId);
    const existing = parseCardAttributes(card?.attributes);
    const existingByKey = new Map(existing.filter((item) => isFieldKey(item.key)).map((item) => [item.key as FieldKey, item]));

    const fields: AutoFillField[] = [];

    for (const def of FIELD_DEFS) {
      const current = existingByKey.get(def.key);
      const candidate = candidates.find((item) => item.fieldKey === def.key);
      const historyRows = suggestions.filter((item) => item.productMainId === row.productMainId && item.fieldKey === def.key);

      if (current?.value && current.verified === true) {
        fields.push({
          key: def.key,
          label: def.label,
          value: current.value,
          source: current.source ?? "MANUAL",
          confidence: current.confidence ?? null,
          evidence: current.evidence ?? null,
          alternatives: [],
          needsReview: false,
          verified: true,
          state: "KEPT",
        });
        continue;
      }

      const alternatives = new Set<string>(candidate?.alternatives ?? []);
      let needsReview = candidate?.needsReview ?? false;
      let source: BankAttribute["source"] | null = candidate?.source ?? null;
      let confidence = candidate?.confidence ?? null;
      let evidence = candidate?.evidence ?? null;
      let value = candidate?.value ?? null;

      for (const historyRow of historyRows) {
        if (!value) {
          value = historyRow.value;
          source = "HISTORY_ANSWER";
          confidence = "LOW";
          evidence = `Geçmiş cevap: soru ${historyRow.sourceQuestionIds ? "kayıtlı" : "—"}`;
          needsReview = true;
          continue;
        }
        const verdict = compareValues(def.key, value, historyRow.value);
        if (verdict !== "COMPATIBLE") {
          alternatives.add(historyRow.value);
          needsReview = true;
        }
      }

      // Mevcut ama doğrulanmamış değer varsa korunur; farklı aday çelişki sayılır.
      if (!value && current?.value) {
        value = current.value;
        source = current.source ?? "MANUAL";
        confidence = current.confidence ?? null;
        evidence = current.evidence ?? null;
        needsReview = current.needsReview ?? false;
      } else if (value && current?.value && current.value !== value) {
        alternatives.add(current.value);
        needsReview = true;
      }

      fields.push({
        key: def.key,
        label: def.label,
        value,
        source,
        confidence,
        evidence,
        alternatives: [...alternatives].slice(0, 3),
        needsReview,
        verified: false,
        state: !value ? "EMPTY" : needsReview ? "REVIEW" : "FILLED",
      });
    }

    plans.push({
      productMainId: row.productMainId,
      title: row.title ?? card?.title ?? null,
      variants: row.variantCount,
      truncated: row.truncated,
      hasCatalog: items.length > 0,
      fields,
      filledCount: fields.filter((field) => field.state === "FILLED").length,
      reviewCount: fields.filter((field) => field.state === "REVIEW").length,
      missingCount: fields.filter((field) => field.state === "EMPTY").length,
    });
  }

  return plans.sort((a, b) => b.filledCount - a.filledCount || a.productMainId.localeCompare(b.productMainId));
}

export interface AutoFillResult {
  products: number;
  filled: number;
  review: number;
  skipped: number;
}

/**
 * Planı kartlara yazar. Doğrulanmış alanlar korunur, otomatik alanlar `verified:false`.
 */
export async function applyAutoFill(
  input: { storeId: string; productMainIds?: string[]; actor: string },
  deps: { prisma?: PrismaClient } = {},
): Promise<AutoFillResult> {
  const prisma = deps.prisma ?? getPrisma();
  const plans = await buildAutoFillPlan({ storeId: input.storeId }, { prisma });
  const selected = input.productMainIds?.length
    ? plans.filter((plan) => input.productMainIds?.includes(plan.productMainId))
    : plans;

  let filled = 0;
  let review = 0;
  let skipped = 0;

  for (const plan of selected) {
    const card = await prisma.productInfo.findFirst({
      where: { storeId: input.storeId, productMainId: plan.productMainId, productId: null },
    });
    const existing = parseCardAttributes(card?.attributes);
    const byKey = new Map(existing.map((item) => [item.key, item]));

    for (const field of plan.fields) {
      if (field.state === "KEPT" || field.state === "EMPTY") {
        if (field.state === "EMPTY") skipped += 1;
        continue;
      }

      const previous = byKey.get(field.key);
      if (previous?.verified === true) continue;

      await setField(
        {
          storeId: input.storeId,
          productMainId: plan.productMainId,
          fieldKey: field.key,
          value: field.value ?? "",
          actor: input.actor,
        },
        { prisma },
      );

      // setField sonrası otomatik çıkarım meta verisini işaretle.
      const updatedCard = await prisma.productInfo.findFirst({
        where: { storeId: input.storeId, productMainId: plan.productMainId, productId: null },
        select: { id: true, attributes: true },
      });
      if (!updatedCard) continue;
      const attributes = parseCardAttributes(updatedCard.attributes).map((item) =>
        item.key === field.key
          ? {
              ...item,
              source: field.source ?? "CATALOG_ATTRIBUTE",
              confidence: field.confidence ?? null,
              evidence: field.evidence ?? null,
              alternatives: field.alternatives,
              needsReview: field.needsReview,
              autoFilledAt: new Date().toISOString(),
              verified: false,
            }
          : item,
      );
      await prisma.productInfo.update({ where: { id: updatedCard.id }, data: { attributes: attributes as unknown as object } });

      if (field.state === "REVIEW") review += 1;
      else filled += 1;
    }
  }

  return { products: selected.length, filled, review, skipped };
}

/**
 * Otomatik doldurulan alanları kullanıcı onayıyla doğrular.
 * Varsayılan olarak yalnızca KATALOG kaynaklı, inceleme istemeyen alanlar.
 * Geçmiş cevabı kaynaklı alanlar `includeHistory` açıkça verilmedikçe doğrulanmaz.
 */
export async function approveAutoFilled(
  input: { storeId: string; productMainId: string; actor: string; includeHistory?: boolean },
  deps: { prisma?: PrismaClient } = {},
): Promise<{ verified: number; skipped: number }> {
  const prisma = deps.prisma ?? getPrisma();
  const card = await prisma.productInfo.findFirst({
    where: { storeId: input.storeId, productMainId: input.productMainId, productId: null },
  });
  if (!card) return { verified: 0, skipped: 0 };

  const attributes = parseCardAttributes(card.attributes);
  let verified = 0;
  let skipped = 0;

  const next = attributes.map((item) => {
    if (item.verified === true) return item;
    const source = item.source ?? "MANUAL";
    const isCatalog = source === "CATALOG_ATTRIBUTE" || source === "CATALOG_DESCRIPTION";
    const isHistory = source === "HISTORY_ANSWER";
    if (item.needsReview === true) {
      skipped += 1;
      return item;
    }
    if (!isCatalog && !(isHistory && input.includeHistory === true)) {
      skipped += 1;
      return item;
    }
    verified += 1;
    return { ...item, verified: true, verifiedBy: input.actor, verifiedAt: new Date().toISOString() };
  });

  if (verified > 0) {
    await prisma.productInfo.update({
      where: { id: card.id },
      data: {
        attributes: next as unknown as object,
        status: next.every((item) => item.verified === true) ? "VERIFIED" : "DRAFT",
        verifiedBy: input.actor,
        verifiedAt: new Date(),
      },
    });
  }

  return { verified, skipped };
}

export function summarizePlan(plans: AutoFillPlan[]): {
  products: number;
  filled: number;
  review: number;
  missing: number;
  verifiedKept: number;
} {
  return {
    products: plans.length,
    filled: plans.reduce((sum, plan) => sum + plan.filledCount, 0),
    review: plans.reduce((sum, plan) => sum + plan.reviewCount, 0),
    missing: plans.reduce((sum, plan) => sum + plan.missingCount, 0),
    verifiedKept: plans.reduce((sum, plan) => sum + plan.fields.filter((field) => field.state === "KEPT").length, 0),
  };
}

/** Alan etiketi (UI için). */
export function labelOf(key: string): string {
  return FIELD_DEFS.find((field) => field.key === key)?.label ?? key;
}
