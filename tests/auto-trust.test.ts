import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAiDraft } from "@/lib/drafts/service";
import { resetEnvCache } from "@/lib/env";
import { createMockProvider } from "@/lib/llm/provider";
import { buildAutoFacts, usableAutoFacts } from "@/lib/products/auto-facts";
import { getPrisma } from "@/lib/prisma";

const prisma = getPrisma();
const actor = { name: "Risk motoru testi" };

function product(overrides: Partial<Parameters<typeof buildAutoFacts>[0]> = {}) {
  return {
    productMainId: "aura-main-1",
    categoryName: "Tül Perde",
    description: null,
    attributes: [],
    truncated: false,
    variantCount: 2,
    fetchedAt: new Date("2026-11-11T09:00:00Z"),
    ...overrides,
  };
}

const SIZES = [
  { name: "Boyut/Ebat", value: "200 x 250", barcode: "a" },
  { name: "Boyut/Ebat", value: "220 x 250", barcode: "b" },
];

beforeEach(async () => {
  resetEnvCache();
  await prisma.draftEvent.deleteMany({});
  await prisma.answerDraft.deleteMany({});
  await prisma.catalogProduct.deleteMany({});
  await prisma.storePolicy.deleteMany({});
  await prisma.question.deleteMany({});
});

afterAll(async () => {
  await prisma.draftEvent.deleteMany({});
  await prisma.answerDraft.deleteMany({});
  await prisma.catalogProduct.deleteMany({});
  await prisma.storePolicy.deleteMany({});
  await prisma.question.deleteMany({});
  await prisma.$disconnect();
});

describe("A/B/C güven sınıflandırması (GÖREV 014)", () => {
  it("1) tüm varyantlarda tek değer → A sınıfı ve gerekçeli", () => {
    const facts = buildAutoFacts(
      product({
        attributes: [
          { name: "Materyal", value: "Keten", barcode: "a" },
          { name: "Materyal", value: "Keten", barcode: "b" },
          ...SIZES,
        ],
      }),
    );
    const fabric = facts.find((fact) => fact.fieldKey === "fabric");
    expect(fabric?.trustClass).toBe("A");
    expect(fabric?.reasons.join(" ")).toMatch(/Tüm 2 varyantta aynı değer/);
    expect(usableAutoFacts(facts).map((fact) => fact.fieldKey)).toContain("fabric");
  });

  it("2) varyantlarda farklı değer → C sınıfı, çelişki işaretli", () => {
    const facts = buildAutoFacts(
      product({
        attributes: [
          { name: "Pile", value: "Pilesiz (1 x 1)", barcode: "a" },
          { name: "Pile", value: "Sık (1 x 3)", barcode: "b" },
        ],
      }),
    );
    const pleat = facts.find((fact) => fact.fieldKey === "pleat");
    expect(pleat?.trustClass).toBe("C");
    expect(pleat?.conflict).toBe(true);
    expect(pleat?.alternatives.length).toBeGreaterThan(0);
    expect(usableAutoFacts(facts)).toEqual([]);
  });

  it("3) sayfalama yarım kaldıysa A sınıfı verilmez", () => {
    const facts = buildAutoFacts(
      product({ truncated: true, attributes: [{ name: "Materyal", value: "Keten", barcode: "a" }] }),
    );
    expect(facts[0]?.trustClass).toBe("C");
    expect(facts[0]?.reasons.join(" ")).toMatch(/sayfalama sınırında/);
  });

  it("4) kategori adı materyal olarak kullanılmaz", () => {
    const facts = buildAutoFacts(
      product({ categoryName: "Tül Perde", attributes: [{ name: "Materyal", value: "Tül Perde", barcode: "a" }] }),
    );
    expect(facts.find((fact) => fact.fieldKey === "fabric")).toBeUndefined();
  });

  it("5) açıklama farklı değer veriyorsa çelişki → C", () => {
    const facts = buildAutoFacts(
      product({
        description: "Ürünümüz %100 keten dokuma kumaştan üretilmiştir.",
        attributes: [{ name: "Materyal", value: "Polyester", barcode: "a" }],
      }),
    );
    const fabric = facts.find((fact) => fact.fieldKey === "fabric");
    expect(fabric?.trustClass).toBe("C");
    expect(fabric?.conflict).toBe(true);
    expect(fabric?.reasons.join(" ")).toMatch(/açıklaması çelişen değer/);
  });

  it("6) yalnızca açıklamada olan bilgi B sınıfıdır", () => {
    const facts = buildAutoFacts(
      product({ description: "Kumaşımız %100 keten dokuma yapıdadır ve düşük ısıda ütülenebilir." }),
    );
    const fabric = facts.find((fact) => fact.fieldKey === "fabric");
    expect(fabric?.trustClass).toBe("B");
    expect(usableAutoFacts(facts)).toEqual([]);
  });

  it("7) kod benzeri değer (Type 1) bilgi sayılmaz", () => {
    const facts = buildAutoFacts(product({ attributes: [{ name: "Yıkama Talimatı", value: "Type 1", barcode: "a" }] }));
    expect(facts.find((fact) => fact.fieldKey === "care")).toBeUndefined();
  });

  it("8) bir ürünün ölçüleri başka ürünün bilgisine karışmaz", () => {
    const first = buildAutoFacts(product({ productMainId: "p1", attributes: [{ name: "Materyal", value: "Keten", barcode: "a" }] }));
    const second = buildAutoFacts(
      product({ productMainId: "p2", attributes: [{ name: "Materyal", value: "Polyester", barcode: "c" }] }),
    );
    expect(first[0]?.productMainId).toBe("p1");
    expect(first[0]?.value).toBe("Keten");
    expect(second[0]?.productMainId).toBe("p2");
    expect(second.some((fact) => fact.value === "Keten")).toBe(false);
  });

  it("9) katalog verisi değişince sınıf yeniden hesaplanır (C → A)", () => {
    const conflicting = buildAutoFacts(
      product({
        attributes: [
          { name: "Materyal", value: "Keten", barcode: "a" },
          { name: "Materyal", value: "Polyester", barcode: "b" },
        ],
      }),
    );
    expect(conflicting.find((fact) => fact.fieldKey === "fabric")?.trustClass).toBe("C");

    const consistent = buildAutoFacts(
      product({
        attributes: [
          { name: "Materyal", value: "Keten", barcode: "a" },
          { name: "Materyal", value: "Keten", barcode: "b" },
        ],
      }),
    );
    expect(consistent.find((fact) => fact.fieldKey === "fabric")?.trustClass).toBe("A");
  });

  it("10) kimlik eşleşmesi olmayan ürün için otomatik bilgi üretilmez", async () => {
    const store = await prisma.store.upsert({ where: { sellerId: 1081168n }, update: {}, create: { sellerId: 1081168n } });
    await prisma.catalogProduct.create({
      data: {
        storeId: store.id,
        productMainId: "baska-urun",
        categoryName: "Tül Perde",
        attributes: [{ name: "Materyal", value: "Keten", barcode: "a" }],
        variantCount: 1,
      },
    });
    const { getAutoFactsForQuestion } = await import("@/lib/products/auto-facts");
    const facts = await getAutoFactsForQuestion({ storeId: store.id, productMainId: "eslesmeyen-urun" }, { prisma });
    expect(facts).toEqual([]);
  });
});

describe("taslak üretiminde A sınıfı kullanımı", () => {
  async function seed(attributes: unknown, text: string) {
    const store = await prisma.store.upsert({ where: { sellerId: 1081168n }, update: {}, create: { sellerId: 1081168n } });
    await prisma.catalogProduct.create({
      data: { storeId: store.id, productMainId: "aura-main-1", categoryName: "Tül Perde", attributes: attributes as object, variantCount: 2 },
    });
    const question = await prisma.question.create({
      data: {
        storeId: store.id,
        trendyolQuestionId: BigInt(`99${Math.floor(Math.random() * 900000) + 100000}`),
        text,
        status: "ANSWERED",
        productMainId: "aura-main-1",
        productName: "Naturel Keten Fon Perde",
      },
    });
    return { store, question };
  }

  it("A sınıfı katalog bilgisi insan doğrulaması olmadan taslakta kullanılır", async () => {
    const { question } = await seed(
      [
        { name: "Materyal", value: "Keten", barcode: "a" },
        { name: "Materyal", value: "Keten", barcode: "b" },
        { name: "Pile", value: "Pilesiz (1 x 1)", barcode: "a" },
        { name: "Pile", value: "Pilesiz (1 x 1)", barcode: "b" },
      ],
      "Bu perde keten mi, pile durumu nedir?",
    );

    let captured = "";
    const provider = createMockProvider((messages) => {
      captured = messages.user;
      return "Perdemiz keten dokudadır ve pilesiz dikimlidir.";
    });

    const draft = await createAiDraft({ questionId: question.id, actor }, { prisma, provider });
    expect(captured).toContain("Kumaş türü: Keten");
    expect(captured).toContain("Pile oranı: Pilesiz (1 x 1)");
    expect(draft.usedFacts.some((fact) => fact.source === "CATALOG_AUTO")).toBe(true);
    // Sınıf A olduğu için insan onayı gerekmez; kalan alanlar cevabı bloke etmez.
    expect(draft.strategy).not.toBe("HUMAN_REVIEW");
    expect(draft.missingForIntent.some((item) => /Kumaş/i.test(item))).toBe(false);
  });

  it("C sınıfı (çelişkili) bilgi taslak kaynağı olarak kullanılmaz", async () => {
    const { question } = await seed(
      [
        { name: "Materyal", value: "Keten", barcode: "a" },
        { name: "Materyal", value: "Polyester", barcode: "b" },
      ],
      "Kumaşı keten mi?",
    );

    let captured = "";
    const provider = createMockProvider((messages) => {
      captured = messages.user;
      return "Kumaş bilgisi için net bir bilgi veremiyorum.";
    });

    const draft = await createAiDraft({ questionId: question.id, actor }, { prisma, provider });
    expect(captured).not.toContain("Kumaş türü: Keten");
    expect(captured).not.toContain("Kumaş türü: Polyester");
    expect(draft.usedFacts.some((fact) => fact.source === "CATALOG_AUTO")).toBe(false);
    expect(draft.strategy).toBe("ASK_DETAIL");
    expect(draft.missingForIntent.some((item) => /Kumaş/i.test(item))).toBe(true);
  });
});
