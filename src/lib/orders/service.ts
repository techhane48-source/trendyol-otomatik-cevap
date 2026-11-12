import { createHash } from "node:crypto";

import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  createOrdersClient,
  type OrdersClient,
  type OrderPackageDto,
} from "@/lib/trendyol/orders-client";

import { decideOrderStatus, extractOrderNumber, matchOrderLine, parseDimensions } from "./decision";

/**
 * Sipariş ve ölçü değişikliği servisi.
 *
 * - Trendyol'a HİÇBİR yazma yapılmaz: yalnızca salt okunur GET.
 * - Onay ve ret yalnızca yerel kayıt + denetim izi üretir.
 * - Onay öncesi sipariş durumu CANLI olarak yeniden sorgulanır; değişmişse talep INVALIDATED olur.
 * - Adres/telefon/ödeme verisi saklanmaz; müşteri kimliği yalnızca tuzlanmış özet olarak tutulur.
 */

export interface OrderActor {
  name: string;
}

export class OrderAccessError extends Error {
  constructor(message = "Bu işlem için yönetici yetkisi gerekir.") {
    super(message);
    this.name = "OrderAccessError";
  }
}

export class OrderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OrderError";
    this.code = code;
  }
}

export interface OrderDeps {
  prisma?: PrismaClient;
  client?: OrdersClient;
}

function requireActor(actor: OrderActor | undefined | null): string {
  const name = actor?.name?.trim();
  if (!name) throw new OrderAccessError();
  return name;
}

/** Müşteri kimliğini düz metin saklamamak için tuzlanmış özet. */
export function customerRefOf(customerId: string | null | undefined): string | null {
  if (!customerId) return null;
  return createHash("sha256").update(`ty-order-ref:${customerId}`).digest("hex").slice(0, 32);
}

export interface SyncOrdersResult {
  fetched: number;
  saved: number;
  packages: number;
  lines: number;
}

/** Sipariş paketlerini yerel aynaya yazar (salt okunur kaynak). */
export async function syncOrders(
  input: { query?: Parameters<OrdersClient["fetchOrdersPage"]>[0] } = {},
  deps: OrderDeps = {},
): Promise<SyncOrdersResult> {
  const prisma = deps.prisma ?? getPrisma();
  const client = deps.client ?? createOrdersClient();
  const page = await client.fetchOrdersPage({ size: 50, ...(input.query ?? {}) });

  let saved = 0;
  let lineCount = 0;

  for (const pkg of page.content) {
    if (!pkg.orderNumber) continue;

    const order = await prisma.order.upsert({
      where: {
        storeId_orderNumber: {
          storeId: await resolveStoreId(prisma),
          orderNumber: pkg.orderNumber,
        },
      },
      create: {
        storeId: await resolveStoreId(prisma),
        orderNumber: pkg.orderNumber,
        shipmentPackageId: pkg.shipmentPackageId ? BigInt(pkg.shipmentPackageId) : undefined,
        status: pkg.status,
        rawStatus: pkg.status,
        orderedAt: pkg.orderDate,
        customerRef: customerRefOf(pkg.customerId),
      },
      update: {
        status: pkg.status,
        rawStatus: pkg.status,
        orderedAt: pkg.orderDate,
        ...(pkg.shipmentPackageId ? { shipmentPackageId: BigInt(pkg.shipmentPackageId) } : {}),
        syncedAt: new Date(),
      },
    });

    saved += 1;

    for (const line of pkg.lines) {
      if (!line.lineId) continue;
      await prisma.orderLine.upsert({
        where: { orderId_lineId: { orderId: order.id, lineId: line.lineId } },
        create: {
          orderId: order.id,
          lineId: line.lineId,
          productId: line.productId,
          productMainId: line.productMainId,
          productName: line.productName,
          quantity: line.quantity,
          status: line.status,
        },
        update: {
          productId: line.productId,
          productMainId: line.productMainId,
          productName: line.productName,
          quantity: line.quantity,
          status: line.status,
        },
      });
      lineCount += 1;
    }
  }

  return { fetched: page.content.length, saved, packages: page.content.length, lines: lineCount };
}

async function resolveStoreId(prisma: PrismaClient): Promise<string> {
  const env = getEnv();
  const store = await prisma.store.upsert({
    where: { sellerId: BigInt(env.TRENDYOL_SELLER_ID) },
    update: {},
    create: { sellerId: BigInt(env.TRENDYOL_SELLER_ID) },
  });
  return store.id;
}

export interface LiveOrderView {
  orderNumber: string;
  shipmentPackageId: string | null;
  status: string;
  statusDecision: "CAN_REQUEST" | "TOO_LATE" | "HUMAN_REVIEW";
  lines: Array<{
    id: string;
    lineId: string;
    productId: string | null;
    productMainId: string | null;
    productName: string | null;
    quantity: number;
  }>;
  customerRef: string | null;
}

/** Siparişin CANLI durumunu Trendyol'dan okur (salt okunur). */
export async function fetchLiveOrder(
  orderNumber: string,
  deps: OrderDeps = {},
): Promise<LiveOrderView[]> {
  const client = deps.client ?? createOrdersClient();
  const page = await client.fetchOrdersPage({ orderNumber, size: 20 });

  return page.content
    .filter((pkg): pkg is OrderPackageDto & { orderNumber: string } => Boolean(pkg.orderNumber))
    .filter((pkg) => pkg.orderNumber === orderNumber)
    .map((pkg) => ({
      orderNumber: pkg.orderNumber,
      shipmentPackageId: pkg.shipmentPackageId,
      status: pkg.status,
      statusDecision: decideOrderStatus(pkg.status).decision,
      customerRef: customerRefOf(pkg.customerId),
      lines: pkg.lines
        .filter((line) => Boolean(line.lineId))
        .map((line) => ({
          id: line.lineId as string,
          lineId: line.lineId as string,
          productId: line.productId,
          productMainId: line.productMainId,
          productName: line.productName,
          quantity: line.quantity,
        })),
    }));
}

export interface ChangeRequestResult {
  id: string;
  status: string;
  decision: "CAN_REQUEST" | "TOO_LATE" | "HUMAN_REVIEW";
  message: string;
  orderNumber: string;
  lineId: string | null;
  requestedWidthCm: number | null;
  requestedHeightCm: number | null;
  orientationUncertain: boolean;
  ownershipVerified: boolean;
}

/**
 * Sorudan ölçü değişikliği talebi oluşturur.
 * Hiçbir durumda müşteriye kesin söz verilmez; yalnızca kayıt ve karar üretilir.
 */
export async function createChangeRequestFromQuestion(
  input: {
    questionId: string;
    actor: OrderActor;
    requestedWidthCm?: number | null;
    requestedHeightCm?: number | null;
    note?: string | null;
  },
  deps: OrderDeps = {},
): Promise<ChangeRequestResult> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();
  const env = getEnv();

  const question = await prisma.question.findUnique({ where: { id: input.questionId } });
  if (!question) throw new OrderError("QUESTION_NOT_FOUND", "Soru bulunamadı.");

  const extracted = extractOrderNumber(question.text);
  if (!extracted.value) {
    throw new OrderError(
      extracted.candidates.length > 1 ? "ORDER_NUMBER_AMBIGUOUS" : "ORDER_NUMBER_NOT_FOUND",
      extracted.candidates.length > 1
        ? "Soru metninde birden fazla sipariş numarası var; insan incelemesi gerekir."
        : "Soru metninde sipariş numarası bulunamadı.",
    );
  }

  const orderNumber = extracted.value;

  // GÖREV 016: birden fazla ölçü talebi tek belirsiz değişikliğe indirgenmez.
  if (!input.requestedWidthCm && !input.requestedHeightCm) {
    const pairs = [...question.text.matchAll(/(\d{2,4})\s*(?:cm)?\s*[-/ye]\s*(\d{2,4})/gi)]
      .map((match) => `${Number(match[1])}x${Number(match[2])}`)
      .filter((label, index, all) => all.indexOf(label) === index);
    if (pairs.length > 1) {
      throw new OrderError(
        "MULTI_SIZE_REQUEST",
        `Soruda birden fazla ölçü talebi var (${pairs.join(", ")}). Her talep ayrı ve açık biçimde kaydedilmeli; tek belirsiz değişiklik oluşturulmadı.`,
      );
    }
  }

  const parsed = parseDimensions(question.text);
  const requestedWidthCm = input.requestedWidthCm ?? parsed.widthCm;
  const requestedHeightCm = input.requestedHeightCm ?? parsed.heightCm;

  // Canlı durum: önceden senkronize edilmiş kayıt tek başına yeterli değildir.
  let live: LiveOrderView[];
  try {
    live = await fetchLiveOrder(orderNumber, deps);
  } catch (error) {
    throw new OrderError(
      "ORDERS_API_UNAVAILABLE",
      `Sipariş durumu doğrulanamadı (${error instanceof Error ? error.name : "hata"}). Değişiklik mümkün diye cevap verilmemeli.`,
    );
  }

  if (live.length === 0) throw new OrderError("ORDER_NOT_FOUND", "Sipariş bulunamadı.");

  const storeId = question.storeId;
  const ownershipVerified = Boolean(
    question.customerId &&
      live.some((pkg) => pkg.customerRef && pkg.customerRef === customerRefOf(question.customerId)),
  );

  // Birden fazla paket varsa ve tek eşleşme yoksa insan incelemesi.
  const decisions = live.map((pkg) => pkg.statusDecision);
  const decision: "CAN_REQUEST" | "TOO_LATE" | "HUMAN_REVIEW" = decisions.includes("TOO_LATE")
    ? "TOO_LATE"
    : decisions.every((item) => item === "CAN_REQUEST")
      ? "CAN_REQUEST"
      : "HUMAN_REVIEW";

  const allLines = live.flatMap((pkg) => pkg.lines.map((line) => ({ ...line, shipmentPackageId: pkg.shipmentPackageId })));
  const lineMatch = matchOrderLine(
    { productId: question.productId, productMainId: question.productMainId },
    allLines,
  );
  const matchedLine = lineMatch.line;
  const shipmentPackageId = matchedLine
    ? (allLines.find((line) => line.id === matchedLine.id)?.shipmentPackageId ?? null)
    : (live[0]?.shipmentPackageId ?? null);

  let status: "PENDING_REVIEW" | "REJECTED" | "NEEDS_VERIFICATION";
  let message: string;
  const notes: string[] = [];

  if (decision === "TOO_LATE") {
    status = "REJECTED";
    message = "Siparişiniz işleme alındığı için ölçü değişikliği yapılamıyor.";
    notes.push(`Sipariş durumu: ${live.map((pkg) => pkg.status).join(", ")}`);
  } else if (decision === "HUMAN_REVIEW") {
    status = "NEEDS_VERIFICATION";
    message = "Talebiniz insan incelemesine alındı; kesin bilgi verilemez.";
    notes.push(`Belirsiz sipariş durumu: ${live.map((pkg) => pkg.status).join(", ")}`);
  } else if (lineMatch.ambiguous || !matchedLine) {
    status = "NEEDS_VERIFICATION";
    message = "Talebiniz insan incelemesine alındı; sipariş kalemi kesinleşmedi.";
    notes.push(lineMatch.reason);
  } else if (!ownershipVerified) {
    status = "NEEDS_VERIFICATION";
    message = "Talebiniz insan incelemesine alındı; müşteri sahipliği doğrulanamadı.";
    notes.push("Müşteri sahipliği API verisiyle doğrulanamadı.");
  } else if (!requestedWidthCm || !requestedHeightCm) {
    status = "NEEDS_VERIFICATION";
    message = "Talebiniz insan incelemesine alındı; istenen ölçü metinden net çıkarılamadı.";
    notes.push(parsed.reason ?? "Ölçü çifti eksik.");
  } else if (parsed.orientationUncertain) {
    status = "NEEDS_VERIFICATION";
    message = "Talebiniz insan incelemesine alındı; en/boy yönü doğrulanmalı.";
    notes.push(parsed.reason ?? "En/boy yönü belirsiz.");
  } else {
    status = "PENDING_REVIEW";
    message = "Ölçü değişikliği talebinizi aldık, üretim onayı bekleniyor.";
  }

  if (input.note?.trim()) notes.push(input.note.trim());

  // Aynı soru + sipariş kalemi için aktif talep varsa tekrar oluşturulmaz.
  const active = await prisma.orderChangeRequest.findFirst({
    where: {
      questionId: question.id,
      orderNumber,
      status: { in: ["PENDING_REVIEW", "NEEDS_VERIFICATION"] },
    },
    select: { id: true, status: true },
  });
  if (active) {
    throw new OrderError("DUPLICATE_ACTIVE_REQUEST", `Bu soru için aktif talep zaten var (${active.status}).`);
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.orderChangeRequest.create({
      data: {
        storeId,
        questionId: question.id,
        orderNumber,
        shipmentPackageId: shipmentPackageId ? BigInt(shipmentPackageId) : null,
        lineId: matchedLine?.id ?? null,
        requestedWidthCm: requestedWidthCm ?? null,
        requestedHeightCm: requestedHeightCm ?? null,
        orientationUncertain: parsed.orientationUncertain,
        status,
        orderStatusAtRequest: live.map((pkg) => pkg.status).join(","),
        ownershipVerified,
        // API verisiyle doğrulanan sahiplik ayrı alanlara da yazılır (denetim izi).
        ownershipVerifiedBy: ownershipVerified ? "api:customerId" : null,
        ownershipVerifiedAt: ownershipVerified ? new Date() : null,
        matchNote: [lineMatch.reason, ...notes].filter(Boolean).join(" | ").slice(0, 500),
        createdBy: actorName,
      },
    });

    await tx.orderChangeEvent.create({
      data: {
        requestId: row.id,
        action: "CREATED",
        actor: actorName,
        details: {
          decision,
          lineReason: lineMatch.reason,
          ownershipVerified,
          orderStatuses: live.map((pkg) => pkg.status),
          parsed: { ...parsed },
        },
      },
    });

    return row;
  });

  // Kalem eşleşmesi kurulamadıysa otomatik kabul yok: karar insan incelemesi.
  const finalDecision =
    decision === "CAN_REQUEST" && (lineMatch.ambiguous || !matchedLine) ? "HUMAN_REVIEW" : decision;

  return {
    id: created.id,
    status: created.status,
    decision: finalDecision,
    message,
    orderNumber,
    lineId: created.lineId,
    requestedWidthCm: created.requestedWidthCm,
    requestedHeightCm: created.requestedHeightCm,
    orientationUncertain: created.orientationUncertain,
    ownershipVerified,
  };
}

/** Onay: yalnızca canlı durum hâlâ Created ise. Aksi halde talep INVALIDATED olur. */
/**
 * Sahiplik doğrulamasını AYRI bir adım olarak kaydeder.
 *
 * Serbest metin notu (`reviewNote`) yetki kanıtı değildir; bu yüzden onaydan önce
 * kimin/ne zaman doğruladığı ayrı alanlara yazılır. Yalnızca insan bu adımı çalıştırabilir.
 */
export async function markOwnershipVerified(
  input: { requestId: string; actor: OrderActor; note?: string | null },
  deps: OrderDeps = {},
): Promise<{ id: string; ownershipVerified: boolean }> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const request = await prisma.orderChangeRequest.findUnique({ where: { id: input.requestId } });
  if (!request) throw new OrderError("REQUEST_NOT_FOUND", "Talep bulunamadı.");
  if (request.status === "APPROVED" || request.status === "REJECTED" || request.status === "INVALIDATED") {
    throw new OrderError("REQUEST_STATE_CHANGED", "Kapanmış talep için sahiplik doğrulaması yapılamaz.");
  }
  if (!request.lineId) {
    throw new OrderError("LINE_NOT_MATCHED", "Kalem eşleşmesi olmayan talep için sahiplik doğrulanamaz.");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.orderChangeRequest.update({
      where: { id: request.id },
      data: {
        ownershipVerified: true,
        ownershipVerifiedBy: actorName,
        ownershipVerifiedAt: new Date(),
        reviewNote: input.note?.trim() || request.reviewNote,
      },
    });

    await tx.orderChangeEvent.create({
      data: {
        requestId: request.id,
        action: "OWNERSHIP_VERIFIED",
        actor: actorName,
        details: { orderNumber: request.orderNumber, lineId: request.lineId, note: input.note?.trim() || null },
      },
    });

    return row;
  });

  return { id: updated.id, ownershipVerified: updated.ownershipVerified };
}

export async function approveChangeRequest(
  input: { requestId: string; actor: OrderActor; note?: string | null },
  deps: OrderDeps = {},
): Promise<{ id: string; status: string; orderStatusAtApproval: string | null }> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const request = await prisma.orderChangeRequest.findUnique({ where: { id: input.requestId } });
  if (!request) throw new OrderError("REQUEST_NOT_FOUND", "Talep bulunamadı.");
  if (request.status === "APPROVED") throw new OrderError("ALREADY_APPROVED", "Talep zaten onaylanmış.");
  if (request.status === "REJECTED") throw new OrderError("REQUEST_REJECTED", "Reddedilmiş talep onaylanamaz.");
  if (request.status === "INVALIDATED") {
    throw new OrderError("REQUEST_INVALIDATED", "Talep geçersiz kılınmış; yeni talep oluşturun.");
  }
  if (!request.lineId) {
    throw new OrderError("LINE_NOT_MATCHED", "Sipariş kalemi eşleşmediği için onaylanamaz.");
  }

  // Sahiplik API verisiyle doğrulanmadıysa yalnızca serbest metin notuyla onay verilemez.
  // Önce `markOwnershipVerified` ile ayrı ve kayıtlı bir doğrulama adımı gerekir.
  if (!request.ownershipVerified) {
    throw new OrderError(
      "OWNERSHIP_NOT_VERIFIED",
      "Müşteri sahipliği doğrulanmadan onay verilemez; önce sahiplik doğrulaması kaydedilmeli.",
    );
  }

  // Eşzamanlılık: canlı durum onay anında yeniden doğrulanır.
  let live: LiveOrderView[];
  try {
    live = await fetchLiveOrder(request.orderNumber, deps);
  } catch {
    throw new OrderError("ORDERS_API_UNAVAILABLE", "Sipariş durumu doğrulanamadı; onay yapılmadı.");
  }

  const currentStatuses = live.map((pkg) => pkg.status);
  const stillCreated =
    live.length > 0 && live.every((pkg) => decideOrderStatus(pkg.status).decision === "CAN_REQUEST");

  if (!stillCreated) {
    await prisma.$transaction(async (tx) => {
      await tx.orderChangeRequest.update({
        where: { id: request.id },
        data: {
          status: "INVALIDATED",
          orderStatusAtApproval: currentStatuses.join(","),
          reviewNote: input.note?.trim() || "Onay anında sipariş durumu değişti.",
        },
      });
      await tx.orderChangeEvent.create({
        data: {
          requestId: request.id,
          action: "INVALIDATED",
          actor: actorName,
          details: { expected: "Created", actual: currentStatuses },
        },
      });
    });

    throw new OrderError(
      "ORDER_STATUS_CHANGED",
      "Sipariş durumu Created değil; talep geçersiz kılındı ve onaylanmadı.",
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.orderChangeRequest.findUnique({ where: { id: request.id } });
    // NEEDS_VERIFICATION durumu da insan incelemesi sonrası onaylanabilir
    // (sahiplik/ölçü belirsizliği insan tarafından kapatılır), ancak kalem eşleşmesi zorunludur.
    if (!current || (current.status !== "PENDING_REVIEW" && current.status !== "NEEDS_VERIFICATION")) {
      throw new OrderError("REQUEST_STATE_CHANGED", "Talep durumu bu sırada değişti; işlem tekrarlanmadı.");
    }

    const row = await tx.orderChangeRequest.update({
      where: { id: request.id },
      data: {
        status: "APPROVED",
        orderStatusAtApproval: currentStatuses.join(","),
        approvedAt: new Date(),
        approvedBy: actorName,
        reviewNote: input.note?.trim() || null,
      },
    });

    await tx.orderChangeEvent.create({
      data: {
        requestId: request.id,
        action: "APPROVED",
        actor: actorName,
        details: { orderStatuses: currentStatuses },
      },
    });

    return row;
  });

  return { id: updated.id, status: updated.status, orderStatusAtApproval: updated.orderStatusAtApproval };
}

export async function rejectChangeRequest(
  input: { requestId: string; actor: OrderActor; note?: string | null },
  deps: OrderDeps = {},
): Promise<{ id: string; status: string }> {
  const actorName = requireActor(input.actor);
  const prisma = deps.prisma ?? getPrisma();

  const request = await prisma.orderChangeRequest.findUnique({ where: { id: input.requestId } });
  if (!request) throw new OrderError("REQUEST_NOT_FOUND", "Talep bulunamadı.");
  if (request.status === "APPROVED") throw new OrderError("ALREADY_APPROVED", "Onaylanmış talep reddedilemez.");
  if (request.status === "REJECTED") throw new OrderError("ALREADY_REJECTED", "Talep zaten reddedilmiş.");

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.orderChangeRequest.update({
      where: { id: request.id },
      data: {
        status: "REJECTED",
        rejectedAt: new Date(),
        rejectedBy: actorName,
        reviewNote: input.note?.trim() || null,
      },
    });
    await tx.orderChangeEvent.create({
      data: { requestId: request.id, action: "REJECTED", actor: actorName, details: { note: input.note ?? null } },
    });
    return row;
  });

  return { id: updated.id, status: updated.status };
}

export interface ChangeRequestView {
  id: string;
  orderNumber: string;
  status: string;
  lineId: string | null;
  productName: string | null;
  originalWidthCm: number | null;
  originalHeightCm: number | null;
  requestedWidthCm: number | null;
  requestedHeightCm: number | null;
  orderStatusAtRequest: string | null;
  orderStatusAtApproval: string | null;
  ownershipVerified: boolean;
  orientationUncertain: boolean;
  matchNote: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

async function resolveProductName(
  prisma: PrismaClient,
  orderNumber: string,
  lineId: string | null,
): Promise<string | null> {
  if (!lineId) return null;
  const order = await prisma.order.findFirst({ where: { orderNumber }, select: { id: true } });
  if (!order) return null;
  const line = await prisma.orderLine.findFirst({
    where: { orderId: order.id, lineId },
    select: { productName: true },
  });
  return line?.productName ?? null;
}

export async function listChangeRequests(
  input: { status?: string; orderNumber?: string; limit?: number } = {},
  deps: OrderDeps = {},
): Promise<ChangeRequestView[]> {
  const prisma = deps.prisma ?? getPrisma();
  const rows = await prisma.orderChangeRequest.findMany({
    where: {
      ...(input.status ? { status: input.status as never } : {}),
      ...(input.orderNumber ? { orderNumber: input.orderNumber } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(input.limit ?? 50, 200),
  });

  const views = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      lineId: row.lineId,
      productName: await resolveProductName(prisma, row.orderNumber, row.lineId),
      originalWidthCm: row.originalWidthCm,
      originalHeightCm: row.originalHeightCm,
      requestedWidthCm: row.requestedWidthCm,
      requestedHeightCm: row.requestedHeightCm,
      orderStatusAtRequest: row.orderStatusAtRequest,
      orderStatusAtApproval: row.orderStatusAtApproval,
      ownershipVerified: row.ownershipVerified,
      orientationUncertain: row.orientationUncertain,
      matchNote: row.matchNote,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt,
      createdAt: row.createdAt,
    })),
  );

  return views;
}

/** Üretim personeli için onaylı ölçü değişiklikleri (yazdırılabilir). */
export async function listApprovedForProduction(deps: OrderDeps = {}): Promise<ChangeRequestView[]> {
  return listChangeRequests({ status: "APPROVED", limit: 100 }, deps);
}

/** Sipariş araması: yerel ayna + (varsa) canlı durum. */
export async function searchOrders(
  input: { orderNumber: string },
  deps: OrderDeps = {},
): Promise<{
  local: Array<{ id: string; orderNumber: string; status: string; lines: number; customerRef: string | null }>;
  live: LiveOrderView[] | { error: string };
}> {
  const prisma = deps.prisma ?? getPrisma();
  const local = await prisma.order.findMany({
    where: { orderNumber: input.orderNumber },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { lines: true } } },
  });

  let live: LiveOrderView[] | { error: string };
  try {
    live = await fetchLiveOrder(input.orderNumber, deps);
  } catch (error) {
    live = { error: error instanceof Error ? error.message : "Sipariş API hatası" };
  }

  return {
    local: local.map((row) => ({
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      lines: row._count.lines,
      customerRef: row.customerRef,
    })),
    live,
  };
}
