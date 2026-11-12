import { cookies } from "next/headers";

import { requireUser } from "@/lib/auth/session";
import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { decideOrderStatus } from "@/lib/orders/decision";
import { listChangeRequests, searchOrders } from "@/lib/orders/service";

import { createChangeRequestAction, syncOrdersAction } from "./actions";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

const DECISION_LABELS: Record<string, string> = {
  CAN_REQUEST: "Talep alınabilir (Created)",
  TOO_LATE: "Talep reddedilir (üretim başlamış)",
  HUMAN_REVIEW: "İnsan incelemesi gerekir",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING_REVIEW: "Onay bekliyor",
  NEEDS_VERIFICATION: "Doğrulama gerekli",
  APPROVED: "Onaylandı",
  REJECTED: "Reddedildi",
  INVALIDATED: "Geçersiz kılındı",
};

const ERROR_MESSAGES: Record<string, string> = {
  yetkisiz: "Yönetici oturumu gerekir.",
  "orders-api-unavailable": "Sipariş API'sine ulaşılamadı; değişiklik mümkün diye cevap verilmemeli.",
  "order-not-found": "Sipariş bulunamadı.",
  "order-number-not-found": "Soru metninde sipariş numarası bulunamadı.",
  "order-number-ambiguous": "Soru metninde birden fazla sipariş numarası var.",
  "duplicate-active-request": "Bu soru için zaten aktif bir talep var.",
  "question-not-found": "Soru bulunamadı.",
  "beklenmeyen-hata": "Beklenmeyen bir hata oluştu.",
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--fg)",
  fontSize: 13,
};

const cellStyle: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--border)", fontSize: 13 };
const headStyle: React.CSSProperties = { ...cellStyle, textAlign: "left", fontSize: 12, opacity: 0.7 };

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; ok?: string; hata?: string; ozet?: string; soru?: string }>;
}) {
  const user = await requireUser();
  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) {
    return (
      <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 20 }}>Erişim gerekli</h1>
        <p style={{ opacity: 0.75 }}>Sipariş paneli için yönetici oturumu gerekir.</p>
      </main>
    );
  }

  const params = await searchParams;
  const orderNumber = params.q?.trim() ?? "";
  const result = orderNumber.length > 0 ? await searchOrders(user.storeId, { orderNumber }) : null;
  const requests = orderNumber ? await listChangeRequests(user.storeId, { orderNumber }) : [];

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1150 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, marginBottom: 4 }}>Siparişler</h1>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
            Salt okunur: Trendyol&apos;a hiçbir sipariş güncellemesi gönderilmez. Onay yalnızca yerel kayıt üretir.
          </p>
        </div>
        <nav style={{ display: "flex", gap: 12, fontSize: 13 }}>
          <a href="/questions">Sorular</a>
          <a href="/drafts">Taslaklar</a>
          <a href="/change-requests">Ölçü talepleri</a>
          <a href="/products">Ürün bilgileri</a>
        </nav>
      </header>

      {params.ok === "senkron" ? (
        <p style={{ marginTop: 16, padding: "10px 12px", borderRadius: 8, background: "#e8f6ee", color: "#14532d", fontSize: 13 }}>
          Sipariş aynası güncellendi: {params.ozet ?? ""}
        </p>
      ) : null}
      {params.hata ? (
        <p style={{ marginTop: 16, padding: "10px 12px", borderRadius: 8, background: "#fdeaea", color: "#7f1d1d", fontSize: 13 }}>
          {ERROR_MESSAGES[params.hata] ?? "İşlem tamamlanamadı."}
        </p>
      ) : null}

      <section style={{ marginTop: 20, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <form method="get" style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <label style={{ fontSize: 12 }}>
            Sipariş numarası
            <input name="q" defaultValue={orderNumber} placeholder="Örn. 123456789" style={{ ...inputStyle, display: "block", marginTop: 4 }} />
          </label>
          <button type="submit" style={{ ...inputStyle, cursor: "pointer" }}>
            Ara / canlı sorgula
          </button>
        </form>
        <form action={syncOrdersAction}>
          <button type="submit" style={{ ...inputStyle, cursor: "pointer" }}>
            Created siparişleri senkronla
          </button>
        </form>
      </section>

      {result ? (
        <section style={{ marginTop: 22 }}>
          <h2 style={{ fontSize: 16 }}>Canlı durum (Trendyol)</h2>
          {"error" in result.live ? (
            <p style={{ fontSize: 13, color: "#7f1d1d" }}>
              Sipariş API&apos;sine ulaşılamadı: {result.live.error} — bu durumda değişiklik mümkün diye cevap verilmemeli.
            </p>
          ) : result.live.length === 0 ? (
            <p style={{ fontSize: 13, opacity: 0.75 }}>Bu numarada sipariş bulunamadı.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={headStyle}>Paket</th>
                  <th style={headStyle}>Durum</th>
                  <th style={headStyle}>Karar</th>
                  <th style={headStyle}>Kalem</th>
                </tr>
              </thead>
              <tbody>
                {result.live.map((pkg) => (
                  <tr key={`${pkg.orderNumber}-${pkg.shipmentPackageId ?? "x"}`}>
                    <td style={cellStyle}>{pkg.shipmentPackageId ?? "—"}</td>
                    <td style={cellStyle}>{pkg.status}</td>
                    <td style={cellStyle}>{DECISION_LABELS[decideOrderStatus(pkg.status).decision]}</td>
                    <td style={cellStyle}>
                      {pkg.lines.map((line) => (
                        <div key={line.id} style={{ fontSize: 12 }}>
                          {line.productName ?? "Ürün"} · adet {line.quantity} · main {line.productMainId ?? "—"} · varyant {line.productId ?? "—"}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2 style={{ fontSize: 16, marginTop: 22 }}>Yerel ayna</h2>
          {result.local.length === 0 ? (
            <p style={{ fontSize: 13, opacity: 0.7 }}>Yerelde kayıt yok (senkron çalıştırılabilir).</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", maxWidth: 720 }}>
              <thead>
                <tr>
                  <th style={headStyle}>Sipariş</th>
                  <th style={headStyle}>Durum</th>
                  <th style={headStyle}>Kalem</th>
                  <th style={headStyle}>Müşteri ref</th>
                </tr>
              </thead>
              <tbody>
                {result.local.map((row) => (
                  <tr key={row.id}>
                    <td style={cellStyle}>{row.orderNumber}</td>
                    <td style={cellStyle}>{row.status}</td>
                    <td style={cellStyle}>{row.lines}</td>
                    <td style={cellStyle}>{row.customerRef ? `${row.customerRef.slice(0, 8)}…` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2 style={{ fontSize: 16, marginTop: 22 }}>Bu sipariş için ölçü talepleri</h2>
          {requests.length === 0 ? (
            <p style={{ fontSize: 13, opacity: 0.7 }}>Talep yok.</p>
          ) : (
            <ul style={{ fontSize: 13, paddingLeft: 18 }}>
              {requests.map((request) => (
                <li key={request.id}>
                  {STATUS_LABELS[request.status] ?? request.status} · yeni ölçü {request.requestedWidthCm ?? "?"}×
                  {request.requestedHeightCm ?? "?"} cm · {dateFormatter.format(request.createdAt)}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {params.soru ? (
        <section style={{ marginTop: 26, padding: 14, border: "1px solid var(--border)", borderRadius: 10 }}>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Sorudan ölçü değişikliği talebi oluştur</h2>
          <p style={{ fontSize: 12, opacity: 0.7 }}>
            Sipariş numarası soru metninden çıkarılır; en/boy yönü metinden kesin değilse talep doğrulamaya düşer.
          </p>
          <form action={createChangeRequestAction} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <input type="hidden" name="questionId" value={params.soru} />
            <label style={{ fontSize: 12 }}>
              En (cm) — isteğe bağlı
              <input name="widthCm" type="number" min={20} max={1000} style={{ ...inputStyle, display: "block", marginTop: 4, width: 120 }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Boy (cm) — isteğe bağlı
              <input name="heightCm" type="number" min={20} max={1000} style={{ ...inputStyle, display: "block", marginTop: 4, width: 120 }} />
            </label>
            <button type="submit" style={{ ...inputStyle, cursor: "pointer" }}>
              Talep oluştur
            </button>
          </form>
        </section>
      ) : null}
    </main>
  );
}
