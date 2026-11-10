import type { PrismaClient } from "@/generated/prisma/client";
import { createLogger } from "@/lib/logger";
import { getPrisma } from "@/lib/prisma";
import { CatalogClient, type CatalogClientOptions } from "@/lib/trendyol/catalog-client";
import { listAttributeNames } from "./catalog-extract";

/**
 * Trendyol kataloğundan ürün anlık görüntüsü çekme (GÖREV 010).
 *
 * - Yalnızca GET; hiçbir ürün oluşturma/güncelleme çağrısı yok.
 * - Eşleştirme yalnızca `productMainId` üzerinden yapılır; farklı ana ürünler birleştirilmez.
 * - Bir ana ürün altındaki varyantlardan yalnızca görülenler saklanır; sayfalama sınırı
 *   aşılırsa `truncated=true` işaretlenir ve özellikler "tüm varyantlar" sayılmaz.
 */

const log = createLogger("products.catalog-sync");

export interface CatalogSyncResult {
  requested: number;
  synced: number;
  notFound: number;
  failed: number;
  variants: number;
  truncated: number;
  products: Array<{
    productMainId: string;
    status: "SYNCED" | "NOT_FOUND" | "FAILED";
    variants: number;
    title: string | null;
    truncated: boolean;
    errorCode?: string;
  }>;
}

export interface CatalogSyncOptions {
  client?: CatalogClient;
  prisma?: PrismaClient;
  pageSize?: number;
  maxPages?: number;
  /** İstekler arasında bekleme (ms) — Trendyol hız sınırına saygı. */
  delayMs?: number;
}

export async function syncCatalog(
  input: { storeId: string; productMainIds?: string[]; limit?: number },
  options: CatalogSyncOptions = {},
): Promise<CatalogSyncResult> {
  const prisma = options.prisma ?? getPrisma();
  const client = options.client ?? new CatalogClient();
  const delayMs = Math.max(options.delayMs ?? 150, 0);

  let productMainIds = input.productMainIds;
  if (!productMainIds || productMainIds.length === 0) {
    const rows = await prisma.question.groupBy({
      by: ["productMainId"],
      where: { storeId: input.storeId, productMainId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { productMainId: "desc" } },
      take: Math.min(input.limit ?? 10, 50),
    });
    productMainIds = rows.map((row) => row.productMainId).filter((id): id is string => Boolean(id));
  }

  const result: CatalogSyncResult = {
    requested: productMainIds.length,
    synced: 0,
    notFound: 0,
    failed: 0,
    variants: 0,
    truncated: 0,
    products: [],
  };

  for (const productMainId of productMainIds) {
    try {
      const page = await client.listByProductMainId(productMainId, {
        pageSize: options.pageSize,
        maxPages: options.maxPages,
      });

      if (page.items.length === 0) {
        result.notFound += 1;
        result.products.push({ productMainId, status: "NOT_FOUND", variants: 0, title: null, truncated: false });
        await prisma.catalogProduct.upsert({
          where: { storeId_productMainId: { storeId: input.storeId, productMainId } },
          update: { lastError: "Katalogda bulunamadı", fetchedAt: new Date() },
          create: { storeId: input.storeId, productMainId, lastError: "Katalogda bulunamadı" },
        });
        continue;
      }

      const first = page.items[0];
      const description = first.description ?? null;
      const attributes = page.items.flatMap((item) =>
        item.attributes.map((attribute) => ({
          name: attribute.attributeName,
          value: attribute.attributeValue,
          barcode: item.barcode,
        })),
      );

      await prisma.catalogProduct.upsert({
        where: { storeId_productMainId: { storeId: input.storeId, productMainId } },
        update: {
          title: first.title,
          brand: first.brand,
          categoryName: first.categoryName,
          description,
          barcodeSample: first.barcode,
          variantCount: page.items.length,
          truncated: page.truncated,
          attributes: attributes as unknown as object,
          attributeNames: listAttributeNames(page.items) as unknown as object,
          fetchedAt: new Date(),
          lastError: null,
        },
        create: {
          storeId: input.storeId,
          productMainId,
          title: first.title,
          brand: first.brand,
          categoryName: first.categoryName,
          description,
          barcodeSample: first.barcode,
          variantCount: page.items.length,
          truncated: page.truncated,
          attributes: attributes as unknown as object,
          attributeNames: listAttributeNames(page.items) as unknown as object,
        },
      });

      result.synced += 1;
      result.variants += page.items.length;
      if (page.truncated) result.truncated += 1;
      result.products.push({
        productMainId,
        status: "SYNCED",
        variants: page.items.length,
        title: first.title,
        truncated: page.truncated,
      });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
      result.failed += 1;
      result.products.push({
        productMainId,
        status: "FAILED",
        variants: 0,
        title: null,
        truncated: false,
        errorCode: code,
      });
      await prisma.catalogProduct.upsert({
        where: { storeId_productMainId: { storeId: input.storeId, productMainId } },
        update: { lastError: code, fetchedAt: new Date() },
        create: { storeId: input.storeId, productMainId, lastError: code },
      });
      log.warn("katalog senkronu başarısız", { productMainId, code });
    }

    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return result;
}

export type CatalogClientFactory = (options?: CatalogClientOptions) => CatalogClient;
