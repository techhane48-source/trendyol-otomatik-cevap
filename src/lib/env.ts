import { z } from "zod";

/**
 * Ortam değişkenleri şeması.
 * KURAL: gerçek API anahtarları yalnızca .env dosyasında tutulur; kaynak koda yazılmaz,
 * hata mesajlarında veya loglarda değerleri asla görünmez.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Veritabanı
  DATABASE_URL: z.string().min(1, "zorunlu (PostgreSQL bağlantı adresi)"),

  // Trendyol entegrasyonu
  TRENDYOL_BASE_URL: z
    .string()
    .url("geçerli bir URL olmalı")
    .default("https://apigw.trendyol.com/integration/qna"),
  TRENDYOL_SELLER_ID: z
    .string()
    .regex(/^\d+$/, "sadece rakamlardan oluşmalı (Trendyol sellerId)"),
  TRENDYOL_API_KEY: z.string().min(1, "zorunlu"),
  TRENDYOL_API_SECRET: z.string().min(1, "zorunlu"),
  /** Trendyol dokümantasyonu: "{sellerId} - SelfIntegration" */
  TRENDYOL_USER_AGENT: z.string().min(1).optional(),

  // Senkronizasyon ayarları
  SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(50),
  SYNC_MAX_PAGES: z.coerce.number().int().min(1).max(500).default(100),
  SYNC_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  SYNC_RETRY_BASE_MS: z.coerce.number().int().min(0).max(60_000).default(500),

  // HTTP
  /** Sipariş (getShipmentPackages) servis kökü — salt okunur GET. */
  ORDERS_BASE_URL: z
    .string()
    .trim()
    .url()
    .default("https://apigw.trendyol.com/integration/order"),
  TRENDYOL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),

  /**
   * Panel/API erişim anahtarı (paylaşılan tek anahtar).
   * Tanımlanmazsa: geliştirmede erişim açık, üretimde erişim TAMAMEN KAPALI (fail-closed).
   * Zorunluluk burada değil `src/lib/auth.ts` içinde uygulanır; böylece `next build`
   * anahtar olmadan da çalışabilir.
   */
  APP_ACCESS_TOKEN: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(16, "en az 16 karakter olmalı").optional(),
  ),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // ---------------------------------------------------------------------------
  // LLM (cevap taslağı üretimi). Anahtar SADECE .env içinde tutulur.
  // `disabled` (varsayılan): AI taslak üretimi kapalı, panelde açıkça bildirilir.
  // ---------------------------------------------------------------------------
  LLM_PROVIDER: z.enum(["mock", "openai-compatible", "disabled"]).default("disabled"),
  /** OpenAI uyumlu API kökü (ör. https://api.openai.com/v1). Anahtar içermez. */
  LLM_BASE_URL: z.string().url("geçerli bir URL olmalı").default("https://api.openai.com/v1"),
  LLM_API_KEY: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  LLM_MODEL: z.string().trim().min(1).default("gpt-4o-mini"),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  LLM_MAX_TOKENS: z.coerce.number().int().min(64).max(4_096).default(600),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(1.5).default(0.2),
  /** Prompt sürümü: üretilen taslağın hangi kurallarla yazıldığını izlemek için. */
  LLM_PROMPT_VERSION: z.string().trim().min(1).default("v1"),
  /** 429/5xx/ağ hatasında tekrar sayısı (0 = tekrar yok). */
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  LLM_RETRY_BASE_MS: z.coerce.number().int().min(0).max(10_000).default(400),
  /**
   * 1K token başına USD fiyat. Sabit fiyat VARSAYILMAZ: tanımlanmazsa maliyet 0
   * raporlanır. Sağlayıcı fiyat listenize göre .env'de ayarlayın.
   */
  LLM_INPUT_COST_PER_1K: z.coerce.number().min(0).max(1_000).default(0),
  LLM_OUTPUT_COST_PER_1K: z.coerce.number().min(0).max(1_000).default(0),
  /** OpenAI `store` bayrağı: test ve üretim çağrılarında varsayılan olarak kapalı. */
  LLM_STORE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** Tek bir toplu kalite testi için üst maliyet sınırı (USD). */
  LLM_MAX_COST_USD: z.coerce.number().min(0).max(1_000).default(2),
  /** Tek çağrılık smoke testi için üst maliyet sınırı (USD). */
  LLM_SMOKE_MAX_COST_USD: z.coerce.number().min(0).max(10).default(0.05),
  /**
   * Bazı OpenAI-uyumlu geçitler oturum başlığı ister (ör. OpenCode Go:
   * `x-opencode-session`). Tanımlıysa her isteğe eklenir; kimlik bilgisi taşımaz.
   */
  LLM_SESSION_HEADER: z.string().trim().max(64).optional(),
  /** Oturum başlığının değeri; verilmezse çalışma başına rastgele üretilir. */
  LLM_SESSION_ID: z.string().trim().max(128).optional(),

  /** Onaylayan/reddeden kişinin adı (tek kiracılı kurulumda kimlik yerine geçer). */
  ADMIN_ACTOR_NAME: z.string().trim().min(1).default("admin"),
});

export type AppEnv = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Ortam değişkenleri geçersiz: ${issues.join("; ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

let cached: AppEnv | null = null;

/**
 * Ortam değişkenlerini doğrular ve döner. Hata mesajında yalnızca alan adı ve
 * kural yer alır; hiçbir gizli değer yazdırılmaz.
 */
export function getEnv(): AppEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const field = issue.path.join(".") || "(kök)";
      return `${field}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }

  cached = parsed.data;
  return cached;
}

/** Testlerde ortam değişkenleri değiştirildiğinde önbelleği temizler. */
export function resetEnvCache(): void {
  cached = null;
}

/** Trendyol isteklerinde kullanılan User-Agent değeri (gizli bilgi içermez). */
export function resolveUserAgent(env: AppEnv): string {
  return env.TRENDYOL_USER_AGENT ?? `${env.TRENDYOL_SELLER_ID} - SelfIntegration`;
}
