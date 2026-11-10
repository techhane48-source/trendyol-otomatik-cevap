import { cookies } from "next/headers";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { answerMemoryStats, listAnswerMemory } from "@/lib/history/service";
import type { AnswerReviewStatus } from "@/generated/prisma/enums";

import { reviewAnswerAction } from "./actions";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("tr-TR", { dateStyle: "short", timeZone: "Europe/Istanbul" });

const STATUS_LABELS: Record<AnswerReviewStatus, string> = {
  UNREVIEWED: "Doğrulanmadı",
  VERIFIED: "Doğrulandı",
  WRONG: "Hatalı",
  OUTDATED: "Güncelliğini yitirdi",
};

const ERROR_MESSAGES: Record<string, string> = {
  yetkisiz: "Yönetici oturumu gerekir.",
  "gecersiz-durum": "Geçersiz doğrulama durumu.",
  "question-not-found": "Soru bulunamadı.",
  "answer-missing": "Cevabı olmayan soru doğrulanamaz.",
  "beklenmeyen-hata": "Beklenmeyen bir hata oluştu.",
};

const cellStyle: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--border)", fontSize: 13, verticalAlign: "top" };
const headStyle: React.CSSProperties = { ...cellStyle, textAlign: "left", fontSize: 12, opacity: 0.7 };
const chipStyle: React.CSSProperties = { display: "inline-block", padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border)", fontSize: 11.5 };

export default async function AnswersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; durum?: string; ok?: string; hata?: string }>;
}) {
  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) {
    return (
      <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 20 }}>Erişim gerekli</h1>
        <p style={{ opacity: 0.75 }}>Geçmiş cevaplar paneli için yönetici oturumu gerekir.</p>
      </main>
    );
  }

  const params = await searchParams;
  const review = (params.durum as AnswerReviewStatus | undefined) ?? undefined;
  const q = params.q?.trim() || undefined;
  const [rows, stats] = await Promise.all([listAnswerMemory({ q, review, limit: 100 }), answerMemoryStats()]);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1200 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, marginBottom: 4 }}>Geçmiş cevaplar (hafıza)</h1>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
            Trendyol&apos;da daha önce verilmiş satıcı cevapları. Bunlar <strong>kanıt değil, referanstır</strong>; doğrulanmış ürün
            kartı ve canlı sipariş verisi her zaman önceliklidir.
          </p>
        </div>
        <nav style={{ display: "flex", gap: 12, fontSize: 13 }}>
          <a href="/drafts">Taslaklar</a>
          <a href="/change-requests">Ölçü talepleri</a>
          <a href="/questions">Sorular</a>
        </nav>
      </header>

      <section style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
        <span style={chipStyle}>Toplam: {stats.total}</span>
        <span style={chipStyle}>Doğrulandı: {stats.verified}</span>
        <span style={chipStyle}>Doğrulanmadı: {stats.unreviewed}</span>
        <span style={chipStyle}>Hatalı: {stats.wrong}</span>
        <span style={chipStyle}>Güncelliğini yitirdi: {stats.outdated}</span>
        <span style={chipStyle}>AI&apos;ya girebilir: {stats.usableForAi}</span>
      </section>

      {params.ok ? (
        <p style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: "#e8f6ee", color: "#14532d", fontSize: 13 }}>
          Doğrulama durumu güncellendi.
        </p>
      ) : null}
      {params.hata ? (
        <p style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: "#fdeaea", color: "#7f1d1d", fontSize: 13 }}>
          {ERROR_MESSAGES[params.hata] ?? "İşlem tamamlanamadı."}
        </p>
      ) : null}

      <form method="get" style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "flex-end" }}>
        <label style={{ fontSize: 12 }}>
          Ara
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="soru veya cevap metni"
            style={{ display: "block", marginTop: 4, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", fontSize: 13, minWidth: 260 }}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Durum
          <select
            name="durum"
            defaultValue={review ?? ""}
            style={{ display: "block", marginTop: 4, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", fontSize: 13 }}
          >
            <option value="">Tümü</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", cursor: "pointer", fontSize: 13 }}>
          Filtrele
        </button>
      </form>

      <section style={{ marginTop: 16 }}>
        {rows.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>Kayıt yok.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headStyle}>Soru</th>
                <th style={headStyle}>Satıcı cevabı</th>
                <th style={headStyle}>Ürün</th>
                <th style={headStyle}>Durum</th>
                <th style={headStyle}>Değerlendir</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.questionId}>
                  <td style={{ ...cellStyle, maxWidth: 300 }}>
                    <div style={{ fontSize: 12, opacity: 0.65 }}>#{row.trendyolQuestionId} · {row.askedAt ? dateFormatter.format(row.askedAt) : "—"}</div>
                    {row.text}
                  </td>
                  <td style={{ ...cellStyle, maxWidth: 340 }}>{row.answerText}</td>
                  <td style={cellStyle}>{row.productName ?? "—"}</td>
                  <td style={cellStyle}>
                    <div>{STATUS_LABELS[row.reviewStatus]}</div>
                    {row.reviewedBy ? (
                      <div style={{ fontSize: 11, opacity: 0.65 }}>
                        {row.reviewedBy} · {row.reviewedAt ? dateFormatter.format(row.reviewedAt) : ""}
                      </div>
                    ) : null}
                    {row.reviewNote ? <div style={{ fontSize: 11, opacity: 0.75 }}>{row.reviewNote}</div> : null}
                  </td>
                  <td style={cellStyle}>
                    <form action={reviewAnswerAction} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <input type="hidden" name="questionId" value={row.questionId} />
                      <select
                        name="status"
                        defaultValue={row.reviewStatus}
                        style={{ padding: "5px 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", fontSize: 12 }}
                      >
                        {Object.entries(STATUS_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <input
                        name="note"
                        placeholder="not (isteğe bağlı)"
                        style={{ padding: "5px 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", fontSize: 12, width: 150 }}
                      />
                      <button type="submit" style={{ padding: "5px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", cursor: "pointer", fontSize: 12 }}>
                        Kaydet
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p style={{ marginTop: 18, fontSize: 12, opacity: 0.65 }}>
        Not: &quot;Doğrulandı&quot; işareti cevabın o gün doğru olduğunu gösterir; fiyat/stok/teslimat gibi bilgiler yine güncel
        kaynaktan doğrulanmalıdır. &quot;Hatalı&quot; ve &quot;Güncelliğini yitirdi&quot; kayıtları AI bağlamına girmez.
      </p>
    </main>
  );
}
