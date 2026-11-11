import type { Intent } from "@/lib/intents/taxonomy";

/**
 * Cevap kalitesi değerlendirmesi (GÖREV 015).
 *
 * Eski yaklaşım: "doğrulanmış politika kullanıldıysa RESOLVED". Bu yanlıştı:
 * politikayı açıklamak, sorunun cevaplandığı anlamına gelmez.
 *
 * Yeni durumlar:
 * - ANSWERED     : Soru mevcut doğrulanmış bilgiyle gerçekten cevaplandı.
 * - PARTIAL      : Sorunun bir kısmı cevaplandı; kalan kısım belirsiz.
 * - NEEDS_INFO   : Gerekli bilgi eksik; müşteriden bilgi ya da ürün verisi gerekiyor.
 * - HUMAN_REVIEW : İnsan kararı veya gerçek işlem gerekiyor (sipariş durumu, fiyat, üretim).
 */

export type AnswerQuality = "ANSWERED" | "PARTIAL" | "NEEDS_INFO" | "HUMAN_REVIEW";

export const QUALITY_LABELS: Record<AnswerQuality, string> = {
  ANSWERED: "Gerçekten cevaplandı",
  PARTIAL: "Kısmen cevaplandı",
  NEEDS_INFO: "Eksik bilgi",
  HUMAN_REVIEW: "İnsan incelemesi",
};

export interface QualityInput {
  question: string;
  answer: string;
  intent: Intent;
  /** Canlı veri (fiyat/sipariş/üretim) gerektiren niyet. */
  requiresHumanReview: boolean;
  /** Doğrulanmış alan sayısı (katalog A sınıfı dahil). */
  coveredFields: number;
  coveredPolicies: number;
  /** PROMISE / STALE gibi engelleyici uyarı sayısı. */
  blockingWarnings: number;
  /** Canlı sipariş durumu doğrulandı mı? */
  liveOrderVerified: boolean;
  /** Müşterinin soruda zaten verdiği bilgiler. */
  providedOrderNumber: boolean;
  providedSize: boolean;
  /** Cevapta kullanılan doğrulanmış bilgi değerleri (kaynak eşleşmesi için). */
  factValues?: string[];
  /** Kaçamak cevap ("kontrol edip ileteceğim") tespiti. */
  evasive?: boolean;
  /** Cevapta geçen ama hiçbir kaynakta bulunmayan ölçüler (uydurulmuş ölçü). */
  fabricatedSizes?: string[];
}

export interface QualityResult {
  quality: AnswerQuality;
  reasons: string[];
  /** Müşterinin zaten verdiği bilgi tekrar istendi mi? */
  unnecessaryAsk: boolean;
}

/** "Bilgimiz yok / kesin bilgi veremiyoruz" kalıpları. */
const NO_INFO_PATTERNS: RegExp[] = [
  /do[ğg]rulanm[ıi][şs]\s+(?:bilgi|veri)[a-zçğıöşü]*(?:\s+\w+){0,2}\s+(?:yok|bulunmuyor|mevcut de[ğg]il)/i,
  /do[ğg]rulanm[ıi][şs]\s+bilgimiz\s+bulunmuyor/i,
  /kesin bilgi veremiyor(?:um|uz)/i,
  /bilgi veremiyor(?:um|uz)/i,
  /do[ğg]rulayam[ıi]yor(?:um|uz)/i,
  /bilgimiz yok/i,
];

/** "Değerlendirilebilir / onay gerekir" gibi koşullu ifadeler. */
const CONDITIONAL_PATTERNS: RegExp[] = [
  /\bde[ğg]erlendirilebilir\b/i,
  /\bonay(?:[ıi]|ı)?\s+(?:gerek|gerekir|gerekli)/i,
  /\bko[şs]ul/i,
  /\b(?:bulunuyorsa|mevcutsa|varsa)\b/i,
  /\btalep edilebilir\b/i,
  /garanti(?:si)? yok/i,
];

const CAPABILITY_PATTERNS: RegExp[] = [
  /m[üu]mk[üu]n\s*m[üu]/i,
  /\bolur mu\b/i,
  /yap[ıi]labilir mi/i,
  /yapabilir misiniz/i,
  /kabul (?:ediyor|ediyor musunuz|edilir)/i,
  /\bvar m[ıi]\b/i,
  /mevcut mu/i,
  /haz[ıi]rlayabilir misiniz/i,
  /dikiyor musunuz/i,
  /dikebilir misiniz/i,
  /kesmeniz m[üu]mk[üu]n/i,
];

/** Müşterinin gerçekleşmiş durumu/aksiyonu sorduğu kalıplar. */
const STATUS_PATTERNS: RegExp[] = [
  /geldi mi/i,
  /ne zaman/i,
  /nerede/i,
  /haz[ıi]r m[ıi]/i,
  /kargoda m[ıi]/i,
  /yapt[ıi]n[ıi]z m[ıi]/i,
  /de[ğg]i[şs]tirdiniz mi/i,
  /iptal ettiniz mi/i,
  /g[öo]nderdiniz mi/i,
  /ula[şs]t[ıi] m[ıi]/i,
  /takip/i,
  /\biade\b/i,
  /yanl[ıi][şs] (?:ürün|g[öo]nderim)/i,
  /hesab[ıi]ma (?:ge[çc]ti|ge[çc]medi)/i,
  /para(?:m[ıi]|y[ıi])? (?:geri )?gelmedi/i,
  /zam m[ıi] geldi/i,
  /pahaland[ıi]/i,
  /fiyat[ıi] (?:artt[ıi]|de[ğg]i[şs]ti)/i,
  /indirim (?:bitti|devam ediyor)/i,
];

const ASK_PATTERNS: RegExp[] = [
  /payla[şs]abilir misiniz/i,
  /belirtir misiniz/i,
  /yazar m[ıi]s[ıi]n[ıi]z/i,
  /s[öo]yler misiniz/i,
  /bilgi verir misiniz/i,
  /iletebilir misiniz/i,
];

const HAS_NUMBER = /\d{2,4}\s*(?:x|×|cm)\b|\b\d{2,4}\s*cm\b|\b\d{2,3}\s*x\s*\d{2,3}\b/i;
const HAS_CONCRETE = [
  /mevcuttur/i,
  /mevcut\b/i,
  /se[çc]ebilirsiniz/i,
  /listede var/i,
  /katalogda (?:mevcut|bulunuyor|yer al)/i,
  /uygulan[ıi]r\b/i,
  /yap[ıi]lamaz/i,
  /m[üu]mk[üu]n de[ğg]il/i,
  /kabul edilmez/i,
  /ge[çc]erlidir/i,
  /esas al[ıi]n[ıi]r/i,
];

export function isNoInfoAnswer(answer: string): boolean {
  return NO_INFO_PATTERNS.some((pattern) => pattern.test(answer));
}

export function evaluateAnswerQuality(input: QualityInput): QualityResult {
  const answer = input.answer.trim();
  const reasons: string[] = [];

  const noInfo = isNoInfoAnswer(answer);
  const capability = CAPABILITY_PATTERNS.some((pattern) => pattern.test(input.question)) ||
    CAPABILITY_PATTERNS.some((pattern) => pattern.test(answer));
  const statusQuestion = STATUS_PATTERNS.some((pattern) => pattern.test(input.question));
  const conditional = CONDITIONAL_PATTERNS.some((pattern) => pattern.test(answer));
  const concrete = HAS_NUMBER.test(answer) || HAS_CONCRETE.some((pattern) => pattern.test(answer));
  const asksInfo = ASK_PATTERNS.some((pattern) => pattern.test(answer));
  const factMentioned =
    !noInfo &&
    (input.factValues ?? []).some((value) => {
      const token = value.trim().split(/\s+/)[0]?.toLocaleLowerCase("tr");
      return token.length >= 4 && answer.toLocaleLowerCase("tr").includes(token);
    });

  const asksOrderNumber = /sipari[şs]\s*(?:no|numar)/i.test(answer);
  const unnecessaryAsk =
    (asksOrderNumber && input.providedOrderNumber) ||
    (asksInfo && /\b[öo]l[çc][üu]\b/i.test(answer) && input.providedSize);

  if ((input.fabricatedSizes ?? []).length > 0) {
    reasons.push(`Cevapta kaynakta olmayan ölçü var: ${(input.fabricatedSizes ?? []).join(", ")}`);
    return { quality: "HUMAN_REVIEW", reasons, unnecessaryAsk };
  }

  if (input.blockingWarnings > 0) {
    reasons.push("Engelleyici uyarı var (doğrulanmamış vaat/eski bilgi)");
    return { quality: "HUMAN_REVIEW", reasons, unnecessaryAsk };
  }

  if (statusQuestion && !input.liveOrderVerified) {
    reasons.push("Soru gerçekleşmiş durumu/aksiyonu soruyor; canlı sipariş/üretim verisi yok");
    return { quality: "HUMAN_REVIEW", reasons, unnecessaryAsk };
  }

  if (input.evasive) {
    reasons.push("Kaçamak cevap: somut bilgi verilmedi");
    return { quality: "PARTIAL", reasons, unnecessaryAsk };
  }

  if (noInfo) {
    if (capability && concrete) {
      reasons.push("Ürün bilgisi yok ama genel kural/koşul açıklandı");
      return { quality: "PARTIAL", reasons, unnecessaryAsk };
    }
    reasons.push("Cevap 'doğrulanmış bilgi yok' diyor; soru cevaplanmadı");
    return { quality: "NEEDS_INFO", reasons, unnecessaryAsk };
  }

  if (unnecessaryAsk) {
    reasons.push("Müşterinin verdiği bilgi tekrar istendi");
    return { quality: "PARTIAL", reasons, unnecessaryAsk };
  }

  if (capability && conditional) {
    if (concrete && !/\b(?:bulunuyorsa|mevcutsa|varsa)\b/i.test(answer)) {
      reasons.push("Yetenek sorusuna doğrulanmış ölçü/kural ile cevap verildi");
      return { quality: "ANSWERED", reasons, unnecessaryAsk };
    }
    reasons.push("Yetenek sorusuna koşullu cevap verildi; kesin bilgi yok");
    return { quality: "PARTIAL", reasons, unnecessaryAsk };
  }

  if (concrete || factMentioned) {
    if (asksInfo) {
      reasons.push("Bilgi verildi ancak ek bilgi de istendi");
      return { quality: "PARTIAL", reasons, unnecessaryAsk };
    }
    reasons.push("Doğrulanmış somut bilgiyle cevaplandı");
    return { quality: "ANSWERED", reasons, unnecessaryAsk };
  }

  if (input.coveredPolicies > 0 && input.coveredFields === 0) {
    reasons.push("Yalnızca genel politika açıklandı, soruya özel bilgi verilmedi");
    return { quality: "PARTIAL", reasons, unnecessaryAsk };
  }

  if (asksInfo) {
    reasons.push("Gerekli bilgi eksik; müşteriden bilgi istendi");
    return { quality: "NEEDS_INFO", reasons, unnecessaryAsk };
  }

  reasons.push("Cevap soruyla somut olarak eşleşmiyor");
  return { quality: "PARTIAL", reasons, unnecessaryAsk };
}
