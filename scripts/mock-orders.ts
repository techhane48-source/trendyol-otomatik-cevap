import { createServer } from "node:http";

/**
 * Mock Trendyol sipariş servisi (E2E).
 * GET  /integration/order/sellers/:sellerId/orders  → paket listesi
 * POST /_control  { status }                        → sipariş durumunu değiştirir (test amaçlı)
 */

let status = "Created";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "POST" && url.pathname === "/_control") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}") as { status?: string };
        if (parsed.status) status = parsed.status;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status }));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
      }
    });
    return;
  }

  if (req.method === "GET" && /\/orders$/.test(url.pathname)) {
    const orderNumber = url.searchParams.get("orderNumber") ?? "123456789";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        page: 0,
        size: 1,
        totalPages: 1,
        totalElements: 1,
        content: [
          {
            shipmentPackageId: 9001,
            orderNumber,
            status,
            orderDate: Date.now(),
            customerId: "CUST-1",
            customerFirstName: "Test",
            customerEmail: "test@example.invalid",
            shipmentAddress: { address1: "gizli adres" },
            lines: [
              {
                lineId: 1,
                productId: "VAR-1",
                productMainId: "MAIN-1",
                productName: "Bambu Tül Perde",
                quantity: 1,
                amount: 999,
              },
            ],
          },
        ],
      }),
    );
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const port = Number(process.env.MOCK_ORDERS_PORT ?? 5597);
server.listen(port, "127.0.0.1", () => {
  console.log(`mock orders listening on ${port}`);
});
