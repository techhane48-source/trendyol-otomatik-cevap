import type { PrismaClient } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";

/**
 * Ürün bilgi kartı servisi.
 *
 * Kurallar:
 * - Kart mağaza + ürün kimliğiyle eşleşir; ana ürün ve varyant ayrı tutulur.
 * - Düzenleme, doğrulanmış (VERIFIED) kartı yeniden DRAFT'a düşürür: doğrulama
 *   her zaman son hâle aittir.
 * - Her işlem `ProductInfoEvent` olarak geçmişe yazılır (önceki değerlerle birlikte).
 * - Bu servis Trendyol'a hiçbir istek atmayan yerel bir bilgi tabanıdır.
 */

export interface ProductAttribute {
  label: string;
  value: string;
}

export interface ProductInfoView {
  id: string;
  storeId: string;
  productMainId: string;
  productId: string | null;
  title: string | null;
  attributes: ProductAttribute[];
  notes: string | null;
  status: "DRAFT" | "VERIFIED";
  verifiedBy: string | null;
  verifiedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class ProductInfoError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProductInfoError";
    this.code = code;
  }
}

export interface ProductActor {
  name: string;
}

export interface ProductDeps {
  prisma?: PrismaClient;
}

function requireActor(actor: ProductActor | undefined): string {
  const name = actor?.name?.trim();
  if (!name) throw new ProductInfoError("UNAUTHORIZED", "Bu işlem için yetkilendirme gerekli.");
  return name;
}

/** "Etiket: Değer" satırlarından özellik listesi üretir (`/products` formu). */
export function parseAttributesText(raw: string): ProductAttribute[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf(":");
      const altSeparator = line.indexOf("=");
      const index = separator >= 0 ? separator : altSeparator;
      if (index <= 0) {
        throw new ProductInfoError("INVALID_ATTRIBUTE", `Özellik satırı "Etiket: Değer" biçiminde olmalı: ${line}`);
      }
      return {
        label: line.slice(0, index).trim(),
        value: line.slice(index + 1).trim(),
      };
    })
    .filter((attribute) => attribute.label.length > 0 && attribute.value.length > 0);
}

function normalizeAttributes(value: unknown): ProductAttribute[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is ProductAttribute => {
      if (typeof item !== "object" || item === null) return false;
      const record = item as Record<string, unknown>;
      return typeof record.label === "string" && typeof record.value === "string";
    })
    .map((item) => ({ label: item.label, value: item.value }));
}

function toView(row: {
  id: string;
  storeId: string;
  productMainId: string;
  productId: string | null;
  title: string | null;
  attributes: unknown;
  notes: string | null;
  status: "DRAFT" | "VERIFIED";
  verifiedBy: string | null;
  verifiedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ProductInfoView {
  return { ...row, attributes: normalizeAttributes(row.attributes) };
}

function validateAttributes(attributes: ProductAttribute[]): ProductAttribute[] {
  if (attributes.length > 30) {
    throw new ProductInfoError("INVALID_ATTRIBUTE", "En fazla 30 özellik eklenebilir.");
  }

  return attributes.map((attribute) => {
    const label = attribute.label.trim();
    const value = attribute.value.trim();
    if (label.length === 0 || value.length === 0) {
      throw new ProductInfoError("INVALID_ATTRIBUTE", "Özellik etiketi ve değeri boş olamaz.");
    }
    if (label.length > 60 || value.length > 300) {
      throw new ProductInfoError("INVALID_ATTRIBUTE", "Özellik etiketi 60, değeri 300 karakteri aşamaz.");
    }
    return { label, value };
  });
}

async function resolveStoreId(
  prisma: PrismaClient,
  input: { storeId?: string | null; sellerId?: string | number | bigint | null },
): Promise<string> {
  if (input.storeId) {
    const store = await prisma.store.findUnique({ where: { id: input.storeId }, select: { id: true } });
    if (!store) throw new ProductInfoError("STORE_NOT_FOUND", "Mağaza bulunamadı.");
    return store.id;
  }

  if (input.sellerId === null || input.sellerId === undefined || String(input.sellerId).trim() === "") {
    throw new ProductInfoError("STORE_REQUIRED", "Mağaza (storeId veya sellerId) zorunlu.");
  }

  const sellerId = BigInt(String(input.sellerId).trim());
  const store = await prisma.store.upsert({
    where: { sellerId },
    create: { sellerId },
    update: {},
    select: { id: true },
  });
  return store.id;
}

/**
 * Ana ürün kartı (productId IS NULL) yalnızca TÜM varyantlarda ortak olan
 * doğrulanmış özellikleri temsil edebilir. Varyantlar arasında farklılaşan
 * (ya da bazı varyantlarda hiç olmayan) bir etiket ana karta yazılamaz.
 */
async function assertMainCardOnlyCommonAttributes(
  prisma: PrismaClient,
  storeId: string,
  productMainId: string,
  attributes: ProductAttribute[],
): Promise<void> {
  if (attributes.length === 0) return;

  const variants = await prisma.productInfo.findMany({
    where: { storeId, productMainId, productId: { not: null } },
    select: { attributes: true },
  });
  if (variants.length === 0) return;

  const perVariant = variants.map((variant) => {
    const list = Array.isArray(variant.attributes) ? (variant.attributes as unknown as ProductAttribute[]) : [];
    return new Map(list.map((item) => [item.label.trim().toLowerCase(), item.value.trim()]));
  });

  const common = new Map<string, string>();
  for (const [label, value] of perVariant[0]) {
    if (perVariant.every((map) => map.get(label) === value)) common.set(label, value);
  }

  const conflicts = attributes.filter((attribute) => !common.has(attribute.label.trim().toLowerCase()));

  if (conflicts.length > 0) {
    throw new ProductInfoError(
      "MAIN_CARD_CONFLICT",
      `Ana ürün kartı yalnızca varyantlarda ortak olan bilgileri içerebilir. Çıkarılması gereken alanlar: ${conflicts
        .map((attribute) => attribute.label)
        .join(", ")}. Varyanta özel bilgiyi varyant kartına girin.`,
    );
  }
}

export async function createProductInfo(
  input: {
    storeId?: string | null;
    sellerId?: string | number | bigint | null;
    productMainId: string;
    productId?: string | null;
    title?: string | null;
    attributes: ProductAttribute[];
    notes?: string | null;
    actor: ProductActor;
  },
  deps: ProductDeps = {},
): Promise<ProductInfoView> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const productMainId = input.productMainId.trim();
  if (productMainId.length === 0) {
    throw new ProductInfoError("INVALID_PRODUCT_ID", "Ürün kimliği (productMainId) zorunlu.");
  }
  if (productMainId.length > 64) {
    throw new ProductInfoError("INVALID_PRODUCT_ID", "Ürün kimliği en fazla 64 karakter olabilir.");
  }

  const productId = input.productId?.trim() || null;
  if (productId && productId.length > 64) {
    throw new ProductInfoError("INVALID_PRODUCT_ID", "Varyant kimliği en fazla 64 karakter olabilir.");
  }

  const attributes = validateAttributes(input.attributes);
  const storeId = await resolveStoreId(prisma, { storeId: input.storeId, sellerId: input.sellerId });

  const existing = await prisma.productInfo.findFirst({
    where: { storeId, productMainId, productId },
    select: { id: true },
  });
  if (existing) {
    throw new ProductInfoError(
      "DUPLICATE_PRODUCT_INFO",
      "Bu mağaza ve ürün kimliği için kayıt zaten var. Düzenleyin.",
    );
  }

  if (productId === null) {
    await assertMainCardOnlyCommonAttributes(prisma, storeId, productMainId, attributes);
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.productInfo.create({
      data: {
        storeId,
        productMainId,
        productId,
        title: input.title?.trim() || null,
        attributes: attributes as unknown as object,
        notes: input.notes?.trim() || null,
        status: "DRAFT",
        createdBy: actorName,
      },
    });

    await tx.productInfoEvent.create({
      data: {
        productInfoId: row.id,
        action: "CREATED",
        actor: actorName,
        changes: { after: { title: row.title, attributes } } as unknown as object,
      },
    });

    return row;
  });

  return toView(created);
}

/**
 * Kartı günceller. Doğrulanmış kart düzenlenirse **yeniden DRAFT** olur
 * (doğrulama her zaman güncel içerik için geçerlidir).
 */
export async function updateProductInfo(
  input: {
    id: string;
    title?: string | null;
    attributes?: ProductAttribute[];
    notes?: string | null;
    productId?: string | null;
    actor: ProductActor;
  },
  deps: ProductDeps = {},
): Promise<ProductInfoView> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const current = await prisma.productInfo.findUnique({ where: { id: input.id } });
  if (!current) throw new ProductInfoError("PRODUCT_INFO_NOT_FOUND", "Ürün bilgi kartı bulunamadı.");

  const attributes = input.attributes ? validateAttributes(input.attributes) : normalizeAttributes(current.attributes);
  const productId = input.productId === undefined ? current.productId : input.productId?.trim() || null;

  if (productId === null) {
    await assertMainCardOnlyCommonAttributes(prisma, current.storeId, current.productMainId, attributes);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.productInfo.update({
      where: { id: input.id },
      data: {
        title: input.title === undefined ? current.title : input.title?.trim() || null,
        attributes: attributes as unknown as object,
        notes: input.notes === undefined ? current.notes : input.notes?.trim() || null,
        productId,
        status: "DRAFT",
        verifiedBy: null,
        verifiedAt: null,
      },
    });

    await tx.productInfoEvent.create({
      data: {
        productInfoId: row.id,
        action: "UPDATED",
        actor: actorName,
        changes: {
          before: {
            title: current.title,
            attributes: normalizeAttributes(current.attributes),
            notes: current.notes,
            productId: current.productId,
            status: current.status,
          },
          after: { title: row.title, attributes, notes: row.notes, productId: row.productId, status: row.status },
        } as unknown as object,
      },
    });

    if (current.status === "VERIFIED") {
      await tx.productInfoEvent.create({
        data: {
          productInfoId: row.id,
          action: "UNVERIFIED",
          actor: actorName,
          note: "İçerik değişti; yeniden doğrulama gerekli.",
        },
      });
    }

    return row;
  });

  return toView(updated);
}

/** Kartı doğrular: doğrulayan kişi ve zaman kaydedilir. */
export async function verifyProductInfo(
  input: { id: string; actor: ProductActor; note?: string | null },
  deps: ProductDeps = {},
): Promise<ProductInfoView> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const current = await prisma.productInfo.findUnique({ where: { id: input.id } });
  if (!current) throw new ProductInfoError("PRODUCT_INFO_NOT_FOUND", "Ürün bilgi kartı bulunamadı.");
  if (current.status === "VERIFIED") {
    throw new ProductInfoError("ALREADY_VERIFIED", "Kart zaten doğrulanmış.");
  }
  if (normalizeAttributes(current.attributes).length === 0) {
    throw new ProductInfoError("EMPTY_PRODUCT_INFO", "Doğrulamak için en az bir özellik girilmelidir.");
  }

  const verified = await prisma.$transaction(async (tx) => {
    const row = await tx.productInfo.update({
      where: { id: current.id },
      data: { status: "VERIFIED", verifiedBy: actorName, verifiedAt: new Date() },
    });

    await tx.productInfoEvent.create({
      data: {
        productInfoId: row.id,
        action: "VERIFIED",
        actor: actorName,
        note: input.note?.trim() || null,
      },
    });

    return row;
  });

  return toView(verified);
}

/** Doğrulamayı geri alır (kart yeniden DRAFT olur). */
export async function unverifyProductInfo(
  input: { id: string; actor: ProductActor; note?: string | null },
  deps: ProductDeps = {},
): Promise<ProductInfoView> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const current = await prisma.productInfo.findUnique({ where: { id: input.id } });
  if (!current) throw new ProductInfoError("PRODUCT_INFO_NOT_FOUND", "Ürün bilgi kartı bulunamadı.");
  if (current.status === "DRAFT") {
    throw new ProductInfoError("NOT_VERIFIED", "Kart zaten doğrulanmamış durumda.");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.productInfo.update({
      where: { id: current.id },
      data: { status: "DRAFT", verifiedBy: null, verifiedAt: null },
    });

    await tx.productInfoEvent.create({
      data: {
        productInfoId: row.id,
        action: "UNVERIFIED",
        actor: actorName,
        note: input.note?.trim() || null,
      },
    });

    return row;
  });

  return toView(updated);
}

/** Panel araması: ürün kimliği / varyant kimliği / başlık içinde arar. */
export async function listProductInfos(
  options: { query?: string | null; status?: "DRAFT" | "VERIFIED" | null; limit?: number } = {},
  deps: ProductDeps = {},
): Promise<ProductInfoView[]> {
  const prisma = deps.prisma ?? getPrisma();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const query = options.query?.trim();

  const rows = await prisma.productInfo.findMany({
    where: {
      ...(options.status ? { status: options.status } : {}),
      ...(query
        ? {
            OR: [
              { productMainId: { contains: query, mode: "insensitive" as const } },
              { productId: { contains: query, mode: "insensitive" as const } },
              { title: { contains: query, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }],
    take: limit,
  });

  return rows.map(toView);
}

/** Kart geçmişi (değişiklik kayıtları). */
export async function getProductInfoHistory(id: string, deps: ProductDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();

  return prisma.productInfoEvent.findMany({
    where: { productInfoId: id },
    orderBy: { createdAt: "asc" },
  });
}

/** Soruya uygulanacak kartı (mağaza kapsamında) bulur. */
export async function findProductInfoForQuestion(
  question: { storeId: string; productMainId: string | null; productId: string | null },
  deps: ProductDeps = {},
) {
  const prisma = deps.prisma ?? getPrisma();
  if (!question.productMainId) return [];

  return prisma.productInfo.findMany({
    where: { storeId: question.storeId, productMainId: question.productMainId },
    select: {
      id: true,
      storeId: true,
      productMainId: true,
      productId: true,
      title: true,
      attributes: true,
      status: true,
    },
  });
}
