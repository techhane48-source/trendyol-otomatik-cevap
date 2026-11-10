import type { FieldKey } from "./bank";

/**
 * Alan değerlerinin anlam sınıflandırması.
 *
 * Amaç: "farklı cümle" ile "çelişen bilgi"yi ayırmak.
 * - "Özel ölçü yapamıyoruz" ile "Ölçülerimiz EN × BOY şeklindedir" ÇELİŞMEZ (biri yetenek,
 *   diğeri ölçü yönü bilgisi).
 * - "1/3 pile" ile "pilesiz" ÇELİŞİR (aynı ürün, aynı özellik, dışlayan değerler).
 * - Sınıflandırılamayan durumlar çelişki sayılmaz; insan incelemesine bırakılır (`REVIEW`).
 */

export type ConflictVerdict = "CONFLICT" | "REVIEW" | "COMPATIBLE";

interface TokenRule {
  token: string;
  pattern: RegExp;
}

/** Yalnızca bu alanlarda birbirini dışlayan değerler olabilir. */
const EXCLUSIVE_FIELDS: FieldKey[] = ["pleat", "blackout", "weightedHem", "customSize", "care", "sewing"];

/** Nominal alanlar: farklı değerler yan yana yaşayabilir (farklı renk/kumaş tanımı). */
const NOMINAL_FIELDS: FieldKey[] = ["fabric", "colors", "description", "mounting"];

/** Çelişki taşımayan bilgi cümleleri (ör. ölçü yönü açıklaması). */
const INFO_TOKENS: Record<string, TokenRule[]> = {
  customSize: [
    { token: "ORIENTATION", pattern: /en\s*[×x*]\s*boy|ölçülerimiz|[öo]l[çc][üu]lerimiz|en\s*ve\s*boy/i },
  ],
  pleat: [{ token: "DALGALI", pattern: /dalgal[ıi]|dolgun/i }],
};

const TOKENS: Record<string, TokenRule[]> = {
  pleat: [
    { token: "PILESIZ", pattern: /pilesiz|pile\s*yok|pilesi\s*yok|d[üu]z\s*dikim/i },
    { token: "PILE_1_2", pattern: /1\s*\/\s*2|yar[ıi]m\s*pile|iki\s*kat/i },
    { token: "PILE_1_3", pattern: /1\s*\/\s*3|[üu][çc]te\s*bir/i },
    { token: "PILE_2_3", pattern: /2\s*\/\s*3/i },
    { token: "PILE_SIK", pattern: /s[ıi]k\s*pile|s[ıi]k[ıi]\s*pile/i },
    { token: "BUZGULU", pattern: /b[üu]zg[üu]|buzg[üu]|ekstrafor/i },
  ],
  blackout: [
    { token: "BLACKOUT", pattern: /blackout|tam\s*karartma|karartma\s*sa[ğg]la|karanl[ıi]k\s*sa[ğg]la/i },
    { token: "NOT_BLACKOUT", pattern: /blackout\s*de[ğg]il|karartma\s*(yok|sa[ğg]lamaz)|g[öo]stermez|[şs]effaf/i },
  ],
  weightedHem: [
    { token: "VAR", pattern: /kur[şs]un|a[ğg][ıi]rl[ıi]k\s*(var|dikil)/i },
    { token: "YOK", pattern: /kur[şs]un\s*(yok|kullanm)|a[ğg][ıi]rl[ıi]k\s*yok/i },
  ],
  customSize: [
    { token: "YAPILIR", pattern: /(yap[ıi]yoruz|yap[ıi]l[ıi]yor|yapabiliriz|[öo]zel\s*[öo]l[çc][üu]\s*(var|al[ıi]n[ıi]yor))/i },
    {
      token: "YAPILMAZ",
      pattern: /(yapam[ıi]yor|yapamay[ıi]z|yap[ıi]lm[ıi]yor|m[üu]mk[üu]n\s*de[ğg]il|sistem\s*izin\s*vermiyor|mevcut\s*de[ğg]il)/i,
    },
  ],
  care: [
    { token: "MAKINE", pattern: /makine|makina/i },
    { token: "ELDE", pattern: /elde\s*y[ıi]ka/i },
    { token: "UTU_YOK", pattern: /[üu]t[üu]\s*(istemez|gerektirmez)/i },
    { token: "UTU_VAR", pattern: /[üu]t[üu]\s*(ister|gerek)/i },
  ],
  sewing: [
    { token: "DUZ", pattern: /d[üu]z\s*dikim/i },
    { token: "PILELI", pattern: /pileli/i },
    { token: "BUZGULU", pattern: /b[üu]zg[üu]l[üu]|ekstrafor/i },
  ],
};

/** Metinden alanın kanonik değerini (varsa) çıkarır. */
export function canonicalToken(fieldKey: string, value: string): string | null {
  const rules = TOKENS[fieldKey] ?? [];
  for (const rule of rules) {
    if (rule.pattern.test(value)) return rule.token;
  }
  return null;
}

function mentionsField(fieldKey: string, value: string): boolean {
  const rules = TOKENS[fieldKey] ?? [];
  if (rules.length === 0) return false;
  return rules.some((rule) => rule.pattern.test(value));
}

/**
 * İki değer çelişiyor mu?
 * - Aynı kanonik değer → COMPATIBLE
 * - Nominal alanlar → COMPATIBLE (farklı tanımlar yan yana yaşar)
 * - İki farklı kesin değer → dışlayan alanda CONFLICT, diğerlerinde REVIEW
 * - Biri kesin, diğeri o alandan söz etmiyor → COMPATIBLE
 * - Biri kesin, diğeri alandan söz ediyor ama sınıflandırılamıyor → REVIEW
 */
export function compareValues(fieldKey: string, left: string, right: string): ConflictVerdict {
  if (left.trim() === right.trim()) return "COMPATIBLE";
  if (NOMINAL_FIELDS.includes(fieldKey as FieldKey)) return "COMPATIBLE";

  const a = canonicalToken(fieldKey, left);
  const b = canonicalToken(fieldKey, right);

  // Bilgi cümlesi (ör. "Ölçülerimiz EN × BOY şeklindedir") çelişki üretmez.
  const info = INFO_TOKENS[fieldKey] ?? [];
  if (info.some((rule) => rule.pattern.test(left) || rule.pattern.test(right))) return "COMPATIBLE";

  if (a === b) return "COMPATIBLE";
  if (a && b) {
    return EXCLUSIVE_FIELDS.includes(fieldKey as FieldKey) ? "CONFLICT" : "REVIEW";
  }
  if (a || b) {
    const other = a ? right : left;
    if (mentionsField(fieldKey, other)) return "REVIEW";
    // Aynı alanda biri kesin değer veriyor, diğeri tamamen farklı bir cümle söylüyorsa
    // bunu "çelişki" değil "belirsiz" say: insan incelesin.
    return EXCLUSIVE_FIELDS.includes(fieldKey as FieldKey) ? "REVIEW" : "COMPATIBLE";
  }
  return "COMPATIBLE";
}

export interface GroupVerdict {
  conflict: boolean;
  needsReview: boolean;
  conflictValues: string[];
}

/**
 * Bir alanın tüm aday değerlerini karşılaştırır.
 * `conflict`: en az bir kesin çelişki var. `needsReview`: çelişki yok ama belirsizlik var.
 */
export function evaluateGroup(fieldKey: string, values: string[]): GroupVerdict {
  const distinct = [...new Set(values.map((value) => value.trim()))].filter(Boolean);
  const conflicts = new Set<string>();
  let needsReview = false;

  for (let i = 0; i < distinct.length; i += 1) {
    for (let j = i + 1; j < distinct.length; j += 1) {
      const verdict = compareValues(fieldKey, distinct[i], distinct[j]);
      if (verdict === "CONFLICT") {
        conflicts.add(distinct[i]);
        conflicts.add(distinct[j]);
      } else if (verdict === "REVIEW") {
        needsReview = true;
      }
    }
  }

  return { conflict: conflicts.size > 0, needsReview, conflictValues: [...conflicts].slice(0, 3) };
}
