import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAiDraft } from "@/lib/drafts/service";
import { resetEnvCache } from "@/lib/env";
import { createMockProvider } from "@/lib/llm/provider";
import type { LlmMessage } from "@/lib/llm/types";
import { decideStrategy, detectIntents, INTENT_FIELDS, INTENT_POLICIES } from "@/lib/intents/taxonomy";
import { getPolicyContext, savePolicy, verifyPolicy } from "@/lib/policies/service";
import { disconnectPrisma, getPrisma } from "@/lib/prisma";

const prisma = getPrisma();
const actor = { name: "onaylayan-kisi" };

/** GÖREV 012'de bildirilen üç gerçek soru — regresyon seti. */
export const REAL_QUESTIONS = [
  {
    text: "260 x 220 kesmeniz mümkün mü?",
    intent: "CUSTOM_SIZE",
    /** Kumaş türü bu soru için zorunlu DEĞİL. */
    mustNotRequire: "fabric",
  },
  {
    text: "Bu kumaştan file olmadan 2 metreye 2 metre dikiyor musunuz?",
    intent: "CUSTOM_SIZE",
    mustNotRequire: null,
  },
  {
    text: "Hafta sonu 170x250 sipariş verdim, şimdi daha pahalı görünüyor, zam mı geldi?",
    intent: "PRICE",
    mustNotRequire: "fabric",
  },
] as const;

async function resetDatabase(): Promise<void> {
  await prisma.qualityItem.deleteMany();
  await prisma.qualityRun.deleteMany();
  await prisma.qualitySet.deleteMany();
  await prisma.llmUsage.deleteMany();
  await prisma.draftEvent.deleteMany();
  await prisma.answerDraft.deleteMany();
  await prisma.productInfoEvent.deleteMany();
  await prisma.productInfo.deleteMany();
  await prisma.orderChangeEvent.deleteMany();
  await prisma.orderChangeRequest.deleteMany();
  await prisma.storePolicy.deleteMany();
  await prisma.question.deleteMany();
  await prisma.store.deleteMany();
}

async function seedQuestion(text: string, productMainId = "MAIN-1"): Promise<{ storeId: string; questionId: string }> {
  const store = await prisma.store.create({ data: { sellerId: 1081168n } });
  const question = await prisma.question.create({
    data: {
      storeId: store.id,
      trendyolQuestionId: 910001n,
      text,
      status: "WAITING_FOR_ANSWER",
      rawStatus: "WAITING_FOR_ANSWER",
      productName: "Naturel Keten Fon Perde",
      productMainId,
      productId: "VAR-1",
      askedAt: new Date("2026-11-01T09:00:00Z"),
    },
  });
  return { storeId: store.id, questionId: question.id };
}

async function seedVerifiedCard(storeId: string, productMainId = "MAIN-1"): Promise<void> {
  await prisma.productInfo.create({
    data: {
      storeId,
      productMainId,
      productId: null,
      title: "Naturel Keten Fon Perde",
      status: "DRAFT",
      attributes: [
        { key: "customSize", label: "Özel ölçü", value: "Özel ölçü üretim yapılıyor", verified: true, source: "MANUAL", confidence: "HIGH" },
        { key: "fabric", label: "Kumaş türü", value: "Keten", verified: true, source: "MANUAL", confidence: "HIGH" },
      ],
    },
  });
}

beforeEach(async () => {
  process.env.LLM_PROVIDER = "mock";
  process.env.ADMIN_ACTOR_NAME = "onaylayan-kisi";
  resetEnvCache();
  await resetDatabase();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("niyet sınıflandırma", () => {
  it("gerçek soruları doğru niyetle etiketler", () => {
    for (const item of REAL_QUESTIONS) {
      expect(detectIntents(item.text).primary).toBe(item.intent);
    }
  });

  it("fiyat sorusunda kumaş alanı zorunlu değildir", () => {
    const { primary, all } = detectIntents(REAL_QUESTIONS[2].text);
    expect(primary).toBe("PRICE");
    const required = all.flatMap((intent) => INTENT_FIELDS[intent]);
    expect(required).not.toContain("fabric");
  });

  it("ölçü sorusunda yalnızca ölçü alanları zorunlu", () => {
    const { all } = detectIntents(REAL_QUESTIONS[0].text);
    const required = all.flatMap((intent) => INTENT_FIELDS[intent]);
    expect(required).toContain("customSize");
    expect(required).not.toContain("fabric");
    expect(required).not.toContain("colors");
  });

  it("dikim + ölçü sorusu hem dikim hem ölçü alanı ister", () => {
    const { primary, all } = detectIntents(REAL_QUESTIONS[1].text);
    expect(primary).toBe("CUSTOM_SIZE");
    expect(all).toContain("SEWING");
    const required = all.flatMap((intent) => INTENT_FIELDS[intent]);
    expect(required).toContain("sewing");
    expect(required).toContain("customSize");
  });

  it("sipariş sonrası ölçü değişikliği niyeti ayrı tanınır", () => {
    expect(detectIntents("Siparişimdeki ürünün ölçüsünü değiştirebilir miyim?").primary).toBe("ORDER_CHANGE");
  });

  it("kargo sorusu ürün alanı istemez", () => {
    const { all } = detectIntents("Kargo kaç günde gelir?");
    expect(all.flatMap((intent) => INTENT_FIELDS[intent])).toHaveLength(0);
    expect(all.flatMap((intent) => INTENT_POLICIES[intent])).toContain("shipping");
  });

  it("strateji: tüm alanlar doğrulanmışsa DIRECT", () => {
    expect(
      decideStrategy({
        intent: "CUSTOM_SIZE",
        requiredFields: ["customSize"],
        coveredFields: ["customSize"],
        requiredPolicies: [],
        coveredPolicies: [],
      }),
    ).toBe("DIRECT");
  });

  it("strateji: hiç kaynak yoksa ASK_DETAIL", () => {
    expect(
      decideStrategy({
        intent: "CUSTOM_SIZE",
        requiredFields: ["customSize"],
        coveredFields: [],
        requiredPolicies: ["customSize"],
        coveredPolicies: [],
      }),
    ).toBe("ASK_DETAIL");
  });

  it("strateji: fiyat sorusu canlı veri olmadan DIRECT olamaz", () => {
    expect(
      decideStrategy({
        intent: "PRICE",
        requiredFields: [],
        coveredFields: [],
        requiredPolicies: ["price"],
        coveredPolicies: [],
      }),
    ).toBe("HUMAN_REVIEW");
  });
});

describe("mağaza politikaları", () => {
  it("kaydedilen politika doğrulanmış sayılmaz", async () => {
    const { storeId } = await seedQuestion("test");
    await savePolicy({ storeId, key: "customSize", value: "Özel ölçü yapıyoruz", actor: actor.name }, { prisma });

    const context = await getPolicyContext({ storeId }, { prisma });
    const policy = context.policies.find((item) => item.key === "customSize")!;
    expect(policy.value).toBe("Özel ölçü yapıyoruz");
    expect(policy.verified).toBe(false);
    expect(context.verified).toHaveLength(0);
  });

  it("doğrulanan politika verified listesine girer, metin değişince düşer", async () => {
    const { storeId } = await seedQuestion("test");
    await savePolicy({ storeId, key: "customSize", value: "Özel ölçü yapıyoruz", actor: actor.name }, { prisma });
    await verifyPolicy({ storeId, key: "customSize", value: "", actor: actor.name }, { prisma });

    let context = await getPolicyContext({ storeId }, { prisma });
    expect(context.verified.map((item) => item.key)).toContain("customSize");

    await savePolicy({ storeId, key: "customSize", value: "Özel ölçü yapmıyoruz", actor: actor.name }, { prisma });
    context = await getPolicyContext({ storeId }, { prisma });
    expect(context.verified.map((item) => item.key)).not.toContain("customSize");
  });

  it("geçersiz anahtar reddedilir", async () => {
    const { storeId } = await seedQuestion("test");
    await expect(
      savePolicy({ storeId, key: "uydurma", value: "x", actor: actor.name }, { prisma }),
    ).rejects.toThrow("POLICY_KEY_INVALID");
  });
});

describe("niyet odaklı taslak", () => {
  it("fiyat sorusunda kumaş bilgisi cevaba/prompta zorunlu tutulmaz, insan incelemesi işaretlenir", async () => {
    const { storeId, questionId } = await seedQuestion(REAL_QUESTIONS[2].text);
    await seedVerifiedCard(storeId);

    let captured: LlmMessage | null = null;
    const provider = {
      name: "mock",
      model: "mock-model",
      async complete(messages: LlmMessage) {
        captured = messages;
        return {
          text: "Sipariş numaranızı paylaşırsanız fiyat karşılaştırması yapılabilir.",
          provider: "mock",
          model: "mock-model",
          promptVersion: "v2-intent",
          durationMs: 5,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: true },
        };
      },
    };

    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    expect(draft.intent).toBe("PRICE");
    expect(draft.requiresHumanReview).toBe(true);
    expect(draft.strategy).toBe("HUMAN_REVIEW");
    expect(captured!.user).toContain("SORU NIYETI: Fiyat değişimi / indirim");
    // Doğrulanmış kumaş bilgisi kartda olsa bile bu soru için "eksik" sayılmaz.
    expect(draft.missingForIntent ?? []).not.toContain("Kumaş türü");
  });

  it("fiyat değişimi iddiası doğrulanmış fiyat politikası yokken uyarı üretir", async () => {
    const { storeId, questionId } = await seedQuestion(REAL_QUESTIONS[2].text);
    await seedVerifiedCard(storeId);

    const provider = createMockProvider(() => "Evet, ürün fiyatına zam geldi.");
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    expect(draft.warnings.some((warning) => warning.kind === "PROMISE")).toBe(true);
    expect(draft.requiresHumanReview).toBe(true);
  });

  it("doğrulanmış özel ölçü alanı varsa cevap doğrudan verilir ve kaçamak sayılmaz", async () => {
    const { storeId, questionId } = await seedQuestion(REAL_QUESTIONS[0].text);
    await seedVerifiedCard(storeId);

    const provider = createMockProvider(() => "Evet, 260 x 220 ölçüsünde üretim yapabiliyoruz.");
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    expect(draft.intent).toBe("CUSTOM_SIZE");
    expect(draft.resolution).toBe("RESOLVED");
    expect(draft.requiresHumanReview).toBe(false);
  });

  it("doğrulanmamış politika prompt'a kesin bilgi olarak girmez", async () => {
    const { storeId, questionId } = await seedQuestion(REAL_QUESTIONS[0].text);
    await savePolicy({ storeId, key: "customSize", value: "Özel ölçü yapmıyoruz", actor: actor.name }, { prisma });

    let captured: LlmMessage | null = null;
    const provider = {
      name: "mock",
      model: "mock-model",
      async complete(messages: LlmMessage) {
        captured = messages;
        return {
          text: "Bu konuda doğrulanmış bilgi bulunmuyor.",
          provider: "mock",
          model: "mock-model",
          promptVersion: "v2-intent",
          durationMs: 5,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: true },
        };
      },
    };

    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    expect(captured!.user).not.toContain("Özel ölçü yapmıyoruz");
    expect(captured!.user).toContain("MAĞAZA POLİTİKASI: VERİLMEDİ");
    expect(draft.policiesUsed).toHaveLength(0);
  });

  it("doğrulanmış politika cevaba kaynak olarak girer", async () => {
    const { storeId, questionId } = await seedQuestion(REAL_QUESTIONS[0].text);
    await savePolicy({ storeId, key: "customSize", value: "Özel ölçü üretim yapıyoruz", actor: actor.name }, { prisma });
    await verifyPolicy({ storeId, key: "customSize", value: "", actor: actor.name }, { prisma });

    let captured: LlmMessage | null = null;
    const provider = {
      name: "mock",
      model: "mock-model",
      async complete(messages: LlmMessage) {
        captured = messages;
        return {
          text: "Evet, özel ölçü üretim yapıyoruz.",
          provider: "mock",
          model: "mock-model",
          promptVersion: "v2-intent",
          durationMs: 5,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: true },
        };
      },
    };

    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    expect(captured!.user).toContain("Özel ölçü üretim yapıyoruz");
    expect(draft.policiesUsed.map((policy) => policy.key)).toContain("customSize");
    expect(draft.strategy).not.toBe("ASK_DETAIL");
  });
});
