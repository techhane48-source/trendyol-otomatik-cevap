/**
 * Sipariş durumu karar motoru ve metin ayrıştırma (saf fonksiyonlar).
 *
 * Kurallar:
 * - Yalnızca **Created** durumunda ölçü değişikliği talebi alınabilir.
 * - Picking / Invoiced / Shipped / Delivered → reddedilir (üretim başlamış).
 * - Cancelled / Returned / Awaiting / UnPacked / bilinmeyen → insan incelemesi.
 * - Created olması talebin UYGULANDIĞI anlamına gelmez; yalnızca alınabilir olduğunu gösterir.
 */

export type OrderDecision = "CAN_REQUEST" | "TOO_LATE" | "HUMAN_REVIEW";

const TOO_LATE = new Set(["picking", "invoiced", "shipped", "delivered"]);
const HUMAN_REVIEW = new Set(["cancelled", "canceled", "returned", "awaiting", "unpacked", "unpackedstatus"]);

export function decideOrderStatus(rawStatus: string | null | undefined): {
  decision: OrderDecision;
  normalized: string;
} {
  const normalized = (rawStatus ?? "").trim().toLowerCase();
  if (normalized.length === 0) return { decision: "HUMAN_REVIEW", normalized: "unknown" };
  if (normalized === "created") return { decision: "CAN_REQUEST", normalized };
  if (TOO_LATE.has(normalized)) return { decision: "TOO_LATE", normalized };
  if (HUMAN_REVIEW.has(normalized)) return { decision: "HUMAN_REVIEW", normalized };
  return { decision: "HUMAN_REVIEW", normalized };
}

/**
 * Soru metninden sipariş numarası çıkarır. Tek aday yoksa `value` null olur
 * (birden fazla numara varsa tahmin yapılmaz).
 */
export function extractOrderNumber(text: string): { value: string | null; candidates: string[] } {
  const candidates = new Set<string>();

  // "sipariş no: 123456789", "sipariş numarası 123456789"
  const labelled = text.matchAll(
    /sipari[şs]\s*(?:no|numaras[ıi]|num)?\s*[:#]?\s*(\d{6,12})/gi,
  );
  for (const match of labelled) candidates.add(match[1]);

  // "#123456789" veya çıplak 9-12 haneli sayı (telefon 10/11 hane ile çakışabilir; önek şartı ile ayrılır)
  const hashed = text.matchAll(/(?:^|\s)#(\d{6,12})\b/g);
  for (const match of hashed) candidates.add(match[1]);

  // Etiketsiz 9–12 haneli sayılar da aday sayılır (birden fazla varsa tahmin yapılmaz).
  const bare = text.matchAll(/(?<!\d)(\d{9,12})(?!\d)/g);
  for (const match of bare) candidates.add(match[1]);

  const list = [...candidates];
  return { value: list.length === 1 ? list[0] : null, candidates: list };
}

export interface ParsedDimensions {
  widthCm: number | null;
  heightCm: number | null;
  /** Yön (en/boy) metinden kesin çıkarılamadı */
  orientationUncertain: boolean;
  /** Açıklama (panelde ve denetim kaydında gösterilir) */
  reason: string | null;
}

const NUMBER = "(\\d{1,4}(?:[.,]\\d{1,2})?)";
const UNIT = "\\s*(cm|santim|santimetre|m|metre)?\\s*";

function toCm(value: string, unit: string | undefined): number | null {
  const numeric = Number(value.replace(",", "."));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const normalized = (unit ?? "").toLowerCase();
  if (normalized === "m" || normalized === "metre") return numeric * 100;
  return numeric;
}

/**
 * Ölçüleri ayrıştırır. Yön tahmini YAPILMAZ:
 * - "en"/"genişlik" ve "boy"/"yükseklik" etiketleri yoksa `orientationUncertain = true`.
 * - Ayırıcı `-` veya tek sayı ise ölçü çifti kabul edilmez.
 */
export function parseDimensions(text: string): ParsedDimensions {
  const cleaned = text.replace(/\s+/g, " ");

  const pair = cleaned.match(new RegExp(`${NUMBER}${UNIT}[x×*]\\s*${NUMBER}${UNIT}`, "i"));
  const labelledPair = cleaned.match(
    new RegExp(`en\\s*[:=]?\\s*${NUMBER}${UNIT}.*?boy\\s*[:=]?\\s*${NUMBER}${UNIT}`, "i"),
  );

  const widthLabel = /\b(en|geni[şs]lik)\b/i.test(cleaned);
  const heightLabel = /\b(boy|y[üu]kseklik)\b/i.test(cleaned);

  if (labelledPair) {
    return {
      widthCm: toCm(labelledPair[1], labelledPair[2]),
      heightCm: toCm(labelledPair[3], labelledPair[4]),
      orientationUncertain: false,
      reason: null,
    };
  }

  if (pair) {
    return {
      widthCm: toCm(pair[1], pair[2]),
      heightCm: toCm(pair[3], pair[4]),
      orientationUncertain: !(widthLabel && heightLabel),
      reason: widthLabel && heightLabel ? null : "En/boy etiketi yok; yön insan tarafından doğrulanmalı.",
    };
  }

  return {
    widthCm: null,
    heightCm: null,
    orientationUncertain: true,
    reason: "Ölçü çifti (ör. 100x250) metinden çıkarılamadı.",
  };
}

export interface OrderLineLike {
  id: string;
  lineId: string;
  productId: string | null;
  productMainId: string | null;
  productName: string | null;
}

export interface LineMatchResult {
  line: OrderLineLike | null;
  ambiguous: boolean;
  reason: string;
}

/**
 * Soru ↔ sipariş kalemi eşleştirmesi.
 * Önce kesin varyant (`productId`), sonra ana ürün (`productMainId`) eşleşmesi aranır.
 * Birden fazla olası eşleşme varsa OTOMATİK KABUL EDİLMEZ.
 */
export function matchOrderLine(
  question: { productId: string | null; productMainId: string | null },
  lines: OrderLineLike[],
): LineMatchResult {
  if (lines.length === 0) return { line: null, ambiguous: false, reason: "Sipariş kalemi bulunamadı." };

  const sameVariant = question.productId
    ? lines.filter((line) => line.productId && line.productId === question.productId)
    : [];
  if (sameVariant.length === 1) return { line: sameVariant[0], ambiguous: false, reason: "Varyant kimliği eşleşti." };
  if (sameVariant.length > 1) {
    return { line: null, ambiguous: true, reason: "Aynı varyant kimliğiyle birden fazla kalem var." };
  }

  const sameMain = question.productMainId
    ? lines.filter((line) => line.productMainId && line.productMainId === question.productMainId)
    : [];
  if (sameMain.length === 1) return { line: sameMain[0], ambiguous: false, reason: "Ana ürün kimliği eşleşti." };
  if (sameMain.length > 1) {
    return { line: null, ambiguous: true, reason: "Aynı ana ürün altında birden fazla kalem var." };
  }

  if (lines.length === 1) {
    return {
      line: null,
      ambiguous: false,
      reason: "Sipariş tek kalemli ancak ürün kimliği soruyla eşleşmiyor.",
    };
  }

  return { line: null, ambiguous: true, reason: "Sipariş çok kalemli; soruyla eşleşen kalem bulunamadı." };
}
