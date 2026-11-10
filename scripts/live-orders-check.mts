import "dotenv/config";

import { createOrdersClient } from "../src/lib/trendyol/orders-client";
import { getEnv } from "../src/lib/env";

/**
 * Gerçek Trendyol sipariş API'sine TEK salt okunur GET.
 * Müşteri adı/adresi/telefonu YAZDIRILMAZ; yalnızca durum dağılımı ve sayılar.
 */

const env = getEnv();
const client = createOrdersClient();

try {
  const page = await client.fetchOrdersPage({ page: 0, size: 3, status: "Created" });
  const statuses = new Map<string, number>();
  for (const pkg of page.content) {
    statuses.set(pkg.status, (statuses.get(pkg.status) ?? 0) + 1);
  }
  console.log(`CANLI GET: 200 · paket=${page.content.length} · toplam=${page.totalElements}`);
  console.log(`DURUMLAR: ${[...statuses.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`);
  console.log(`KALEMLER: ${page.content.reduce((sum, pkg) => sum + pkg.lines.length, 0)}`);
  console.log(`SATICI: ${env.TRENDYOL_SELLER_ID} · yazma isteği: 0`);
} catch (error) {
  console.log(`CANLI GET BAŞARISIZ: ${(error as { code?: string }).code ?? "UNKNOWN"}`);
  process.exitCode = 1;
}
