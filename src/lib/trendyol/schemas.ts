import { z } from "zod";

/**
 * Trendyol Q&A yanıt şemaları.
 *
 * Kaynak: Trendyol "Trendyol Question & Answer" entegrasyon dokümantasyonu —
 * GET /integration/qna/sellers/{sellerId}/questions/filter
 *
 * NOT: Doküman ile gerçek yanıt arasında fark olabileceği için şemalar "loose"
 * (gevşek) tanımlandı: kullandığımız alanlar sıkı doğrulanır, dokümanda olmayan
 * ek alanlar sessizce korunur (ham veri `raw` alanında saklanır). Dokümanda
 * olmayan bir alan varsayılmaz — eksikse doğrulama hata verir.
 */

/** Epoch (ms) veya ISO-8601 metni olarak gelebilen tarih alanı. */
export const timestampSchema = z
  .union([z.number(), z.string()])
  .nullish();

export const nullableStringSchema = z
  .union([z.string(), z.number()])
  .nullish();

/** Tek bir soru kaydı (Trendyol yanıtındaki hali). */
export const trendyolQuestionSchema = z.looseObject({
  id: z.union([z.number(), z.string().regex(/^\d+$/)]),
  text: z.string().nullish(),
  status: z.string().nullish(),
  creationDate: timestampSchema,
  answeredDate: timestampSchema,
  answer: z
    .union([
      z.string(),
      z.looseObject({ text: z.string().nullish(), answerText: z.string().nullish() }),
    ])
    .nullish(),
  productName: nullableStringSchema,
  productMainId: nullableStringSchema,
  productId: nullableStringSchema,
  customerId: nullableStringSchema,
  /** Bazı sürümlerde soru metni "question" alanında dönebilir. */
  question: z.string().nullish(),
});

export type TrendyolQuestionRaw = z.infer<typeof trendyolQuestionSchema>;

/** Spring Page sarmalayıcısı. */
export const trendyolQnaPageSchema = z.looseObject({
  content: z.array(z.unknown()).default([]),
  totalPages: z.number().int().nonnegative().nullish(),
  totalElements: z.number().int().nonnegative().nullish(),
  number: z.number().int().nonnegative().nullish(),
  size: z.number().int().nonnegative().nullish(),
  last: z.boolean().nullish(),
  first: z.boolean().nullish(),
  empty: z.boolean().nullish(),
});

export type TrendyolQnaPage = z.infer<typeof trendyolQnaPageSchema>;

/** Veritabanına yazılan normalize edilmiş soru. */
export const normalizedQuestionSchema = z.object({
  trendyolQuestionId: z.bigint().positive(),
  text: z.string().min(1),
  rawStatus: z.string().nullable(),
  productName: z.string().nullable(),
  productMainId: z.string().nullable(),
  productId: z.string().nullable(),
  customerId: z.string().nullable(),
  answerText: z.string().nullable(),
  askedAt: z.date().nullable(),
  answeredAt: z.date().nullable(),
  raw: z.unknown(),
});

export type NormalizedQuestion = z.infer<typeof normalizedQuestionSchema>;

export class TrendyolResponseValidationError extends Error {
  readonly issues: string[];

  constructor(context: string, issues: string[]) {
    super(`Trendyol yanıtı doğrulanamadı (${context}): ${issues.join("; ")}`);
    this.name = "TrendyolResponseValidationError";
    this.issues = issues;
  }
}

/** Epoch (ms) / ISO metni / boş değeri Date'e çevirir. */
export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Saniye cinsinden gelirse ms'e çevir.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return toDate(Number(trimmed));
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function extractAnswerText(answer: TrendyolQuestionRaw["answer"]): string | null {
  if (!answer) return null;
  if (typeof answer === "string") return optionalText(answer);
  return optionalText(answer.text) ?? optionalText(answer.answerText);
}

/**
 * Ham soru kaydını doğrular ve veritabanı modeline uygun hale getirir.
 * Zorunlu alanlar (id, metin) yoksa doğrulama hatası fırlatır.
 */
export function normalizeQuestion(input: unknown, index: number): NormalizedQuestion {
  const parsed = trendyolQuestionSchema.safeParse(input);
  if (!parsed.success) {
    throw new TrendyolResponseValidationError(
      `content[${index}]`,
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(kök)"}: ${issue.message}`),
    );
  }

  const raw = parsed.data;
  const text = optionalText(raw.text) ?? optionalText(raw.question);
  if (!text) {
    throw new TrendyolResponseValidationError(`content[${index}]`, [
      "text: soru metni bulunamadı (text/question alanı boş)",
    ]);
  }

  const idSource = String(raw.id);
  if (!/^\d+$/.test(idSource)) {
    throw new TrendyolResponseValidationError(`content[${index}]`, [
      `id: sayısal olmayan soru kimliği`,
    ]);
  }

  return normalizedQuestionSchema.parse({
    trendyolQuestionId: BigInt(idSource),
    text,
    rawStatus: optionalText(raw.status),
    productName: optionalText(raw.productName),
    productMainId: optionalText(raw.productMainId),
    productId: optionalText(raw.productId),
    customerId: optionalText(raw.customerId),
    answerText: extractAnswerText(raw.answer),
    askedAt: toDate(raw.creationDate),
    answeredAt: toDate(raw.answeredDate),
    raw,
  });
}

/** Sayfa yanıtını doğrular; içindeki soruları da normalize eder. */
export function parseQuestionsPage(payload: unknown): {
  page: TrendyolQnaPage;
  questions: NormalizedQuestion[];
} {
  const parsed = trendyolQnaPageSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TrendyolResponseValidationError(
      "sayfa",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(kök)"}: ${issue.message}`),
    );
  }

  const page = parsed.data;
  const questions = page.content.map((item, index) => normalizeQuestion(item, index));
  return { page, questions };
}

/** Trendyol durum metnini yerel enum'a çevirir. */
export function mapQuestionStatus(rawStatus: string | null): {
  status: "WAITING_FOR_ANSWER" | "ANSWERED" | "REJECTED" | "UNKNOWN";
  rawStatus: string | null;
} {
  switch (rawStatus) {
    case "WAITING_FOR_ANSWER":
      return { status: "WAITING_FOR_ANSWER", rawStatus };
    case "ANSWERED":
      return { status: "ANSWERED", rawStatus };
    case "REJECTED":
      return { status: "REJECTED", rawStatus };
    default:
      return { status: "UNKNOWN", rawStatus };
  }
}
