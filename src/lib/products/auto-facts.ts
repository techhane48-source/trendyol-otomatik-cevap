import type { PrismaClient } from "@/generated/prisma/client";

import { getPrisma } from "@/lib/prisma";
import { extractFromDescription, fieldKeyForAttributeName, fold, isMeaningfulValue } from "@/lib/products/catalog-extract";
import { isFieldValueValid } from "@/lib/products/verdict";
import { compareValues } from "@/lib/products/value-semantics";
import type { FieldKey } from "@/lib/products/bank";
import { FIELD_DEFS } from "@/lib/products/bank";

/**
 * Risk bazlı otomatik güven motoru (GÖREV 014).
 *
 * A — doğrudan kullanılabilir: ilgili mağaza + ilgili ürün kimliğine bağlı, yapılandırılmış,
 *     tüm varyantlarda tek anlamlı, sayfalama tamamlanmış, çelişkisiz katalog özelliği.
 *     İnsan onayı beklemeden AI taslağında kullanılabilir.
 * B — destekleyici: ürün açıklaması / geçmiş satıcı cevabı. Kesin gerçek gibi gösterilmez,
 *     yalnızca düşük riskli bağlam sağlar.
 * C — insan incelemesi: çelişki, eksik/kısmi varyant verisi, belirsiz eşleşme, sipariş
 *     değişikliği/üretim taahhüdü, iade-fiyat garantisi, kaynaksız kesin iddia.
 *
 * KURAL: güven puanı istatistik değil, aşağıdaki açık kuralların sonucudur ve her karar
 * için insan okunabilir gerekçe üretilir. `KATALOG/HIGH` tek başına A sınıfı yapmaz.
 */

export type TrustClass = "A" | "B" | "C";

export const TRUST_LABELS: Record<TrustClass, string> = {
  A: "Otomatik güvenilir",
  B: "Destekleyici",
  C: "İnceleme gerekli",
};

export interface AutoFact {
  productMainId: string;
  /** Varyant kimliği: tüm varyantlarda ortak bilgi ise "ALL", değilse barkod listesi. */
  variantIdentity: string;
  fieldKey: FieldKey;
  label: string;
  value: string;
  source: "CATALOG_ATTRIBUTE" | "CATALOG_DESCRIPTION";
  /** Kaynağın son güncellenme zamanı (katalog çekimi). */
  updatedAt: string | null;
  trustClass: TrustClass;
  /** "Bu bilgi neden güvenilir?" sorusunun cevabı. */
  reasons: string[];
  /** Aynı alanda görülen farklı değerler (varsa). */
  alternatives: string[];
  /** Çelişkili kaynak var mı? */
  conflict: boolean;
}

export interface StoredCatalogProduct {
  productMainId: string;
  categoryName?: string | null;
  description?: string | null;
  attributes: unknown;
  truncated?: boolean;
  variantCount?: number;
  fetchedAt?: Date | string | null;
}

interface AttributeEntry {
  name: string;
  value: string;
  barcode?: string;
}

function readAttributes(attributes: unknown): AttributeEntry[] {
  if (!Array.isArray(attributes)) return [];
  const entries: AttributeEntry[] = [];
  for (const item of attributes) {
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; value?: unknown; barcode?: unknown; attributeName?: unknown; attributeValue?: unknown };
    const name = typeof record.name === "string" ? record.name : typeof record.attributeName === "string" ? record.attributeName : null;
    const value = typeof record.value === "string" ? record.value : typeof record.attributeValue === "string" ? record.attributeValue : null;
    if (!name || !value) continue;
    entries.push({ name, value, barcode: typeof record.barcode === "string" ? record.barcode : undefined });
  }
  return entries;
}

function labelOf(fieldKey: FieldKey): string {
  return FIELD_DEFS.find((field) => field.key === fieldKey)?.label ?? fieldKey;
}

const MATERIAL_TOKENS = ["keten", "pamuk", "polyester", "viskon", "saten", "sonil", "bambu", "kadife", "yun", "ipek", "akrilik"];

/**
 * Kumaş alanında gerçek çelişki: iki metin farklı materyal adı veriyorsa.
 * "Keten" ile "%100 Keten dokuma" çelişmez; "Keten" ile "Polyester" çelişir.
 */
function fabricConflict(left: string, right: string): boolean {
  const leftTokens = MATERIAL_TOKENS.filter((token) => fold(left).includes(token));
  const rightTokens = MATERIAL_TOKENS.filter((token) => fold(right).includes(token));
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  return !leftTokens.some((token) => rightTokens.includes(token));
}

function isCategoryLike(fieldKey: FieldKey, value: string, categoryName?: string | null): boolean {
  const folded = fold(value);
  if (!folded) return true;
  if (categoryName) {
    const category = fold(categoryName);
    if (folded === category) return true;
  }
  if (fieldKey === "fabric" && /^(perde|tul perde|fon perde|kumas|materyal)$/.test(folded)) return true;
  return false;
}

/**
 * Kayıtlı katalog ürününden A/B/C sınıflandırılmış bilgi listesi üretir.
 * Fonksiyon saftır: katalog verisi değişince sınıflar yeniden hesaplanır.
 */
export function buildAutoFacts(product: StoredCatalogProduct): AutoFact[] {
  const attributes = readAttributes(product.attributes);
  const updatedAt = product.fetchedAt
    ? new Date(product.fetchedAt).toISOString()
    : null;
  const categoryName = product.categoryName ?? null;
  const truncated = product.truncated === true;

  // Alan bazında değer dağılımı (varyant bazlı tekrar sayılmaz).
  const byField = new Map<FieldKey, { name: string; values: Map<string, Set<string>>; total: number }>();

  for (const attribute of attributes) {
    const fieldKey = fieldKeyForAttributeName(attribute.name);
    if (!fieldKey) continue;

    const stat = byField.get(fieldKey) ?? { name: attribute.name, values: new Map<string, Set<string>>(), total: 0 };
    const variantKey = attribute.barcode ?? `row-${stat.total}`;
    const bucket = stat.values.get(attribute.value) ?? new Set<string>();
    if (bucket.has(variantKey)) continue;
    bucket.add(variantKey);
    stat.values.set(attribute.value, bucket);
    stat.total += 1;
    byField.set(fieldKey, stat);
  }

  const facts: AutoFact[] = [];
  const descriptionCandidates = extractFromDescription(product.description ?? null);

  for (const [fieldKey, stat] of byField) {
    const entries = [...stat.values.entries()].sort((a, b) => b[1].size - a[1].size);
    const meaningful = entries.filter(([value]) => isMeaningfulValue(value) && !isCategoryLike(fieldKey, value, categoryName));
    if (meaningful.length === 0) continue;

    const [topValue, topVariants] = meaningful[0];
    const alternatives = meaningful.slice(1).map(([value]) => value);
    const totalVariants = stat.total;
    const share = totalVariants > 0 ? topVariants.size / totalVariants : 0;
    const reasons: string[] = [];

    if (!isFieldValueValid(fieldKey, topValue)) continue;

    let trustClass: TrustClass = "A";
    let conflict = false;

    if (alternatives.length > 0) {
      trustClass = "C";
      conflict = true;
      reasons.push(`Varyantlar arasında farklı değerler var: ${[topValue, ...alternatives.slice(0, 3)].join(" / ")}`);
    } else {
      reasons.push(`Tüm ${topVariants.size} varyantta aynı değer (${stat.name} = ${topValue})`);
      reasons.push("Yapılandırılmış katalog özelliği");
    }

    if (Math.round(share * 100) < 100 && alternatives.length > 0) {
      reasons.push(`Varyantların %${Math.round(share * 100)}'inde bu değer`);
    }

    if (truncated) {
      trustClass = "C";
      reasons.push("Katalog sayfalama sınırında: tüm varyantlar görülmedi");
    }

    // Açıklamada aynı alan için farklı bir ifade olabilir; yalnızca GERÇEKTEN çelişen
    // değerler insan incelemesine düşer ("%100 Keten" ile "Keten" çelişmez).
    const descriptionMatch = descriptionCandidates.find((candidate) => candidate.fieldKey === fieldKey);
    if (descriptionMatch && fold(descriptionMatch.value) !== fold(topValue)) {
      const relation =
        fieldKey === "fabric" && fabricConflict(topValue, descriptionMatch.value) ? "CONFLICT" : compareValues(fieldKey, topValue, descriptionMatch.value);
      if (relation === "CONFLICT") {
        trustClass = "C";
        conflict = true;
        reasons.push(`Ürün açıklaması çelişen değer içeriyor: “${descriptionMatch.value}”`);
      } else {
        reasons.push(`Ürün açıklaması uyumlu: “${descriptionMatch.value}”`);
      }
    }

    facts.push({
      productMainId: product.productMainId,
      variantIdentity: alternatives.length === 0 ? "ALL" : [...topVariants].join(","),
      fieldKey,
      label: labelOf(fieldKey),
      value: topValue,
      source: "CATALOG_ATTRIBUTE",
      updatedAt,
      trustClass,
      reasons,
      alternatives,
      conflict,
    });
  }

  // Açıklamadan gelen ve özellikte karşılığı olmayan bilgiler: destekleyici (B).
  const coveredFields = new Set(facts.map((fact) => fact.fieldKey));
  for (const candidate of descriptionCandidates) {
    if (coveredFields.has(candidate.fieldKey)) continue;
    if (!isFieldValueValid(candidate.fieldKey, candidate.value)) continue;

    facts.push({
      productMainId: product.productMainId,
      variantIdentity: "ALL",
      fieldKey: candidate.fieldKey,
      label: labelOf(candidate.fieldKey),
      value: candidate.value,
      source: "CATALOG_DESCRIPTION",
      updatedAt,
      trustClass: "B",
      reasons: [
        "Ürün açıklamasından çıkarıldı (yapılandırılmış özellik değil)",
        `Kanıt: ${candidate.evidence}`,
      ],
      alternatives: [],
      conflict: false,
    });
  }

  return facts;
}

/** Soruya bağlı ürünün kayıtlı katalog verisinden otomatik güven kararları. */
export async function getAutoFactsForQuestion(
  input: { storeId: string; productMainId: string | null },
  deps: { prisma?: PrismaClient } = {},
): Promise<AutoFact[]> {
  if (!input.productMainId) return [];
  const prisma = deps.prisma ?? getPrisma();

  const product = await prisma.catalogProduct.findUnique({
    where: { storeId_productMainId: { storeId: input.storeId, productMainId: input.productMainId } },
    select: {
      productMainId: true,
      categoryName: true,
      description: true,
      attributes: true,
      truncated: true,
      variantCount: true,
      fetchedAt: true,
    },
  });

  if (!product) return [];
  return buildAutoFacts(product);
}

/** Yalnızca A sınıfı bilgiler AI taslağında kesin kaynak olarak kullanılabilir. */
export function usableAutoFacts(facts: AutoFact[]): AutoFact[] {
  return facts.filter((fact) => fact.trustClass === "A");
}
