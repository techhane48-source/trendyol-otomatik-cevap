import { cookies } from "next/headers";

import { requireUser } from "@/lib/auth/session";
import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { listApprovedForProduction, listChangeRequests } from "@/lib/orders/service";

import {
  approveChangeRequestAction,
  markOwnershipAction,
  rejectChangeRequestAction,
} from "../orders/actions";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

const STATUS_LABELS: Record<string, string> = {
  PENDING_REVIEW: "Onay bekliyor",
  NEEDS_VERIFICATION: "Doğrulama gerekli",
  APPROVED: "Onaylandı",
  REJECTED: "Reddedildi",
  INVALIDATED: "Geçersiz kılındı",
};

const OK_MESSAGES: Record<string, string> = {
  "talep-olusturuldu": "Talep oluşturuldu. Onay öncesi sipariş durumu tekrar sorgulanacak.",
  "sahiplik-dogrulandi": "Sahiplik doğrulaması kaydedildi. Artık onay verilebilir.",
  onaylandi: "Talep onaylandı (yerel kayıt). Canlı durum onay anında yeniden doğrulandı.",
  reddedildi: "Talep reddedildi.",
};

const ERROR_MESSAGES: Record<string, string> = {
  yetkisiz: "Yönetici oturumu gerekir.",
  "order-status-changed": "Sipariş durumu değişti: talep GEÇERSİZ kılındı, onaylanmadı.",
  "orders-api-unavailable": "Sipariş API'sine ulaşılamadı; onay yapılmadı.",
  "request-not-found": "Talep bulunamadı.",
  "already-approved": "Talep zaten onaylanmış.",
  "request-rejected": "Reddedilmiş talep onaylanamaz.",
  "request-invalidated": "Talep geçersiz kılınmış; yeni talep oluşturun.",
  "line-not-matched": "Sipariş kalemi eşleşmediği için onaylanamaz.",
  "request-state-changed": "Talep durumu değişti; işlem tekrarlanmadı.",
  "ownership-not-verified": "Müşteri sahipliği doğrulanmadan onay verilemez; önce sahiplik doğrulaması kaydedin.",
  "already-rejected": "Talep zaten reddedilmiş.",
  "beklenmeyen-hata": "Beklenmeyen bir hata oluştu.",
};

const cellStyle: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--border)", fontSize: 13 };
const headStyle: React.CSSProperties = { ...cellStyle, textAlign: "left", fontSize: 12, opacity: 0.7 };

function dims(width: number | null, height: number | null): string {
  return width && height ? `${width}×${height} cm` : "—";
}

export default async function ChangeRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; hata?: string; durum?: string; print?: string }>;
}) {
  const user = await requireUser();
  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) {
    return (
      <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 20 }}>Erişim gerekli</h1>
        <p style={{ opacity: 0.75 }}>Ölçü talepleri paneli için yönetici oturumu gerekir.</p>
      </main>
    );
  }

  const params = await searchParams;
  const filter = params.durum ?? "";
  const rows = await listChangeRequests(user.storeId, { status: filter || undefined, limit: 100 });
  const approved = await listApprovedForProduction(user.storeId);
  const printing = params.print === "1";

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1150 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, marginBottom: 4 }}>Ölçü değişikliği talepleri</h1>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
            Onay yalnızca yerel kayıttır; Trendyol&apos;a hiçbir yazma gönderilmez. Onaydan önce sipariş durumu canlı sorgulanır.
          </p>
        </div>
        {!printing ? (
          <nav style={{ display: "flex", gap: 12, fontSize: 13 }}>
            <a href="/orders">Siparişler</a>
            <a href="/drafts">Taslaklar</a>
            <a href="/change-requests?print=1">Üretim listesi (yazdır)</a>
          </nav>
        ) : null}
      </header>

      <p style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: "#fff7e6", color: "#7c4a03", fontSize: 12.5 }}>
        <strong>Yetki notu:</strong> Paylaşılan yönetici anahtarı gerçek kullanıcı kimliği değildir; onaylayan aktör güvenilir biçimde
        izlenemez. Çok kullanıcılı kullanımdan önce kullanıcı bazlı kimlik doğrulama gerekir.
      </p>

      {params.ok && OK_MESSAGES[params.ok] ? (
        <p style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: "#e8f6ee", color: "#14532d", fontSize: 13 }}>
          {OK_MESSAGES[params.ok]}
        </p>
      ) : null}
      {params.hata ? (
        <p style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: "#fdeaea", color: "#7f1d1d", fontSize: 13 }}>
          {ERROR_MESSAGES[params.hata] ?? "İşlem tamamlanamadı."}
        </p>
      ) : null}

      {!printing ? (
        <>
          <nav style={{ marginTop: 16, display: "flex", gap: 10, fontSize: 12 }}>
            {["", "PENDING_REVIEW", "NEEDS_VERIFICATION", "APPROVED", "REJECTED", "INVALIDATED"].map((status) => (
              <a
                key={status || "all"}
                href={status ? `/change-requests?durum=${status}` : "/change-requests"}
                style={{ opacity: filter === status ? 1 : 0.6 }}
              >
                {status ? (STATUS_LABELS[status] ?? status) : "Tümü"}
              </a>
            ))}
          </nav>

          <section style={{ marginTop: 14 }}>
            {rows.length === 0 ? (
              <p style={{ fontSize: 13, opacity: 0.7 }}>Kayıt yok.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={headStyle}>Sipariş</th>
                    <th style={headStyle}>Ürün</th>
                    <th style={headStyle}>Yeni ölçü</th>
                    <th style={headStyle}>Durum (talep)</th>
                    <th style={headStyle}>Sipariş durumu</th>
                    <th style={headStyle}>Sahiplik</th>
                    <th style={headStyle}>Tarih</th>
                    <th style={headStyle}>İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td style={cellStyle}>{row.orderNumber}</td>
                      <td style={cellStyle}>{row.productName ?? "—"}</td>
                      <td style={cellStyle}>
                        {dims(row.requestedWidthCm, row.requestedHeightCm)}
                        {row.orientationUncertain ? <div style={{ fontSize: 11, opacity: 0.7 }}>en/boy belirsiz</div> : null}
                      </td>
                      <td style={cellStyle}>{STATUS_LABELS[row.status] ?? row.status}</td>
                      <td style={cellStyle}>{row.orderStatusAtRequest ?? "—"}</td>
                      <td style={cellStyle}>{row.ownershipVerified ? "doğrulandı" : "doğrulanamadı"}</td>
                      <td style={cellStyle}>{dateFormatter.format(row.createdAt)}</td>
                      <td style={cellStyle}>
                        {row.status === "PENDING_REVIEW" || row.status === "NEEDS_VERIFICATION" ? (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {!row.ownershipVerified ? (
                              <form action={markOwnershipAction}>
                                <input type="hidden" name="requestId" value={row.id} />
                                <input type="hidden" name="note" value="Sipariş müşteriyle eşleştirildi (insan doğrulaması)" />
                                <button
                                  type="submit"
                                  style={{ padding: "5px 9px", borderRadius: 7, border: "1px solid var(--border)", cursor: "pointer", fontSize: 12 }}
                                >
                                  Sahipliği doğrula
                                </button>
                              </form>
                            ) : null}
                            <form action={approveChangeRequestAction}>
                              <input type="hidden" name="requestId" value={row.id} />
                              <button
                                type="submit"
                                disabled={!row.ownershipVerified}
                                title={row.ownershipVerified ? undefined : "Önce sahiplik doğrulaması gerekir"}
                                style={{ padding: "5px 9px", borderRadius: 7, border: "1px solid var(--border)", cursor: row.ownershipVerified ? "pointer" : "not-allowed", fontSize: 12, opacity: row.ownershipVerified ? 1 : 0.5 }}
                              >
                                Onayla
                              </button>
                            </form>
                            <form action={rejectChangeRequestAction}>
                              <input type="hidden" name="requestId" value={row.id} />
                              <button
                                type="submit"
                                style={{ padding: "5px 9px", borderRadius: 7, border: "1px solid var(--border)", cursor: "pointer", fontSize: 12 }}
                              >
                                Reddet
                              </button>
                            </form>
                          </div>
                        ) : (
                          <span style={{ fontSize: 12, opacity: 0.6 }}>{row.approvedBy ? `onaylayan: ${row.approvedBy}` : "—"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ) : null}

      <section style={{ marginTop: 30 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>Üretim için onaylı ölçü değişiklikleri</h2>
        <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
          Yazdırmak için Ctrl+P (liste yazdırma görünümünde gereksiz menüler gizlenir).
        </p>
        {approved.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>Onaylı talep yok.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headStyle}>Sipariş</th>
                <th style={headStyle}>Ürün</th>
                <th style={headStyle}>Yeni ölçü</th>
                <th style={headStyle}>Onaylayan</th>
                <th style={headStyle}>Onay zamanı</th>
                <th style={headStyle}>Onay anındaki durum</th>
              </tr>
            </thead>
            <tbody>
              {approved.map((row) => (
                <tr key={row.id}>
                  <td style={cellStyle}>{row.orderNumber}</td>
                  <td style={cellStyle}>{row.productName ?? "—"}</td>
                  <td style={cellStyle}>{dims(row.requestedWidthCm, row.requestedHeightCm)}</td>
                  <td style={cellStyle}>{row.approvedBy ?? "—"}</td>
                  <td style={cellStyle}>{row.approvedAt ? dateFormatter.format(row.approvedAt) : "—"}</td>
                  <td style={cellStyle}>{row.orderStatusAtApproval ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
