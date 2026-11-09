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
  TRENDYOL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
