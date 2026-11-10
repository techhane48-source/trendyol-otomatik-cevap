import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAiDraft } from "@/lib/drafts/service";
import { resetEnvCache } from "@/lib/env";
import { classifyQuestion, relatedCategories } from "@/lib/history/categories";
import { searchHistoricalAnswers } from "@/lib/history/search";
import { getAccessMode, checkAccess } from "@/lib/auth";
import {
  FIELD_DEFS,
  bulkSetField,
  exportCsv,
  getCardFields,
  importCsv,
  listTopProducts,
  setField,
  unverifyField,
  verifiedAttributes,
  verifyField,
} from "@/lib/products/bank";
import { acceptSuggestion, extractFeatureCandidates, generateSuggestions, listSuggestions, rejectSuggestion } from "@/lib/products/suggestions";
import { disconnectPrisma, getPrisma } from "@/lib/prisma";
import { createMockProvider } from "@/lib/llm/provider";

const prisma = getPrisma();
const actor = { name: "urun-sorumlusu" };
let counter = 0;

async function seedStore(sellerId = 1081168n): Promise<string> {
  const row = await prisma.store.upsert({ where: { sellerId }, update: {}, create: { sellerId } });
  return row.id;
}

async function seedQuestion(input: {
  storeId: string;
  text: string;
  answer?: string | null;
  productMainId?: string | null;
  productId?: string | null;
}): Promise<string> {
  counter += 1;
  const row = await prisma.question.create({
    data: {
      storeId: input.storeId,
      trendyolQuestionId: BigInt(8_000_000 + counter),
      text: input.text,
      status: input.answer ? "ANSWERED" : "WAITING_FOR_ANSWER",
      rawStatus: input.answer ? "ANSWERED" : "WAITING_FOR_ANSWER",
      productName: "Bambu Tül Perde",
      productMainId: input.productMainId ?? "MAIN-1",
      productId: input.productId ?? "VAR-1",
      customerId: "CUST-1",
      answerText: input.answer ?? null,
      answeredAt: input.answer ? new Date() : null,
      askedAt: new Date(),
    },
  });
  return row.id;
}

async function resetDatabase(): Promise<void> {
  await prisma.productFieldSuggestion.deleteMany();
  await prisma.orderChangeEvent.deleteMany();
  await prisma.orderChangeRequest.deleteMany();
  await prisma.orderLine.deleteMany();
  await prisma.order.deleteMany();
  await prisma.qualityItem.deleteMany();
  await prisma.qualityRun.deleteMany();
  await prisma.qualitySet.deleteMany();
  await prisma.llmUsage.deleteMany();
  await prisma.draftEvent.deleteMany();
  await prisma.answerDraft.deleteMany();
  await prisma.productInfoEvent.deleteMany();
  await prisma.productInfo.deleteMany();
  await prisma.question.deleteMany();
}

beforeEach(async () => {
  process.env.LLM_PROVIDER = "mock";
  process.env.ADMIN_ACTOR_NAME = "urun-sorumlusu";
  resetEnvCache();
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await disconnectPrisma();
});

describe("ürün listesi", () => {
  it("en çok soru gelen ürünleri sayar, varyantları ayrı tutar", async () => {
    const storeId = await seedStore();
    for (let index = 0; index < 3; index += 1) {
      await seedQuestion({ storeId, text: `Ölçü sorusu ${index} cm?`, productId: "VAR-1" });
    }
    await seedQuestion({ storeId, text: "Pile sorusu?", productId: "VAR-2" });
    await seedQuestion({ storeId, text: "Kumaş sorusu?", productMainId: "MAIN-2", productId: "VAR-9" });

    const products = await listTopProducts({ storeId }, { prisma });
    expect(products[0].productMainId).toBe("MAIN-1");
    expect(products[0].questionCount).toBe(4);
    expect(products[0].variants.sort()).toEqual(["VAR-1", "VAR-2"]);
    expect(products[1].productMainId).toBe("MAIN-2");
  });
});

describe("alan bazında doğrulama", () => {
  it("bir alanı doğrulamak diğer alanları doğrulamaz", async () => {
    const storeId = await seedStore();
    await setField({ storeId, productMainId: "MAIN-1", fieldKey: "fabric", value: "Bambu dokulu tül", actor: actor.name }, { prisma });
    await setField({ storeId, productMainId: "MAIN-1", fieldKey: "pleat", value: "1/3 pile", actor: actor.name }, { prisma });

    await verifyField({ storeId, productMainId: "MAIN-1", fieldKey: "fabric", actor: actor.name }, { prisma });

    const card = await getCardFields({ storeId, productMainId: "MAIN-1" }, { prisma });
    const fabric = card.fields.find((field) => field.key === "fabric");
    const pleat = card.fields.find((field) => field.key === "pleat");

    expect(fabric?.verified).toBe(true);
    expect(fabric?.verifiedBy).toBe(actor.name);
    expect(pleat?.verified).toBe(false);
    expect(pleat?.value).toBe("1/3 pile");
  });

  it("değer değişince doğrulama düşer", async () => {
    const storeId = await seedStore();
    await setField({ storeId, productMainId: "MAIN-1", fieldKey: "fabric", value: "İlk", actor: actor.name }, { prisma });
    await verifyField({ storeId, productMainId: "MAIN-1", fieldKey: "fabric", actor: actor.name }, { prisma });
    await setField({ storeId, productMainId: "MAIN-1", fieldKey: "fabric", value: "Değişti", actor: actor.name }, { prisma });

    const card = await getCardFields({ storeId, productMainId: "MAIN-1" }, { prisma });
    expect(card.fields.find((field) => field.key === "fabric")?.verified).toBe(false);
  });

  it("boş alan doğrulanamaz, doğrulama kaldırılabilir", async () => {
    const storeId = await seedStore();
    await setField({ storeId, productMainId: "MAIN-1", fieldKey: "care", value: "30 derece", actor: actor.name }, { prisma });
    await expect(verifyField({ storeId, productMainId: "MAIN-1", fieldKey: "care", actor: actor.name, value: "  " }, { prisma })).rejects.toMatchObject({ code: "EMPTY_FIELD" });

    await verifyField({ storeId, productMainId: "MAIN-1", fieldKey: "care", actor: actor.name }, { prisma });
    await unverifyField({ storeId, productMainId: "MAIN-1", fieldKey: "care", actor: actor.name }, { prisma });
    const card = await getCardFields({ storeId, productMainId: "MAIN-1" }, { prisma });
    expect(card.fields.find((field) => field.key === "care")?.verified).toBe(false);
  });

  it("yalnızca doğrulanmış alanlar AI bilgisi sayılır", () => {
    const attributes = [
      { key: "fabric", label: "Kumaş türü", value: "Bambu", verified: true },
      { key: "pleat", label: "Pile oranı", value: "1/3", verified: false },
    ];
    expect(verifiedAttributes(attributes, "VERIFIED").map((attribute) => attribute.key)).toEqual(["fabric"]);
    // Eski kayıt: alan işareti yoksa kart durumu belirler.
    expect(verifiedAttributes([{ key: "a", label: "A", value: "1" }], "VERIFIED")).toHaveLength(1);
    expect(verifiedAttributes([{ key: "a", label: "A", value: "1" }], "DRAFT")).toHaveLength(0);
  });

  it("toplu güncelleme tüm seçili ürünlere yazar ve doğrulanmamış bırakır", async () => {
    const storeId = await seedStore();
    const result = await bulkSetField({ storeId, productMainIds: ["MAIN-1", "MAIN-2"], fieldKey: "mounting", value: "Kornişe takılır", actor: actor.name }, { prisma });
    expect(result.updated).toBe(2);

    for (const main of ["MAIN-1", "MAIN-2"]) {
      const card = await getCardFields({ storeId, productMainId: main }, { prisma });
      expect(card.fields.find((field) => field.key === "mounting")?.verified).toBe(false);
    }
  });
});

describe("CSV", () => {
  it("dışa aktarır ve içe aktarılan değerleri doğrulanmamış yazar", async () => {
    const storeId = await seedStore();
    await setField({ storeId, productMainId: "MAIN-1", fieldKey: "fabric", value: "Bambu", actor: actor.name }, { prisma });
    await verifyField({ storeId, productMainId: "MAIN-1", fieldKey: "fabric", actor: actor.name }, { prisma });

    const csv = await exportCsv({ storeId }, { prisma });
    expect(csv.split("\n")[0]).toContain("productMainId");
    expect(csv).toContain("Bambu");

    const imported = await importCsv(
      { storeId, actor: actor.name, csv: "productMainId,productId,fabric,pleat\nMAIN-2,,Keten,1/2\n" },
      { prisma },
    );
    expect(imported.rows).toBe(1);
    expect(imported.updated).toBe(2);

    const card = await getCardFields({ storeId, productMainId: "MAIN-2" }, { prisma });
    const fabric = card.fields.find((field) => field.key === "fabric");
    expect(fabric?.value).toBe("Keten");
    expect(fabric?.verified).toBe(false);
    expect(fabric?.source).toBe("CSV");
  });

  it("geçersiz CSV reddedilir", async () => {
    const storeId = await seedStore();
    await expect(importCsv({ storeId, actor: actor.name, csv: "fabric\nBambu\n" }, { prisma })).rejects.toMatchObject({
      code: "INVALID_CSV",
    });
  });
});

describe("geçmiş cevap önerileri", () => {
  it("özellik cevaplarından aday çıkarır, fiyat/stok/sipariş cevaplarını atar", () => {
    const candidates = extractFeatureCandidates([
      { questionId: "1", trendyolQuestionId: "11", text: "Kumaş şeffaf mı?", answerText: "Efendim kumaşımız şeffaf değildir." },
      { questionId: "2", trendyolQuestionId: "12", text: "Fiyatı ne kadar?", answerText: "1.299 TL, stokta var." },
      { questionId: "3", trendyolQuestionId: "13", text: "Siparişim nerede?", answerText: "Siparişiniz yarın kargoda." },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].fieldKey).toBe("fabric");
    expect(candidates[0].sourceQuestionIds).toEqual(["11"]);
    expect(candidates[0].value).not.toContain("Efendim");
  });

  it("aynı alanda farklı değerleri çelişki olarak işaretler", () => {
    const candidates = extractFeatureCandidates([
      { questionId: "1", trendyolQuestionId: "11", text: "Kumaş şeffaf mı?", answerText: "Şeffaf değildir." },
      { questionId: "2", trendyolQuestionId: "12", text: "Kumaş şeffaf mı?", answerText: "Hafif şeffaftır." },
    ]);

    expect(candidates.length).toBe(2);
    expect(candidates.every((candidate) => candidate.conflict)).toBe(true);
  });

  it("öneriyi üretir, kabul eder ama alanı doğrulanmış yapmaz", async () => {
    const storeId = await seedStore();
    await seedQuestion({ storeId, text: "Kumaş şeffaf mı?", answer: "Kumaşımız şeffaf değildir." });

    const generated = await generateSuggestions({ storeId, actor: actor.name }, { prisma });
    expect(generated.created).toBeGreaterThan(0);

    const suggestions = await listSuggestions({ storeId, status: "PENDING" }, { prisma });
    expect(suggestions[0].sourceQuestionIds.length).toBeGreaterThan(0);

    const accepted = await acceptSuggestion({ suggestionId: suggestions[0].id, actor: actor.name }, { prisma });
    expect(accepted.verified).toBe(false);

    const card = await getCardFields({ storeId, productMainId: suggestions[0].productMainId }, { prisma });
    const field = card.fields.find((item) => item.key === suggestions[0].fieldKey);
    expect(field?.value).toBe(suggestions[0].value);
    expect(field?.verified).toBe(false);
  });

  it("öneri reddedilebilir", async () => {
    const storeId = await seedStore();
    await seedQuestion({ storeId, text: "Kumaş şeffaf mı?", answer: "Şeffaf değildir." });
    await generateSuggestions({ storeId, actor: actor.name }, { prisma });
    const [suggestion] = await listSuggestions({ storeId, status: "PENDING" }, { prisma });

    await rejectSuggestion({ suggestionId: suggestion.id, actor: actor.name, note: "emin değilim" }, { prisma });
    const pending = await listSuggestions({ storeId, status: "PENDING" }, { prisma });
    expect(pending).toHaveLength(0);
  });
});

describe("hafıza kalitesi", () => {
  it("soru kategorilerini ayırır", () => {
    expect(classifyQuestion("100x250 ölçü olur mu?")).toBe("MEASURE");
    expect(classifyQuestion("pilesiz dikim nasıl durur?")).toBe("PLEAT");
    expect(classifyQuestion("kargo kaç günde gelir?")).toBe("SHIPPING");
    expect(classifyQuestion("sipariş numaram 123456789")).toBe("ORDER");
    expect(relatedCategories("FABRIC")).toContain("PLEAT");
    expect(relatedCategories("FABRIC")).not.toContain("SHIPPING");
  });

  it("alakasız kategorideki geçmiş cevabı bağlama sokmaz", async () => {
    const storeId = await seedStore();
    await seedQuestion({ storeId, text: "Kargo kaç günde gelir?", answer: "2 iş günü içinde kargoda olur." });
    const questionId = await seedQuestion({ storeId, text: "Kumaş şeffaf mı, dışarıdan görünür mü?" });

    const matches = await searchHistoricalAnswers({
      storeId,
      text: "Kumaş şeffaf mı, dışarıdan görünür mü?",
      excludeQuestionId: questionId,
    });
    expect(matches).toHaveLength(0);
  });
});

describe("taslak: doğrulanmış alan ve çözüm sınıfı", () => {
  it("yalnızca doğrulanmış alanı kullanır, RESOLVED işaretler", async () => {
    const storeId = await seedStore();
    const questionId = await seedQuestion({ storeId, text: "Kumaş türü nedir?" });

    await setField({ storeId, productMainId: "MAIN-1", fieldKey: "fabric", value: "Bambu dokulu tül", actor: actor.name }, { prisma });
    await setField({ storeId, productMainId: "MAIN-1", fieldKey: "pleat", value: "1/3 pile", actor: actor.name }, { prisma });
    await verifyField({ storeId, productMainId: "MAIN-1", fieldKey: "fabric", actor: actor.name }, { prisma });

    const draft = await createAiDraft(
      { questionId, actor },
      { prisma, provider: createMockProvider(() => "Kumaşımız bambu dokulu tüldür.") },
    );

    expect(draft.usedFacts.map((fact) => fact.value)).toEqual(["Bambu dokulu tül"]);
    expect(draft.usedFacts.every((fact) => fact.source === "VERIFIED_CARD")).toBe(true);
    expect(draft.resolution).toBe("RESOLVED");
    expect(draft.missingInfo.some((item) => item.includes("Pile oranı"))).toBe(true);
    expect(draft.status).toBe("PENDING");
  });

  it("doğrulanmış alan yoksa GENERIC olur", async () => {
    const storeId = await seedStore();
    const questionId = await seedQuestion({ storeId, text: "Kumaş türü nedir?" });

    const draft = await createAiDraft(
      { questionId, actor },
      { prisma, provider: createMockProvider(() => "Bilgiyi kontrol edip ileteceğim.") },
    );

    expect(draft.resolution).toBe("GENERIC");
    expect(draft.usedFacts).toHaveLength(0);
  });
});

describe("erişim kapısı", () => {
  it("APP_ACCESS_TOKEN boşsa geliştirmede de kapalıdır", () => {
    const previous = process.env.APP_ACCESS_TOKEN;
    delete process.env.APP_ACCESS_TOKEN;
    try {
      expect(getAccessMode()).toBe("misconfigured");
      expect(checkAccess("herhangi")).toMatchObject({ ok: false, status: 503 });
    } finally {
      if (previous !== undefined) process.env.APP_ACCESS_TOKEN = previous;
    }
  });
});
