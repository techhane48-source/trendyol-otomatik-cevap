import "dotenv/config";

import { createOrdersClient } from "../src/lib/trendyol/orders-client";
import {
  approveChangeRequest,
  createChangeRequestFromQuestion,
  listChangeRequests,
  syncOrders,
} from "../src/lib/orders/service";
import { getPrisma } from "../src/lib/prisma";

/**
 * GÖREV 007 E2E: gerçek PostgreSQL + mock sipariş servisi.
 * Akış: Created → talep (PENDING_REVIEW) → onay → durum Picking → ikinci talep INVALIDATED →
 *       servis kapanınca ORDERS_API_UNAVAILABLE.
 */

const prisma = getPrisma();
const PORT = 5597;
const BASE = `http://127.0.0.1:${PORT}/integration/order`;
const actor = { name: "e2e-uretim" };

async function setStatus(status: string): Promise<void> {
  await fetch(`http://127.0.0.1:${PORT}/_control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

async function seedQuestion(text: string, customerId = "CUST-1"): Promise<string> {
  const store = await prisma.store.upsert({
    where: { sellerId: BigInt(process.env.TRENDYOL_SELLER_ID ?? "1081168") },
    update: {},
    create: { sellerId: BigInt(process.env.TRENDYOL_SELLER_ID ?? "1081168") },
  });
  const question = await prisma.question.create({
    data: {
      storeId: store.id,
      trendyolQuestionId: BigInt(`99${Math.floor(Math.random() * 900000) + 100000}`),
      text,
      status: "ANSWERED",
      rawStatus: "ANSWERED",
      productName: "Bambu Tül Perde",
      productMainId: "MAIN-1",
      productId: "VAR-1",
      customerId,
      askedAt: new Date(),
    },
  });
  return question.id;
}

async function cleanup(questionIds: string[]): Promise<void> {
  await prisma.orderChangeEvent.deleteMany({ where: { request: { questionId: { in: questionIds } } } });
  await prisma.orderChangeRequest.deleteMany({ where: { questionId: { in: questionIds } } });
  await prisma.orderLine.deleteMany();
  await prisma.order.deleteMany();
  await prisma.question.deleteMany({ where: { id: { in: questionIds } } });
}

// Mock servis ayrı süreçte çalışıyor (npm run mock:orders).
async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/_control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "Created" }),
      });
      if (response.ok) return;
    } catch {
      // servis henüz hazır değil
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Mock sipariş servisi başlatılamadı (port " + PORT + ").");
}

const client = createOrdersClient({
  baseUrl: BASE,
  sellerId: process.env.TRENDYOL_SELLER_ID ?? "1081168",
  apiKey: "mock-key",
  apiSecret: "mock-secret",
  timeoutMs: 5_000,
  maxRetries: 0,
  retryBaseMs: 10,
});

const questionIds: string[] = [];

try {
  await waitForServer();

  const syncResult = await syncOrders({}, { prisma, client });
  console.log(`SENKRON: ${syncResult.saved} paket / ${syncResult.lines} kalem`);

  const order = await prisma.order.findFirst({ include: { lines: true } });
  console.log(`YEREL: durum=${order?.status} kalem=${order?.lines.length} customerRef=${order?.customerRef?.slice(0, 8)}…`);

  const q1 = await seedQuestion("Sipariş no 123456789 için en 100 boy 250 cm olsun");
  questionIds.push(q1);
  const req1 = await createChangeRequestFromQuestion({ questionId: q1, actor }, { prisma, client });
  console.log(`TALEP 1: ${req1.status} · ${req1.decision} · ${req1.requestedWidthCm}×${req1.requestedHeightCm} · "${req1.message}"`);

  const approved = await approveChangeRequest({ requestId: req1.id, actor }, { prisma, client });
  console.log(`ONAY 1: ${approved.status} · onay anındaki durum=${approved.orderStatusAtApproval}`);

  await setStatus("Picking");
  const q2 = await seedQuestion("Sipariş no 123456789 için en 120 boy 260 cm yapabilir misiniz");
  questionIds.push(q2);
  const req2 = await createChangeRequestFromQuestion({ questionId: q2, actor }, { prisma, client });
  console.log(`TALEP 2 (Picking): ${req2.status} · ${req2.decision} · "${req2.message}"`);

  await setStatus("Created");
  const q3 = await seedQuestion("Sipariş no 123456789 için en 110 boy 240 cm olsun");
  questionIds.push(q3);
  const req3 = await createChangeRequestFromQuestion({ questionId: q3, actor }, { prisma, client });
  await setStatus("Picking");
  try {
    await approveChangeRequest({ requestId: req3.id, actor }, { prisma, client });
    console.log("HATA: onay beklenmiyordu");
  } catch (error) {
    const row = await prisma.orderChangeRequest.findUnique({ where: { id: req3.id } });
    console.log(
      `YARIŞ DURUMU: onay reddedildi (${(error as { code?: string }).code ?? "?"}) · talep durumu=${row?.status}`,
    );
  }

  await setStatus("Created");
  const mismatched = await seedQuestion("Sipariş no 123456789 için en 100 boy 250 cm olsun", "CUST-OTHER");
  questionIds.push(mismatched);
  const req4 = await createChangeRequestFromQuestion({ questionId: mismatched, actor }, { prisma, client });
  console.log(`SAHİPLİK: ${req4.status} · doğrulandı=${req4.ownershipVerified}`);

  // Erişilemeyen port: API kesintisi senaryosu (servis kapatılmaz, ayrı istemci kullanılır).
  const downClient = createOrdersClient({
    baseUrl: `http://127.0.0.1:${PORT + 1}/integration/order`,
    sellerId: process.env.TRENDYOL_SELLER_ID ?? "1081168",
    apiKey: "mock-key",
    apiSecret: "mock-secret",
    timeoutMs: 2_000,
    maxRetries: 0,
    retryBaseMs: 10,
  });

  const q5 = await seedQuestion("Sipariş no 123456789 için en 100 boy 250 cm olsun");
  questionIds.push(q5);
  try {
    await createChangeRequestFromQuestion({ questionId: q5, actor }, { prisma, client: downClient });
    console.log("HATA: API kesintisinde kayıt oluşmamalıydı");
  } catch (error) {
    console.log(`API KESİNTİSİ: ${(error as { code?: string }).code ?? "?"} · kayıt oluşmadı`);
  }

  const all = await listChangeRequests({}, { prisma });
  console.log(`TOPLAM TALEP: ${all.length}`);
  for (const row of all) {
    console.log(`  ${row.orderNumber} · ${row.status} · ${row.requestedWidthCm}×${row.requestedHeightCm} · ${row.matchNote?.slice(0, 60)}`);
  }
} finally {
  await cleanup(questionIds);
  console.log("TEMİZLİK: E2E kayıtları silindi");
  await prisma.$disconnect();
}
