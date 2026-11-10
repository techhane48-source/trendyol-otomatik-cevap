import type { HistoryMatch } from "./search";

/**
 * Geçmiş cevaplardan gelen güncelliğini yitirmiş bilgileri tespit eder.
 *
 * Kural: geçmiş bir cevap **kanıt değil, referanstır**. Fiyat, stok, teslimat, iade ve
 * sipariş değişikliği bilgileri yalnızca o gün doğruydu; yeni taslakta güncel gerçek gibi
 * kullanılamaz. Doğrulanmış ürün kartı veya canlı sipariş verisi her zaman önceliklidir.
 */

export type StaleKind = "PRICE" | "STOCK" | "DELIVERY" | "RETURN" | "ORDER_CHANGE";

export interface StaleClaim {
  kind: StaleKind;
  phrase: string;
}

const PATTERNS: Array<{ kind: StaleKind; regex: RegExp }> = [
  { kind: "PRICE", regex: /\b\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?\s*(?:tl|₺|lira)\b/gi },
  { kind: "PRICE", regex: /\bfiyat[ıi]?\s*(?:budur|bu şekilde|aynı|değişmedi)\b/gi },
  { kind: "STOCK", regex: /\bstok(?:lar)?(?:da|ta)?\s*(?:var|yok|mevcut|tükendi|kalmadı)\b/gi },
  { kind: "DELIVERY", regex: /\b(?:bugün|yarın|ertesi gün|\d{1,2}\s*gün)\s*(?:içinde)?\s*(?:kargo|teslim|elimizde)\b/gi },
  { kind: "DELIVERY", regex: /\b(?:kargoda|yola çıktı|dağıtımda)\b/gi },
  { kind: "RETURN", regex: /\b(?:14|30)\s*gün\s*(?:içinde)?\s*iade\b/gi },
  { kind: "RETURN", regex: /\biade\s*(?:süresi|koşulu|edebilir|alınır|garantisi)\b/gi },
  { kind: "ORDER_CHANGE", regex: /\bsipari[şs](?:iniz|inizde|inizi)?\s*(?:değiştir|güncelle|iptal|düzelt)/gi },
];

export function detectStaleClaims(text: string): StaleClaim[] {
  const found: StaleClaim[] = [];
  const seen = new Set<string>();

  for (const { kind, regex } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const phrase = match[0].trim();
      const key = `${kind}:${phrase.toLocaleLowerCase("tr")}`;
      if (phrase.length === 0 || seen.has(key)) continue;
      seen.add(key);
      found.push({ kind, phrase });
    }
  }

  return found;
}

const KIND_LABELS: Record<StaleKind, string> = {
  PRICE: "fiyat",
  STOCK: "stok",
  DELIVERY: "teslimat",
  RETURN: "iade",
  ORDER_CHANGE: "sipariş değişikliği",
};

export function staleClaimMessage(claim: StaleClaim): string {
  return `Geçmiş cevaptan gelen güncel olmayabilecek ${KIND_LABELS[claim.kind]} bilgisi: "${claim.phrase}"`;
}

export interface HistoryContextFacts {
  /** Doğrulanmış ürün kartı kullanıldı mı? */
  verifiedCardUsed: boolean;
  /** Canlı sipariş durumu doğrulandı mı? */
  liveOrderVerified: boolean;
}

/**
 * Taslakta geçmiş cevap kullanıldıysa ve güncelliği kanıtlanmamış iddia varsa uyarı üretir.
 * Ürün kartı/sipariş doğrulaması yoksa uyarı "kesin bilgi yok" seviyesine yükselir.
 */
export function evaluateHistoryUsage(
  text: string,
  matches: HistoryMatch[],
  facts: HistoryContextFacts,
): { claims: StaleClaim[]; messages: string[]; blocksApproval: boolean } {
  if (matches.length === 0) return { claims: [], messages: [], blocksApproval: false };

  const claims = detectStaleClaims(text);
  const messages = claims.map(staleClaimMessage);

  // Geçmiş cevap referans alındı ve doğrulanmış kaynak yoksa: kesin cevap üretilmemeli.
  const blocksApproval = claims.length > 0 && !facts.verifiedCardUsed && !facts.liveOrderVerified;

  if (claims.length > 0 && !blocksApproval) {
    messages.push("Geçmiş cevap referans alındı; fiyat/stok/teslimat bilgileri güncel kaynaktan doğrulanmalı.");
  }

  return { claims, messages, blocksApproval };
}
