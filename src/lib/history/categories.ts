/**
 * Soru kategorisi sınıflandırması.
 *
 * Amaç: geçmiş cevapları yalnızca ilgili kategoriyle eşleştirmek. Ölçü sorusuna kargo
 * cevabı, kumaş sorusuna iade cevabı bağlama sokulmaz. Sipariş/iade/kargo cevapları
 * kalıcı ürün özelliği sayılmaz.
 */

export type QuestionCategory =
  | "MEASURE"
  | "PLEAT"
  | "FABRIC"
  | "COLOR"
  | "WASH"
  | "MOUNT"
  | "ORDER"
  | "RETURN"
  | "SHIPPING"
  | "OTHER";

const LETTERS = "A-Za-zÇĞİÖŞÜçğıöşü";

/**
 * Türkçe güvenli kelime sınırı. `\b` ş/ğ/ı gibi harflerde çalışmadığı için
 * harf sınıfı elle tanımlanır.
 */
function word(pattern: string): RegExp {
  return new RegExp(`(?<![${LETTERS}])(?:${pattern})(?![${LETTERS}])`, "i");
}

const RULES: Array<{ category: QuestionCategory; pattern: RegExp }> = [
  { category: "ORDER", pattern: word("sipari[şs]\s*(no|numarası|numarasi|numaram|numaran)?|spariş|order") },
  { category: "RETURN", pattern: word("iade|geri\s*gönder|değişim\s*yap|cayma") },
  { category: "SHIPPING", pattern: word("kargo|kargoya|teslim|teslimat|kaç\s*günde|gün\s*içinde|takip\s*no") },
  { category: "PLEAT", pattern: word("pile|pilesiz|pilesi|pili|büzgü|buzgü|dalga|dolgun") },
  { category: "MEASURE", pattern: word("ölçü|olcu|cm|santim|santimetre|metre|en|boy|genişlik|yükseklik|kısalt|uzat|kesim|kesil") },
  { category: "WASH", pattern: word("yıka|yika|ütü|utu|çek|cek|tüy|tuy|leke|temizle|makinede") },
  { category: "MOUNT", pattern: word("montaj|kurulum|takma|takıl|korniş|kornis|bant|ekstrafor|çengel|cengel") },
  { category: "COLOR", pattern: word("renk|bej|pudra|mint|gri|antrasit|beyaz|krem|siyah|indigo|mercan|ton") },
  { category: "FABRIC", pattern: word("kumaş|kumas|tül|tul|kadife|keten|bambu|şeffaf|seffaf|karartma|blackout|gramaj|dokuma|desen") },
];

export function classifyQuestion(text: string): QuestionCategory {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return "OTHER";
}

/** Kalıcı ürün özelliği olabilecek kategoriler. */
export const FEATURE_CATEGORIES: QuestionCategory[] = ["MEASURE", "PLEAT", "FABRIC", "COLOR", "WASH", "MOUNT"];

export function isFeatureCategory(category: QuestionCategory): boolean {
  return FEATURE_CATEGORIES.includes(category);
}

/** Aynı veya yakın kategoriler (bağlama girebilecek geçmiş cevaplar). */
export function relatedCategories(category: QuestionCategory): QuestionCategory[] {
  const groups: QuestionCategory[][] = [
    ["FABRIC", "MEASURE", "PLEAT", "COLOR"],
    ["WASH", "FABRIC"],
    ["MOUNT", "MEASURE"],
    ["ORDER", "RETURN", "SHIPPING"],
  ];

  const group = groups.find((item) => item.includes(category));
  return group ?? [category];
}
