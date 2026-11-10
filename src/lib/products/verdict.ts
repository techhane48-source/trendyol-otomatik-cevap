import type { BankAttribute, FieldKey } from "./bank";
import { fold, isMeaningfulValue } from "./catalog-extract";

/**
 * Aday bilgi güven sınıflandırması (GÖREV 010B).
 *
 * GÜVENİLİR: açık katalog özelliği + doğru ürün eşleşmesi + çelişki yok.
 * İNCELEME: belirsiz, eksik, sayfa sınırında ya da kaynaklar farklı.
 * RED: kategori adı, kod, alakasız veya geçersiz değer.
 *
 * KATALOG/HIGH tek başına doğrulanmış anlamına GELMEZ; yalnızca "güvenilir aday"dır.
 * Geçmiş satıcı cevabı hiçbir zaman güvenilir aday sayılmaz (insan onayı şart).
 */

export type Verdict = "TRUSTED" | "REVIEW" | "REJECT";

export interface VerdictInput {
  fieldKey: FieldKey;
  value: string | null;
  source: BankAttribute["source"] | null;
  confidence: BankAttribute["confidence"] | null;
  alternatives?: string[];
  needsReview?: boolean;
  /** Ürün kimliği (productMainId) katalogla birebir eşleşti mi? */
  identityMatched: boolean;
  /** Katalog sayfalama sınırına takıldı mı? */
  truncated: boolean;
  /** Görülen varyant sayısı (0 ise katalog verisi yok). */
  variantCount: number;
  /** Kategori adı (kategori adı materyal sayılmaz). */
  categoryName?: string | null;
}

export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
}

/** Kumaş alanında kategori/ürün tipi adı gibi değerler geçersizdir. */
function isCategoryLikeValue(fieldKey: FieldKey, value: string, categoryName?: string | null): boolean {
  const folded = fold(value);
  if (!folded) return true;

  if (categoryName) {
    const category = fold(categoryName);
    if (folded === category) return true;
    if (fieldKey === "fabric" && (folded.endsWith("perde") || folded.startsWith("perde") || folded === "tul")) return true;
  }

  if (fieldKey === "fabric" && /^(perde|tul perde|fon perde|kumas|materyal)$/.test(folded)) return true;
  return false;
}

/**
 * Alan için anlamlı değer kontrolü. Özellik adı eşleşse bile değer alanla ilgili değilse
 * ("Ütü / yıkama = Type 1") bilgi sayılmaz.
 */
export function isFieldValueValid(fieldKey: FieldKey, value: string): boolean {
  const folded = fold(value);
  switch (fieldKey) {
    case "fabric":
      return /[a-z]{3,}/.test(folded) && !/^[a-z]{0,3}\d+$/.test(folded);
    case "pleat":
      return /pile|pilesiz|d[üu]z|b[üu]zg|ekstrafor|dalgal|1\s*x\s*[123]|1\s*\/\s*[23]/.test(folded);
    case "blackout":
      return /karart|blackout|seffaf|isik|karanli|perdeleme|gunes/.test(folded);
    case "care":
      return /yika|utu|derece|kuru|temizle|eld|ıslak|nemli/.test(folded);
    case "weightedHem":
      return /kursun|agirlik|etek/.test(folded);
    case "mounting":
      return /montaj|kanca|pim|rulo|kornis|bant|asma|asil/.test(folded);
    case "customSize":
      return /olcu|cm|en|boy|[x×]|\d{2,}/.test(folded);
    case "sewing":
      return /dikim|dikis|pile|buzg|ekstrafor|duz/.test(folded);
    case "colors":
      return /[a-z]{3,}/.test(folded);
    default:
      return true;
  }
}

export function classifyCandidate(input: VerdictInput): VerdictResult {
  const reasons: string[] = [];
  const value = (input.value ?? "").trim();

  if (!value) return { verdict: "REJECT", reasons: ["Değer boş"] };
  if (!isMeaningfulValue(value)) {
    return { verdict: "REJECT", reasons: ["Geçersiz/kod benzeri değer"] };
  }
  if (isCategoryLikeValue(input.fieldKey, value, input.categoryName)) {
    return { verdict: "REJECT", reasons: ["Kategori/ürün tipi adı bilgi değil"] };
  }
  if (!isFieldValueValid(input.fieldKey, value)) {
    return { verdict: "REJECT", reasons: ["Değer bu alanla ilgili değil"] };
  }
  if (!input.identityMatched) {
    return { verdict: "REVIEW", reasons: ["Ürün/varyant kimliği doğrulanamadı"] };
  }
  if (input.variantCount === 0) {
    return { verdict: "REVIEW", reasons: ["Katalogda eşleşen varyant yok"] };
  }
  if (input.alternatives && input.alternatives.length > 0) {
    reasons.push("Varyantlar arasında farklı değer var");
  }
  if (input.truncated) {
    reasons.push("Katalog sayfalama sınırında: tüm varyantlar görülmedi");
  }
  if (input.needsReview) {
    reasons.push("Otomatik çıkarım inceleme istedi");
  }

  const trusted =
    input.source === "CATALOG_ATTRIBUTE" &&
    input.confidence === "HIGH" &&
    !input.truncated &&
    (input.alternatives?.length ?? 0) === 0 &&
    input.needsReview !== true;

  if (trusted) {
    return { verdict: "TRUSTED", reasons: ["Açık katalog özelliği, tüm varyantlarda aynı, çelişki yok"] };
  }

  if (input.source === "HISTORY_ANSWER") {
    reasons.push("Geçmiş satıcı cevabı kesin doğru kabul edilmez");
  }
  if (input.source === "CATALOG_DESCRIPTION") {
    reasons.push("Ürün açıklamasından çıkarıldı: tek tek doğrulanmalı");
  }
  if (input.confidence === "MEDIUM" || input.confidence === "LOW") {
    reasons.push(`Güven: ${input.confidence}`);
  }

  return { verdict: "REVIEW", reasons: reasons.length > 0 ? reasons : ["Belirsiz"] };
}

/** Kart üzerindeki tek bir alanın sınıfı (kayıtlı veriden). */
export function classifyStoredAttribute(
  fieldKey: FieldKey,
  attribute: BankAttribute,
  context: { categoryName?: string | null; truncated?: boolean; variantCount?: number; identityMatched?: boolean },
): VerdictResult {
  return classifyCandidate({
    fieldKey,
    value: attribute.value,
    source: attribute.source ?? "MANUAL",
    confidence: attribute.confidence ?? null,
    alternatives: attribute.alternatives ?? [],
    needsReview: attribute.needsReview ?? false,
    identityMatched: context.identityMatched ?? true,
    truncated: context.truncated ?? false,
    variantCount: context.variantCount ?? 1,
    categoryName: context.categoryName ?? null,
  });
}
