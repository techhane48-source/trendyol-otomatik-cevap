import type { Intent } from "@/lib/intents/taxonomy";
import { parseSizeRequest } from "@/lib/products/sizes";

/**
 * İş kuyruğu sınıflandırıcısı (GÖREV 017).
 *
 * Kurallar açık ve sıralıdır; "AI puanı" yoktur. Her karar gerekçe metni üretir.
 * Sıra önemlidir: iptal/sensitive durumlar üretim talebinden önce gelir.
 */

export type WorkCategory = "AUTO_CANDIDATE" | "SUPPORT" | "WORKSHOP" | "NEEDS_INFO";
export type WorkPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type WorkTeam = "AI" | "Müşteri Temsilcisi" | "Atölye";

export interface ClassifyInput {
  text: string;
  intent: Intent;
  intents: Intent[];
  strategy: string;
  resolution: string;
  requiresHumanReview: boolean;
  orderNumber: string | null;
  orderMatch: string | null;
  /** Trendyol sipariş durumu (varsa) */
  orderStatus: string | null;
  coveredFields: number;
  coveredPolicies: number;
}

export interface ClassifyResult {
  category: WorkCategory;
  team: WorkTeam;
  priority: WorkPriority;
  reasons: string[];
}

const REFUND = /iade|para(?:y[ıi])?|geri\s*[öo]deme|[üu]cret iadesi/i;
const DELIVERY_COMPLAINT = /gecik|gelmedi|ula[şs]mad[ıi]|ne zaman gel|kargoda|nerede|teslim (?:edilmedi|edilmedi)|kargoya[^.]{0,25}(?:verilir|verilmi[şs]|ne zaman)/i;
const CHANGE = /de[ğg]i[şs]tir|k[üu][çc][üu]lt|b[üu]y[üu]t|olsun|yapabilir|yapma [şs]ans|yapabilme|d[üu]zelt|ekle/i;
const SENSITIVE_PRICE = /zam|pahal[ıi]|indirim|fiyat/i;
const PRODUCTION_ACCESSORY = /ku[şs]ak|aksesuar|pile|dikim|diki[şs]|ba[şs]l[ıi]k|kanca|halka|b[üu]zd[üu]rme|d[üu]zg[üu] diki[şs]/i;

function has(intents: Intent[], intent: Intent): boolean {
  return intents.includes(intent);
}

export function classifyWork(input: ClassifyInput): ClassifyResult {
  const text = input.text;
  const orderCancelled = (input.orderStatus ?? "").toLowerCase() === "cancelled";
  const orderDelivered = (input.orderStatus ?? "").toLowerCase() === "delivered";
  const orderStage = (input.orderStatus ?? "").toLowerCase();
  const preProduction = ["created", "awaiting", "picking", "invoiced"].includes(orderStage);

  // 1) İptal edilmiş siparişe üretim talebi açılmaz → temsilci.
  if (orderCancelled) {
    return {
      category: "SUPPORT",
      team: "Müşteri Temsilcisi",
      priority: "URGENT",
      reasons: ["Sipariş Trendyol'da iptal edilmiş; üretim/ölçü değişikliği açılamaz."],
    };
  }

  // 2) İade / para / teslimat itirazı → temsilci, öncelikli.
  if (REFUND.test(text)) {
    return {
      category: "SUPPORT",
      team: "Müşteri Temsilcisi",
      priority: "URGENT",
      reasons: ["İade/ücret iadesi ifadesi var; banka/PSP verisi bu sistemde yok.", "İnsan değerlendirmesi zorunlu."],
    };
  }

  if (DELIVERY_COMPLAINT.test(text)) {
    return {
      category: "SUPPORT",
      team: "Müşteri Temsilcisi",
      priority: "HIGH",
      reasons: ["Teslimat/gecikme itirazı; otomatik 'çözüldü' sayılamaz."],
    };
  }

  // 3) Fiyat anlaşmazlığı → temsilci.
  if (has(input.intents, "PRICE") || SENSITIVE_PRICE.test(text)) {
    return {
      category: "SUPPORT",
      team: "Müşteri Temsilcisi",
      priority: "NORMAL",
      reasons: ["Fiyat/kampanya konusu; canlı fiyat geçmişi olmadan kesin cevap verilemez."],
    };
  }

  // 4) Ölçü/dikim/üretim değişikliği → atölye.
  const workshopIntent =
    has(input.intents, "ORDER_CHANGE") || has(input.intents, "CUSTOM_SIZE") || has(input.intents, "SEWING") || PRODUCTION_ACCESSORY.test(text);
  const sizeRequest = parseSizeRequest(text);
  if ((workshopIntent || ((sizeRequest.requested || sizeRequest.single) && CHANGE.test(text))) && (input.orderNumber || CHANGE.test(text))) {
    const reasons: string[] = [];
    let priority: WorkPriority = "NORMAL";

    if (!input.orderNumber) {
      reasons.push("Sipariş numarası yok; talep siparişe bağlanamadı.");
    } else if (input.orderMatch === "MATCHED") {
      reasons.push("Sipariş canlı Trendyol verisiyle eşleşti.");
    } else {
      reasons.push(`Sipariş eşleşmesi doğrulanamadı (${input.orderMatch ?? "yok"}).`);
    }

    if (preProduction) {
      priority = "HIGH";
      reasons.push("Üretim başlamamış görünüyor; değişiklik erken değerlendirilmeli.");
    } else if (orderDelivered) {
      reasons.push("Sipariş teslim edilmiş; değişiklik büyük olasılıkla mümkün değil, atölye karar verir.");
    } else if (input.orderStatus) {
      reasons.push(`Sipariş durumu: ${input.orderStatus}.`);
    }

    if (CHANGE.test(text)) reasons.push("Metinde değişiklik/üretim talebi ifadesi var.");

    return { category: "WORKSHOP", team: "Atölye", priority, reasons };
  }

  // 5) Doğrulanmış bilgiyle cevaplanabilen ürün soruları → otomatik aday.
  const productIntent = ["FABRIC", "MOUNT", "CARE", "DIMENSIONS", "CUSTOM_SIZE", "SEWING", "ACCESSORIES", "PRICE"].includes(input.intent);
  if (
    productIntent &&
    input.resolution === "ANSWERED" &&
    !input.requiresHumanReview &&
    (input.coveredFields > 0 || input.coveredPolicies > 0)
  ) {
    return {
      category: "AUTO_CANDIDATE",
      team: "AI",
      priority: "LOW",
      reasons: [
        "Soru doğrulanmış ürün bilgisiyle cevaplandı.",
        `${input.coveredFields} doğrulanmış ürün alanı, ${input.coveredPolicies} doğrulanmış politika kullanıldı.`,
      ],
    };
  }

  // 6) Kalan: gerçekten ek bilgi gerekiyor.
  const reasons: string[] = [];
  if (input.coveredFields === 0) reasons.push("Doğrulanmış ürün alanı yok.");
  if (input.coveredPolicies === 0) reasons.push("İlgili doğrulanmış mağaza politikası yok.");
  if (input.resolution !== "ANSWERED") reasons.push(`Taslak durumu: ${input.resolution}.`);
  reasons.push("Müşteriden veya satıcıdan ek bilgi gerekiyor.");

  return { category: "NEEDS_INFO", team: "Müşteri Temsilcisi", priority: "NORMAL", reasons };
}

export const CATEGORY_LABELS: Record<WorkCategory, string> = {
  AUTO_CANDIDATE: "Otomatik cevap adayı",
  SUPPORT: "Müşteri temsilcisi",
  WORKSHOP: "Atölye",
  NEEDS_INFO: "Bilgi eksik",
};

export const PRIORITY_LABELS: Record<WorkPriority, string> = {
  LOW: "Düşük",
  NORMAL: "Normal",
  HIGH: "Yüksek",
  URGENT: "Acil",
};

export const STATUS_LABELS: Record<string, string> = {
  NEW: "Yeni",
  IN_REVIEW: "İncelemede",
  APPROVED: "Onaylandı",
  REJECTED: "Reddedildi",
  DONE: "Tamamlandı",
};

export const STAGE_LABELS: Record<string, string> = {
  NOT_STARTED: "Kesim başlamadı",
  CUTTING: "Kesimde",
  SEWING: "Dikimde",
  PACKED: "Paketlendi",
  SHIPPED: "Kargoya verildi",
};
