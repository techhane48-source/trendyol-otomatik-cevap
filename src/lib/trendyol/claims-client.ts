import { z } from "zod";

import { getEnv, type AppEnv } from "@/lib/env";

/**
 * Trendyol iade (claim) istemcisi — SALT OKUNUR (GÖREV 016).
 *
 * Yalnızca GET. İade kaydı/onay durumu görülebilir; banka/PSP hareketi
 * görülemediği için "ücret hesaba geçti" iddiası bu veriyle KURULAMAZ.
 */

const claimItemSchema = z.looseObject({
  status: z.string().optional(),
  claimItemStatus: z.string().optional(),
  name: z.string().optional(),
});

const claimSchema = z
  .looseObject({
    claimId: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    orderNumber: z.union([z.string(), z.number()]).optional(),
    claimDate: z.number().optional(),
    claimItemStatus: z.string().optional(),
    items: z.array(claimItemSchema).optional(),
  })
  .transform((raw) => ({
    claimId: raw.claimId === undefined ? (raw.id === undefined ? null : String(raw.id)) : String(raw.claimId),
    orderNumber: raw.orderNumber === undefined ? null : String(raw.orderNumber),
    claimDate: raw.claimDate ? new Date(raw.claimDate) : null,
    status: raw.claimItemStatus ?? null,
    itemStatuses: (raw.items ?? []).map((item) => item.claimItemStatus ?? item.status ?? null).filter(Boolean) as string[],
  }));

const claimsPageSchema = z.looseObject({ content: z.array(claimSchema).optional() });

export type ClaimDto = z.infer<typeof claimSchema>;

export interface ClaimsClientConfig {
  baseUrl: string;
  sellerId: string;
  apiKey: string;
  apiSecret: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function claimsConfigFromEnv(env: AppEnv = getEnv()): ClaimsClientConfig {
  return {
    baseUrl: env.ORDERS_BASE_URL,
    sellerId: env.TRENDYOL_SELLER_ID,
    apiKey: env.TRENDYOL_API_KEY,
    apiSecret: env.TRENDYOL_API_SECRET,
    timeoutMs: env.TRENDYOL_TIMEOUT_MS,
  };
}

export class ClaimsApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ClaimsApiError";
    this.code = code;
  }
}

export function createClaimsClient(config: ClaimsClientConfig = claimsConfigFromEnv()) {
  const doFetch = config.fetchImpl ?? fetch;
  const root = `${config.baseUrl.replace(/\/+$/, "")}/sellers/${config.sellerId}/claims`;
  const auth = `Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString("base64")}`;

  return {
    async fetchClaims(query: { orderNumber: string; size?: number }): Promise<ClaimDto[]> {
      const params = new URLSearchParams({
        orderNumber: query.orderNumber,
        size: String(query.size ?? 10),
        page: "0",
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await doFetch(`${root}?${params.toString()}`, {
          method: "GET",
          headers: { authorization: auth, accept: "application/json", "user-agent": "trendyol-soru-asistani/0.1" },
          signal: controller.signal,
        });
        if (!response.ok) throw new ClaimsApiError(`HTTP_${response.status}`, "İade API isteği reddedildi.");
        const parsed = claimsPageSchema.safeParse(await response.json());
        if (!parsed.success) throw new ClaimsApiError("INVALID_SCHEMA", "İade API yanıtı beklenen şemaya uymuyor.");
        return parsed.data.content ?? [];
      } catch (error) {
        if (error instanceof ClaimsApiError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
          throw new ClaimsApiError("TIMEOUT", "İade API isteği zaman aşımına uğradı.");
        }
        throw new ClaimsApiError("NETWORK", "İade API'sine ulaşılamadı.");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type ClaimsClient = ReturnType<typeof createClaimsClient>;

/** İade durumunu Türkçe ve ihtiyatlı biçimde özetler; para hareketi iddiası kurmaz. */
export function describeClaims(claims: ClaimDto[]): string {
  if (claims.length === 0) {
    return "- Bu sipariş için Trendyol'da görünür bir iade (claim) kaydı YOK. “İade yok” demek yerine kaydın görünmediğini söyle.";
  }

  const lines = claims.slice(0, 3).map((claim) => {
    const when = claim.claimDate
      ? claim.claimDate.toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" })
      : "tarih yok";
    return `- İade kaydı: ${claim.status ?? "durum belirtilmemiş"} (${when})`;
  });

  lines.push(
    "- İade kaydı, iadenin ONAYLANDIĞI veya ücretin hesaba GEÇTİĞİ anlamına gelmez; banka/ödeme sağlayıcı verisi bu sistemde yok.",
  );
  return lines.join("\n");
}
