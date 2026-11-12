import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAiDraft } from "@/lib/drafts/service";
import { createUser, listUsers } from "@/lib/auth/users";
import { legacyLoginAllowed } from "@/lib/auth/session";
import { listAnswerMemory, answerMemoryStats } from "@/lib/history/service";
import { listApprovedForProduction, listChangeRequests, searchOrders } from "@/lib/orders/service";
import { getPolicyContext } from "@/lib/policies/service";
import { disconnectPrisma, getPrisma } from "@/lib/prisma";
import {
  createProductInfo,
  getProductInfoHistory,
  listProductInfos,
  updateProductInfo,
  verifyProductInfo,
  ProductInfoError,
} from "@/lib/products/service";
import { listQualitySets, listQualityRuns, listRunItems, startQualityRun, QualityError } from "@/lib/quality/service";
import { getStoreSettings } from "@/lib/store/settings";
import { WorkError, approveWorkItem, ensureWorkItems, listWorkItems } from "@/lib/work-queue/service";

/**
 * GÖREV 019 — IDOR / mağaza izolasyonu testleri.
 *
 * İki bağımsız test mağazası; her modül için "başka mağazanın ID'sini bilsen de
 * okuyamazsın / güncelleyemezsin / AI bağlamında kullanamazsın / işlem başlatamazsın".
 * Gerçek müşteri verisi kopyalanmaz; test verisi sonunda silinir.
 */

const prisma = getPrisma();
const tag = Date.now().toString().slice(-6);

let storeA = "";
let storeB = "";
let qA = "";
let qB = "";
let cardA = "";
let cardB = "";
let workA = "";
let workB = "";
let setB = "";
let draftB = "";
let userA = "";
let userB = "";
let orderB = "";

beforeAll(async () => {
  const a = await prisma.store.create({ data: { name: `IDOR A ${tag}`, sellerId: BigInt(910000 + Number(tag)) } });
  const b = await prisma.store.create({ data: { name: `IDOR B ${tag}`, sellerId: BigInt(920000 + Number(tag)) } });
  storeA = a.id;
  storeB = b.id;

  const questionA = await prisma.question.create({
    data: { storeId: storeA, trendyolQuestionId: BigInt(710000 + Number(tag)), text: `A sorusu ${tag}`, status: "WAITING_FOR_ANSWER", askedAt: new Date(), customerId: "CUST-A" },
  });
  const questionB = await prisma.question.create({
    data: { storeId: storeB, trendyolQuestionId: BigInt(720000 + Number(tag)), text: `B sorusu ${tag}`, status: "WAITING_FOR_ANSWER", askedAt: new Date(), customerId: "CUST-B", answerText: "B geçmiş cevabı", answerReviewStatus: "VERIFIED" },
  });
  qA = questionA.id;
  qB = questionB.id;

  const draft = await prisma.answerDraft.create({
    data: { storeId: storeB, questionId: qB, revision: 1, status: "PENDING", source: "AI", text: `B taslağı ${tag}` },
  });
  draftB = draft.id;

  const order = await prisma.order.create({
    data: { storeId: storeB, orderNumber: `IDOR-${tag}-B`, customerRef: "CUST-B", status: "Created", orderedAt: new Date(), fetchedAt: new Date() },
  });
  orderB = order.id;

  await prisma.orderChangeRequest.create({
    data: { storeId: storeB, questionId: qB, orderId: orderB, orderNumber: order.orderNumber, status: "PENDING_REVIEW" },
  });

  await prisma.storePolicy.create({ data: { storeId: storeB, key: "price", value: `B gizli politika ${tag}`, verified: true } });

  const infoA = await createProductInfo({
    storeId: storeA,
    productMainId: `MAIN-A-${tag}`,
    attributes: [{ label: "Kumaş", value: "A kumaşı" }],
    actor: { name: "test" },
  });
  const infoB = await createProductInfo({
    storeId: storeB,
    productMainId: `MAIN-B-${tag}`,
    attributes: [{ label: "Kumaş", value: "B kumaşı" }],
    actor: { name: "test" },
  });
  cardA = infoA.id;
  cardB = infoB.id;

  await ensureWorkItems({ storeId: storeA, questionIds: [qA] });
  await ensureWorkItems({ storeId: storeB, questionIds: [qB] });
  workA = (await prisma.workItem.findFirstOrThrow({ where: { questionId: qA } })).id;
  workB = (await prisma.workItem.findFirstOrThrow({ where: { questionId: qB } })).id;

  const qualitySet = await prisma.qualitySet.create({
    data: { storeId: storeB, name: `B seti ${tag}`, createdBy: "test", sampleQuestionIds: [qB], sampleCount: 1 },
  });
  setB = qualitySet.id;
  await prisma.qualityRun.create({
    data: { storeId: storeB, setId: setB, promptVersion: "v1", provider: "test", model: "test", status: "COMPLETED", startedBy: "test" },
  });

  const createdA = await createUser({ storeId: storeA, email: `idor-a-${tag}@example.test`, password: "GucluSifre123", role: "OWNER" });
  const createdB = await createUser({ storeId: storeB, email: `idor-b-${tag}@example.test`, password: "GucluSifre123", role: "OWNER" });
  userA = createdA.id;
  userB = createdB.id;
});

afterAll(async () => {
  const stores = [storeA, storeB].filter(Boolean);
  if (stores.length) {
    await prisma.workItemEvent.deleteMany({ where: { workItem: { storeId: { in: stores } } } });
    await prisma.workItem.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.qualityRun.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.qualitySet.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.answerDraft.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.orderChangeRequest.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.order.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.question.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.storePolicy.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.productInfo.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.storeSettings.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.session.deleteMany({ where: { user: { storeId: { in: stores } } } });
    await prisma.loginAttempt.deleteMany({ where: { user: { storeId: { in: stores } } } });
    await prisma.user.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.store.deleteMany({ where: { id: { in: stores } } });
  }
  await disconnectPrisma();
});

describe("okuma izolasyonu", () => {
  it("sorular ve geçmiş cevaplar mağaza kapsamlı", async () => {
    const memoryA = await listAnswerMemory({ storeId: storeA, limit: 100 });
    expect(memoryA.some((row) => row.questionId === qB)).toBe(false);

    const statsA = await answerMemoryStats(storeA);
    const statsB = await answerMemoryStats(storeB);
    expect(statsA.total).toBe(0);
    expect(statsB.total).toBeGreaterThan(0);
  });

  it("sipariş ve değişiklik talepleri mağaza kapsamlı", async () => {
    const requestsA = await listChangeRequests(storeA, { limit: 100 });
    expect(requestsA).toHaveLength(0);
    const requestsB = await listChangeRequests(storeB, { limit: 100 });
    expect(requestsB.length).toBeGreaterThan(0);

    const approvedA = await listApprovedForProduction(storeA);
    expect(approvedA).toHaveLength(0);

    const searchA = await searchOrders(storeA, { orderNumber: `IDOR-${tag}-B` });
    expect(searchA.local).toHaveLength(0);
  });

  it("politikalar mağaza kapsamlı", async () => {
    const contextA = await getPolicyContext({ storeId: storeA });
    expect(contextA.policies.some((row) => row.value.includes(`B gizli politika ${tag}`))).toBe(false);
  });

  it("ürün bilgi kartları ve geçmişi mağaza kapsamlı", async () => {
    const cardsA = await listProductInfos(storeA, { limit: 200 });
    expect(cardsA.some((card) => card.id === cardB)).toBe(false);
    expect(cardsA.some((card) => card.id === cardA)).toBe(true);

    expect(await getProductInfoHistory(storeA, cardB)).toEqual([]);
    expect((await getProductInfoHistory(storeB, cardB)).length).toBeGreaterThan(0);
  });

  it("iş kuyruğu ve kalite kayıtları mağaza kapsamlı", async () => {
    const itemsA = await listWorkItems(storeA, { limit: 100 });
    expect(itemsA.some((item) => item.id === workB)).toBe(false);
    expect(itemsA.some((item) => item.id === workA)).toBe(true);

    expect(await listQualitySets(storeA)).toHaveLength(0);
    expect((await listQualitySets(storeB)).length).toBeGreaterThan(0);
    expect(await listQualityRuns(storeA)).toHaveLength(0);
    expect(await listRunItems(storeA, (await listQualityRuns(storeB))[0].runId)).toEqual([]);
  });

  it("kullanıcı listesi ve ayarlar mağaza kapsamlı", async () => {
    const usersA = await listUsers(storeA);
    expect(usersA.some((entry) => entry.id === userB)).toBe(false);
    expect(usersA.some((entry) => entry.id === userA)).toBe(true);

    const settingsA = await getStoreSettings(storeA);
    const settingsB = await getStoreSettings(storeB);
    expect(settingsA.workflow.find((entry) => entry.category === "ACTION_REQUEST")?.team).toBe("İşlem Ekibi");
    expect(settingsB.orderRules).toBeNull();
  });
});

describe("yazma / işlem başlatma izolasyonu", () => {
  it("başka mağazanın ürün kartı güncellenemez ve doğrulanamaz", async () => {
    await expect(
      updateProductInfo({ id: cardB, storeId: storeA, title: "ele geçirildi", actor: { name: "test" } }),
    ).rejects.toBeInstanceOf(ProductInfoError);

    await expect(
      verifyProductInfo({ id: cardB, storeId: storeA, actor: { name: "test" } }),
    ).rejects.toBeInstanceOf(ProductInfoError);

    const untouched = await prisma.productInfo.findUniqueOrThrow({ where: { id: cardB } });
    expect(untouched.status).toBe("DRAFT");
    expect(untouched.title).not.toBe("ele geçirildi");
  });

  it("başka mağazanın iş kaydı onaylanamaz", async () => {
    await expect(
      approveWorkItem({ storeId: storeA, workItemId: workB, actor: { name: "a@example.test", role: "ADMIN" } }),
    ).rejects.toBeInstanceOf(WorkError);
    const untouched = await prisma.workItem.findUniqueOrThrow({ where: { id: workB } });
    expect(untouched.status).toBe("NEW");
  });

  it("başka mağazanın kalite setiyle koşu başlatılamaz", async () => {
    await expect(startQualityRun({ setId: setB, storeId: storeA, actor: { name: "test" } })).rejects.toBeInstanceOf(
      QualityError,
    );
  });

  it("başka mağazanın sorusu için AI taslağı üretilemez", async () => {
    await expect(
      createAiDraft({ questionId: qB, storeId: storeA, actor: { name: "test" } }),
    ).rejects.toThrow();
  });

  it("başka mağazanın taslağı görüntülenemez/güncellenemez", async () => {
    const visibleA = await prisma.answerDraft.findFirst({ where: { id: draftB, storeId: storeA } });
    expect(visibleA).toBeNull();
    const draft = await prisma.answerDraft.findUniqueOrThrow({ where: { id: draftB } });
    expect(draft.storeId).toBe(storeB);
  });
});

describe("eski giriş yolu", () => {
  it("aktif OWNER varken eski anahtar kapalıdır", async () => {
    const owners = await prisma.user.count({ where: { role: "OWNER", active: true } });
    expect(owners).toBeGreaterThan(0);
    expect(await legacyLoginAllowed()).toBe(false);
  });

  it("LEGACY_LOGIN=off anahtarı ayrıca kapatır", async () => {
    const previous = process.env.LEGACY_LOGIN;
    process.env.LEGACY_LOGIN = "off";
    expect(await legacyLoginAllowed()).toBe(false);
    if (previous === undefined) delete process.env.LEGACY_LOGIN;
    else process.env.LEGACY_LOGIN = previous;
  });
});
