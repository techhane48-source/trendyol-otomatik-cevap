/**
 * LLM katmanı — ortak tipler.
 *
 * Kural: sağlayıcı/model/anahtar yalnızca ortam değişkenlerinden gelir.
 * Anahtar hiçbir zaman loglanmaz, hata mesajına veya veritabanına yazılmaz.
 */

/** Prompt üretiminde kullanılan, doğrulanmış bilgi kümesi. */
export interface DraftContext {
  /** Müşterinin sorusu (ham metin). */
  questionText: string;
  productName: string | null;
  productMainId: string | null;
  /**
   * Ürün hakkında DOĞRULANMIŞ ek bilgi (ölçü, kumaş, garanti vb.).
   * Bilinmiyorsa `null` — bu durumda model özellik uydurmamalıdır.
   */
  productInfo?: string | null;
  storeName?: string | null;
  /** Mağazanın genel üslup notu (varsa). */
  tone?: string | null;
  /** Sipariş/ölçü değişikliği bağlamı için ek talimat (varsa). */
  orderGuidance?: string | null;

  /* ---- GÖREV 012: niyet odaklı cevap motoru ---- */
  /** Algılanan birincil niyet (INTENT_LABELS anahtarı). */
  intent?: string | null;
  /** Niyet etiketi (Türkçe, panelde ve prompt'ta gösterilir). */
  intentLabel?: string | null;
  /** Cevap stratejisi: DIRECT | PARTIAL | ASK_DETAIL | HUMAN_REVIEW */
  strategy?: string | null;
  /** Doğrulanmış mağaza politikaları (yalnızca onaylanmışlar). */
  policies?: Array<{ label: string; value: string }> | null;
  /** Bu soru için gerçekten gerekli ama doğrulanmamış alan/politika etiketleri. */
  missingForIntent?: string[] | null;
  /** Canlı veri (fiyat/sipariş) gerektiren niyetlerde true. */
  requiresHumanReview?: boolean;
  /**
   * Geçmiş soru-cevaplar (REFERANS). Doğrulanmış ürün bilgisi değildir; fiyat/stok/
   * teslimat/iade bilgisi güncel gerçek olarak kullanılamaz.
   */
  history?: Array<{ ref: string; question: string; answer: string; reviewStatus: string; reason: string }> | null;
}

import type { LlmUsageInfo } from "./usage";

export interface LlmMessage {
  system: string;
  user: string;
}

export interface LlmCompletion {
  text: string;
  /** Sağlayıcı adı (ör. "openai-compatible"). Anahtar içermez. */
  provider: string;
  /** Kullanılan model adı (ör. "gpt-4o-mini"). Anahtar içermez. */
  model: string;
  promptVersion: string;
  /** Çağrı süresi (ms) */
  durationMs: number;
  /** Sağlayıcının verdiği ya da tahmin edilen token kullanımı */
  usage: LlmUsageInfo;
  /** HTTP durum kodu (başarılı çağrıda 200) */
  httpStatus?: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(messages: LlmMessage): Promise<LlmCompletion>;
}

/** Sağlayıcı yapılandırılmadığında fırlatılır (panelde açık mesaj gösterilir). */
export class LlmNotConfiguredError extends Error {
  constructor(message = "LLM sağlayıcısı yapılandırılmadı (LLM_PROVIDER / LLM_API_KEY).") {
    super(message);
    this.name = "LlmNotConfiguredError";
  }
}

/** Sağlayıcı çağrısı başarısız olduğunda fırlatılır. Mesaj gizli bilgi içermez. */
export class LlmRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LlmRequestError";
    this.code = code;
  }
}
