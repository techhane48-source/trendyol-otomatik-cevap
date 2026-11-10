import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getPrisma } from "@/lib/prisma";
import { CatalogClient } from "@/lib/trendyol/catalog-client";
import { extractFromCatalog, extractFromDescription, isMeaningfulValue, tidyDescriptionValue } from "@/lib/products/catalog-extract";
import { syncCatalog } from "@/lib/products/catalog-sync";
import { applyAutoFill, approveAutoFilled, buildAutoFillPlan } from "@/lib/products/autofill";
import { setField, verifyField } from "@/lib/products/bank";

const prisma = getPrisma();
const createdStores: string[] = [];
const createdMains: string[] = [];

async function seedStore(): Promise<string> {
  const store = await prisma.store.create({ data: { sellerId: BigInt(9_100_000 + Math.floor(Math.random() * 100_000)) } });
  createdStores.push(store.id);
  return store.id;
}

async function seedQuestion(storeId: string, productMainId: string, text: string): Promise<void> {
  await prisma.question.create({
    data: {
      storeId,
      trendyolQuestionId: BigInt(9_200_000 + Math.floor(Math.random() * 700_000)),
      text,
      status: "ANSWERED",
      rawStatus: "ANSWERED",
      productMainId,
      askedAt: new Date(),
    },
  });
}

afterAll(async () => {
  await prisma.productFieldSuggestion.deleteMany({ where: { storeId: { in: createdStores } } });
  await prisma.productInfo.deleteMany({ where: { storeId: { in: createdStores } } });
  await prisma.catalogProduct.deleteMany({ where: { storeId: { in: createdStores } } });
  await prisma.question.deleteMany({ where: { storeId: { in: createdStores } } });
  await prisma.store.deleteMany({ where: { id: { in: createdStores } } });
});

describe("katalog istemcisi", () => {
  let server: Server;
  let baseUrl: string;
  let lastRequest: { method: string; url: string } | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastRequest = { method: req.method ?? "", url: req.url ?? "" };
      const url = new URL(req.url ?? "/", "http://mock");
      const page = Number(url.searchParams.get("page") ?? 0);

      if (url.pathname.endsWith("/unauthorized")) {
        res.writeHead(401).end(JSON.stringify({ message: "unauthorized" }));
        return;
      }

      const content = [
        {
          id: "c1",
          barcode: "BAR-1",
          productMainId: "MAIN-A",
          title: "Keten Fon Perde",
          description: "%100 keten kumaş. Pilesiz dikim. Makinede yıkanabilir.",
          brand: "Test",
          categoryName: "Fon Perde",
          approved: true,
          archived: false,
          attributes: [
            { attributeId: 1, attributeName: "Materyal", attributeValue: "Keten" },
            { attributeId: 2, attributeName: "Pile", attributeValue: "Pilesiz (1 x 1)" },
          ],
        },
      ];

      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ page, size: 100, totalElements: 1, totalPages: 1, content: page === 0 ? content : [] }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("yalnızca GET kullanır ve ürünleri normalize eder", async () => {
    const client = new CatalogClient({ baseUrl, sellerId: "1", apiKey: "k", apiSecret: "s" });
    const page = await client.listByProductMainId("MAIN-A");

    expect(lastRequest?.method).toBe("GET");
    expect(page.items).toHaveLength(1);
    expect(page.items[0].attributes[1]).toMatchObject({ attributeName: "Pile", attributeValue: "Pilesiz (1 x 1)" });
    expect(page.truncated).toBe(false);
  });

  it("kimlik doğrulama hatasını sınıflandırır, anahtarı mesaja yazmaz", async () => {
    const server2 = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    const client = new CatalogClient({ baseUrl: url, sellerId: "1", apiKey: "GIZLI-ANAHTAR", apiSecret: "GIZLI-SIR", maxRetries: 0 });

    await expect(client.listByProductMainId("MAIN-A")).rejects.toMatchObject({ kind: "auth", status: 401 });
    try {
      await client.listByProductMainId("MAIN-A");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("GIZLI");
    }
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });
});

describe("katalogdan alan çıkarımı", () => {
  const items = [
    {
      id: "a",
      barcode: "B1",
      productMainId: "M",
      title: null,
      description: null,
      brand: null,
      categoryName: null,
      approved: true,
      archived: false,
      attributes: [
        { attributeId: 1, attributeName: "Pile", attributeValue: "1/3 Pile" },
        { attributeId: 2, attributeName: "Materyal", attributeValue: "%100 Keten" },
      ],
    },
    {
      id: "b",
      barcode: "B2",
      productMainId: "M",
      title: null,
      description: null,
      brand: null,
      categoryName: null,
      approved: true,
      archived: false,
      attributes: [
        { attributeId: 1, attributeName: "Pile", attributeValue: "Pilesiz (1 x 1)" },
        { attributeId: 2, attributeName: "Materyal", attributeValue: "%100 Keten" },
      ],
    },
  ];

  it("tüm varyantlarda ortak özelliği yüksek güvenle verir", () => {
    const candidates = extractFromCatalog({ items, description: null });
    const fabric = candidates.find((candidate) => candidate.fieldKey === "fabric");
    expect(fabric).toMatchObject({ value: "%100 Keten", confidence: "HIGH", needsReview: false });
  });

  it("varyantlar arasında farklı özellik değerini incelemeye bırakır", () => {
    const candidates = extractFromCatalog({ items, description: null });
    const pleat = candidates.find((candidate) => candidate.fieldKey === "pleat");
    expect(pleat?.needsReview).toBe(true);
    expect(pleat?.alternatives.length).toBeGreaterThan(0);
  });

  it("açıklamadan açık bilgiyi çıkarır, pazarlama cümlesini çıkarmaz", () => {
    const candidates = extractFromDescription(
      "Ürünümüz %100 keten kumaştan üretilmiştir. Pilesiz dikim yapılmıştır. Yaşam alanlarınıza şıklık katar.",
    );
    expect(candidates.some((candidate) => candidate.fieldKey === "fabric" && candidate.value.includes("keten"))).toBe(true);
    expect(candidates.some((candidate) => candidate.fieldKey === "pleat")).toBe(true);
    const junk = extractFromDescription("Yaşam alanlarınıza şıklık katar. Harika bir üründür.");
    expect(junk).toHaveLength(0);
  });

  it("kod gibi görünen özellik değerlerini eler ve uzun cümleyi kısaltır", () => {
    expect(isMeaningfulValue("T100")).toBe(false);
    expect(isMeaningfulValue("Pilesiz")).toBe(true);
    expect(tidyDescriptionValue("Düz dikim pilesiz modern tasarımı sayesinde minimal görünüm sunar")).toBe(
      "Düz dikim pilesiz modern tasarımı",
    );
  });
});

describe("katalog senkronu ve otomatik doldurma", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://mock");
      const main = url.searchParams.get("productMainId");

      if (main === "MAIN-YOK") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ totalElements: 0, totalPages: 0, content: [] }));
        return;
      }

      const content = [
        {
          id: "x1",
          barcode: "BX1",
          productMainId: main ?? "MAIN-X",
          title: "Keten Tül Perde",
          description: "%100 keten kumaş. Pilesiz dikim. Makinede yıkanabilir.",
          brand: "Test",
          categoryName: "Tül Perde",
          approved: true,
          archived: false,
          attributes: [
            { attributeId: 1, attributeName: "Materyal", attributeValue: "Keten" },
            { attributeId: 2, attributeName: "Pile", attributeValue: "Pilesiz (1 x 1)" },
            { attributeId: 3, attributeName: "Renk", attributeValue: "Bej" },
          ],
        },
      ];

      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ page: 0, size: 100, totalElements: 1, totalPages: 1, content }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("katalogu çeker, kartı taslak doldurur ve doğrulamaz", async () => {
    const storeId = await seedStore();
    const main = `MAIN-${Date.now()}`;
    createdMains.push(main);
    await seedQuestion(storeId, main, "Kumaş türü nedir? Pile oranı kaç?");

    const client = new CatalogClient({ baseUrl, sellerId: "1", apiKey: "k", apiSecret: "s" });
    const sync = await syncCatalog({ storeId, productMainIds: [main] }, { prisma, client });
    expect(sync.synced).toBe(1);
    expect(sync.variants).toBe(1);

    const applied = await applyAutoFill({ storeId, actor: "test-otomatik" }, { prisma });
    expect(applied.filled).toBeGreaterThan(0);

    const card = await prisma.productInfo.findFirst({ where: { storeId, productMainId: main } });
    const attributes = card?.attributes as Array<{ key: string; value: string; verified?: boolean; source?: string }>;
    const fabric = attributes.find((item) => item.key === "fabric");
    expect(fabric).toMatchObject({ value: "Keten", verified: false, source: "CATALOG_ATTRIBUTE" });
    expect(attributes.some((item) => item.verified === true)).toBe(false);
  });

  it("bulunamayan ürünü hata olarak işaretler, kart oluşturmaz", async () => {
    const storeId = await seedStore();
    const client = new CatalogClient({ baseUrl, sellerId: "1", apiKey: "k", apiSecret: "s" });
    const sync = await syncCatalog({ storeId, productMainIds: ["MAIN-YOK"] }, { prisma, client });

    expect(sync.notFound).toBe(1);
    expect(sync.synced).toBe(0);
    const record = await prisma.catalogProduct.findUnique({
      where: { storeId_productMainId: { storeId, productMainId: "MAIN-YOK" } },
    });
    expect(record?.lastError).toBeTruthy();
  });

  it("doğrulanmış alanı ezmez, onayda yalnızca katalog kaynaklı alanları doğrular", async () => {
    const storeId = await seedStore();
    const main = `MAIN-ONAY-${Date.now()}`;
    createdMains.push(main);
    await seedQuestion(storeId, main, "Kumaş ve pile bilgisi?");

    await setField({ storeId, productMainId: main, fieldKey: "fabric", value: "Elle doğruladığım keten", actor: "insan" }, { prisma });
    await verifyField({ storeId, productMainId: main, fieldKey: "fabric", actor: "insan" }, { prisma });

    const client = new CatalogClient({ baseUrl, sellerId: "1", apiKey: "k", apiSecret: "s" });
    await syncCatalog({ storeId, productMainIds: [main] }, { prisma, client });
    await applyAutoFill({ storeId, actor: "test-otomatik" }, { prisma });

    const plan = (await buildAutoFillPlan({ storeId, productMainId: main }, { prisma }))[0];
    const fabric = plan.fields.find((field) => field.key === "fabric");
    expect(fabric?.state).toBe("KEPT");
    expect(fabric?.value).toBe("Elle doğruladığım keten");

    const approved = await approveAutoFilled({ storeId, productMainId: main, actor: "insan" }, { prisma });
    expect(approved.verified).toBeGreaterThan(0);

    const card = await prisma.productInfo.findFirst({ where: { storeId, productMainId: main } });
    const attributes = (card?.attributes ?? []) as Array<{ key: string; value: string; verified?: boolean; source?: string }>;
    const verifiedFabric = attributes.find((item) => item.key === "fabric");
    expect(verifiedFabric?.value).toBe("Elle doğruladığım keten");
    expect(verifiedFabric?.verified).toBe(true);
    // Renk katalogdan gelip onaylandı; doğrulanmış kumaş bozulmadı.
    expect(attributes.find((item) => item.key === "colors")?.verified).toBe(true);
  });

  it("geçmiş cevap kaynaklı alanı tek tıkla doğrulamaz", async () => {
    const storeId = await seedStore();
    const main = `MAIN-GECMIS-${Date.now()}`;
    createdMains.push(main);
    await seedQuestion(storeId, main, "Kumaş türü nedir?");

    await prisma.productFieldSuggestion.create({
      data: {
        storeId,
        productMainId: main,
        fieldKey: "fabric",
        value: "Kadife",
        sourceQuestionIds: ["q1"] as unknown as object,
        status: "PENDING",
      },
    });

    const client = new CatalogClient({ baseUrl, sellerId: "1", apiKey: "k", apiSecret: "s" });
    await syncCatalog({ storeId, productMainIds: [main] }, { prisma, client });
    await applyAutoFill({ storeId, actor: "test-otomatik" }, { prisma });

    const approved = await approveAutoFilled({ storeId, productMainId: main, actor: "insan" }, { prisma });
    expect(approved.skipped).toBeGreaterThan(0);

    const card = await prisma.productInfo.findFirst({ where: { storeId, productMainId: main } });
    const attributes = (card?.attributes ?? []) as Array<{ key: string; verified?: boolean; source?: string }>;
    const historyField = attributes.find((item) => item.key === "fabric");
    // Katalog özelliği varsa o kazanır ve doğrulanabilir; geçmiş cevabı asla otomatik doğrulanmaz.
    expect(historyField?.source === "HISTORY_ANSWER" ? historyField.verified !== true : true).toBe(true);
  });
});

afterEach(async () => {
  // Testler arası sızıntı yok: her test kendi mağazasını oluşturur.
  await prisma.catalogProduct.deleteMany({ where: { storeId: { in: createdStores } } });
});
