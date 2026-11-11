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

/**
 * Türkçe güvenli kelime sınırı. JS'de `\b` ve `\w` ş/ğ/ı/ü harflerini kapsamaz,
 * bu yüzden harf sınıfı elle tanımlanır.
 */
function word(pattern: string): RegExp {
  return new RegExp(`(?<![${LETTERS}])(?:${pattern})(?![${LETTERS}])`, "i");
}

const NUM = "\\d{2,4}";
const SEP = "\\s*[x×/]\\s*";

interface IntentRule {
  intent: Intent;
  pattern: RegExp;
}

/** Sıra önemlidir: ilk eşleşen niyet birincil kabul edilir. */
const RULES: IntentRule[] = [
  {
    intent: "ORDER_CHANGE",
    pattern: word(
      "[öo]l[çc][a-zçğıöşü]*(\\s*de[ğg]i[şs][a-zçğıöşü]*|\\s*d[üu]zelt[a-zçğıöşü]*|\\s*g[üu]ncell[a-zçğıöşü]*)" +
        "|de[ğg]i[şs]iklik\\s*(yap|talep)[a-zçğıöşü]*" +
        "|sipari[şs]\\s*sonras[a-zçğıöşü]*",
    ),
  },
  {
    intent: "PRICE",
    pattern: word(
      "fiyat[a-zçğıöşü]*|zam[a-zçğıöşü]*|indirim[a-zçğıöşü]*|kampanya[a-zçğıöşü]*|kupon[a-zçğıöşü]*" +
        "|promosyon[a-zçğıöşü]*|pahal[ıi][a-zçğıöşü]*|ucuz[a-zçğıöşü]*|tutar[a-zçğıöşü]*|[üu]cret[a-zçğıöşü]*" +
        "|ka[çc]\\s*lira|ne\\s*kadar|fark\\s*var",
    ),
  },
  {
    intent: "SHIPPING",
    pattern: word(
      "kargo[a-zçğıöşü]*|teslimat[a-zçğıöşü]*|teslim[a-zçğıöşü]*|ka[çc]\s*g[üu]nde" +
        "|g[üu]n\s*i[çc]inde|g[öo]nderim[a-zçğıöşü]*|paket[a-zçğıöşü]*",
    ),
  },
  {
    intent: "ORDER_STATUS",
    pattern: word(
      "sipari[şs][a-zçğıöşü]*(\\s*numara[a-zçğıöşü]*)?|numara[a-zçğıöşü]*\\s*sipari[şs][a-zçğıöşü]*" +
        "|sipari[şs]im|kargoya\\s*ver[a-zçğıöşü]*|haz[ıi]rlan[a-zçğıöşü]*|iptal[a-zçğıöşü]*" +
        "|teslim\\s*edil[a-zçğıöşü]*|iade[a-zçğıöşü]*|para[a-zçğıöşü]*\\s*geri|geri\\s*[öo]deme[a-zçğıöşü]*|gelmedi",
    ),
  },
  
  {
    intent: "CUSTOM_SIZE",
    pattern: word(
      "[öo]zel\\s*[öo]l[çc][a-zçğıöşü]*|kesim[a-zçğıöşü]*|keser[a-zçğıöşü]*|kesmeniz|kesil[a-zçğıöşü]*" +
        "|kestir[a-zçğıöşü]*|[öo]l[çc][a-zçğıöşü]*|santim[a-zçğıöşü]*|santimetre[a-zçğıöşü]*|metre[a-zçğıöşü]*" +
        `|${NUM}${SEP}${NUM}|${NUM}\\s*(en|boy)|${NUM}\\s*ye\\s*${NUM}|hangisini\\s*se[çc]` +
        "|(bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz|on|yarım|bucuk|buçuk)\\s*metre[a-zçğıöşü]*",
    ),
  },
  {
    intent: "SEWING",
    pattern: word(
      "dikim[a-zçğıöşü]*|dikiyor[a-zçğıöşü]*|diker[a-zçğıöşü]*|dikilecek|dikilir|pile[a-zçğıöşü]*" +
        "|b[üu]zg[üu][a-zçğıöşü]*|ekstrafor[a-zçğıöşü]*|d[üu]ğme[a-zçğıöşü]*|kurdele[a-zçğıöşü]*" +
        "|ba[ğg]lama[a-zçğıöşü]*|aksesuar[a-zçğıöşü]*|file[a-zçğıöşü]*|astar[a-zçğıöşü]*",
    ),
  },
  {
    intent: "CARE",
    pattern: word("y[ıi]ka[a-zçğıöşü]*|[üu]t[üu][a-zçğıöşü]*|leke[a-zçğıöşü]*|temizle[a-zçğıöşü]*|makinede"),
  },
  {
    intent: "MOUNT",
    pattern: word(
      "montaj[a-zçğıöşü]*|kurulum[a-zçğıöşü]*|takma[a-zçğıöşü]*|tak[ıi]l[a-zçğıöşü]*|korni[şs][a-zçğıöşü]*" +
        "|kanca[a-zçğıöşü]*|[çc]engel[a-zçğıöşü]*|pim[a-zçğıöşü]*|bant[a-zçğıöşü]*|rulo[a-zçğıöşü]*" +
        "|ray[a-zçğıöşü]*|ku[şs]g[öo]z[a-zçğıöşü]*|rustik",
    ),
  },
  {
    intent: "FABRIC",
    pattern: word(
      "kuma[şs][a-zçğıöşü]*|t[üu]l[a-zçğıöşü]*|keten[a-zçğıöşü]*|kadife[a-zçğıöşü]*|[şs][öo]nil[a-zçğıöşü]*" +
        "|bambu[a-zçğıöşü]*|karartma[a-zçğıöşü]*|blackout[a-zçğıöşü]*|[şs]effaf[a-zçğıöşü]*" +
        "|dokuma[a-zçğıöşü]*|gramaj[a-zçğıöşü]*|desen[a-zçğıöşü]*|polyester[a-zçğıöşü]*|pamuk[a-zçğıöşü]*" +
        "|viskon[a-zçğıöşü]*|renk[a-zçğıöşü]*|bej|pudra|mint|antrasit|krem|siyah|beyaz|gri",
    ),
  },
];

/** Birden fazla niyet tespiti (birincil + ikincil). */
export function detectIntents(text: string): { primary: Intent; all: Intent[] } {
  const found: Intent[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text) && !found.includes(rule.intent)) found.push(rule.intent);
  }

  const hasLongOrderNumber = /\d{9,12}/.test(text);
  const hasChangeVerb = /de[ğg]i[şs]|olsun|yap(m|abil|ar)|haz[ıi]rla(m|yabil)|d[üu]zelt|g[üu]ncelle/i.test(text);
  const hasMeasureSignal = /[öo]l[çc]|\d{2,4}\s*[x×/]\s*\d{2,4}|\bboy\b|\ben\b|cm/i.test(text);

  // Sipariş kimliği + değişiklik fiili + ölçü sinyali → sipariş sonrası ölçü değişikliği.
  if ((hasLongOrderNumber || /sipari[şs]/i.test(text)) && hasChangeVerb && hasMeasureSignal && !found.includes("ORDER_CHANGE")) {
    found.unshift("ORDER_CHANGE");
  }

  // Ölçü sorusu sipariş numarası içermiyorsa ölçü niyeti sipariş durumundan önce gelir.
  if (!hasLongOrderNumber && found.includes("CUSTOM_SIZE") && found[0] === "ORDER_STATUS") {
    found.splice(found.indexOf("CUSTOM_SIZE"), 1);
    found.unshift("CUSTOM_SIZE");
  }

  // Destek/tamir anlatısı içinde geçen "fiyat" kelimesi niyeti fiyata çekmesin.
  const supportNarrative = /y[ıi]rt[ıi]l|tamir|dikil|yeniden yap|perdeci|de[ğg]i[şs]tirmek istiyorum/i.test(text);
  const explicitPriceQuestion = /ne kadar|fiyat[ıi] ne|fiyat[ıi]n[ıi]z|ka[çc]\s*(?:tl|lira)|zam m[ıi] geldi|indirim var m[ıi]/i.test(text);
  if (supportNarrative && !explicitPriceQuestion) {
    const priceIndex = found.indexOf("PRICE");
    if (priceIndex >= 0) found.splice(priceIndex, 1);
  }

  // İade / ücret iadesi varsa birincil niyet sipariş durumudur.
  const refund = /iade|para(?:y[ıi])?\s*geri|geri\s*[öo]deme|[üu]cret iadesi/i.test(text);
  if (refund) {
    const statusIndex = found.indexOf("ORDER_STATUS");
    if (statusIndex > 0) {
      found.splice(statusIndex, 1);
      found.unshift("ORDER_STATUS");
    } else if (statusIndex < 0) {
      found.unshift("ORDER_STATUS");
    }
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

/** Canlı veri (fiyat, sipariş durumu) gerektirdiği için otomatik kesin cevap verilmeyen niyetler. */
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
 * - Kaynak yok → ASK_DETAIL (müşteriden eksik ayrıntı istenir).
 * - Tüm zorunlu alanlar/politikalar doğrulanmış → DIRECT.
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
