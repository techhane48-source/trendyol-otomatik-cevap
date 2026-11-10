/**
 * Müşteri metni sanitizasyonu.
 *
 * İki amaç:
 * 1. **Prompt injection**: müşteri mesajı güvenilmez veridir; modelin talimat
 *    alanını taklit edebilecek kalıplar etkisizleştirilir ve metin sınırlanır.
 * 2. **PII**: sağlayıcıya ve kalite kayıtlarına gereksiz kişisel veri gitmez
 *    (telefon, e-posta, IBAN, adres ipuçları, sipariş numarası).
 */

const MAX_QUESTION_LENGTH = 1_000;

const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions?|prompts?|rules?)/gi,
  /\b(?:önceki|yukarıdaki|tüm)\s+(?:talimatları|kuralları|komutları)\s+(?:yok\s*say|unut|görmezden\s*gel)/gi,
  /\bsystem\s*(?:prompt|message|talimat)/gi,
  /\b(?:sen|siz)\s+artık\s+(?:bir|farklı)/gi,
  /\bassistant\s*:/gi,
  /\b(?:developer|admin)\s*(?:mode|modu)\b/gi,
  /<\/?(?:system|assistant|user|im_start|im_end)>/gi,
  /\[\[.*?\]\]/g,
];

export interface SanitizedQuestion {
  /** Modele gönderilecek güvenli metin */
  text: string;
  /** Injection kalıbı tespit edildi mi? */
  injectionSuspected: boolean;
  /** Kısaltıldı mı? */
  truncated: boolean;
}

export function neutralizePromptInjection(raw: string): { text: string; suspected: boolean } {
  let text = raw;
  let suspected = false;

  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      suspected = true;
      text = text.replace(pattern, "[metin kaldırıldı]");
    }
  }

  return { text, suspected };
}

/** Telefon, e-posta, IBAN, sipariş/TC benzeri kimlikleri maskeler. */
export function maskPii(raw: string): string {
  return raw
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[e-posta]")
    .replace(/\b(?:\+?90\s?)?0?5\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/g, "[telefon]")
    .replace(/\bTR\d{2}[\s]?(?:\d{4}[\s]?){5}\d{2}\b/gi, "[iban]")
    .replace(/\b\d{11}\b/g, "[numara]")
    .replace(/\b(?:sipariş|siparis|order)\s*(?:no|numarası|numarasi|#)?\s*[:\s]?\s*\d{4,}\b/gi, "[sipariş-no]");
}

/** Modele gönderilecek soru metnini hazırlar: injection etkisizleştirme + PII maskeleme + sınır. */
export function sanitizeQuestion(raw: string): SanitizedQuestion {
  const masked = maskPii(raw ?? "");
  const { text: neutralized, suspected } = neutralizePromptInjection(masked);
  const collapsed = neutralized.replace(/\s+/g, " ").trim();
  const truncated = collapsed.length > MAX_QUESTION_LENGTH;

  return {
    text: truncated ? `${collapsed.slice(0, MAX_QUESTION_LENGTH)}…` : collapsed,
    injectionSuspected: suspected,
    truncated,
  };
}

/** Sağlayıcı yanıtında PII olup olmadığını kontrol eder (kayıt öncesi uyarı). */
export function containsPii(text: string): boolean {
  return maskPii(text) !== text;
}
