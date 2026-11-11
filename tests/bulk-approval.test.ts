import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getPrisma } from "@/lib/prisma";
import { createAiDraft } from "@/lib/drafts/service";
import { createMockProvider } from "@/lib/llm/provider";
import { classifyCandidate } from "@/lib/products/verdict";
import { buildAutoFillPlan, verifySelectedFields } from "@/lib/products/autofill";

const prisma = getPrisma();
const stores: string[] = [];

async function seedStore(): Promise<string> {
  const store = await prisma.store.create({
    data: { sellerId: BigInt(9_300_000 + Math.floor(Math.random() * 600_000)) },
  });
  stores.push(store.id);
  return store.id;
}

async function seedCard(
  storeId: string,
  productMainId: string,
  fields: Array<{ key: string; label: string; value: string; source?: string; confidence?: string; needsReview?: boolean; alternatives?: string[] }>,
): Promise<void> {
  await prisma.productInfo.create({
    data: {
      storeId,
      productMainId,
      productId: null,
      status: "DRAFT",
      title: "Test Ürün",
      attributes: fields.map((field) => ({
        ...field,
        source: field.source ?? "CATALOG_ATTRIBUTE",
        confidence: field.confidence ?? "HIGH",
        verified: false,
      })) as unknown as object,
    },
  });
}

async function seedCatalog(
  storeId: string,
  productMainId: string,
  attributes: Array<{ name: string; value: string }>,
  extra: { truncated?: boolean; categoryName?: string; variantCount?: number } = {},
): Promise<void> {
  await prisma.catalogProduct.create({
    data: {
      storeId,
      productMainId,
      title: "Test Ürün",
      categoryName: extra.categoryName ?? "Fon Perde",
      variantCount: extra.variantCount ?? 1,
      truncated: extra.truncated ?? false,
      attributes: attributes.map((attribute, index) => ({
        name: attribute.name,
        value: attribute.value,
        barcode: `B-${index}`,
      })) as unknown as object,
    },
  });
}

async function seedQuestion(storeId: string, productMainId: string, text = "Kumaş türü nedir?"): Promise<string> {
  const question = await prisma.question.create({
    data: {
      storeId,
      trendyolQuestionId: BigInt(9_400_000 + Math.floor(Math.random() * 500_000)),
      text,
      status: "ANSWERED",
      rawStatus: "ANSWERED",
      productMainId,
      askedAt: new Date(),
    },
  });
  return question.id;
}

afterAll(async () => {
  await prisma.answerDraft.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.productInfo.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.catalogProduct.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.question.deleteMany({ where: { storeId: { in: stores } } });
  await prisma.store.deleteMany({ where: { id: { in: stores } } });
});

describe("güven sınıflandırması", () => {
  const base = {
    fieldKey: "fabric" as const,
    value: "Keten",
    source: "CATALOG_ATTRIBUTE" as const,
    confidence: "HIGH" as const,
    identityMatched: true,
    truncated: false,
    variantCount: 3,
  };

  it("açık katalog özelliği + eşleşme + çelişki yok → GÜVENİLİR", () => {
    expect(classifyCandidate(base).verdict).toBe("TRUSTED");
  });

  it("varyantlar farklıysa ana üründe tek değer doğrulanmaz", () => {
    expect(classifyCandidate({ ...base, alternatives: ["Pilesiz (1 x 1)"] }).verdict).toBe("REVIEW");
  });

  it("sayfalama sınırındaki katalog güvenilir sayılmaz", () => {
    expect(classifyCandidate({ ...base, truncated: true }).verdict).toBe("REVIEW");
  });

  it("kimliği doğrulanamayan eşleşme güvenilir sayılmaz", () => {
    expect(classifyCandidate({ ...base, identityMatched: false }).verdict).toBe("REVIEW");
  });

  it("geçmiş satıcı cevabı hiçbir zaman güvenilir değil", () => {
    expect(classifyCandidate({ ...base, source: "HISTORY_ANSWER" }).verdict).toBe("REVIEW");
  });

  it("kategori adı materyal olarak kabul edilmez (RED)", () => {
    const result = classifyCandidate({ ...base, value: "Tül Perde", categoryName: "Tül Perde" });
    expect(result.verdict).toBe("REJECT");
    const result2 = classifyCandidate({ ...base, value: "Fon Perde" });
    expect(result2.verdict).toBe("REJECT");
  });

  it("kod benzeri değer reddedilir", () => {
    expect(classifyCandidate({ ...base, value: "T100" }).verdict).toBe("REJECT");
    expect(classifyCandidate({ ...base, fieldKey: "care", value: "T100" }).verdict).toBe("REJECT");
  });

  it("alanla ilgisiz değer reddedilir (Ütü = Type 1)", () => {
    expect(classifyCandidate({ ...base, fieldKey: "care", value: "Type 1" }).verdict).toBe("REJECT");
    expect(classifyCandidate({ ...base, fieldKey: "mounting", value: "Arkada kalıyor" }).verdict).toBe("REJECT");
    expect(classifyCandidate({ ...base, fieldKey: "blackout", value: "Oda Karanlığı" }).verdict).toBe("TRUSTED");
  });

  it("açıklamadan gelen değer tek tek doğrulanmalı", () => {
    expect(classifyCandidate({ ...base, source: "CATALOG_DESCRIPTION", confidence: "HIGH" }).verdict).toBe("REVIEW");
  });
});

describe("toplu doğrulama", () => {
  let storeId: string;
  const main = "MAIN-BULK-1";

  beforeEach(async () => {
    storeId = await seedStore();
    await seedCatalog(storeId, main, [
      { name: "Materyal", value: "Keten" },
      { name: "Pile", value: "Pilesiz" },
    ]);
    await seedCard(storeId, main, [
      { key: "fabric", label: "Kumaş türü", value: "Keten" },
      { key: "pleat", label: "Pile oranı", value: "Pilesiz" },
      { key: "care", label: "Ütü / yıkama", value: "Kontrol edilecek", confidence: "MEDIUM", needsReview: true },
    ]);
  });

  it("seçilen güvenilir alanları tek işlemde doğrular, incelemeyi atlar", async () => {
    const result = await verifySelectedFields(
      {
        storeId,
        actor: "toplu-test",
        items: [
          { productMainId: main, fieldKey: "fabric", value: "Keten" },
          { productMainId: main, fieldKey: "pleat", value: "Pilesiz" },
          { productMainId: main, fieldKey: "care", value: "Kontrol edilecek" },
        ],
      },
      { prisma },
    );

    expect(result.verified).toBe(2);
    expect(result.skipped).toBe(1);

    const card = await prisma.productInfo.findFirst({ where: { storeId, productMainId: main } });
    const attributes = card?.attributes as Array<{ key: string; verified?: boolean; verifiedBy?: string; verifiedAt?: string }>;
    const fabric = attributes.find((attribute) => attribute.key === "fabric");
    expect(fabric?.verified).toBe(true);
    expect(fabric?.verifiedBy).toBe("toplu-test");
    expect(fabric?.verifiedAt).toBeTruthy();
    expect(attributes.find((attribute) => attribute.key === "care")?.verified).toBe(false);
  });

  it("değer değişmişse eski değeri doğrulamaz", async () => {
    const result = await verifySelectedFields(
      { storeId, actor: "toplu-test", items: [{ productMainId: main, fieldKey: "fabric", value: "Kadife" }] },
      { prisma },
    );
    expect(result.verified).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons[0].reason).toContain("eşleşmiyor");
  });

  it("ikinci onay aynı alanı tekrar doğrulamaz (idempotent)", async () => {
    await verifySelectedFields(
      { storeId, actor: "toplu-test", items: [{ productMainId: main, fieldKey: "fabric", value: "Keten" }] },
      { prisma },
    );
    const second = await verifySelectedFields(
      { storeId, actor: "toplu-test", items: [{ productMainId: main, fieldKey: "fabric", value: "Keten" }] },
      { prisma },
    );
    expect(second.verified).toBe(0);
    expect(second.alreadyVerified).toBe(1);
  });

  it("başka mağazanın kartını doğrulamaz", async () => {
    const otherStore = await seedStore();
    const result = await verifySelectedFields(
      { storeId: otherStore, actor: "saldirgan", items: [{ productMainId: main, fieldKey: "fabric", value: "Keten" }] },
      { prisma },
    );
    expect(result.verified).toBe(0);
    const card = await prisma.productInfo.findFirst({ where: { storeId, productMainId: main } });
    const attributes = card?.attributes as Array<{ key: string; verified?: boolean }>;
    expect(attributes.find((attribute) => attribute.key === "fabric")?.verified).toBe(false);
  });
});

describe("AI onaysız bilgiyi kesin gerçek olarak kullanmaz", () => {
  it("A sınıfı katalog bilgisi onaysız kullanılır, C sınıfı kullanılmaz", async () => {
    const storeId = await seedStore();
    const main = `MAIN-AI-${Date.now()}`;
    await seedCatalog(storeId, main, [{ name: "Materyal", value: "Keten" }]);
    await seedCard(storeId, main, [{ key: "fabric", label: "Kumaş türü", value: "Keten" }]);
    const questionId = await seedQuestion(storeId, main);

    // GÖREV 014: tek değerli, yapılandırılmış katalog bilgisi A sınıfıdır → insan onayı beklemez.
    const autoTrusted = await createAiDraft(
      { questionId, actor: { name: "test" } },
      { prisma, provider: createMockProvider(() => "Kumaş türü ketendir.") },
    );
    expect(autoTrusted.usedFacts.some((fact) => fact.source === "CATALOG_AUTO")).toBe(true);

    // Sayfalama yarım kalan (C sınıfı) katalog bilgisi hiç kullanılmaz.
    await prisma.catalogProduct.updateMany({ where: { storeId, productMainId: main }, data: { truncated: true } });
    const reviewOnly = await createAiDraft(
      { questionId, actor: { name: "test" } },
      { prisma, provider: createMockProvider(() => "Kumaş türü ketendir.") },
    );
    expect(reviewOnly.usedFacts).toHaveLength(0);

    // Elle doğrulama her zaman önceliklidir ve kaynak VERIFIED_CARD olur.
    await prisma.productInfo.updateMany({
      where: { storeId, productMainId: main },
      data: {
        status: "VERIFIED",
        attributes: [
          { key: "fabric", label: "Kumaş türü", value: "Keten", verified: true, source: "CATALOG_ATTRIBUTE" },
        ] as unknown as object,
      },
    });

    const verified = await createAiDraft(
      { questionId, actor: { name: "test" } },
      { prisma, provider: createMockProvider(() => "Kumaş türü ketendir.") },
    );
    expect(verified.usedFacts.some((fact) => fact.source === "VERIFIED_CARD")).toBe(true);
  });

  it("plan, inceleme sınıfındaki alanı güvenilir saymaz", async () => {
    const storeId = await seedStore();
    const main = `MAIN-PLAN-${Date.now()}`;
    await seedCatalog(storeId, main, [{ name: "Materyal", value: "Keten" }], { truncated: true });
    await seedCard(storeId, main, [{ key: "fabric", label: "Kumaş türü", value: "Keten" }]);

    const [plan] = await buildAutoFillPlan({ storeId, productMainId: main }, { prisma });
    const fabric = plan.fields.find((field) => field.key === "fabric");
    expect(fabric?.verdict).toBe("REVIEW");
    expect(fabric?.verdictReasons.join(" ")).toContain("sınır");
  });
});
