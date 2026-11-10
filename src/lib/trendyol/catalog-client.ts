import { createLogger } from "@/lib/logger";
import { getEnv, resolveUserAgent } from "@/lib/env";
import { TrendyolApiError } from "./client";

/**
 * Trendyol ürün kataloğu — SALT OKUNUR istemci (GÖREV 010).
 *
 * Kullanılan resmî servisler (developers.trendyol.com):
 * - Ürün Filtreleme V1: `GET /integration/product/sellers/{sellerId}/products`
 *   Parametreler: `approved`, `productMainId`, `barcode`, `page`, `size`.
 * - Ürün Filtreleme - Temel Bilgiler V2: `GET /integration/product/sellers/{sellerId}/product/{barcode}`
 *
 * Yalnızca GET kullanılır; ürün oluşturma/güncelleme/silme çağrılmaz.
 * API anahtarı hiçbir log, hata mesajı veya veritabanı kaydına yazılmaz.
 */

const log = createLogger("trendyol.catalog");

export interface CatalogAttributeDto {
  attributeId: number;
  attributeName: string;
  attributeValue: string;
  attributeValueId?: number | null;
}

export interface CatalogProductDto {
  id: string;
  barcode: string;
  productMainId: string | null;
  title: string | null;
  description: string | null;
  brand: string | null;
  categoryName: string | null;
  approved: boolean;
  archived: boolean;
  attributes: CatalogAttributeDto[];
}

export interface CatalogPage {
  items: CatalogProductDto[];
  totalElements: number;
  totalPages: number;
  page: number;
  size: number;
}

export interface CatalogClientOptions {
  baseUrl?: string;
  sellerId?: string;
  apiKey?: string;
  apiSecret?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Testlerde fetch enjeksiyonu. */
  fetchImpl?: typeof fetch;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAttribute(raw: unknown): CatalogAttributeDto | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.attributeName === "string" ? record.attributeName.trim() : "";
  const value = typeof record.attributeValue === "string" ? record.attributeValue.trim() : "";
  if (!name || !value) return null;
  return {
    attributeId: toNumber(record.attributeId),
    attributeName: name,
    attributeValue: value,
    attributeValueId: record.attributeValueId == null ? null : toNumber(record.attributeValueId),
  };
}

export function normalizeCatalogProduct(raw: unknown): CatalogProductDto | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const barcode = typeof record.barcode === "string" ? record.barcode.trim() : "";
  if (!barcode) return null;

  const attributes = Array.isArray(record.attributes)
    ? record.attributes.map(normalizeAttribute).filter((item): item is CatalogAttributeDto => item !== null)
    : [];

  return {
    id: typeof record.id === "string" ? record.id : barcode,
    barcode,
    productMainId: typeof record.productMainId === "string" ? record.productMainId : null,
    title: typeof record.title === "string" ? record.title : null,
    description: typeof record.description === "string" ? record.description : null,
    brand: typeof record.brand === "string" ? record.brand : null,
    categoryName: typeof record.categoryName === "string" ? record.categoryName : null,
    approved: record.approved === true,
    archived: record.archived === true,
    attributes,
  };
}

export class CatalogClient {
  private readonly baseUrl: string;
  private readonly sellerId: string;
  private readonly authorization: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CatalogClientOptions = {}) {
    const env = getEnv();
    this.baseUrl = (options.baseUrl ?? new URL(env.TRENDYOL_BASE_URL).origin).replace(/\/+$/, "");
    this.sellerId = options.sellerId ?? env.TRENDYOL_SELLER_ID;
    const key = options.apiKey ?? env.TRENDYOL_API_KEY;
    const secret = options.apiSecret ?? env.TRENDYOL_API_SECRET;
    this.authorization = `Basic ${Buffer.from(`${key}:${secret}`, "utf8").toString("base64")}`;
    this.userAgent = resolveUserAgent(env);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Sınıflandırılmış hata; mesajda kimlik bilgisi yoktur. */
  private error(kind: "network" | "timeout" | "client" | "server" | "auth" | "forbidden" | "rate_limit", status: number | null, detail: string): TrendyolApiError {
    const message = status ? `Trendyol katalog isteği başarısız (HTTP ${status})` : `Trendyol katalog isteği başarısız (${detail})`;
    return new TrendyolApiError(message, {
      kind,
      status,
      retryable: kind === "rate_limit" || kind === "server" || kind === "timeout",
    });
  }

  private async getJson(path: string, params: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    let lastError: TrendyolApiError | null = null;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(url.toString(), {
          method: "GET",
          headers: {
            Authorization: this.authorization,
            Accept: "application/json",
            "User-Agent": this.userAgent,
          },
          signal: controller.signal,
        });

        if (response.status === 401) throw this.error("auth", 401, "unauthorized");
        if (response.status === 403) throw this.error("forbidden", 403, "forbidden");
        if (response.status === 429) throw this.error("rate_limit", 429, "rate limit");
        if (response.status >= 500) throw this.error("server", response.status, "server");
        if (!response.ok) throw this.error("client", response.status, "client");

        return (await response.json()) as unknown;
      } catch (error) {
        if (error instanceof TrendyolApiError) {
          lastError = error;
          if (!error.retryable) break;
        } else if (error instanceof Error && error.name === "AbortError") {
          lastError = this.error("timeout", null, "timeout");
        } else {
          lastError = this.error("network", null, "network");
        }

        if (attempt <= this.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    log.warn("catalog isteği başarısız", { path, code: lastError?.code });
    throw lastError ?? this.error("network", null, "unknown");
  }

  /**
   * Onaylı ürünleri `productMainId` ile filtreleyerek çeker.
   * Aynı `productMainId` altında çok sayıda barkod olabilir; sayfa sınırı aşılırsa
   * `truncated=true` döner ve kart yalnızca görülen varyantları kapsar.
   */
  async listByProductMainId(
    productMainId: string,
    options: { pageSize?: number; maxPages?: number } = {},
  ): Promise<{ items: CatalogProductDto[]; totalElements: number; truncated: boolean }> {
    const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
    const maxPages = Math.min(Math.max(options.maxPages ?? 3, 1), 10);
    const items: CatalogProductDto[] = [];
    let totalElements = 0;
    let totalPages = 0;

    for (let page = 0; page < maxPages; page += 1) {
      const raw = (await this.getJson(`/integration/product/sellers/${this.sellerId}/products`, {
        approved: true,
        productMainId,
        page,
        size: pageSize,
      })) as { content?: unknown[]; totalElements?: number; totalPages?: number };

      const content = Array.isArray(raw.content) ? raw.content : [];
      totalElements = toNumber(raw.totalElements);
      totalPages = toNumber(raw.totalPages);

      for (const row of content) {
        const parsed = normalizeCatalogProduct(row);
        if (parsed) items.push(parsed);
      }

      if (content.length < pageSize || page + 1 >= totalPages) break;
    }

    // Aynı barkod birden fazla sayfada gelirse tekilleştir.
    const byBarcode = new Map<string, CatalogProductDto>();
    for (const item of items) byBarcode.set(item.barcode, item);

    return {
      items: [...byBarcode.values()],
      totalElements,
      truncated: totalPages > maxPages || items.length > byBarcode.size,
    };
  }

  /** Tek barkodun temel bilgileri (V2). Salt okunur GET. */
  async getByBarcode(barcode: string): Promise<CatalogProductDto | null> {
    const raw = (await this.getJson(`/integration/product/sellers/${this.sellerId}/product/${encodeURIComponent(barcode)}`, {})) as
      | Record<string, unknown>
      | null;
    if (!raw) return null;
    const candidate = Array.isArray(raw.content) ? raw.content[0] : raw;
    return normalizeCatalogProduct(candidate);
  }
}
