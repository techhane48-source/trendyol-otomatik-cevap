import type { FieldKey } from "@/lib/products/bank";

/**
 * Soru niyeti sınıflandırması (GÖREV 012).
 *
 * Amaç: müşterinin gerçekte ne sorduğunu belirlemek ve yalnızca o niyetle ilgili
 * doğrulanmış kaynakları zorunlu tutmak. Örneğin fiyat sorusunda kumaş türü aramak
 * yanlıştır; ölçü sorusunda renk bilgisi zorunlu değildir.
 */

export type Intent =
  | "CUSTOM_SIZE"
  | "SEWING"
  | "FABRIC"
  | "PRICE"
  | "ORDER_STATUS"
  | "ORDER_CHANGE"
  | "CARE"
  | "MOUNT"
  | "SHIPPING"
  | "OTHER";

export const INTENT_LABELS: Record<Intent, string> = {
  CUSTOM_SIZE: "Özel ölçü / kesim",
  SEWING: "Dikim / pile / aksesuar",
  FABRIC: "Kumaş ve ürün özellikleri",
  PRICE: "Fiyat değişimi / indirim",
  ORDER_STATUS: "Sipariş durumu",
  ORDER_CHANGE: "Sipariş sonrası ölçü değişikliği",
  CARE: "Yıkama / bakım",
  MOUNT: "Montaj",
  SHIPPING: "Kargo / teslimat",
  OTHER: "Diğer",
};

const LETTERS = "A-Za-zÇĞİÖŞÜçğıöşü";

function word(pattern: string): RegExp {
  return new RegExp(`(?<![${LETTERS}])(?:${pattern})(?![${LETTERS}])`, "i");
}

interface IntentRule {
  intent: Intent;
  pattern: RegExp;
  /** Aynı metinde bu kalıp da varsa kural yükseltilir (ör. ölçü + sipariş = değişiklik). */
  boost?: RegExp;
}

/** Sıra önemlidir: ilk eşleşen niyet birincil kabul edilir. */
const RULES: IntentRule[] = [
  {
    intent: "ORDER_CHANGE",
    pattern: word(
      "öl[çc][a-zçğıöşü]*\\s*(de[ğg]i[şs]\\w*|d[üu]zelt|g[üu]ncelle)|de[ğg]i[şs]iklik\\s*(yap|talep)|sipari[şs]\\s*sonras",
    ),
  },
  {
    intent: "PRICE",
    pattern: word(
      "fiyat|fiyatı|fiyatlar|zam|indirim|kampanya|kupon|promosyon|pahalı|pahali|ucuz|tutar|ücret|ucret|kaç\\s*lira|ne\\s*kadar|fark\\s*var",
    ),
  },
  {
    intent: "ORDER_STATUS",
    pattern: word(
      "sipari[şs]\\s*(no|numaras|numaram|durum|nerede|takip)|sipari[şs]im|kargoya\\s*ver|hazırlan|hazirlan|iptal|teslim\\s*edildi",
    ),
  },
  {
    intent: "SHIPPING",
    pattern: word("kargo|kargoya|teslimat|teslim|kaç\\s*g[üu]nde|g[üu]n\\s*i[çc]inde|g[öo]nderim|paket"),
  },
  {
    intent: "CUSTOM_SIZE",
    pattern: word(
      "özel\\s*öl[çc]ü|ozel\\s*olcu|kesim|keser|kesmeniz|kesil|kestir|öl[çc]ü|olcu|santim|santimetre|\\d{2,4}\\s*[x×]\\s*\\d{2,4}|\\d+\\s*metre|metreye|en\\s*\\d+|boy\\s*\\d+",
    ),
  },
  {
    intent: "SEWING",
    pattern: word(
      "dikim|dikiyor|dikiyor\\s*musunuz|diker|dikilecek|pile|pilesiz|pili|b[üu]zg[üu]|ekstrafor|d[üu]ğme|dugme|kurdele|ba[ğg]lama|aksesuar|file|astar",
    ),
  },
  { intent: "CARE", pattern: word("yıka|yika|y[ıi]kama|ütü|utu|leke|temizle|çekme|cekme|solma|makinede") },
  { intent: "MOUNT", pattern: word("montaj|kurulum|takma|takıl|korni[şs]|kanca|çengel|cengel|pim|bant|rulo|ray") },
  {
    intent: "FABRIC",
    pattern: word(
      "kuma[şs]|kumas|t[üu]l|keten|kadife|[şs][öo]nil|bambu|karartma|blackout|[şs]effaf|dokuma|gramaj|desen|polyester|pamuk|viskon|renk|bej|pudra|mint|antrasit|krem|siyah|beyaz|gri",
    ),
  },
];

/** Birden fazla niyet tespiti (birincil + ikincil). */
export function detectIntents(text: string): { primary: Intent; all: Intent[] } {
  const found: Intent[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text) && !found.includes(rule.intent)) found.push(rule.intent);
  }

  // Ölçü/dikim sorusu sipariş numarası içeriyorsa bu bir sipariş sonrası değişikliktir.
  if (found.includes("ORDER_STATUS") && /öl[çc][üu]|\d{2,4}\s*[x×]\s*\d{2,4}/i.test(text) && !found.includes("ORDER_CHANGE")) {
    found.unshift("ORDER_CHANGE");
  }

  const primary = found[0] ?? "OTHER";
  return { primary, all: found.length > 0 ? found : ["OTHER"] };
}

export function classifyIntent(text: string): Intent {
  return detectIntents(text).primary;
}

/** Niyetin gerektirdiği doğrulanmış ürün alanları (yalnızca gerçekten ilgili olanlar). */
export const INTENT_FIELDS: Record<Intent, FieldKey[]> = {
  CUSTOM_SIZE: ["customSize", "description"],
  SEWING: ["sewing", "pleat"],
  FABRIC: ["fabric", "blackout"],
  PRICE: [],
  ORDER_STATUS: [],
  ORDER_CHANGE: ["customSize"],
  CARE: ["care"],
  MOUNT: ["mounting"],
  SHIPPING: [],
  OTHER: [],
};

/** Niyetin gerektirdiği doğrulanmış mağaza politikaları. */
export const INTENT_POLICIES: Record<Intent, string[]> = {
  CUSTOM_SIZE: ["customSize", "sizeRanges"],
  SEWING: ["sewing", "accessories"],
  FABRIC: [],
  PRICE: ["price"],
  ORDER_STATUS: [],
  ORDER_CHANGE: ["orderChange"],
  CARE: [],
  MOUNT: ["accessories"],
  SHIPPING: ["shipping"],
  OTHER: [],
};

/** Ürün bilgisi kartından cevaplanabilecek niyetler. */
export const PRODUCT_INTENTS: Intent[] = ["CUSTOM_SIZE", "SEWING", "FABRIC", "CARE", "MOUNT"];

/** Canlı veri (fiyat, sipariş durumu) gerektirdiği için asla otomatik kesin cevap verilmeyen niyetler. */
export const HUMAN_REVIEW_INTENTS: Intent[] = ["PRICE", "ORDER_STATUS", "ORDER_CHANGE", "SHIPPING"];

export type AnswerStrategy = "DIRECT" | "PARTIAL" | "ASK_DETAIL" | "HUMAN_REVIEW";

export const STRATEGY_LABELS: Record<AnswerStrategy, string> = {
  DIRECT: "Doğrudan cevap",
  PARTIAL: "Kısmi cevap",
  ASK_DETAIL: "Ayrıntı iste",
  HUMAN_REVIEW: "İnsan incelemesi",
};

/**
 * Cevap stratejisini belirler.
 * - Hiç kaynak yok → ASK_DETAIL (müşteriden eksik ayrıntı istenir, insan incelemesi işaretlenir).
 * - Tüm zorunlu alanlar doğrulanmış → DIRECT.
 * - Bir kısmı doğrulanmış → PARTIAL.
 * - Canlı veri gerektiren niyet → en az HUMAN_REVIEW.
 */
export function decideStrategy(input: {
  intent: Intent;
  requiredFields: FieldKey[];
  coveredFields: FieldKey[];
  requiredPolicies: string[];
  coveredPolicies: string[];
}): AnswerStrategy {
  const total = input.requiredFields.length + input.requiredPolicies.length;
  const covered = input.coveredFields.length + input.coveredPolicies.length;

  if (HUMAN_REVIEW_INTENTS.includes(input.intent)) {
    return total > 0 && covered === total ? "PARTIAL" : "HUMAN_REVIEW";
  }

  if (total === 0) return covered > 0 ? "DIRECT" : "ASK_DETAIL";
  if (covered === 0) return "ASK_DETAIL";
  if (covered >= total) return "DIRECT";
  return "PARTIAL";
}
