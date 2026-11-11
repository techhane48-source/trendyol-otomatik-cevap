import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAiDraft } from "@/lib/drafts/service";
import { resetEnvCache } from "@/lib/env";
import { createMockProvider } from "@/lib/llm/provider";
import { INTENT_FIELDS, detectIntents } from "@/lib/intents/taxonomy";
import { getPolicyContext, savePolicy, verifyPolicy } from "@/lib/policies/service";
import { analyzeRequestedSize, describeSizeAnalysis, extractRequestedSize, variantSizesOf } from "@/lib/products/sizes";
import { getPrisma } from "@/lib/prisma";

const prisma = getPrisma();
const actor = { name: "Aura Perde" };

const SIZES = [
  { name: "Boyut/Ebat", value: "150 x 250" },
  { name: "Boyut/Ebat", value: "200 x 250" },
  { name: "Boyut/Ebat", value: "220 x 250" },
  { name: "Boyut/Ebat", value: "260 x 260" },
  { name: "Pile", value: "Pilesiz (1 x 1)" },
];

async function seedStore() {
  return prisma.store.upsert({
    where: { sellerId: 1081168n },
    update: {},
    create: { sellerId: 1081168n },
  });
}

async function seedQuestion(input: {
  storeId: string;
  text: string;
  productMainId?: string | null;
  productName?: string | null;
}) {
  return prisma.question.create({
    data: {
      storeId: input.storeId,
      trendyolQuestionId: BigInt(`88${Math.floor(Math.random() * 900000) + 100000}`),
      text: input.text,
      status: "ANSWERED",
      productMainId: input.productMainId ?? null,
      productName: input.productName ?? null,
    },
  });
}

beforeEach(async () => {
  resetEnvCache();
  await prisma.draftEvent.deleteMany({});
  await prisma.answerDraft.deleteMany({});
  await prisma.storePolicy.deleteMany({});
  await prisma.catalogProduct.deleteMany({});
  await prisma.question.deleteMany({});
});

afterAll(async () => {
  await prisma.draftEvent.deleteMany({});
  await prisma.answerDraft.deleteMany({});
  await prisma.storePolicy.deleteMany({});
  await prisma.catalogProduct.deleteMany({});
  await prisma.question.deleteMany({});
  await prisma.$disconnect();
});

describe("varyant ölçü analizi (GÖREV 013)", () => {
  const sizes = variantSizesOf(SIZES);

  it("katalog ölçülerini EN x BOY olarak ayrıştırır", () => {
    expect(sizes.map((size) => size.label)).toEqual(["150 x 250", "200 x 250", "220 x 250", "260 x 260"]);
  });

  it("A) listede olan ölçü mevcut varyant olarak bildirilir", () => {
    const analysis = analyzeRequestedSize(sizes, extractRequestedSize("200 x 250 ölçüsünde var mı?")!);
    expect(analysis.exact?.label).toBe("200 x 250");
    expect(describeSizeAnalysis(analysis)).toContain("listede VAR");
  });

  it("A) listede olmayan ölçü için küçültme istisnası söylenir, kesin söz verilmez", () => {
    const analysis = analyzeRequestedSize(sizes, extractRequestedSize("210 x 250 kesmeniz mümkün mü?")!);
    expect(analysis.exact).toBeNull();
    expect(analysis.shrinkCandidates.map((size) => size.label)).toEqual(["220 x 250", "260 x 260"]);
    const text = describeSizeAnalysis(analysis);
    expect(text).toContain("listede YOK");
    expect(text).toContain("küçültme TALEBİ");
    expect(text).toMatch(/onayı gerekir/);
  });

  it("B) satın alınandan büyük ölçü için büyütme vaadi üretilmez", () => {
    const analysis = analyzeRequestedSize(sizes, extractRequestedSize("300 x 300 yapabilir misiniz?")!);
    const purchased = analyzeRequestedSize(sizes, extractRequestedSize("200 x 250")!);
    // 210x250 hiçbir varyantta yok: daha büyük aday da yok.
    expect(purchased.exact?.label).toBe("200 x 250");
    expect(analysis.shrinkCandidates).toEqual([]);
    const text = describeSizeAnalysis(analysis);
    expect(text).toContain("Büyütme yapılamaz");
    expect(text).not.toMatch(/kesinlikle yapılabilir/);
  });

  it("C) 220x250 alınıp 210x250 istenirse küçültme onaya bağlı değerlendirilir", () => {
    const analysis = analyzeRequestedSize(sizes, extractRequestedSize("210 x 250 olabilir mi?")!);
    expect(analysis.shrinkCandidates.some((size) => size.label === "220 x 250")).toBe(true);
    expect(describeSizeAnalysis(analysis)).toMatch(/kabul garantisi yoktur/);
  });

  it("ölçü verisi yoksa ölçü mevcutmuş gibi davranılmaz", () => {
    const text = describeSizeAnalysis(analyzeRequestedSize([], { width: 260, height: 220 }));
    expect(text).toContain("ölçü verisi YOK");
  });

  it("metre yazımı cm'ye çevrilir", () => {
    expect(extractRequestedSize("2 metreye 2 metre dikiyor musunuz?")).toEqual({ width: 200, height: 200 });
  });
});

describe("niyet ayrımı (regresyon D-F)", () => {
  it("D) file sorusunda ölçü ve dikim ayrı değerlendirilir, kumaş zorunlu değil", () => {
    const info = detectIntents("File olmadan 200x200 dikiyor musunuz?");
    expect(info.all).toContain("SEWING");
    expect(info.all).toContain("CUSTOM_SIZE");
    expect(info.all).not.toContain("FABRIC");
    expect(INTENT_FIELDS.FABRIC).toContain("fabric");
    expect(INTENT_FIELDS[info.primary]).not.toContain("fabric");
  });

  it("E) fiyat sorusunda kumaş/pile alanı istenmez", () => {
    const info = detectIntents("Geçen hafta aldım, şimdi pahalı; zam mı geldi?");
    expect(info.primary).toBe("PRICE");
    expect(INTENT_FIELDS.PRICE).toEqual([]);
    expect(INTENT_FIELDS[info.primary]).not.toContain("fabric");
  });

  it("F) teslimat sorusu kargo niyetine düşer", () => {
    expect(detectIntents("Yarın teslim olur mu?").primary).toBe("SHIPPING");
  });
});

describe("politika katmanı (regresyon G-H)", () => {
  it("G) doğrulanmamış politika AI'ya kesin kural olarak verilmez", async () => {
    const store = await seedStore();
    await savePolicy({ storeId: store.id, key: "price", value: "Sipariş anındaki fiyat geçerlidir.", actor: actor.name }, { prisma });

    const context = await getPolicyContext({ storeId: store.id }, { prisma });
    expect(context.policies.find((policy) => policy.key === "price")?.value).toContain("Sipariş anındaki");
    expect(context.verified).toEqual([]);

    let captured = "";
    const provider = createMockProvider((messages) => {
      captured = messages.user;
      return "Fiyatlar dönemsel olarak değişebilir; sipariş anındaki fiyat geçerlidir.";
    });

    await createAiDraft({ questionId: (await seedQuestion({ storeId: store.id, text: "Fiyatı ne kadar?" })).id, actor }, { prisma, provider });
    expect(captured).not.toContain("Sipariş anındaki fiyat geçerlidir.");
    expect(captured).toContain("MAĞAZA POLİTİKASI: VERİLMEDİ");
  });

  it("G) doğrulanmış politika kaynak olarak kullanılır", async () => {
    const store = await seedStore();
    await savePolicy({ storeId: store.id, key: "price", value: "Sipariş anındaki fiyat geçerlidir.", actor: actor.name }, { prisma });
    await verifyPolicy({ storeId: store.id, key: "price", value: "", actor: actor.name }, { prisma });
    expect((await getPolicyContext({ storeId: store.id }, { prisma })).verified).toHaveLength(1);
  });

  it("H) doğrulanmış politika metni değişirse doğrulama düşer", async () => {
    const store = await seedStore();
    await savePolicy({ storeId: store.id, key: "shipping", value: "1-3 iş günü içinde kargoya verilir.", actor: actor.name }, { prisma });
    await verifyPolicy({ storeId: store.id, key: "shipping", value: "", actor: actor.name }, { prisma });

    const result = await savePolicy(
      { storeId: store.id, key: "shipping", value: "2-5 iş günü içinde kargoya verilir.", actor: actor.name },
      { prisma },
    );
    expect(result.changed).toBe(true);
    const context = await getPolicyContext({ storeId: store.id }, { prisma });
    expect(context.policies.find((policy) => policy.key === "shipping")?.verified).toBe(false);
    expect(context.verified).toEqual([]);
  });
});

describe("taslak üretiminde ölçü kaynağı", () => {
  it("katalogdaki birebir varyant doğrudan cevap olarak kullanılır", async () => {
    const store = await seedStore();
    await prisma.catalogProduct.create({
      data: {
        storeId: store.id,
        productMainId: "aura-test-1",
        title: "Naturel Keten Fon Perde",
        variantCount: 4,
        attributes: SIZES,
      },
    });
    const question = await seedQuestion({
      storeId: store.id,
      text: "220 x 250 ölçüsü var mı?",
      productMainId: "aura-test-1",
      productName: "Naturel Keten Fon Perde",
    });

    let captured = "";
    const provider = createMockProvider((messages) => {
      captured = messages.user;
      return "220 x 250 ölçüsü mevcut varyantlarımızda bulunuyor.";
    });

    const draft = await createAiDraft({ questionId: question.id, actor }, { prisma, provider });
    expect(captured).toContain("İstenen ölçü listede VAR: 220 x 250");
    expect(draft.intent).toBe("CUSTOM_SIZE");
    expect(draft.strategy).toBe("DIRECT");
  });

  it("katalog verisi yokken 'ölçü mevcut' denmez", async () => {
    const store = await seedStore();
    const question = await seedQuestion({ storeId: store.id, text: "260 x 220 kesmeniz mümkün mü?", productMainId: "yok-boyle-urun" });

    let captured = "";
    const provider = createMockProvider((messages) => {
      captured = messages.user;
      return "260 x 220 ölçüsü için katalogda kayıt bulunmuyor; istediğiniz ölçüyü netleştirir misiniz?";
    });

    await createAiDraft({ questionId: question.id, actor }, { prisma, provider });
    expect(captured).toContain("ölçü verisi YOK");
    expect(captured).not.toContain("listede VAR");
  });
});
