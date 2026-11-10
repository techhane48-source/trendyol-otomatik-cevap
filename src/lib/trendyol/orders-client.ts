import { z } from "zod";

import { getEnv, type AppEnv } from "@/lib/env";

/**
 * Trendyol sipariş (getShipmentPackages) istemcisi — SALT OKUNUR.
 *
 * - Yalnızca GET kullanılır; sipariş güncelleme/iptal gibi hiçbir yazma çağrısı yoktur.
 * - Adres, telefon, e-posta, kimlik ve ödeme alanları okunmaz/saklanmaz.
 * - Kimlik bilgileri mevcut env sisteminden gelir; loglanmaz.
 */

const orderLineSchema = z
  .looseObject({
    lineId: z.union([z.number(), z.string()]).optional(),
    productId: z.union([z.number(), z.string()]).optional(),
    productMainId: z.union([z.number(), z.string()]).optional(),
    barcode: z.union([z.number(), z.string()]).optional(),
    productName: z.string().optional(),
    quantity: z.number().optional(),
    status: z.string().optional(),
  })
  .transform((raw) => ({
    lineId: raw.lineId === undefined ? null : String(raw.lineId),
    productId: raw.productId === undefined ? null : String(raw.productId),
    productMainId: raw.productMainId === undefined ? null : String(raw.productMainId),
    productName: raw.productName ?? null,
    quantity: raw.quantity ?? 1,
    status: raw.status ?? null,
  }));

const orderPackageSchema = z
  .looseObject({
    shipmentPackageId: z.union([z.number(), z.string()]).optional(),
    orderNumber: z.union([z.number(), z.string()]).optional(),
    status: z.string().optional(),
    orderDate: z.number().optional(),
    customerId: z.union([z.number(), z.string()]).optional(),
    lines: z.array(orderLineSchema).optional(),
  })
  .transform((raw) => ({
    shipmentPackageId: raw.shipmentPackageId === undefined ? null : String(raw.shipmentPackageId),
    orderNumber: raw.orderNumber === undefined ? null : String(raw.orderNumber),
    status: raw.status ?? "Unknown",
    orderDate: raw.orderDate ? new Date(raw.orderDate) : null,
    customerId: raw.customerId === undefined ? null : String(raw.customerId),
    lines: raw.lines ?? [],
  }));

const ordersPageSchema = z.looseObject({
  page: z.number().optional(),
  size: z.number().optional(),
  totalPages: z.number().optional(),
  totalElements: z.number().optional(),
  content: z.array(orderPackageSchema),
});

export type OrderLineDto = z.infer<typeof orderLineSchema>;
export type OrderPackageDto = z.infer<typeof orderPackageSchema>;

export interface OrdersQuery {
  page?: number;
  size?: number;
  status?: string;
  orderNumber?: string;
  startDate?: number;
  endDate?: number;
  /** Cursor tabanlı akış için son görülen paket kimliği */
  cursor?: string;
}

export interface OrdersPageResult {
  content: OrderPackageDto[];
  page: number;
  size: number;
  totalPages: number | null;
  totalElements: number | null;
}

export interface OrdersClientConfig {
  baseUrl: string;
  sellerId: string;
  apiKey: string;
  apiSecret: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  fetchImpl?: typeof fetch;
}

export function ordersConfigFromEnv(env: AppEnv = getEnv()): OrdersClientConfig {
  return {
    baseUrl: env.ORDERS_BASE_URL,
    sellerId: env.TRENDYOL_SELLER_ID,
    apiKey: env.TRENDYOL_API_KEY,
    apiSecret: env.TRENDYOL_API_SECRET,
    timeoutMs: env.TRENDYOL_TIMEOUT_MS,
    maxRetries: env.SYNC_MAX_RETRIES,
    retryBaseMs: env.SYNC_RETRY_BASE_MS,
  };
}

export class OrdersApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OrdersApiError";
    this.code = code;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function createOrdersClient(config: OrdersClientConfig = ordersConfigFromEnv()) {
  const doFetch = config.fetchImpl ?? fetch;
  const root = `${config.baseUrl.replace(/\/+$/, "")}/sellers/${config.sellerId}/orders`;
  const auth = `Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString("base64")}`;

  function buildUrl(query: OrdersQuery): string {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set("page", String(query.page));
    if (query.size !== undefined) params.set("size", String(query.size));
    if (query.status) params.set("status", query.status);
    if (query.orderNumber) params.set("orderNumber", query.orderNumber);
    if (query.startDate !== undefined) params.set("startDate", String(query.startDate));
    if (query.endDate !== undefined) params.set("endDate", String(query.endDate));
    const suffix = params.toString();
    return suffix ? `${root}?${suffix}` : root;
  }

  async function getJson(url: string, attempt = 0): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await doFetch(url, {
        method: "GET",
        headers: {
          authorization: auth,
          "user-agent": "trendyol-soru-asistani/0.1",
          accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        if (RETRYABLE.has(response.status) && attempt < config.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, config.retryBaseMs * Math.pow(2, attempt)));
          return getJson(url, attempt + 1);
        }
        throw new OrdersApiError(`HTTP_${response.status}`, `Sipariş API isteği reddedildi (HTTP ${response.status}).`);
      }

      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof OrdersApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new OrdersApiError("TIMEOUT", "Sipariş API isteği zaman aşımına uğradı.");
      }
      if (attempt < config.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, config.retryBaseMs * Math.pow(2, attempt)));
        return getJson(url, attempt + 1);
      }
      throw new OrdersApiError("NETWORK", "Sipariş API'sine ulaşılamadı.");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** Tek sayfa sipariş paketi (salt okunur GET). */
    async fetchOrdersPage(query: OrdersQuery = {}): Promise<OrdersPageResult> {
      const raw = await getJson(buildUrl(query));
      const parsed = ordersPageSchema.safeParse(raw);
      if (!parsed.success) {
        throw new OrdersApiError("INVALID_SCHEMA", "Sipariş API yanıtı beklenen şemaya uymuyor.");
      }
      return {
        content: parsed.data.content,
        page: parsed.data.page ?? query.page ?? 0,
        size: parsed.data.size ?? query.size ?? parsed.data.content.length,
        totalPages: parsed.data.totalPages ?? null,
        totalElements: parsed.data.totalElements ?? null,
      };
    },

    /**
     * Cursor tabanlı artımlı senkronizasyon için `/orders/stream` uç noktasını kullanır.
     * Not: Akış uç noktası sağlayıcı tarafında yeni paketleri sırayla döndürür.
     */
    async fetchOrdersStream(cursor?: string): Promise<{ packages: OrderPackageDto[]; nextCursor: string | null }> {
      const url = cursor ? `${root}/stream?cursor=${encodeURIComponent(cursor)}` : `${root}/stream`;
      const raw = await getJson(url);
      const parsed = z
        .looseObject({
          content: z.array(orderPackageSchema).optional(),
          packages: z.array(orderPackageSchema).optional(),
          cursor: z.union([z.string(), z.number()]).optional(),
          nextCursor: z.union([z.string(), z.number()]).optional(),
        })
        .safeParse(raw);

      if (!parsed.success) {
        throw new OrdersApiError("INVALID_SCHEMA", "Sipariş akışı yanıtı beklenen şemaya uymuyor.");
      }

      const packages = parsed.data.content ?? parsed.data.packages ?? [];
      const next = parsed.data.nextCursor ?? parsed.data.cursor ?? null;
      return { packages, nextCursor: next === null ? null : String(next) };
    },
  };
}

export type OrdersClient = ReturnType<typeof createOrdersClient>;
