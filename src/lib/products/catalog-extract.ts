import type { CatalogAttributeDto, CatalogProductDto } from "@/lib/trendyol/catalog-client";
import type { FieldKey } from "./bank";

/**
 * Katalogdan alan çıkarımı (GÖREV 010).
 *
 * İlkeler:
 * - Yalnızca **açık** ifadeler bilgiye dönüşür; pazarlama cümleleri ("idealdir", "şık durur")
 *   alan değeri olmaz.
 * - Özellik (attribute) değeri tüm varyantlarda aynıysa HIGH, çoğunluktaysa MEDIUM,
 *   farklı değerler varsa LOW + insan incelemesi.
 * - Buradan çıkan hiçbir değer doğrulanmış (VERIFIED) değildir; taslak adayıdır.
 */

export type EvidenceSource = "CATALOG_ATTRIBUTE" | "CATALOG_DESCRIPTION";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface CatalogCandidate {
  fieldKey: FieldKey;
  value: string;
  source: EvidenceSource;
  confidence: Confidence;
  /** Kanıt: "Özellik: Pile = Pilesiz (1 x 1)" veya açıklamadan alıntı. */
  evidence: string;
  /** Aynı alanda görülen farklı değerler (varsa insan incelemeli). */
  alternatives: string[];
  needsReview: boolean;
}

/** Alan → katalog özellik adları (Türkçe alan adları; eşleşme normalize edilir). */
const ATTRIBUTE_NAMES: Record<FieldKey, string[]> = {
  fabric: ["materyal", "kumas tipi", "kumas turu", "kumas", "materyal bileseni", "kumas icerigi"],
  pleat: ["pile", "pile orani", "pile sikligi", "pilesi"],
  sewing: ["dikim", "dikim sekli", "dikim turu"],
  blackout: ["karartma", "karartma seviyesi", "isik gecirgenligi", "blackout", "gunes isigi gecirgenligi"],
  weightedHem: ["kursun", "kursunlu etek", "etek", "agirlik", "etek agirligi"],
  care: ["yikama", "yikama talimati", "yikama onerisi", "utu", "bakim", "bakim onerisi"],
  mounting: ["montaj", "montaj sekli", "asma", "asma sekli", "kanca", "pile bandi", "asilma"],
  customSize: ["ozel olcu", "olcu", "olculer", "olcu bilgisi"],
  colors: ["renk"],
  description: [],
};

/** Türkçe karakterleri sadeleştirip küçük harfe çevirir (özellik adı eşleşmesi için). */
export function fold(value: string): string {
  return value
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Anlamsız özellik değerlerini eler: "T100" gibi kodlar, tek sayı, çok kısa jetonlar.
 * Anlamlı tek kelimeler (Pilesiz, Keten, Beyaz) korunur.
 */
export function isMeaningfulValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  if (/^\d+$/.test(trimmed)) return false;
  // Harf + rakam karışık kısa kodlar (T100, 30C) bilgi değildir.
  if (/^[A-Za-zÇĞİÖŞÜçğıöşü]{0,3}\d{2,}[A-Za-z0-9]*$/.test(trimmed)) return false;
  if (/^[A-Z0-9_-]{1,6}$/.test(trimmed) && /\d/.test(trimmed)) return false;
  return true;
}

/** Açıklamadan gelen değeri tek cümlelik, okunur bir ifadeye indirger. */
export function tidyDescriptionValue(value: string, maxLength = 90): string {
  let result = value.replace(/\s+/g, " ").trim();

  // Bağlaç ve açıklama kalıplarında kes: pazarlama kuyruğu alan değerine girmez.
  for (const marker of [", ", "; ", " sayesinde", " olarak ", " ve ", " ile "]) {
    const index = result.indexOf(marker);
    if (index > 0) result = result.slice(0, index).trim();
  }

  if (result.length <= maxLength) return result;
  const slice = result.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > 30 ? slice.slice(0, lastSpace) : slice).trim()}…`;
}

interface AttributeStat {
  fieldKey: FieldKey;
  name: string;
  values: Map<string, number>;
  total: number;
}

/** Varyantların özelliklerini alan bazında toplar. */
export function collectAttributeStats(items: CatalogProductDto[]): AttributeStat[] {
  const byField = new Map<string, AttributeStat>();

  for (const item of items) {
    const seenInItem = new Set<string>();
    for (const attribute of item.attributes) {
      const fieldKey = (Object.keys(ATTRIBUTE_NAMES) as FieldKey[]).find((key) =>
        ATTRIBUTE_NAMES[key].some((name) => fold(attribute.attributeName) === name || fold(attribute.attributeName).includes(name)),
      );
      if (!fieldKey) continue;

      const key = `${fieldKey}::${fold(attribute.attributeName)}`;
      const stat = byField.get(key) ?? { fieldKey, name: attribute.attributeName, values: new Map(), total: 0 };
      const seenKey = `${key}::${attribute.attributeValue}`;
      if (seenInItem.has(seenKey)) continue;
      seenInItem.add(seenKey);
      stat.values.set(attribute.attributeValue, (stat.values.get(attribute.attributeValue) ?? 0) + 1);
      stat.total += 1;
      byField.set(key, stat);
    }
  }

  return [...byField.values()].filter((stat) => stat.total > 0);
}

const DESCRIPTION_RULES: Array<{ fieldKey: FieldKey; pattern: RegExp; confidence: Confidence }> = [
  // Kumaş
  { fieldKey: "fabric", pattern: /%\s*\d{2,3}\s*(?:keten|pamuk|polyester|viskon|ipek|saten|şönil|bambu)[^.;]{0,40}/i, confidence: "HIGH" },
  { fieldKey: "fabric", pattern: /(keten|pamuklu|polyester|viskon|bambu|şönil|saten|tül|file)\s*(?:dokulu|dokuma|kumaş|karışım)[^.;]{0,30}/i, confidence: "MEDIUM" },
  // Pile
  { fieldKey: "pleat", pattern: /(pilesiz|düz dikim|1\s*\/\s*[23]\s*pile|2\s*\/\s*3\s*pile|sık pile|seyrek pile|büzgülü)[^.;]{0,40}/i, confidence: "HIGH" },
  // Karartma
  { fieldKey: "blackout", pattern: /(tam karartma|yar[ıi]m karartma|karartma sa[ğg]lar|blackout|şeffaf|yar[ıi] şeffaf|ışık ge[çc]irmez)[^.;]{0,40}/i, confidence: "HIGH" },
  // Dikim
  { fieldKey: "sewing", pattern: /(düz dikim|pilesiz dikim|pileli dikim|büzgülü dikim|ekstrafor(?:lu)?|kurşunlu etek)[^.;]{0,40}/i, confidence: "MEDIUM" },
  // Kurşun / etek
  { fieldKey: "weightedHem", pattern: /(kurşun(?:lu)? etek|etek(?:te)? kurşun|ağırlık(?:lı)? etek)[^.;]{0,30}/i, confidence: "HIGH" },
  { fieldKey: "weightedHem", pattern: /kurşun(?:suz)[^.;]{0,30}/i, confidence: "MEDIUM" },
  // Yıkama / ütü
  { fieldKey: "care", pattern: /(makinede y[ıi]kan[^.;]{0,40}|elde y[ıi]kan[^.;]{0,30}|ütü (?:istemez|gerektirmez|yapılmamalı)[^.;]{0,30}|düşük ısıda ütü[^.;]{0,30})/i, confidence: "HIGH" },
  // Montaj
  { fieldKey: "mounting", pattern: /(kanca|pimli|pile band[ıi]|rulo|korniş|montaj[^.;]{0,25})[^.;]{0,30}/i, confidence: "MEDIUM" },
  // Özel ölçü
  { fieldKey: "customSize", pattern: /(özel ölçü[^.;]{0,40}|istenilen ölçü[^.;]{0,30}|en\s*[x×]\s*boy[^.;]{0,30})/i, confidence: "MEDIUM" },
  // Renkler
  { fieldKey: "colors", pattern: /(pudra|bej|antrasit|gri|mint|yeşil|mavi|krem|ekru|beyaz|siyah|kahverengi|somon|vizon)\s*rengi[^.;]{0,20}/i, confidence: "MEDIUM" },
];

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 25);
  const end = Math.min(text.length, index + length + 25);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Ürün açıklamasından alan adayları. Pazarlama cümleleri elenir. */
export function extractFromDescription(description: string | null | undefined): CatalogCandidate[] {
  if (!description) return [];
  const text = description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return [];

  const candidates: CatalogCandidate[] = [];
  const usedFields = new Set<FieldKey>();

  for (const rule of DESCRIPTION_RULES) {
    if (usedFields.has(rule.fieldKey)) continue;
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const value = tidyDescriptionValue(match[0].trim().replace(/[.,;]$/, ""));
    // Çok kısa veya yalnızca sıfat olan eşleşmeler bilgi sayılmaz.
    if (value.replace(/\s+/g, "").length < 6) continue;
    usedFields.add(rule.fieldKey);
    candidates.push({
      fieldKey: rule.fieldKey,
      value,
      source: "CATALOG_DESCRIPTION",
      confidence: rule.confidence,
      evidence: `Açıklama: “${snippet(text, match.index, match[0].length)}”`,
      alternatives: [],
      needsReview: rule.confidence !== "HIGH",
    });
  }

  return candidates;
}

/**
 * Katalog ürünlerinden alan adayları üretir.
 * `items` aynı `productMainId` altındaki varyantlardır.
 */
export function extractFromCatalog(input: {
  items: CatalogProductDto[];
  description?: string | null;
  truncated?: boolean;
}): CatalogCandidate[] {
  const candidates: CatalogCandidate[] = [];
  const stats = collectAttributeStats(input.items);

  for (const stat of stats) {
    const entries = [...stat.values.entries()].sort((a, b) => b[1] - a[1]);
    const top = entries.find(([value]) => isMeaningfulValue(value));
    if (!top) continue;
    const [topValue, topCount] = top;

    const meaningful = entries.filter(([value]) => isMeaningfulValue(value));
    const meaningfulTotal = meaningful.reduce((sum, [, count]) => sum + count, 0);
    const share = meaningfulTotal > 0 ? topCount / meaningfulTotal : 0;
    const alternatives = meaningful.filter(([value]) => value !== topValue).map(([value]) => value);
    const confidence: Confidence = alternatives.length === 0 ? "HIGH" : share >= 0.9 ? "MEDIUM" : "LOW";

    candidates.push({
      fieldKey: stat.fieldKey,
      value: topValue,
      source: "CATALOG_ATTRIBUTE",
      confidence: alternatives.length === 0 && !input.truncated ? "HIGH" : confidence,
      evidence: `Özellik: ${stat.name} = ${topValue} (${topCount}/${stat.total} varyant)`,
      alternatives,
      needsReview: alternatives.length > 0 || Boolean(input.truncated),
    });
  }

  // Özellikte bulunmayan alanları açıklamadan tamamla.
  const covered = new Set(candidates.map((candidate) => candidate.fieldKey));
  for (const candidate of extractFromDescription(input.description ?? input.items[0]?.description ?? null)) {
    if (covered.has(candidate.fieldKey)) continue;
    // Katalogda farklı bir değer varsa çelişki olarak işaretlenir.
    const attributeCandidate = candidates.find((item) => item.fieldKey === candidate.fieldKey);
    if (attributeCandidate) {
      attributeCandidate.alternatives.push(candidate.value);
      attributeCandidate.needsReview = true;
      continue;
    }
    candidates.push(candidate);
  }

  return candidates;
}

/** Özellik adlarını teşhis için listeler. */
export function listAttributeNames(items: CatalogProductDto[]): string[] {
  const names = new Set<string>();
  for (const item of items) for (const attribute of item.attributes) names.add(attribute.attributeName);
  return [...names].sort((a, b) => a.localeCompare(b, "tr"));
}

/** Katalog özelliklerini özetler: aynı ad+değer tek satır, kaç varyantta görüldüğü ile. */
export function summarizeAttributes(items: CatalogProductDto[], limit = 40): Array<{ name: string; value: string; count: number }> {
  const map = new Map<string, { name: string; value: string; count: number }>();
  for (const item of items) {
    const seen = new Set<string>();
    for (const attribute of item.attributes as CatalogAttributeDto[]) {
      const key = `${attribute.attributeName}::${attribute.attributeValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = map.get(key) ?? { name: attribute.attributeName, value: attribute.attributeValue, count: 0 };
      row.count += 1;
      map.set(key, row);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "tr")).slice(0, limit);
}
