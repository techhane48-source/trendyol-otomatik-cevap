import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { resetEnvCache } from "@/lib/env";
import { createMockProvider } from "@/lib/llm/provider";
import { disconnectPrisma, getPrisma } from "@/lib/prisma";
import {
  QualityAccessError,
  QualityError,
  MIN_SAMPLES,
  createQualitySet,
  getUsageReport,
  listQualityRuns,
  listRunItems,
  scoreQualityItem,
  startQualityRun,
} from "@/lib/quality/service";
import { createProductInfo, verifyProductInfo } from "@/lib/products/service";

const prisma = getPrisma();

async function storeIdNow(): Promise<string> {
  const existing = await prisma.store.findFirst({ orderBy: { createdAt: "asc" } });
  if (existing) return existing.id;
  const created = await prisma.store.create({ data: { sellerId: BigInt(700000 + Math.floor(Math.random() * 90000)) } });
  return created.id;
}
const actor = { name: "kalite-yoneticisi" };

const PROVIDER_ERROR = "Sağlayıcı hatası";

async function resetDatabase(): Promise<void> {
  await prisma.qualityItem.deleteMany();
  await prisma.qualityRun.deleteMany();
  await prisma.qualitySet.deleteMany();
  await prisma.llmUsage.deleteMany();
  await prisma.draftEvent.deleteMany();
  await prisma.answerDraft.deleteMany();
  await prisma.productInfoEvent.deleteMany();
  await prisma.productInfo.deleteMany();
  await prisma.question.deleteMany();
  await prisma.store.deleteMany();
}

async function seedQuestions(count: number, text?: string): Promise<string[]> {
  const store = await prisma.store.create({ data: { sellerId: 1081168n } });
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const question = await prisma.question.create({
      data: {
        storeId: store.id,
        trendyolQuestionId: BigInt(910000 + index),
        text:
          text ??
          `Ürün hakkında bilgi alabilir miyim? Beni 0532 123 45 ${String(index).padStart(2, "0")} numaradan arayın.`,
        status: "ANSWERED",
        rawStatus: "ANSWERED",
        productName: "Bambu Tül Perde",
        productMainId: "MAIN-Q1",
        productId: null,
        askedAt: new Date("2026-11-01T09:00:00Z"),
      },
    });
    ids.push(question.id);
  }

  return ids;
}

beforeEach(async () => {
  process.env.LLM_PROVIDER = "mock";
  process.env.ADMIN_ACTOR_NAME = "kalite-yoneticisi";
  process.env.LLM_INPUT_COST_PER_1K = "0.5";
  process.env.LLM_OUTPUT_COST_PER_1K = "1.5";
  resetEnvCache();
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await disconnectPrisma();
});

describe("değerlendirme seti", () => {
  it("30 örnekle set oluşturur ve soru kimliklerini sabitler", async () => {
    await seedQuestions(35);
    const set = await createQualitySet({ storeId: await storeIdNow(), name: "Ekim seti", sampleCount: MIN_SAMPLES, actor }, { prisma });

    expect(set.sampleCount).toBe(MIN_SAMPLES);

    const row = await prisma.qualitySet.findUnique({ where: { id: set.id } });
    expect(Array.isArray(row?.sampleQuestionIds)).toBe(true);
    expect((row?.sampleQuestionIds as string[]).length).toBe(MIN_SAMPLES);
  });

  it("izin verilen aralık dışındaki örnek sayısını reddeder", async () => {
    await seedQuestions(5);
    await expect(createQualitySet({ storeId: await storeIdNow(), sampleCount: 10, actor }, { prisma })).rejects.toMatchObject({
      code: "INVALID_SAMPLE_COUNT",
    });
    await expect(createQualitySet({ storeId: await storeIdNow(), sampleCount: 51, actor }, { prisma })).rejects.toMatchObject({
      code: "INVALID_SAMPLE_COUNT",
    });
  });

  it("soru yoksa güvenli hata verir", async () => {
    await expect(createQualitySet({ storeId: await storeIdNow(), sampleCount: 30, actor }, { prisma })).rejects.toMatchObject({
      code: "NO_QUESTIONS",
    });
  });

  it("yönetici kimliği olmadan işlem yapılamaz", async () => {
    await expect(createQualitySet({ storeId: await storeIdNow(), sampleCount: 30, actor: { name: "  " } }, { prisma })).rejects.toBeInstanceOf(
      QualityAccessError,
    );
  });
});

describe("değerlendirme koşusu", () => {
  it("örnekleri değerlendirir, PII maskeleyerek saklar ve kullanım kaydı üretir", async () => {
    await seedQuestions(30);
    const provider = createMockProvider(() => "Sorunuz için teşekkür ederiz, ilgili bilgiyi iletiyoruz.");
    const set = await createQualitySet({ storeId: await storeIdNow(), name: "Koşu seti", sampleCount: 30, actor }, { prisma });

    const result = await startQualityRun({ setId: set.id, actor }, { prisma, provider });
    expect(result.itemCount).toBe(30);

    const items = await listRunItems(await storeIdNow(), result.runId, { prisma });
    expect(items).toHaveLength(30);
    expect(items[0].questionMasked).not.toContain("0532");
    expect(items[0].questionMasked).toContain("[telefon]");

    const usages = await prisma.llmUsage.findMany({ where: { purpose: "quality" } });
    expect(usages.length).toBe(30);
    expect(usages[0].outcome).toBe("SUCCESS");
    expect(usages[0].estimatedCostUSD).toBeGreaterThan(0);
  });

  it("doğrulanmış bilgi yokken kesin vaat içeren cevabı NEEDS_INFO olarak işaretler", async () => {
    await seedQuestions(30);
    const provider = createMockProvider(() => "Bu perde kesinlikle göstermez, 5 yıl garantilidir.");
    const set = await createQualitySet({ storeId: await storeIdNow(), name: "Vaat seti", sampleCount: 30, actor }, { prisma });

    const result = await startQualityRun({ setId: set.id, actor }, { prisma, provider });
    const items = await listRunItems(await storeIdNow(), result.runId, { prisma });

    expect(items.every((item) => item.outcome === "NEEDS_INFO")).toBe(true);
    expect(items[0].checks?.needsHuman).toBe(true);
    expect(items[0].checks?.warningCount).toBeGreaterThan(0);
  });

  it("aynı seti tekrar çalıştırınca yeni koşu oluşur ve karşılaştırılabilir", async () => {
    await seedQuestions(30);
    const provider = createMockProvider(() => "Bilgiyi kontrol edip ileteceğiz.");
    const set = await createQualitySet({ storeId: await storeIdNow(), name: "Karşılaştırma", sampleCount: 30, actor }, { prisma });

    const first = await startQualityRun({ setId: set.id, actor }, { prisma, provider });
    const second = await startQualityRun({ setId: set.id, actor }, { prisma, provider });

    const runs = await listQualityRuns(await storeIdNow(), { prisma });
    expect(runs.length).toBe(2);
    expect(runs[0].runId).toBe(second.runId);
    expect(runs[0].itemCount).toBe(runs[1].itemCount);
    expect(runs.map((run) => run.promptVersion).every((version) => version.length > 0)).toBe(true);
    expect(first.itemCount).toBe(second.itemCount);
  });

  it("sağlayıcı hata verirse başarısız çağrıyı kaydeder ve koşuyu FAILED yapar", async () => {
    await seedQuestions(30);
    const provider = {
      name: "bozuk",
      model: "bozuk-model",
      complete: async () => {
        throw new Error(PROVIDER_ERROR);
      },
    };
    const set = await createQualitySet({ storeId: await storeIdNow(), name: "Hata seti", sampleCount: 30, actor }, { prisma });
    const result = await startQualityRun({ setId: set.id, actor }, { prisma, provider });

    const run = await prisma.qualityRun.findUnique({ where: { id: result.runId } });
    expect(run?.status).toBe("FAILED");
    expect(await prisma.llmUsage.count({ where: { outcome: "ERROR" } })).toBe(30);
  });

  it("olmayan set için güvenli hata verir", async () => {
    await expect(startQualityRun({ setId: "yok", actor }, { prisma })).rejects.toMatchObject({
      code: "SET_NOT_FOUND",
    });
  });
});

describe("insan değerlendirmesi ve metrikler", () => {
  it("1–5 arası puanı kaydeder, geçersiz puanı reddeder", async () => {
    await seedQuestions(30);
    const provider = createMockProvider(() => "Bilgiyi ileteceğiz.");
    const set = await createQualitySet({ storeId: await storeIdNow(), name: "Puan seti", sampleCount: 30, actor }, { prisma });
    const result = await startQualityRun({ setId: set.id, actor }, { prisma, provider });
    const items = await listRunItems(await storeIdNow(), result.runId, { prisma });

    await expect(scoreQualityItem({ itemId: items[0].id, score: 0, actor }, { prisma })).rejects.toBeInstanceOf(
      QualityError,
    );
    await expect(scoreQualityItem({ itemId: items[0].id, score: 6, actor }, { prisma })).rejects.toBeInstanceOf(
      QualityError,
    );

    const saved = await scoreQualityItem({ itemId: items[0].id, score: 5, note: "Net cevap", actor }, { prisma });
    expect(saved.humanScore).toBe(5);

    const row = await prisma.qualityItem.findUnique({ where: { id: items[0].id } });
    expect(row?.humanNote).toBe("Net cevap");
    expect(row?.evaluatedBy).toBe("kalite-yoneticisi");
    expect(row?.evaluatedAt).toBeInstanceOf(Date);
  });

  it("ortalama insan puanı ve oranları raporlar", async () => {
    await seedQuestions(30);
    const provider = createMockProvider(() => "Bilgiyi ileteceğiz.");
    const set = await createQualitySet({ storeId: await storeIdNow(), name: "Metrik seti", sampleCount: 30, actor }, { prisma });
    const result = await startQualityRun({ setId: set.id, actor }, { prisma, provider });
    const items = await listRunItems(await storeIdNow(), result.runId, { prisma });

    await scoreQualityItem({ itemId: items[0].id, score: 4, actor }, { prisma });
    await scoreQualityItem({ itemId: items[1].id, score: 2, actor }, { prisma });

    const [run] = await listQualityRuns(await storeIdNow(), { prisma });
    expect(run.avgHumanScore).toBe(3);
    expect(run.scoredCount).toBe(2);
    expect(run.warningRate).toBe(0);
    expect(run.needsInfoRate).toBe(0);
    expect(run.totalCostUSD).toBeGreaterThan(0);
  });

  it("günlük kullanım raporu başarısız çağrıları da sayar", async () => {
    const usageStoreId = await storeIdNow();
    await prisma.llmUsage.createMany({
      data: [
        {
          storeId: usageStoreId,
          provider: "mock",
          model: "mock-model",
          promptVersion: "v1",
          outcome: "SUCCESS",
          durationMs: 12,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          estimatedCostUSD: 0.0001,
        },
        {
          storeId: usageStoreId,
          provider: "mock",
          model: "mock-model",
          promptVersion: "v1",
          outcome: "ERROR",
          errorCode: "HTTP_500",
          durationMs: 30,
        },
      ],
    });

    const report = await getUsageReport(await storeIdNow(), { prisma });
    expect(report.totalCalls).toBe(2);
    expect(report.failedCalls).toBe(1);
    expect(report.totalTokens).toBe(150);
    expect(report.daily.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ana ürün kartı bütünlüğü", () => {
  it("aynı mağaza ve ana ürün için ikinci NULL varyant kaydı veritabanında reddedilir", async () => {
    const store = await prisma.store.create({ data: { sellerId: 1081168n } });
    const base = {
      storeId: store.id,
      productMainId: "MAIN-DUP",
      productId: null,
      attributes: [],
    };

    await prisma.productInfo.create({ data: base });
    await expect(prisma.productInfo.create({ data: base })).rejects.toThrow();
  });

  it("ana ürün kartına varyantlarda farklılaşan özellik yazılamaz", async () => {
    const store = await prisma.store.create({ data: { sellerId: 1081168n } });

    await createProductInfo(
      {
        storeId: store.id,
        productMainId: "MAIN-C1",
        productId: "VAR-A",
        attributes: [{ label: "Renk", value: "Bej" }],
        actor,
      },
      { prisma },
    );
    await createProductInfo(
      {
        storeId: store.id,
        productMainId: "MAIN-C1",
        productId: "VAR-B",
        attributes: [{ label: "Renk", value: "Mint" }],
        actor,
      },
      { prisma },
    );

    await expect(
      createProductInfo(
        {
          storeId: store.id,
          productMainId: "MAIN-C1",
          attributes: [{ label: "Renk", value: "Bej" }],
          actor,
        },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: "MAIN_CARD_CONFLICT" });
  });

  it("varyant kimliği olmayan ana kart tekil kalır ve doğrulanabilir", async () => {
    const store = await prisma.store.create({ data: { sellerId: 1081168n } });

    const card = await createProductInfo(
      {
        storeId: store.id,
        productMainId: "MAIN-OK",
        attributes: [{ label: "Kumaş", value: "Bambu dokulu tül" }],
        actor,
      },
      { prisma },
    );
    const verified = await verifyProductInfo({ id: card.id, actor }, { prisma });
    expect(verified.status).toBe("VERIFIED");
  });
});
