/**
 * Taslak güvenlik ağı (guardrail).
 *
 * Prompt tek başına yeterli değildir: model yine de ölçü/garanti gibi somut bir
 * ayrıntı yazabilir. Burada, verilen doğrulanmış bilgide BULUNMAYAN somut iddialar
 * tespit edilir ve taslakla birlikte saklanır. Onaylama, bu uyarılar kabul
 * edilmeden (acknowledgeWarnings) yapılamaz.
 */

export type WarningKind = "MEASUREMENT" | "WARRANTY" | "SHIPPING" | "MATERIAL" | "STOCK";

export interface DraftWarning {
  kind: WarningKind;
  /** Metinde geçen ifade (müşteri verisi değildir; taslak metninden alınır). */
  phrase: string;
}

const PATTERNS: Array<{ kind: WarningKind; regex: RegExp }> = [
  { kind: "MEASUREMENT", regex: /\d+(?:[.,]\d+)?\s?(?:cm|mm|mt|lt|kg|gr|adet|watt|kişi|kisi|m|g|w)\b/gi },
  { kind: "WARRANTY", regex: /\d+\s?(?:yıl|yil|ay|gün|gun)\w*\s?garanti\w*/gi },
  { kind: "WARRANTY", regex: /garanti\w*/gi },
  { kind: "SHIPPING", regex: /\d+\s?(?:iş\s?günü|is\s?gunu|gün|gun|saat)\w*\s?(?:içinde|icinde|kargo)\w*/gi },
  { kind: "SHIPPING", regex: /(?:ücretsiz|ucretsiz)\s?kargo\w*/gi },
  { kind: "MATERIAL", regex: /(?:%?\d{1,3}\s?)?(?:pamuk|polyester|ipek|yün|yun|keten|viskon|kadife|saten)\w*/gi },
  { kind: "STOCK", regex: /stok\w*\s?\d+/gi },
];

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("tr-TR")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Taslak metnindeki, doğrulanmış bilgide karşılığı olmayan somut iddiaları döndürür.
 *
 * @param text Taslak metni
 * @param knownFacts Prompt'a verilen doğrulanmış bilgiler (ürün adı, ek bilgi vb.)
 */
export function detectUnverifiedClaims(text: string, knownFacts: string | null | undefined): DraftWarning[] {
  const haystack = normalize(text);
  const facts = normalize(knownFacts ?? "");
  const found: DraftWarning[] = [];
  const seen = new Set<string>();

  for (const { kind, regex } of PATTERNS) {
    regex.lastIndex = 0;
    for (const match of haystack.matchAll(regex)) {
      const phrase = (match[0] ?? "").replace(/\s+/g, " ").trim();
      if (phrase.length === 0) continue;

      const key = `${kind}:${phrase}`;
      if (seen.has(key)) continue;

      // Bilgi zaten doğrulanmış metinde geçiyorsa uyarı üretilmez.
      if (facts.includes(phrase)) continue;

      seen.add(key);
      found.push({ kind, phrase });
    }
  }

  return found.filter(
    (warning) =>
      !found.some(
        (other) =>
          other !== warning &&
          other.kind === warning.kind &&
          other.phrase.length > warning.phrase.length &&
          other.phrase.includes(warning.phrase),
      ),
  );
}

/** Modelin döndürdüğü metni saklanabilir hale getirir (boşluklar, kod bloğu, tırnaklar). */
export function normalizeDraftText(raw: string): string {
  return raw
    .replace(/^\s*```(?:\w+)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .replace(/^\s*(?:cevap|yanıt|yanit)\s*:\s*/i, "")
    .replace(/^["'“”](.*)["'“”]$/s, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
