import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAiDraft } from "@/lib/drafts/service";
import { resetEnvCache } from "@/lib/env";
import { buildOrderGuidance, detectOrderClaimViolations } from "@/lib/orders/ai-guidance";
import { decideOrderStatus, extractOrderNumber, matchOrderLine, parseDimensions } from "@/lib/orders/decision";
import {
  OrderAccessError,
  OrderError,
  approveChangeRequest,
  createChangeRequestFromQuestion,
  listApprovedForProduction,
  listChangeRequests,
  rejectChangeRequest,
  syncOrders,
} from "@/lib/orders/service";
import { disconnectPrisma, getPrisma } from "@/lib/prisma";
import { createMockProvider } from "@/lib/llm/provider";
import type { OrdersClient, OrderPackageDto } from "@/lib/trendyol/orders-client";

const prisma = getPrisma();
const actor = { name: "uretim-sorumlusu" };

function pkg(overrides: Partial<OrderPackageDto> = {}): OrderPackageDto {
  return {
    shipmentPackageId: "9001",
    orderNumber: "123456789",
    status: "Created",
    orderDate: new Date("2026-11-01T10:00:00Z"),
    customerId: "CUST-1",
    lines: [
      {
        lineId: "L1",
        productId: "VAR-1",
        productMainId: "MAIN-1",
        productName: "Bambu Tül Perde",
        quantity: 1,
        status: null,
      },
    ],
    ...overrides,
  };
}

function fakeClient(packages: OrderPackageDto[] | (() => never)): OrdersClient {
  return {
    async fetchOrdersPage(query = {}) {
      if (typeof packages === "function") return packages();
      const filtered = query.orderNumber
        ? packages.filter((item) => item.orderNumber === query.orderNumber)
        : packages;
      return { content: filtered, page: 0, size: filtered.length, totalPages: 1, totalElements: filtered.length };
    },
    async fetchOrdersStream() {
      return { packages: typeof packages === "function" ? [] : packages, nextCursor: null };
    },
  };
}

async function seedQuestion(
  overrides: Partial<{ text: string; customerId: string | null; productId: string | null; productMainId: string | null }> = {},
): Promise<string> {
  const store = await prisma.store.upsert({
    where: { sellerId: 1081168n },
    update: {},
    create: { sellerId: 1081168n },
  });

  const question = await prisma.question.create({
    data: {
      storeId: store.id,
      trendyolQuestionId: BigInt(`77${Math.floor(Math.random() * 900000) + 100000}`),
      text: overrides.text ?? "Sipariş no 123456789 için en 100 boy 250 cm olarak değiştirebilir misiniz?",
      status: "ANSWERED",
      rawStatus: "ANSWERED",
      productName: "Bambu Tül Perde",
      productMainId: overrides.productMainId === undefined ? "MAIN-1" : overrides.productMainId,
      productId: overrides.productId === undefined ? "VAR-1" : overrides.productId,
      customerId: overrides.customerId === undefined ? "CUST-1" : overrides.customerId,
      askedAt: new Date(),
    },
  });

  return question.id;
}

async function resetDatabase(): Promise<void> {
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
  process.env.ADMIN_ACTOR_NAME = "uretim-sorumlusu";
  resetEnvCache();
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await disconnectPrisma();
});

describe("durum karar motoru", () => {
  it.each([
    ["Created", "CAN_REQUEST"],
    ["Picking", "TOO_LATE"],
    ["Invoiced", "TOO_LATE"],
    ["Shipped", "TOO_LATE"],
    ["Delivered", "TOO_LATE"],
    ["Cancelled", "HUMAN_REVIEW"],
    ["Returned", "HUMAN_REVIEW"],
    ["Awaiting", "HUMAN_REVIEW"],
    ["UnPacked", "HUMAN_REVIEW"],
    ["Bilinmeyen", "HUMAN_REVIEW"],
    ["", "HUMAN_REVIEW"],
  ])("%s → %s", (status, expected) => {
    expect(decideOrderStatus(status).decision).toBe(expected);
  });
});

describe("metin ayrıştırma", () => {
  it("sipariş numarasını etiketli metinden çıkarır", () => {
    expect(extractOrderNumber("Sipariş no: 123456789 için rica ediyorum").value).toBe("123456789");
    expect(extractOrderNumber("siparis numarasi 987654321").value).toBe("987654321");
  });

  it("birden fazla numarada tahmin yapmaz", () => {
    const result = extractOrderNumber("123456789 ve 987654321 numaralı siparişler");
    expect(result.value).toBeNull();
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("ölçüleri en/boy etiketiyle kesin ayrıştırır", () => {
    const parsed = parseDimensions("en 100 boy 250 cm olarak değiştirir misiniz");
    expect(parsed).toMatchObject({ widthCm: 100, heightCm: 250, orientationUncertain: false });
  });

  it("etiket yoksa yönü belirsiz işaretler", () => {
    const parsed = parseDimensions("100x250 olarak değiştirebilir misiniz");
    expect(parsed.widthCm).toBe(100);
    expect(parsed.heightCm).toBe(250);
    expect(parsed.orientationUncertain).toBe(true);
  });

  it("tire veya tek sayıyı ölçü çifti saymaz", () => {
    expect(parseDimensions("150-260 olsun").widthCm).toBeNull();
    expect(parseDimensions("boyu 145 cm olsun").heightCm).toBeNull();
  });

  it("metre birimini cm'ye çevirir", () => {
    const parsed = parseDimensions("en 2 metre boy 2.5 metre olsun");
    expect(parsed.widthCm).toBe(200);
    expect(parsed.heightCm).toBe(250);
  });
});

describe("kalem eşleştirme", () => {
  const lines = [
    { id: "1", lineId: "L1", productId: "VAR-1", productMainId: "MAIN-1", productName: "A" },
    { id: "2", lineId: "L2", productId: "VAR-2", productMainId: "MAIN-1", productName: "B" },
  ];

  it("varyant kimliğiyle tek kalem eşleşir", () => {
    const match = matchOrderLine({ productId: "VAR-1", productMainId: "MAIN-1" }, lines);
    expect(match.line?.lineId).toBe("L1");
    expect(match.ambiguous).toBe(false);
  });

  it("aynı ana ürün altında çok kalem varsa belirsiz sayar", () => {
    const match = matchOrderLine({ productId: "VAR-9", productMainId: "MAIN-1" }, lines);
    expect(match.ambiguous).toBe(true);
    expect(match.line).toBeNull();
  });
});

describe("talep oluşturma", () => {
  it("Created + doğrulanmış sahiplik + net ölçü → PENDING_REVIEW", async () => {
    const questionId = await seedQuestion();
    const result = await createChangeRequestFromQuestion(
      { questionId, actor },
      { prisma, client: fakeClient([pkg()]) },
    );

    expect(result.status).toBe("PENDING_REVIEW");
    expect(result.decision).toBe("CAN_REQUEST");
    expect(result.message).toContain("üretim onayı bekleniyor");
    expect(result.requestedWidthCm).toBe(100);
    expect(result.requestedHeightCm).toBe(250);

    const events = await prisma.orderChangeEvent.findMany({ where: { requestId: result.id } });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("CREATED");
  });

  it("Picking durumunda talep reddedilir ve kesin söz verilmez", async () => {
    const questionId = await seedQuestion();
    const result = await createChangeRequestFromQuestion(
      { questionId, actor },
      { prisma, client: fakeClient([pkg({ status: "Picking" })]) },
    );

    expect(result.status).toBe("REJECTED");
    expect(result.decision).toBe("TOO_LATE");
    expect(result.message).toContain("işleme alındığı için");
  });

  it("müşteri sahipliği doğrulanamazsa doğrulamaya düşer", async () => {
    const questionId = await seedQuestion({ customerId: "CUST-OTHER" });
    const result = await createChangeRequestFromQuestion(
      { questionId, actor },
      { prisma, client: fakeClient([pkg()]) },
    );

    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.ownershipVerified).toBe(false);
  });

  it("yanlış ürün eşleşmesinde otomatik kabul etmez", async () => {
    const questionId = await seedQuestion({ productId: "VAR-OTHER", productMainId: "MAIN-OTHER" });
    const result = await createChangeRequestFromQuestion(
      { questionId, actor },
      { prisma, client: fakeClient([pkg()]) },
    );

    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.decision).toBe("HUMAN_REVIEW");
  });

  it("çok kalemli siparişte belirsiz eşleşmeyi insan incelemesine bırakır", async () => {
    const questionId = await seedQuestion();
    const multi = pkg({
      lines: [
        { lineId: "L1", productId: "VAR-1", productMainId: "MAIN-1", productName: "A", quantity: 1, status: null },
        { lineId: "L2", productId: "VAR-1", productMainId: "MAIN-1", productName: "A", quantity: 2, status: null },
      ],
    });
    const result = await createChangeRequestFromQuestion(
      { questionId, actor },
      { prisma, client: fakeClient([multi]) },
    );
    expect(result.status).toBe("NEEDS_VERIFICATION");
  });

  it("en/boy belirsizse doğrulama ister", async () => {
    const questionId = await seedQuestion({ text: "Sipariş no 123456789 için 100x250 olsun" });
    const result = await createChangeRequestFromQuestion(
      { questionId, actor },
      { prisma, client: fakeClient([pkg()]) },
    );

    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.orientationUncertain).toBe(true);
  });

  it("sipariş numarası yoksa hata verir", async () => {
    const questionId = await seedQuestion({ text: "Ölçü değiştirebilir miyim?" });
    await expect(
      createChangeRequestFromQuestion({ questionId, actor }, { prisma, client: fakeClient([pkg()]) }),
    ).rejects.toMatchObject({ code: "ORDER_NUMBER_NOT_FOUND" });
  });

  it("API kesintisinde değişiklik mümkün sayılmaz ve kayıt oluşmaz", async () => {
    const questionId = await seedQuestion();
    const broken = fakeClient(() => {
      throw new Error("API down");
    });

    await expect(createChangeRequestFromQuestion({ questionId, actor }, { prisma, client: broken })).rejects.toMatchObject(
      { code: "ORDERS_API_UNAVAILABLE" },
    );
    expect(await prisma.orderChangeRequest.count()).toBe(0);
  });

  it("mükerrer aktif talebi engeller", async () => {
    const questionId = await seedQuestion();
    await createChangeRequestFromQuestion({ questionId, actor }, { prisma, client: fakeClient([pkg()]) });

    await expect(
      createChangeRequestFromQuestion({ questionId, actor }, { prisma, client: fakeClient([pkg()]) }),
    ).rejects.toMatchObject({ code: "DUPLICATE_ACTIVE_REQUEST" });
  });

  it("yetkisiz (aktörsüz) işlem reddedilir", async () => {
    const questionId = await seedQuestion();
    await expect(
      createChangeRequestFromQuestion({ questionId, actor: { name: "" } }, { prisma, client: fakeClient([pkg()]) }),
    ).rejects.toBeInstanceOf(OrderAccessError);
  });
});

describe("onay ve ret", () => {
  async function pendingRequest(client: OrdersClient) {
    const questionId = await seedQuestion();
    const created = await createChangeRequestFromQuestion({ questionId, actor }, { prisma, client });
    return created.id;
  }

  it("canlı durum Created ise onaylar", async () => {
    const client = fakeClient([pkg()]);
    const requestId = await pendingRequest(client);

    const approved = await approveChangeRequest(
      { requestId, actor, note: "üretim uygun" },
      { prisma, client },
    );
    expect(approved.status).toBe("APPROVED");
    expect(approved.orderStatusAtApproval).toContain("Created");

    const production = await listApprovedForProduction({ prisma });
    expect(production).toHaveLength(1);
    expect(production[0].approvedBy).toBe("uretim-sorumlusu");
  });

  it("onay anında Picking'e geçmiş siparişi INVALIDATED yapar", async () => {
    const initial = fakeClient([pkg()]);
    const requestId = await pendingRequest(initial);

    const later = fakeClient([pkg({ status: "Picking" })]);
    await expect(approveChangeRequest({ requestId, actor }, { prisma, client: later })).rejects.toMatchObject({
      code: "ORDER_STATUS_CHANGED",
    });

    const row = await prisma.orderChangeRequest.findUnique({ where: { id: requestId } });
    expect(row?.status).toBe("INVALIDATED");
    const events = await prisma.orderChangeEvent.findMany({ where: { requestId } });
    expect(events.some((event) => event.action === "INVALIDATED")).toBe(true);
  });

  it("doğrulama bekleyen talep insan incelemesiyle onaylanabilir", async () => {
    const questionId = await seedQuestion({ customerId: "CUST-OTHER" });
    const client = fakeClient([pkg()]);
    const created = await createChangeRequestFromQuestion({ questionId, actor }, { prisma, client });
    expect(created.status).toBe("NEEDS_VERIFICATION");

    const approved = await approveChangeRequest({ requestId: created.id, actor, note: "sipariş müşteriyle eşleşti" }, { prisma, client });
    expect(approved.status).toBe("APPROVED");
  });

  it("kalem eşleşmesi olmayan talep onaylanamaz", async () => {
    const questionId = await seedQuestion({ productId: "VAR-OTHER", productMainId: "MAIN-OTHER" });
    const client = fakeClient([pkg()]);
    const created = await createChangeRequestFromQuestion({ questionId, actor }, { prisma, client });
    await expect(approveChangeRequest({ requestId: created.id, actor }, { prisma, client })).rejects.toMatchObject({
      code: "LINE_NOT_MATCHED",
    });
  });

  it("çift onayı engeller", async () => {
    const client = fakeClient([pkg()]);
    const requestId = await pendingRequest(client);
    await approveChangeRequest({ requestId, actor }, { prisma, client });

    await expect(approveChangeRequest({ requestId, actor }, { prisma, client })).rejects.toMatchObject({
      code: "ALREADY_APPROVED",
    });
  });

  it("reddedilen talep tekrar reddedilemez ve onaylanamaz", async () => {
    const client = fakeClient([pkg()]);
    const requestId = await pendingRequest(client);

    await rejectChangeRequest({ requestId, actor, note: "müşteri vazgeçti" }, { prisma });
    await expect(rejectChangeRequest({ requestId, actor }, { prisma })).rejects.toMatchObject({
      code: "ALREADY_REJECTED",
    });
    await expect(approveChangeRequest({ requestId, actor }, { prisma, client })).rejects.toMatchObject({
      code: "REQUEST_REJECTED",
    });
  });

  it("API kesintisinde onay yapılmaz", async () => {
    const requestId = await pendingRequest(fakeClient([pkg()]));
    const broken = fakeClient(() => {
      throw new Error("down");
    });
    await expect(approveChangeRequest({ requestId, actor }, { prisma, client: broken })).rejects.toMatchObject({
      code: "ORDERS_API_UNAVAILABLE",
    });
    const row = await prisma.orderChangeRequest.findUnique({ where: { id: requestId } });
    expect(row?.status).toBe("PENDING_REVIEW");
  });

  it("onaylı talepler listelenir, filtre çalışır", async () => {
    const client = fakeClient([pkg()]);
    const requestId = await pendingRequest(client);
    await approveChangeRequest({ requestId, actor }, { prisma, client });

    const approved = await listChangeRequests({ status: "APPROVED" }, { prisma });
    expect(approved).toHaveLength(1);
    const pending = await listChangeRequests({ status: "PENDING_REVIEW" }, { prisma });
    expect(pending).toHaveLength(0);
  });
});

describe("sipariş senkronizasyonu", () => {
  it("paketleri ve kalemleri yerel aynaya yazar (PII saklamaz)", async () => {
    const result = await syncOrders({}, { prisma, client: fakeClient([pkg()]) });
    expect(result.saved).toBe(1);
    expect(result.lines).toBe(1);

    const order = await prisma.order.findFirst({ include: { lines: true } });
    expect(order?.status).toBe("Created");
    expect(order?.customerRef).not.toBe("CUST-1");
    expect(order?.lines[0].lineId).toBe("L1");
  });
});

describe("AI taslak kısıtları", () => {
  it("kayıt yokken onay iddiası uyarı üretir", () => {
    const warnings = detectOrderClaimViolations("Ölçü değişikliği talebiniz onaylandı.", { kind: "NONE" });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].kind).toBe("PROMISE");
  });

  it("PENDING_REVIEW'da 'aldık' serbest, 'onaylandı' yasak", () => {
    const state = { kind: "PENDING_REVIEW" as const, orderNumber: "123", status: "PENDING_REVIEW" };
    expect(detectOrderClaimViolations("Talebinizi aldık, üretim onayı bekleniyor.", state)).toHaveLength(0);
    expect(detectOrderClaimViolations("Talebiniz onaylandı.", state).length).toBeGreaterThan(0);
  });

  it("APPROVED durumunda onay cümlesi serbest", () => {
    const state = { kind: "APPROVED" as const, orderNumber: "123" };
    expect(detectOrderClaimViolations("Ölçü değişikliği talebiniz onaylandı.", state)).toHaveLength(0);
  });

  it("durum doğrulanmadan 'yapılamıyor' denemez", () => {
    const warnings = detectOrderClaimViolations("Maalesef ölçü değişikliği yapılamıyor.", { kind: "NONE" });
    expect(warnings.some((warning) => warning.phrase.includes("yapılamıyor"))).toBe(true);
  });

  it("NONE durumunda rehberlik kesin ifadeyi yasaklar", () => {
    const guidance = buildOrderGuidance({ kind: "NONE" });
    expect(guidance.allowedClaim).toBe("NONE");
    expect(guidance.instruction).toContain("YASAK");
  });

  it("onaysız talepte AI taslağı NEEDS_INFO olur ve kesin söz veremez", async () => {
    const questionId = await seedQuestion();
    await createChangeRequestFromQuestion({ questionId, actor }, { prisma, client: fakeClient([pkg()]) });

    const provider = createMockProvider(() => "Ölçü değişikliği talebiniz onaylandı, üretime geçiyoruz.");
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    expect(draft.status).toBe("NEEDS_INFO");
    expect(draft.warnings.length).toBeGreaterThan(0);
    expect(draft.warnings.some((warning) => /onay/i.test(warning.phrase))).toBe(true);
  });

  it("onaylı talepte AI onay cümlesini kurabilir", async () => {
    const client = fakeClient([pkg()]);
    const questionId = await seedQuestion();
    const created = await createChangeRequestFromQuestion({ questionId, actor }, { prisma, client });
    await approveChangeRequest({ requestId: created.id, actor }, { prisma, client });

    const provider = createMockProvider(() => "Ölçü değişikliği talebiniz onaylandı.");
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    expect(draft.warnings).toHaveLength(0);
    expect(draft.status).toBe("PENDING");
  });
});

describe("yetkisiz erişim", () => {
  it("liste ve onay işlemleri aktör ister", async () => {
    await expect(approveChangeRequest({ requestId: "x", actor: { name: "" } }, { prisma })).rejects.toBeInstanceOf(
      OrderAccessError,
    );
    await expect(
      createChangeRequestFromQuestion({ questionId: "x", actor: { name: "" } }, { prisma }),
    ).rejects.toBeInstanceOf(OrderAccessError);
  });

  it("olmayan talep için güvenli hata verir", async () => {
    await expect(approveChangeRequest({ requestId: "yok", actor }, { prisma })).rejects.toBeInstanceOf(OrderError);
  });
});
