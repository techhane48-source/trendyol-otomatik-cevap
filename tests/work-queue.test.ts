import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { disconnectPrisma, getPrisma } from "@/lib/prisma";
import {
  WorkAccessError,
  WorkError,
  approveWorkItem,
  completeWorkItem,
  ensureWorkItems,
  getWorkMetrics,
  listWorkItems,
  rejectWorkItem,
  setProductionStage,
  startWorkReview,
} from "@/lib/work-queue/service";

const prisma = getPrisma();
const storeName = `test-work-queue-${Date.now()}`;
let storeId = "";
let questionSeq = 700000;

const admin = { name: "test-admin", role: "ADMIN" as const };
const workshop = { name: "test-atolye", role: "WORKSHOP" as const };
const support = { name: "test-temsilci", role: "SUPPORT" as const };

async function makeQuestion(text: string, extra: { productName?: string; customerId?: string } = {}) {
  questionSeq += 1;
  return prisma.question.create({
    data: {
      storeId,
      trendyolQuestionId: BigInt(questionSeq),
      text,
      status: "WAITING_FOR_ANSWER",
      productName: extra.productName ?? "Bambu Tül Perde",
      customerId: extra.customerId ?? "CUST-A",
      askedAt: new Date(),
    },
  });
}

async function makeOrder(orderNumber: string, status: string, customerId = "CUST-A") {
  return prisma.order.create({
    data: {
      storeId,
      orderNumber,
      customerRef: customerId,
      status,
      orderedAt: new Date(),
      fetchedAt: new Date(),
    },
  });
}

beforeEach(async () => {
  if (!storeId) {
    const store = await prisma.store.create({ data: { name: storeName, sellerId: BigInt(880000 + (Date.now() % 1000)) } });
    storeId = store.id;
  }
});

afterAll(async () => {
  if (storeId) {
    await prisma.workItemEvent.deleteMany({ where: { workItem: { storeId } } });
    await prisma.workItem.deleteMany({ where: { storeId } });
    await prisma.answerDraft.deleteMany({ where: { storeId } });
    await prisma.question.deleteMany({ where: { storeId } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } }).catch(() => null);
  }
  await disconnectPrisma();
});

describe("GÖREV 017 — sınıflandırma", () => {
  it("iade sorusu müşteri temsilcisine URGENT gider", async () => {
    const q = await makeQuestion("Ürünü iade etmek istiyorum, param ne zaman hesabıma geçer?");
    await ensureWorkItems({ storeId, questionIds: [q.id] });
    const [item] = await listWorkItems(storeId, { search: q.text.slice(0, 12) });
    expect(item.category).toBe("HUMAN_REVIEW");
    expect(item.team).toBe("Müşteri Temsilcisi");
    expect(item.priority).toBe("URGENT");
  });

  it("teslimat itirazı otomatik çözüldü sayılmaz", async () => {
    const q = await makeQuestion("Kargom 5 gündür gelmedi, nerede?");
    await ensureWorkItems({ storeId, questionIds: [q.id] });
    const [item] = await listWorkItems(storeId, { search: "Kargom 5 gündür" });
    expect(item.category).toBe("HUMAN_REVIEW");
    expect(item.priority).toBe("HIGH");
  });

  it("iptal edilmiş siparişe üretim talebi açılmaz", async () => {
    await makeOrder("777000001", "Cancelled");
    const q = await makeQuestion("777000001 numaralı siparişimin ölçüsünü değiştirmek istiyorum, eni 200 olsun");
    await ensureWorkItems({ storeId, questionIds: [q.id] });
    const [item] = await listWorkItems(storeId, { search: "777000001" });
    expect(item.category).toBe("HUMAN_REVIEW");
    expect(item.orderStatusAtClassify).toBe("Cancelled");
    expect(item.reasons.join(" ")).toContain("iptal");
  });

  it("üretim başlamamış siparişte ölçü değişikliği atölyeye YÜKSEK öncelikle gider", async () => {
    await makeOrder("777000002", "Picking");
    const q = await makeQuestion("777000002 siparişimde eni 180 boyu 250 olsun, değiştirebilir misiniz?");
    await ensureWorkItems({ storeId, questionIds: [q.id] });
    const [item] = await listWorkItems(storeId, { search: "777000002" });
    expect(item.category).toBe("ACTION_REQUEST");
    expect(item.team).toBe("İşlem Ekibi");
    expect(item.priority).toBe("HIGH");
  });

  it("aynı soru iki kez iş kaydı oluşturmaz", async () => {
    const q = await makeQuestion("Perde kumaşı kaç gram?");
    const first = await ensureWorkItems({ storeId, questionIds: [q.id] });
    const second = await ensureWorkItems({ storeId, questionIds: [q.id] });
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);
    const count = await prisma.workItem.count({ where: { questionId: q.id } });
    expect(count).toBe(1);
  });

  it("çoklu ölçü talepleri ayrı kayıtlara düşer", async () => {
    const q1 = await makeQuestion("Birinci perde 150-260 olsun");
    const q2 = await makeQuestion("İkinci perde 180-240 olsun");
    await ensureWorkItems({ storeId, questionIds: [q1.id, q2.id] });
    const items = await prisma.workItem.findMany({ where: { questionId: { in: [q1.id, q2.id] } } });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
  });
});

describe("GÖREV 017 — yetki ve iş akışı", () => {
  it("atölye onayı olmadan müşteriye onay metni üretilmez; SUPPORT rolü onay veremez", async () => {
    const q = await makeQuestion("Ölçü değişikliği talebim onaylandı mı?");
    await ensureWorkItems({ storeId, questionIds: [q.id] });
    const [item] = await listWorkItems(storeId, { search: q.text.slice(0, 12) });

    await expect(approveWorkItem({ storeId, workItemId: item.id, actor: support })).rejects.toBeInstanceOf(WorkAccessError);
    // NEW durumundan doğrudan onay da geçersizdir.
    await expect(approveWorkItem({ storeId, workItemId: item.id, actor: admin })).rejects.toBeInstanceOf(WorkError);

    const fresh = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.status).toBe("NEW");
  });

  it("onay kayıtlı işlemden sonra cevap taslağı üretir; tamamlama ayrı işlemdir", async () => {
    await makeOrder("777000003", "Picking");
    const q = await makeQuestion("777000003 siparişimde boyu 240 olsun");
    await ensureWorkItems({ storeId, questionIds: [q.id] });
    const [item] = await listWorkItems(storeId, { search: "777000003" });

    await startWorkReview({ storeId, workItemId: item.id, actor: workshop });
    const approved = await approveWorkItem({ storeId, workItemId: item.id, actor: workshop });
    expect(approved.status).toBe("APPROVED");
    expect(approved.closedAt).toBeNull();

    const draft = await prisma.answerDraft.findUniqueOrThrow({ where: { id: approved.draftId! } });
    expect(draft.text).toContain("onaylanmıştır");
    expect(draft.status).toBe("PENDING"); // gönderilmez: yalnızca taslak

    const done = await completeWorkItem({ storeId, workItemId: item.id, actor: workshop });
    expect(done.status).toBe("DONE");
    expect(done.closedAt).not.toBeNull();
  });

  it("red işlemi farklı bir taslak metni üretir ve onayla karışmaz", async () => {
    const q = await makeQuestion("777000004 siparişimin ölçüsünü değiştirin");
    await ensureWorkItems({ storeId, questionIds: [q.id] });
    const [item] = await listWorkItems(storeId, { search: "777000004" });
    await startWorkReview({ storeId, workItemId: item.id, actor: admin });
    const rejected = await rejectWorkItem({ storeId, workItemId: item.id, actor: admin });
    const draft = await prisma.answerDraft.findUniqueOrThrow({ where: { id: rejected.draftId! } });
    expect(draft.text).toContain("gerçekleştirilememektedir");
    expect(draft.text).not.toContain("onaylanmıştır");
  });

  it("üretim aşaması elle işaretlenir ve Trendyol durumundan türetilmez", async () => {
    const q = await makeQuestion("Kesim başladı mı?");
    await ensureWorkItems({ storeId, questionIds: [q.id] });
    const [item] = await listWorkItems(storeId, { search: q.text.slice(0, 12) });
    expect(item.productionStage).toBeNull();

    await setProductionStage({ storeId, workItemId: item.id, actor: workshop, stage: "CUTTING" });
    const fresh = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.productionStage).toBe("CUTTING");
    expect(fresh.productionStageBy).toBe("test-atolye");
  });

  it("ortalama çözüm süresi yalnızca kapanmış kayıtlardan hesaplanır", async () => {
    const before = await getWorkMetrics(storeId);
    const q = await makeQuestion("Süre testi sorusu 999000111");
    await ensureWorkItems({ storeId, questionIds: [q.id] });
    const [item] = await listWorkItems(storeId, { search: "999000111" });
    await startWorkReview({ storeId, workItemId: item.id, actor: admin });
    await approveWorkItem({ storeId, workItemId: item.id, actor: admin });
    await completeWorkItem({ storeId, workItemId: item.id, actor: admin });

    const after = await getWorkMetrics(storeId);
    expect(after.completed).toBe(before.completed + 1);
    expect(after.averageResolutionMinutes).not.toBeNull();
    expect(after.averageResolutionMinutes!).toBeGreaterThanOrEqual(0);
  });
});
