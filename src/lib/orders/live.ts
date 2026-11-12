import type { PrismaClient } from "@/generated/prisma/client";

import { getPrisma } from "@/lib/prisma";
import { customerRefOf } from "@/lib/orders/service";
import { createOrdersClient, OrdersApiError, type OrderPackageDto, type OrdersClient } from "@/lib/trendyol/orders-client";

/**
 * Canlı sipariş bağlamı (GÖREV 016) — SALT OKUNUR.
 *
 * - Trendyol'a yalnızca GET yapılır; sipariş durumu/verisi değiştirilmez.
 * - Sipariş numarası tek başına müşteri doğrulaması SAYILMAZ: soru ile siparişin
 *   `customerId` özeti eşleşmelidir. Eşleşme yoksa kişisel detay taslağa girmez.
 * - Tazelik: `STALE_MS` içindeki yerel kopya kullanılır, aksi hâlde Trendyol'dan
 *   yeniden çekilir. Eski veriyle "güncel durum" iddiası üretilmez.
 * - İade/ücret iadesi: Trendyol claim kaydı görülür ama banka/PSP hareketi
 *   görülmediği için "para hesaba geçti" iddiası kurulmaz.
 */

export const STALE_MS = 10 * 60 * 1000;

export type OrderStage = "PREPARING" | "SHIPPED" | "DELIVERED" | "CANCELLED" | "RETURNED" | "UNKNOWN";

export interface LiveOrderView {
  orderNumber: string;
  /** Trendyol ham durumu (güvenli; PII değil) */
  rawStatus: string;
  statusLabel: string;
  stage: OrderStage;
  orderDate: Date | null;
  cargoProviderName: string | null;
  /** Takip numarası var mı — numara taslağa yazılmaz, müşteri panelden görür. */
  hasTracking: boolean;
  hasTrackingLink: boolean;
  estimatedDeliveryStart: Date | null;
  estimatedDeliveryEnd: Date | null;
  agreedDeliveryDate: Date | null;
  deliveredAt: Date | null;
  lastModifiedAt: Date | null;
  /** Bu görünümün kaynağı: canlı API mi yerel kopya mı */
  source: "REMOTE" | "CACHE";
  fetchedAt: Date;
  /** Yerel kopya tazelik sınırını aştı mı */
  stale: boolean;
  packageCount: number;
}

export type LiveOrderResult =
  | { kind: "MATCHED"; order: LiveOrderView }
  | { kind: "UNVERIFIED"; reason: string }
  | { kind: "MISMATCH"; reason: string }
  | { kind: "NOT_FOUND" }
  | { kind: "UNAVAILABLE"; reason: string };

const STATUS_MAP: Record<string, { label: string; stage: OrderStage }> = {
  created: { label: "Sipariş oluşturuldu, hazırlanmayı bekliyor", stage: "PREPARING" },
  awaiting: { label: "Sipariş onayı bekleniyor", stage: "PREPARING" },
  picking: { label: "Hazırlanıyor (toplanıyor)", stage: "PREPARING" },
  invoiced: { label: "Faturalandı, kargoya hazırlanıyor", stage: "PREPARING" },
  shipped: { label: "Kargoya verildi", stage: "SHIPPED" },
  delivered: { label: "Teslim edildi", stage: "DELIVERED" },
  cancelled: { label: "İptal edildi", stage: "CANCELLED" },
  returned: { label: "İade edildi", stage: "RETURNED" },
  unpacked: { label: "Paket bölündü / yeniden oluşturuldu", stage: "PREPARING" },
  undelivered: { label: "Teslim edilemedi", stage: "SHIPPED" },
  unsupplied: { label: "Tedarik edilemedi", stage: "CANCELLED" },
};

export function orderStageOf(raw: string | null | undefined): { label: string; stage: OrderStage } {
  const key = (raw ?? "").trim().toLowerCase();
  return STATUS_MAP[key] ?? { label: `Trendyol durumu: ${raw || "bilinmiyor"}`, stage: "UNKNOWN" };
}

function pickDeliveredAt(pkg: OrderPackageDto): Date | null {
  const history = pkg.packageHistories ?? [];
  const delivered = [...history].reverse().find((item) => item.status.toLowerCase() === "delivered");
  return delivered?.at ?? null;
}

function toView(pkg: OrderPackageDto, source: "REMOTE" | "CACHE", fetchedAt: Date, packageCount: number): LiveOrderView {
  const status = pkg.shipmentPackageStatus ?? pkg.status;
  const mapped = orderStageOf(status);
  return {
    orderNumber: pkg.orderNumber ?? "",
    rawStatus: status,
    statusLabel: mapped.label,
    stage: mapped.stage,
    orderDate: pkg.orderDate,
    cargoProviderName: pkg.cargoProviderName ?? null,
    hasTracking: Boolean(pkg.cargoTrackingNumber),
    hasTrackingLink: Boolean(pkg.cargoTrackingLink),
    estimatedDeliveryStart: pkg.estimatedDeliveryStartDate ?? null,
    estimatedDeliveryEnd: pkg.estimatedDeliveryEndDate ?? null,
    agreedDeliveryDate: pkg.agreedDeliveryDate ?? null,
    deliveredAt: pickDeliveredAt(pkg),
    lastModifiedAt: pkg.lastModifiedDate ?? null,
    source,
    fetchedAt,
    stale: Date.now() - fetchedAt.getTime() > STALE_MS,
    packageCount,
  };
}

export interface LiveOrderInput {
  storeId: string;
  orderNumber: string;
  /** Sorunun geldiği müşteri kimliği (Trendyol). Yoksa eşleşme doğrulanamaz. */
  questionCustomerId: string | null;
  now?: Date;
}

export interface LiveOrderDeps {
  prisma?: PrismaClient;
  client?: Pick<OrdersClient, "fetchOrdersPage">;
}

function fmt(date: Date | null): string {
  if (!date) return "";
  return date.toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" });
}

function fmtTime(date: Date): string {
  return date.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", dateStyle: "short", timeStyle: "short" });
}

/** Taslak prompt'una girecek güvenli özet. PII (ad, adres, telefon) içermez. */
export function describeLiveOrder(order: LiveOrderView): string {
  const lines: string[] = [];
  lines.push(`- Sipariş durumu: ${order.statusLabel} (Trendyol: ${order.rawStatus})`);
  if (order.orderDate) lines.push(`- Sipariş tarihi: ${fmt(order.orderDate)}`);
  if (order.cargoProviderName) lines.push(`- Kargo firması: ${order.cargoProviderName}`);
  lines.push(
    order.hasTracking
      ? "- Kargo takip numarası MEVCUT (numarayı cevaba yazma; müşteri sipariş detayında görür)."
      : "- Kargo takip numarası henüz YOK.",
  );
  if (order.estimatedDeliveryStart || order.estimatedDeliveryEnd) {
    const start = fmt(order.estimatedDeliveryStart);
    const end = fmt(order.estimatedDeliveryEnd);
    lines.push(
      `- Trendyol TAHMİNİ kargoya teslim aralığı: ${start || "?"} – ${end || "?"} (bu, müşteriye teslim tarihi DEĞİLDİR).`,
    );
  }
  if (order.agreedDeliveryDate) lines.push(`- Mutabık teslim tarihi: ${fmt(order.agreedDeliveryDate)}`);
  if (order.deliveredAt) lines.push(`- Teslim edildiği tarih: ${fmt(order.deliveredAt)}`);
  if (order.lastModifiedAt) lines.push(`- Trendyol'da son güncelleme: ${fmt(order.lastModifiedAt)}`);
  lines.push(`- Veri kaynağı: ${order.source === "REMOTE" ? "Trendyol canlı API" : "yerel kopya"}, çekildi: ${fmtTime(order.fetchedAt)}`);
  if (order.stale) lines.push("- UYARI: Bu veri eski olabilir; güncel durum iddiası kurma, teyit gerektiğini söyle.");
  return lines.join("\n");
}

export async function getLiveOrder(input: LiveOrderInput, deps: LiveOrderDeps = {}): Promise<LiveOrderResult> {
  const prisma = deps.prisma ?? getPrisma();
  const now = input.now ?? new Date();

  if (!input.questionCustomerId) {
    return {
      kind: "UNVERIFIED",
      reason: "Soruda müşteri kimliği yok; siparişin bu müşteriye ait olduğu doğrulanamadı.",
    };
  }

  const expectedRef = customerRefOf(input.questionCustomerId);

  const local = await prisma.order.findUnique({
    where: { storeId_orderNumber: { storeId: input.storeId, orderNumber: input.orderNumber } },
    select: {
      shipmentPackageId: true,
      status: true,
      orderedAt: true,
      customerRef: true,
      cargoProviderName: true,
      cargoTrackingNumber: true,
      cargoTrackingLink: true,
      estimatedDeliveryStart: true,
      estimatedDeliveryEnd: true,
      agreedDeliveryDate: true,
      deliveredAt: true,
      lastModifiedAt: true,
      fetchedAt: true,
    },
  });

  if (local && local.customerRef && local.customerRef !== expectedRef) {
    return { kind: "MISMATCH", reason: "Sipariş, soruyu soran müşteriyle eşleşmiyor." };
  }

  const freshest = local?.fetchedAt ?? null;
  if (local && freshest && now.getTime() - freshest.getTime() <= STALE_MS && local.status) {
    const view: LiveOrderView = {
      orderNumber: input.orderNumber,
      rawStatus: local.status,
      statusLabel: orderStageOf(local.status).label,
      stage: orderStageOf(local.status).stage,
      orderDate: local.orderedAt,
      cargoProviderName: local.cargoProviderName,
      hasTracking: Boolean(local.cargoTrackingNumber),
      hasTrackingLink: Boolean(local.cargoTrackingLink),
      estimatedDeliveryStart: local.estimatedDeliveryStart,
      estimatedDeliveryEnd: local.estimatedDeliveryEnd,
      agreedDeliveryDate: local.agreedDeliveryDate,
      deliveredAt: local.deliveredAt,
      lastModifiedAt: local.lastModifiedAt,
      source: "CACHE",
      fetchedAt: freshest,
      stale: false,
      packageCount: 1,
    };
    return { kind: "MATCHED", order: view };
  }

  const client = deps.client ?? createOrdersClient();
  let packages: OrderPackageDto[];
  try {
    const page = await client.fetchOrdersPage({ orderNumber: input.orderNumber, size: 10, page: 0 });
    packages = page.content.filter((pkg) => pkg.orderNumber === input.orderNumber);
  } catch (error) {
    const reason = error instanceof OrdersApiError ? error.code : "UNKNOWN";
    return { kind: "UNAVAILABLE", reason: `Sipariş API'si yanıt vermedi (${reason}).` };
  }

  if (packages.length === 0) return { kind: "NOT_FOUND" };

  const own = packages.filter((pkg) => Boolean(pkg.shipmentPackageId));
  if (own.length === 0) return { kind: "NOT_FOUND" };

  const refs = new Set(own.map((pkg) => customerRefOf(pkg.customerId)).filter(Boolean));
  if (!refs.has(expectedRef)) {
    return { kind: "MISMATCH", reason: "Siparişin müşterisi soruyu soran müşteriyle eşleşmiyor." };
  }

  const latest = [...own].sort((a, b) => {
    const at = a.lastModifiedDate?.getTime() ?? a.orderDate?.getTime() ?? 0;
    const bt = b.lastModifiedDate?.getTime() ?? b.orderDate?.getTime() ?? 0;
    return bt - at;
  })[0];

  const fetchedAt = now;
  const view = toView(latest, "REMOTE", fetchedAt, own.length);

  const saved = await prisma.order.upsert({
    where: { storeId_orderNumber: { storeId: input.storeId, orderNumber: input.orderNumber } },
    create: {
      storeId: input.storeId,
      orderNumber: input.orderNumber,
      shipmentPackageId: latest.shipmentPackageId ? BigInt(latest.shipmentPackageId) : undefined,
      status: view.rawStatus,
      rawStatus: view.rawStatus,
      orderedAt: latest.orderDate,
      customerRef: customerRefOf(latest.customerId),
      cargoProviderName: view.cargoProviderName,
      cargoTrackingNumber: latest.cargoTrackingNumber ?? null,
      cargoTrackingLink: latest.cargoTrackingLink ?? null,
      estimatedDeliveryStart: view.estimatedDeliveryStart,
      estimatedDeliveryEnd: view.estimatedDeliveryEnd,
      agreedDeliveryDate: view.agreedDeliveryDate,
      deliveredAt: view.deliveredAt,
      lastModifiedAt: view.lastModifiedAt,
      fetchedAt,
    },
    update: {
      shipmentPackageId: latest.shipmentPackageId ? BigInt(latest.shipmentPackageId) : undefined,
      status: view.rawStatus,
      rawStatus: view.rawStatus,
      orderedAt: latest.orderDate,
      cargoProviderName: view.cargoProviderName,
      cargoTrackingNumber: latest.cargoTrackingNumber ?? null,
      cargoTrackingLink: latest.cargoTrackingLink ?? null,
      estimatedDeliveryStart: view.estimatedDeliveryStart,
      estimatedDeliveryEnd: view.estimatedDeliveryEnd,
      agreedDeliveryDate: view.agreedDeliveryDate,
      deliveredAt: view.deliveredAt,
      lastModifiedAt: view.lastModifiedAt,
      fetchedAt,
      syncedAt: fetchedAt,
    },
  });

  // Satırlar yalnızca ürün/ölçü eşleştirmesi için; PII yok.
  for (const line of latest.lines) {
    if (!line.lineId) continue;
    await prisma.orderLine.upsert({
      where: { orderId_lineId: { orderId: saved.id, lineId: line.lineId } },
      create: {
        orderId: saved.id,
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
  }

  return { kind: "MATCHED", order: view };
}
