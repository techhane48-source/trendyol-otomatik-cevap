import { createLogger } from "@/lib/logger";
import { getEnv, resolveUserAgent, type AppEnv } from "@/lib/env";
import {
  parseQuestionsPage,
  TrendyolResponseValidationError,
  type NormalizedQuestion,
  type TrendyolQnaPage,
} from "./schemas";

const log = createLogger("trendyol.client");

export type TrendyolErrorKind =
  | "auth"
  | "forbidden"
  | "rate_limit"
  | "server"
  | "client"
  | "timeout"
  | "network"
  | "validation";

/** Trendyol API hatalarını sınıflandırır. Mesajda gizli bilgi bulunmaz. */
export class TrendyolApiError extends Error {
  readonly kind: TrendyolErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: {
      kind: TrendyolErrorKind;
      status?: number | null;
      retryable?: boolean;
      attempts?: number;
      retryAfterMs?: number | null;
    },
  ) {
    super(message);
    this.name = "TrendyolApiError";
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.attempts = options.attempts ?? 1;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  /** SyncRun.errorCode alanına yazılan kısa kod. */
  get code(): string {
    if (this.kind === "timeout") return "TIMEOUT";
    if (this.kind === "network") return "NETWORK";
    if (this.kind === "validation") return "VALIDATION";
    if (this.kind === "auth") return "401";
    if (this.kind === "forbidden") return "403";
    if (this.kind === "rate_limit") return "429";
    return this.status ? String(this.status) : this.kind.toUpperCase();
  }
}

export interface TrendyolClientConfig {
  baseUrl: string;
  sellerId: string;
  apiKey: string;
  apiSecret: string;
  userAgent: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  /** Test enjeksiyonu için. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Retry gecikmesine eklenecek 0-1 arası rastgelelik (testte 0 verilebilir). */
  jitter?: () => number;
}

export interface QuestionsQuery {
  page?: number;
  size?: number;
  status?: string;
  /** Epoch ms. Trendyol en fazla iki haftalık aralık kabul eder. */
  startDate?: number;
  /** Epoch ms. */
  endDate?: number;
  orderByField?: "CreatedDate" | "Status";
  orderByDirection?: "ASC" | "DESC";
}

export interface QuestionsPageResult {
  page: TrendyolQnaPage;
  questions: NormalizedQuestion[];
  /** İsteğin kaç denemede tamamlandığı. */
  attempts: number;
}

const MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 2_000;

/** Ortam değişkenlerinden istemci konfigürasyonu üretir. */
export function clientConfigFromEnv(env: AppEnv = getEnv()): TrendyolClientConfig {
  return {
    baseUrl: env.TRENDYOL_BASE_URL.replace(/\/+$/, ""),
    sellerId: env.TRENDYOL_SELLER_ID,
    apiKey: env.TRENDYOL_API_KEY,
    apiSecret: env.TRENDYOL_API_SECRET,
    userAgent: resolveUserAgent(env),
    timeoutMs: env.TRENDYOL_TIMEOUT_MS,
    maxRetries: env.SYNC_MAX_RETRIES,
    retryBaseMs: env.SYNC_RETRY_BASE_MS,
  };
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Trendyol Q&A (soru-cevap) API istemcisi — SADECE OKUMA.
 * Bu modülde cevap gönderme/güncelleme çağrısı bulunmaz.
 */
export class TrendyolQnaClient {
  private readonly config: TrendyolClientConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  constructor(config: TrendyolClientConfig) {
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = config.sleepImpl ?? realSleep;
    this.jitter = config.jitter ?? Math.random;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetch kullanılamıyor (Node 18+ veya fetch enjeksiyonu gerekir)");
    }
  }

  /** Basic Auth başlığı. Değer hiçbir yerde loglanmaz. */
  private authorizationHeader(): string {
    const raw = `${this.config.apiKey}:${this.config.apiSecret}`;
    return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }

  buildUrl(query: QuestionsQuery): string {
    const params = new URLSearchParams();
    params.set("page", String(query.page ?? 0));
    params.set("size", String(query.size ?? 50));
    if (query.status) params.set("status", query.status);
    if (query.startDate !== undefined) params.set("startDate", String(query.startDate));
    if (query.endDate !== undefined) params.set("endDate", String(query.endDate));
    if (query.orderByField) params.set("orderByField", query.orderByField);
    if (query.orderByDirection) params.set("orderByDirection", query.orderByDirection);

    return `${this.config.baseUrl}/sellers/${this.config.sellerId}/questions/filter?${params.toString()}`;
  }

  /** Tek sayfa soru çeker; 401/403/429/5xx/timeout için sınırlı tekrar dener. */
  async fetchQuestionsPage(query: QuestionsQuery = {}): Promise<QuestionsPageResult> {
    const url = this.buildUrl(query);
    const maxAttempts = Math.max(1, this.config.maxRetries + 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const payload = await this.performRequest(url, attempt);

        try {
          const { page, questions } = parseQuestionsPage(payload);
          return { page, questions, attempts: attempt };
        } catch (error) {
          if (error instanceof TrendyolResponseValidationError) {
            throw new TrendyolApiError(error.message, {
              kind: "validation",
              retryable: false,
              attempts: attempt,
            });
          }
          throw error;
        }
      } catch (error) {
        const apiError = this.toApiError(error, attempt);

        if (!apiError.retryable || attempt >= maxAttempts) {
          throw apiError;
        }

        const delay = this.computeDelay(apiError, attempt);
        log.warn("Trendyol isteği tekrar denenecek", {
          attempt,
          maxAttempts,
          code: apiError.code,
          delayMs: delay,
        });
        await this.sleepImpl(delay);
      }
    }

    // Buraya normalde ulaşılmaz.
    throw new TrendyolApiError("Trendyol isteği tamamlanamadı", {
      kind: "network",
      attempts: maxAttempts,
    });
  }

  private async performRequest(url: string, attempt: number): Promise<unknown> {
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: this.authorizationHeader(),
          "User-Agent": this.config.userAgent,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new TrendyolApiError("Trendyol isteği zaman aşımına uğradı", {
          kind: "timeout",
          retryable: true,
          attempts: attempt,
        });
      }
      throw new TrendyolApiError("Trendyol API'sine ulaşılamadı (ağ hatası)", {
        kind: "network",
        retryable: true,
        attempts: attempt,
      });
    }

    if (response.status === 401) {
      throw new TrendyolApiError("Trendyol kimlik doğrulaması başarısız (401)", {
        kind: "auth",
        status: 401,
        retryable: false,
        attempts: attempt,
      });
    }

    if (response.status === 403) {
      throw new TrendyolApiError(
        "Trendyol erişimi reddedildi (403). Satıcı/entegrasyon yetkisi kontrol edilmeli.",
        { kind: "forbidden", status: 403, retryable: false, attempts: attempt },
      );
    }

    if (response.status === 429) {
      throw new TrendyolApiError("Trendyol hız sınırı aşıldı (429)", {
        kind: "rate_limit",
        status: 429,
        retryable: true,
        attempts: attempt,
        retryAfterMs: this.parseRetryAfter(response.headers.get("retry-after")),
      });
    }

    if (response.status >= 500) {
      throw new TrendyolApiError(`Trendyol sunucu hatası (${response.status})`, {
        kind: "server",
        status: response.status,
        retryable: true,
        attempts: attempt,
      });
    }

    if (!response.ok) {
      // 400/404/409 vb. — tekrar denemek anlamsız.
      throw new TrendyolApiError(`Trendyol isteği reddedildi (${response.status})`, {
        kind: "client",
        status: response.status,
        retryable: false,
        attempts: attempt,
      });
    }

    try {
      return await response.json();
    } catch {
      throw new TrendyolApiError("Trendyol yanıtı JSON olarak okunamadı", {
        kind: "validation",
        status: response.status,
        retryable: false,
        attempts: attempt,
      });
    }
  }

  private parseRetryAfter(header: string | null): number | null {
    if (!header) return null;

    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }

    const date = new Date(header);
    if (!Number.isNaN(date.getTime())) {
      return Math.min(Math.max(date.getTime() - Date.now(), 0), MAX_RETRY_DELAY_MS);
    }

    return null;
  }

  private computeDelay(error: TrendyolApiError, attempt: number): number {
    const fallback =
      error.kind === "rate_limit"
        ? (error.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS)
        : this.config.retryBaseMs * 2 ** (attempt - 1);

    const base = error.retryAfterMs ?? fallback;
    const withJitter = base + Math.floor(this.jitter() * Math.min(base, 1_000));
    return Math.min(Math.max(withJitter, 0), MAX_RETRY_DELAY_MS);
  }

  private toApiError(error: unknown, attempt: number): TrendyolApiError {
    if (error instanceof TrendyolApiError) {
      // attempts bilgisini güncel tut.
      return error.attempts === attempt
        ? error
        : new TrendyolApiError(error.message, {
            kind: error.kind,
            status: error.status,
            retryable: error.retryable,
            attempts: attempt,
            retryAfterMs: error.retryAfterMs,
          });
    }

    if (error instanceof Error && error.name === "TimeoutError") {
      return new TrendyolApiError("Trendyol isteği zaman aşımına uğradı", {
        kind: "timeout",
        retryable: true,
        attempts: attempt,
      });
    }

    return new TrendyolApiError("Beklenmeyen Trendyol istemci hatası", {
      kind: "network",
      retryable: false,
      attempts: attempt,
    });
  }
}

export function createTrendyolClient(config?: Partial<TrendyolClientConfig>): TrendyolQnaClient {
  return new TrendyolQnaClient({ ...clientConfigFromEnv(), ...config });
}
