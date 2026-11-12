import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAiDraft, toDraftView } from "@/lib/drafts/service";
import { resetEnvCache } from "@/lib/env";
import { createMockProvider } from "@/lib/llm/provider";
import { describeClaims } from "@/lib/trendyol/claims-client";
import { describeLiveOrder, getLiveOrder, orderStageOf } from "@/lib/orders/live";
import { extractOrderNumber } from "@/lib/orders/decision";
import type { OrderPackageDto } from "@/lib/trendyol/orders-client";
import { disconnectPrisma, getPrisma } from "@/lib/prisma";

const prisma = getPrisma();
const actor = { name: "test" };

function pkg(overrides: Partial<OrderPackageDto> = {}): OrderPackageDto {
  return {
    shipmentPackageId: "9001",
    orderNumber: "11797104158",
    status: "Shipped",
    shipmentPackageStatus: "Shipped",
    orderDate: new Date("2026-11-05T10:00:00Z"),
    customerId: "CUST-1",
    cargoProviderName: "Trendyol Express",
    cargoTrackingNumber: "7280027504111111",
    cargoTrackingLink: "https://tracking.trendyol.com/?id=x",
    estimatedDeliveryStartDate: new Date("2026-11-07T10:00:00Z"),
    estimatedDeliveryEndDate: new Date("2026-11-09T10:00:00Z"),
    lastModifiedDate: new Date("2026-11-06T09:00:00Z"),
    packageHistories: [
      { status: "Picking", at: new Date("2026-11-05T12:00:00Z") },
      { status: "Shipped", at: new Date("2026-11-06T09:00:00Z") },
    ],
    lines: [
      { lineId: "L1", productId: "VAR-1", productMainId: "MAIN-1", productName: "Bambu Tül", quantity: 1, status: "Shipped" },
    ],
    ...overrides,
  };
}

function fakeOrders(list: OrderPackageDto[] | (() => never)) {
  return {
    async fetchOrdersPage(query: { orderNumber?: string } = {}) {
      if (typeof list === "function") return list();
      const content = query.orderNumber ? list.filter((p) => p.orderNumber === query.orderNumber) : list;
      return { content, page: 0, size: content.length, totalPages: 1, totalElements: content.length };
    },
  };
}

async function seedStoreAndQuestion(overrides: { text: string; customerId?: string | null } = { text: "" }) {
  const store = await prisma.store.upsert({
    where: { sellerId: 1081168n },
    update: {},
    create: { sellerId: 1081168n },
  });
  const question = await prisma.question.create({
    data: {
      storeId: store.id,
      trendyolQuestionId: BigInt(`78${Math.floor(Math.random() * 900000) + 100000}`),
      text: overrides.text,
      status: "ANSWERED",
      productName: "Bambu Tül Perde",
      productMainId: "MAIN-1",
      productId: "VAR-1",
      customerId: overrides.customerId === undefined ? "CUST-1" : overrides.customerId,
      askedAt: new Date(),
    },
  });
  return { storeId: store.id, questionId: question.id };
}

async function reset(): Promise<void> {
  await prisma.draftEvent.deleteMany();
  await prisma.answerDraft.deleteMany();
  await prisma.orderLine.deleteMany();
  await prisma.order.deleteMany();
  await prisma.question.deleteMany();
  await prisma.llmUsage.deleteMany();
  await prisma.storePolicy.deleteMany();
  await prisma.productInfo.deleteMany();
}

beforeEach(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetEnvCache();
  await reset();
});

afterAll(async () => {
  await reset();
  await disconnectPrisma();
});

describe("canlı sipariş eşleştirme (GÖREV 016)", () => {
  it("durum eşlemesi Türkçe ve doğru", () => {
    expect(orderStageOf("Created").stage).toBe("PREPARING");
    expect(orderStageOf("Picking").label).toContain("Hazırlanıyor");
    expect(orderStageOf("Invoiced").stage).toBe("PREPARING");
    expect(orderStageOf("Shipped").label).toContain("Kargoya verildi");
    expect(orderStageOf("Delivered").stage).toBe("DELIVERED");
    expect(orderStageOf("Returned").stage).toBe("RETURNED");
    expect(orderStageOf("Cancelled").stage).toBe("CANCELLED");
    expect(orderStageOf("BilinmeyenDurum").stage).toBe("UNKNOWN");
  });

  it("sipariş numarası ölçüyle karışmaz", () => {
    expect(extractOrderNumber("260 x 220 ölçüsü var mı").value).toBeNull();
    expect(extractOrderNumber("11804167582 siparişim ne zaman gelir").value).toBe("11804167582");
  });

  it("müşteri eşleşirse canlı veri kullanılır ve kaydedilir", async () => {
    const { storeId } = await seedStoreAndQuestion();
    const result = await getLiveOrder(
      { storeId, orderNumber: "11797104158", questionCustomerId: "CUST-1" },
      { prisma, client: fakeOrders([pkg()]) },
    );

    expect(result.kind).toBe("MATCHED");
    if (result.kind !== "MATCHED") return;
    expect(result.order.source).toBe("REMOTE");
    expect(result.order.stage).toBe("SHIPPED");
    expect(result.order.hasTracking).toBe(true);
    expect(result.order.estimatedDeliveryEnd).not.toBeNull();

    const saved = await prisma.order.findUnique({
      where: { storeId_orderNumber: { storeId, orderNumber: "11797104158" } },
    });
    expect(saved?.cargoProviderName).toBe("Trendyol Express");
    expect(saved?.fetchedAt).not.toBeNull();
  });

  it("farklı müşteriye ait sipariş kullanılmaz (PII sızmaz)", async () => {
    const { storeId } = await seedStoreAndQuestion();
    const result = await getLiveOrder(
      { storeId, orderNumber: "11797104158", questionCustomerId: "BASKASI" },
      { prisma, client: fakeOrders([pkg()]) },
    );
    expect(result.kind).toBe("MISMATCH");

    const saved = await prisma.order.findUnique({
      where: { storeId_orderNumber: { storeId, orderNumber: "11797104158" } },
    });
    expect(saved).toBeNull();
  });

  it("müşteri kimliği yoksa eşleşme doğrulanmaz", async () => {
    const { storeId } = await seedStoreAndQuestion({ text: "", customerId: null });
    const result = await getLiveOrder(
      { storeId, orderNumber: "11797104158", questionCustomerId: null },
      { prisma, client: fakeOrders([pkg()]) },
    );
    expect(result.kind).toBe("UNVERIFIED");
  });

  it("10 dakikalık taze yerel kopya API'ye gitmeden kullanılır", async () => {
    const { storeId } = await seedStoreAndQuestion();
    await getLiveOrder(
      { storeId, orderNumber: "11797104158", questionCustomerId: "CUST-1" },
      { prisma, client: fakeOrders([pkg()]) },
    );

    let calls = 0;
    const counting = {
      async fetchOrdersPage() {
        calls += 1;
        return { content: [pkg()], page: 0, size: 1, totalPages: 1, totalElements: 1 };
      },
    };
    const result = await getLiveOrder(
      { storeId, orderNumber: "11797104158", questionCustomerId: "CUST-1" },
      { prisma, client: counting },
    );
    expect(result.kind).toBe("MATCHED");
    if (result.kind === "MATCHED") expect(result.order.source).toBe("CACHE");
    expect(calls).toBe(0);
  });

  it("eski kopya yeniden çekilir (eski veriyle güncel iddia yok)", async () => {
    const { storeId } = await seedStoreAndQuestion();
    await getLiveOrder(
      { storeId, orderNumber: "11797104158", questionCustomerId: "CUST-1" },
      { prisma, client: fakeOrders([pkg()]) },
    );
    await prisma.order.updateMany({
      where: { storeId, orderNumber: "11797104158" },
      data: { fetchedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    let calls = 0;
    const counting = {
      async fetchOrdersPage() {
        calls += 1;
        return { content: [pkg({ shipmentPackageStatus: "Delivered", status: "Delivered" })], page: 0, size: 1, totalPages: 1, totalElements: 1 };
      },
    };
    const result = await getLiveOrder(
      { storeId, orderNumber: "11797104158", questionCustomerId: "CUST-1" },
      { prisma, client: counting },
    );
    expect(calls).toBe(1);
    expect(result.kind).toBe("MATCHED");
    if (result.kind === "MATCHED") {
      expect(result.order.stage).toBe("DELIVERED");
      expect(result.order.source).toBe("REMOTE");
    }
  });

  it("API hatası durumunda uydurma yapılmaz", async () => {
    const { storeId } = await seedStoreAndQuestion();
    const result = await getLiveOrder(
      { storeId, orderNumber: "11797104158", questionCustomerId: "CUST-1" },
      {
        prisma,
        client: fakeOrders(() => {
          throw new Error("boom");
        }),
      },
    );
    expect(result.kind).toBe("UNAVAILABLE");
  });

  it("sipariş bulunamazsa NOT_FOUND", async () => {
    const { storeId } = await seedStoreAndQuestion();
    const result = await getLiveOrder(
      { storeId, orderNumber: "11797104158", questionCustomerId: "CUST-1" },
      { prisma, client: fakeOrders([]) },
    );
    expect(result.kind).toBe("NOT_FOUND");
  });

  it("özet metni tahmini teslim ile gerçek teslimi ayırır, takip no yazmaz", async () => {
    const { storeId } = await seedStoreAndQuestion();
    const result = await getLiveOrder(
      { storeId, orderNumber: "11797104158", questionCustomerId: "CUST-1" },
      { prisma, client: fakeOrders([pkg()]) },
    );
    expect(result.kind).toBe("MATCHED");
    if (result.kind !== "MATCHED") return;
    const text = describeLiveOrder(result.order);
    expect(text).toContain("TAHMİNİ");
    expect(text).toContain("teslim tarihi DEĞİLDİR");
    expect(text).not.toContain("7280027504111111");
    expect(text).toContain("çekildi");
  });
});

describe("iade (claim) özeti", () => {
  it("kayıt yoksa 'iade yok' denmez", () => {
    expect(describeClaims([])).toContain("kaydı YOK");
  });

  it("iade kaydı para geçti iddiası kurmaz", () => {
    const text = describeClaims([
      { claimId: "C1", orderNumber: "11797104158", claimDate: new Date("2026-11-08T10:00:00Z"), status: "Accepted", itemStatuses: [] },
    ]);
    expect(text).toContain("İade kaydı");
    expect(text).toContain("hesaba GEÇTİĞİ");
  });
});

describe("taslak entegrasyonu", () => {
  it("eşleşen canlı sipariş taslağa kaynak olarak eklenir", async () => {
    const { questionId } = await seedStoreAndQuestion({
      text: "11797104158 siparişim şu an hangi aşamada?",
    });

    const seen: string[] = [];
    const provider = createMockProvider((messages) => {
      seen.push(messages.user);
      return "Siparişiniz kargoya verilmiş durumda. Kargo takip bilgisi sipariş detayınızda yer alıyor.";
    });

    const draft = await createAiDraft(
      { questionId, actor },
      { prisma, provider, ordersClient: fakeOrders([pkg()]) },
    );

    expect(draft.orderMatch).toBe("MATCHED");
    expect(draft.contextSources.some((source) => source.type === "TRENDYOL_ORDER")).toBe(true);
    expect(seen[0]).toContain("CANLI SİPARİŞ BİLGİSİ");
    expect(seen[0]).toContain("Kargoya verildi");
    expect(seen[0]).not.toContain("7280027504111111");
    expect(draft.resolution).toBe("ANSWERED");
  });

  it("müşteri eşleşmezse kişisel sipariş detayı prompt'a girmez", async () => {
    const { questionId } = await seedStoreAndQuestion({ text: "11797104158 siparişim nerede?", customerId: "BASKASI" });

    const seen: string[] = [];
    const provider = createMockProvider((messages) => {
      seen.push(messages.user);
      return "Sipariş numaranızı doğrulayamadığımız için bu konuda kesin bilgi veremiyorum.";
    });

    const draft = await createAiDraft(
      { questionId, actor },
      { prisma, provider, ordersClient: fakeOrders([pkg()]) },
    );

    expect(draft.orderMatch).toBe("MISMATCH");
    expect(seen[0]).not.toContain("CANLI SİPARİŞ BİLGİSİ");
    expect(draft.warnings.some((warning) => warning.kind === "ORDER")).toBe(true);
    expect(draft.resolution).toBe("HUMAN_REVIEW");
  });

  it("API ulaşılamazsa güncel durum iddiası kurulmaz", async () => {
    const { questionId } = await seedStoreAndQuestion({ text: "11797104158 siparişim nerede?" });
    const provider = createMockProvider(() => "Sipariş durumunuz hakkında doğrulanmış bilgi bulunmuyor.");

    const draft = await createAiDraft(
      { questionId, actor },
      {
        prisma,
        provider,
        ordersClient: fakeOrders(() => {
          throw new Error("boom");
        }),
      },
    );

    expect(draft.orderMatch).toBe("UNAVAILABLE");
    expect(draft.warnings.some((warning) => warning.kind === "ORDER")).toBe(true);
    expect(draft.resolution).not.toBe("ANSWERED");
  });

  it("iade sorusunda claim bağlamı eklenir, para geçti denmez", async () => {
    const { questionId } = await seedStoreAndQuestion({ text: "11797104158 iade ettim para hesabıma geçmedi" });

    const seen: string[] = [];
    const provider = createMockProvider((messages) => {
      seen.push(messages.user);
      return "İade kaydınız görünüyor; ücretin hesabınıza geçişi bankanıza bağlıdır, bu konuda kesin bilgi veremiyorum.";
    });

    const draft = await createAiDraft(
      { questionId, actor },
      {
        prisma,
        provider,
        ordersClient: fakeOrders([pkg({ shipmentPackageStatus: "Delivered", status: "Delivered" })]),
        claimsClient: {
          async fetchClaims() {
            return [{ claimId: "C1", orderNumber: "11797104158", claimDate: new Date(), status: "Accepted", itemStatuses: [] }];
          },
        },
      },
    );

    expect(seen[0]).toContain("İADE (CLAIM) BİLGİSİ");
    expect(seen[0]).toContain("hesaba geçtiğini SÖYLEME");
    expect(draft.resolution).toBe("HUMAN_REVIEW");
  });
});

describe("çoklu ölçü talebi", () => {
  it("tek belirsiz değişikliğe indirgenmez, ayrı kayıt ister", async () => {
    const { questionId } = await seedStoreAndQuestion({
      text: "11797104158 150-260 2 adet olsun, 135-260 yapma şansınız var mı",
    });
    const { createChangeRequestFromQuestion } = await import("@/lib/orders/service");
    await expect(createChangeRequestFromQuestion({ questionId, actor })).rejects.toMatchObject({
      code: "MULTI_SIZE_REQUEST",
    });
  });
});

describe("regresyon: canlı veri yokken durum soruları çözülmüş sayılmaz", () => {
  it.each([
    ["Merhaba 2 gun Sonra  mı kargoya verilir"],
    ["merhaba siparisim hazırlanıyor yaziyor kargoya ne zmn verilir acaba"],
  ])("%s → ANSWERED değil", async (text) => {
    const { questionId } = await seedStoreAndQuestion({ text, customerId: "CUST-1" });
    const provider = createMockProvider(
      () => "Kargoya verme süresi ürünün hazırlık süresine göre değişir; Trendyol'da gösterilen tahmini kargoya teslim tarihi esas alınır.",
    );
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });
    expect(draft.resolution).not.toBe("ANSWERED");
  });

  it("değişiklik tamamlandı iddiası ihlal olarak yakalanır", async () => {
    const { detectOrderClaimViolations } = await import("@/lib/orders/ai-guidance");
    const violations = detectOrderClaimViolations("Değişikliğiniz onaylandı ve uygulandı.", { kind: "NONE" });
    expect(violations.length).toBeGreaterThan(0);
  });
});
