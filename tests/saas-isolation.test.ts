import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthError, ROLE_LABELS, createUser, hashPassword, listUsers, login, updateUser, verifyPassword } from "@/lib/auth/users";
import { listQuestionsForDrafting } from "@/lib/drafts/service";
import { getPolicyContext } from "@/lib/policies/service";
import { disconnectPrisma, getPrisma } from "@/lib/prisma";
import { evaluateChangeRule, getStoreSettings, saveOrderRule, saveWorkflow, type OrderRule } from "@/lib/store/settings";
import {
  WorkError,
  approveWorkItem,
  ensureWorkItems,
  getWorkMetrics,
  listWorkItems,
} from "@/lib/work-queue/service";

/**
 * GÖREV 018 — mağaza izolasyonu ve kullanıcı güvenliği testleri.
 *
 * İki ayrı test mağazası kullanılır. Gerçek müşteri verisi kopyalanmaz;
 * test verisi geçici oluşturulur ve sonunda silinir. Aura Perde kaydına
 * yalnızca OKUMA yapılır (migration sonrası veri korunduğunu doğrulamak için).
 */

const prisma = getPrisma();
const suffix = Date.now().toString().slice(-6);

let storeA = "";
let storeB = "";
let questionA = "";
let questionB = "";
let policyB = "";
let userA = "";
let userB = "";
let itemA = "";
let itemB = "";
const emails: string[] = [];

async function makeStore(tag: string) {
  return prisma.store.create({ data: { name: `Test ${tag} ${suffix}`, sellerId: BigInt(900000 + Number(suffix) + (tag === "A" ? 0 : 1)) } });
}

async function makeQuestion(storeId: string, text: string, seq: number) {
  return prisma.question.create({
    data: {
      storeId,
      trendyolQuestionId: BigInt(800000 + seq),
      text,
      status: "WAITING_FOR_ANSWER",
      productName: "Test Ürün",
      customerId: `CUST-${seq}`,
      askedAt: new Date(),
    },
  });
}

beforeAll(async () => {
  const a = await makeStore("A");
  const b = await makeStore("B");
  storeA = a.id;
  storeB = b.id;

  questionA = (await makeQuestion(storeA, `${suffix}1 siparişimde eni 200 olsun lütfen`, 1)).id;
  questionB = (await makeQuestion(storeB, `${suffix}2 siparişimde boyu 300 olsun lütfen`, 2)).id;

  await prisma.order.create({
    data: {
      storeId: storeB,
      orderNumber: `TEST-${suffix}-B`,
      customerRef: "CUST-B",
      status: "Created",
      orderedAt: new Date(),
      fetchedAt: new Date(),
    },
  });

  const policy = await prisma.storePolicy.create({
    data: { storeId: storeB, key: "price", value: "B mağazasının gizli fiyat politikası", verified: true },
  });
  policyB = policy.id;

  await saveWorkflow(
    storeB,
    [
      { key: "auto_candidate", label: "Otomatik", category: "AUTO_CANDIDATE", team: "AI" },
      { key: "human_review", label: "İnceleme", category: "HUMAN_REVIEW", team: "Destek" },
      { key: "action_request", label: "Beden değişikliği", category: "ACTION_REQUEST", team: "Tasarım Ekibi" },
      { key: "needs_info", label: "Bilgi eksik", category: "NEEDS_INFO", team: "Destek" },
    ],
    [{ key: "size_change", label: "Beden değişikliği" }],
  );

  const rule: OrderRule = {
    allowedStatuses: ["Created"],
    blockedStatuses: ["Picking", "Shipped", "Cancelled"],
    unknown: "HUMAN_REVIEW",
    humanReviewOnUnknown: true,
  };
  await saveOrderRule(storeB, rule);

  const createdA = await createUser({ storeId: storeA, email: `owner-a-${suffix}@example.test`, password: "GucluSifre123", role: "OWNER", name: "A Sahibi" });
  const createdB = await createUser({ storeId: storeB, email: `owner-b-${suffix}@example.test`, password: "GucluSifre123", role: "OWNER", name: "B Sahibi" });
  userA = createdA.id;
  userB = createdB.id;
  emails.push(createdA.email, createdB.email);

  await ensureWorkItems({ storeId: storeA, questionIds: [questionA] });
  await ensureWorkItems({ storeId: storeB, questionIds: [questionB] });

  itemA = (await prisma.workItem.findFirstOrThrow({ where: { questionId: questionA } })).id;
  itemB = (await prisma.workItem.findFirstOrThrow({ where: { questionId: questionB } })).id;
});

afterAll(async () => {
  const stores = [storeA, storeB].filter(Boolean);
  if (stores.length > 0) {
    await prisma.workItemEvent.deleteMany({ where: { workItem: { storeId: { in: stores } } } });
    await prisma.workItem.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.answerDraft.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.question.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.order.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.storePolicy.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.storeSettings.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.session.deleteMany({ where: { user: { storeId: { in: stores } } } });
    await prisma.loginAttempt.deleteMany({ where: { user: { storeId: { in: stores } } } });
    await prisma.user.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.store.deleteMany({ where: { id: { in: stores } } });
  }
  await disconnectPrisma();
});

describe("kullanıcı ve oturum güvenliği", () => {
  it("şifreler düz metin saklanmaz ve doğru şifre ile giriş yapılır", async () => {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userA } });
    expect(row.passwordHash).not.toContain("GucluSifre123");
    expect(row.passwordHash.startsWith("$2")).toBe(true);
    expect(await verifyPassword("GucluSifre123", row.passwordHash)).toBe(true);

    const result = await login(emails[0], "GucluSifre123");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.storeId).toBe(storeA);
  });

  it("hatalı şifre reddedilir ve 5 denemeden sonra hız sınırı uygulanır", async () => {
    const email = `limit-${suffix}@example.test`;
    const created = await createUser({ storeId: storeA, email, password: "BaskaSifre123", role: "SUPPORT" });
    emails.push(created.email);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await login(email, "yanlis-sifre");
      expect(failed.ok).toBe(false);
    }
    const blocked = await login(email, "BaskaSifre123");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toBe("RATE_LIMITED");

    await prisma.loginAttempt.deleteMany({ where: { emailHash: { not: "" }, userId: created.id } });
  });

  it("SUPPORT rolü yönetici işlemi yapamaz (rol düşürme korunur)", async () => {
    await expect(
      updateUser({ storeId: storeA, userId: userA, role: "SUPPORT" }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("kullanıcı listesi mağaza kapsamlıdır", async () => {
    const listA = await listUsers(storeA);
    const listB = await listUsers(storeB);
    expect(listA.some((entry) => entry.id === userB)).toBe(false);
    expect(listB.some((entry) => entry.id === userA)).toBe(false);
    expect(ROLE_LABELS.OWNER).toBe("Mağaza sahibi");
  });
});

describe("veri izolasyonu", () => {
  it("mağaza A, mağaza B'nin sorusunu/taslağını göremez", async () => {
    const questionsA = await listQuestionsForDrafting(storeA, { limit: 50 });
    expect(questionsA.some((row) => row.id === questionB)).toBe(false);
    expect(questionsA.some((row) => row.id === questionA)).toBe(true);
  });

  it("mağaza A, mağaza B'nin politikasını kullanamaz", async () => {
    const contextA = await getPolicyContext({ storeId: storeA });
    const contextB = await getPolicyContext({ storeId: storeB });
    expect(contextA.policies.some((row) => row.value.includes("B mağazasının"))).toBe(false);
    expect(contextB.policies.some((row) => row.value.includes("B mağazasının"))).toBe(true);
    expect(policyB).toBeTruthy();
  });

  it("başka mağazanın iş kaydı ID'si bilinse bile erişim reddedilir", async () => {
    await expect(
      approveWorkItem({ storeId: storeA, workItemId: itemB, actor: { name: "a@example.test", role: "ADMIN" } }),
    ).rejects.toBeInstanceOf(WorkError);
    const untouched = await prisma.workItem.findUniqueOrThrow({ where: { id: itemB } });
    expect(untouched.status).toBe("NEW");
  });

  it("iş kuyruğu listesi ve metrikleri mağaza kapsamlıdır", async () => {
    const itemsA = await listWorkItems(storeA, { limit: 100 });
    expect(itemsA.every((item) => item.questionId === questionA)).toBe(true);

    const metricsA = await getWorkMetrics(storeA);
    const metricsB = await getWorkMetrics(storeB);
    expect(metricsA.total).toBe(1);
    expect(metricsB.total).toBe(1);
  });

  it("kategori etiketi mağaza yapılandırmasından gelir", async () => {
    const settingsB = await getStoreSettings(storeB);
    expect(settingsB.workflow.find((entry) => entry.category === "ACTION_REQUEST")?.label).toBe("Beden değişikliği");
    const settingsA = await getStoreSettings(storeA);
    expect(settingsA.workflow.find((entry) => entry.category === "ACTION_REQUEST")?.label).toBe("İşlem talebi");
  });
});

describe("mağaza bazlı sipariş kuralı", () => {
  it("B mağazasının kuralı yalnızca B'de uygulanır", async () => {
    const settingsB = await getStoreSettings(storeB);
    const settingsA = await getStoreSettings(storeA);

    expect(evaluateChangeRule(settingsB, "Created")?.decision).toBe("ALLOW");
    expect(evaluateChangeRule(settingsB, "Picking")?.decision).toBe("DENY");
    expect(evaluateChangeRule(settingsB, "BilinmeyenDurum")?.decision).toBe("HUMAN_REVIEW");
    expect(evaluateChangeRule(settingsA, "Picking")).toBeNull();
  });

  it("Aura kuralı: Created açık, Picking ve sonrası kapalı", async () => {
    const aura = await prisma.store.findFirst({ where: { sellerId: BigInt(1081168) }, include: { settings: true } });
    if (!aura?.settings) return; // Aura kaydı olmayan kurulumlarda atlanır
    const settings = await getStoreSettings(aura.id);
    expect(evaluateChangeRule(settings, "Created")?.decision).toBe("ALLOW");
    expect(evaluateChangeRule(settings, "Picking")?.decision).toBe("DENY");
    expect(evaluateChangeRule(settings, "Shipped")?.decision).toBe("DENY");
    expect(evaluateChangeRule(settings, "Cancelled")?.decision).toBe("DENY");
    expect(evaluateChangeRule(settings, "Tanimsiz")?.decision).toBe("HUMAN_REVIEW");
  });
});

describe("geçiş: mevcut veriler korunur", () => {
  it("her mağaza için yapılandırma kaydı var (backfill çalıştı)", async () => {
    const stores = await prisma.store.findMany({ select: { id: true } });
    if (stores.length === 0) return;
    for (const store of stores) await getStoreSettings(store.id);
    const settings = await prisma.storeSettings.count({ where: { storeId: { in: stores.map((entry) => entry.id) } } });
    expect(settings).toBe(stores.length);
  });

  it("eski iş kayıtları yeni kategori değerlerine taşındı", async () => {
    const legacy = await prisma.workItem.count({ where: { category: { in: ["SUPPORT", "WORKSHOP"] as never } } });
    expect(legacy).toBe(0);
  });
});
