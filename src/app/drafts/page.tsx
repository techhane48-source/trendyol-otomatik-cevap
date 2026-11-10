import { cookies } from "next/headers";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getDraftHistory, listQuestionsForDrafting, type DraftView } from "@/lib/drafts/service";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";

import {
  approveDraftAction,
  createDraftAction,
  editDraftAction,
  rejectDraftAction,
} from "./actions";

export const dynamic = "force-dynamic";

const log = createLogger("page.drafts");

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

function formatDate(value: Date | null | undefined): string {
  return value ? dateFormatter.format(value) : "—";
}

const STATUS_LABELS: Record<DraftView["status"], string> = {
  PENDING: "Onay bekliyor",
  APPROVED: "Onaylandı",
  REJECTED: "Reddedildi",
  SUPERSEDED: "Geçersiz (yeni revizyon)",
};

const MESSAGES: Record<string, string> = {
  "taslak-olusturuldu": "AI taslağı oluşturuldu. Onaylamadan önce metni kontrol edin.",
  "revizyon-kaydedildi": "Düzenleme yeni revizyon olarak kaydedildi; eski revizyon korunuyor.",
  "onaylandi": "Taslak onaylandı (yalnızca yerel kayıt — Trendyol'a cevap gönderilmedi).",
  "reddedildi": "Taslak reddedildi.",
};

const ERROR_MESSAGES: Record<string, string> = {
  "uyari-kabul-edilmedi": "Taslakta doğrulanmamış özel ifadeler var. Düzenleyin veya uyarıları açıkça kabul edin.",
  "llm-yapilandirilmadi": "AI sağlayıcısı yapılandırılmadı (LLM_PROVIDER / LLM_API_KEY).",
  "llm-hatasi": "AI sağlayıcısına ulaşılamadı. Taslak oluşturulmadı.",
  "draft-not-found": "Taslak bulunamadı.",
  "draft-locked": "Onaylanmış/reddedilmiş taslak düzenlenemez.",
  "draft-superseded": "Daha yeni bir revizyon var; son revizyonu kullanın.",
  "already-approved": "Taslak zaten onaylanmış.",
  "draft-rejected": "Reddedilmiş taslak onaylanamaz.",
  "already-rejected": "Taslak zaten reddedilmiş.",
  "question-not-found": "Soru bulunamadı.",
  "invalid-text": "Taslak metni 5–2000 karakter arasında olmalı.",
  "llm-request-error": "AI isteği başarısız oldu.",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
};

const buttonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--text)",
  cursor: "pointer",
};

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: Promise<{ hata?: string; ok?: string }>;
}) {
  const cookieStore = await cookies();
  const access = checkAccess(cookieStore.get(ACCESS_COOKIE_NAME)?.value ?? null);

  if (!access.ok) {
    return (
      <>
        <h1>Taslaklar</h1>
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Erişim gerekli</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            {access.error}
          </p>
          <p style={{ marginBottom: 0 }}>
            <a href="/questions">Giriş ekranına git</a>
          </p>
        </div>
      </>
    );
  }

  const params = await searchParams;
  const okMessage = params?.ok ? MESSAGES[params.ok] : null;
  const errorMessage = params?.hata
    ? (ERROR_MESSAGES[params.hata] ?? `İşlem başarısız (${params.hata}).`)
    : null;

  const env = getEnv();
  const llmEnabled = env.LLM_PROVIDER !== "disabled";

  let rows: Awaited<ReturnType<typeof listQuestionsForDrafting>> = [];
  let loadError: string | null = null;

  try {
    rows = await listQuestionsForDrafting({ limit: 25 });
  } catch (error) {
    log.error("Taslak paneli yüklenemedi", { error });
    loadError = "Sorular yüklenemedi. Veritabanı bağlantısını kontrol edin.";
  }

  const histories = new Map<string, Awaited<ReturnType<typeof getDraftHistory>>>();
  for (const row of rows) {
    if (row.drafts.length > 0) {
      histories.set(row.id, await getDraftHistory(row.id));
    }
  }

  return (
    <>
      <h1>Taslaklar</h1>
      <p className="subtitle">
        AI önerisi + insan onayı. Onay yalnızca yerel kaydı değiştirir; <strong>Trendyol'a cevap
        gönderilmez.</strong>
      </p>

      <div className="card" style={{ marginBottom: 12 }}>
        <strong>AI sağlayıcısı:</strong>{" "}
        <span className="muted">
          {llmEnabled ? `${env.LLM_PROVIDER} · ${env.LLM_MODEL}` : "kapalı (LLM_PROVIDER=disabled)"}
        </span>
        {llmEnabled ? null : (
          <div className="muted" style={{ marginTop: 6 }}>
            Taslak üretimi için <code>LLM_PROVIDER</code> ve <code>LLM_API_KEY</code> ortam
            değişkenlerini ayarlayın. Anahtar yalnızca <code>.env</code> dosyasında tutulur.
          </div>
        )}
      </div>

      {okMessage ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>Tamam:</strong> <span className="muted">{okMessage}</span>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>Hata:</strong> <span className="muted">{errorMessage}</span>
        </div>
      ) : null}

      {loadError ? (
        <div className="card">
          <strong>Hata:</strong> <span className="muted">{loadError}</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            Kayıtlı soru yok. Önce soruları çekin: <code>POST /api/sync</code>
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {rows.map((row) => {
            const latest = row.drafts[0] as unknown as DraftView | undefined;
            const history = histories.get(row.id) ?? [];
            const warnings = latest?.warnings ?? [];

            return (
              <div key={row.id} className="card">
                <div className="muted" style={{ fontSize: 12 }}>
                  {row.productName ?? "Ürün bilgisi yok"} · {formatDate(row.askedAt)} ·{" "}
                  {row.rawStatus ?? row.status}
                </div>
                <p style={{ margin: "6px 0 10px" }}>{row.text}</p>

                {latest ? (
                  <>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                      Revizyon {latest.revision} · {STATUS_LABELS[latest.status]} ·{" "}
                      {latest.source === "AI" ? "AI" : "İnsan düzenlemesi"}
                      {latest.approvedBy ? ` · onaylayan: ${latest.approvedBy}` : ""}
                      {latest.approvedAt ? ` · ${formatDate(latest.approvedAt)}` : ""}
                    </div>

                    {warnings.length > 0 ? (
                      <div
                        style={{
                          border: "1px solid #b45309",
                          borderRadius: 8,
                          padding: 8,
                          marginBottom: 8,
                          fontSize: 13,
                        }}
                      >
                        <strong>Doğrulanmamış ifadeler:</strong>{" "}
                        <span className="muted">
                          {warnings.map((warning) => warning.phrase).join(", ")}
                        </span>
                      </div>
                    ) : null}

                    <form action={editDraftAction} style={{ display: "grid", gap: 6 }}>
                      <input type="hidden" name="draftId" value={latest.id} />
                      <textarea
                        name="text"
                        defaultValue={latest.text}
                        rows={3}
                        style={inputStyle}
                        disabled={latest.status !== "PENDING"}
                      />
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <input
                          name="note"
                          placeholder="Not (isteğe bağlı)"
                          style={{ ...inputStyle, flex: "1 1 200px", width: "auto" }}
                        />
                        <button
                          type="submit"
                          style={buttonStyle}
                          disabled={latest.status !== "PENDING"}
                        >
                          Düzenle (yeni revizyon)
                        </button>
                      </div>
                    </form>

                    <form
                      action={approveDraftAction}
                      style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}
                    >
                      <input type="hidden" name="draftId" value={latest.id} />
                      <input name="note" placeholder="Onay notu" style={{ ...inputStyle, flex: "1 1 200px", width: "auto" }} />
                      {warnings.length > 0 ? (
                        <label className="muted" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                          <input type="checkbox" name="acknowledgeWarnings" />
                          Uyarıları kabul ediyorum
                        </label>
                      ) : null}
                      <button type="submit" style={buttonStyle} disabled={latest.status !== "PENDING"}>
                        Onayla
                      </button>
                    </form>

                    <form action={rejectDraftAction} style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <input type="hidden" name="draftId" value={latest.id} />
                      <button type="submit" style={buttonStyle} disabled={latest.status !== "PENDING"}>
                        Reddet
                      </button>
                    </form>

                    {history.length > 1 ? (
                      <details style={{ marginTop: 10 }}>
                        <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
                          Taslak geçmişi ({history.length} revizyon)
                        </summary>
                        <ol style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
                          {history.map((item) => (
                            <li key={item.id} style={{ marginBottom: 8 }}>
                              <div className="muted">
                                Revizyon {item.revision} · {STATUS_LABELS[item.status]} ·{" "}
                                {item.source === "AI" ? "AI" : "İnsan"} · {formatDate(item.createdAt)}
                              </div>
                              <div style={{ whiteSpace: "pre-wrap" }}>{item.text}</div>
                              <div className="muted" style={{ fontSize: 12 }}>
                                {item.history
                                  .map(
                                    (event) =>
                                      `${event.action} — ${event.actor} (${formatDate(event.createdAt)})`,
                                  )
                                  .join(" · ")}
                              </div>
                            </li>
                          ))}
                        </ol>
                      </details>
                    ) : null}
                  </>
                ) : (
                  <form action={createDraftAction} style={{ display: "grid", gap: 6 }}>
                    <input type="hidden" name="questionId" value={row.id} />
                    <input
                      name="productInfo"
                      placeholder="Ürün hakkında doğrulanmış bilgi (ölçü, kumaş, garanti) — boş bırakılabilir"
                      style={inputStyle}
                    />
                    <button type="submit" style={{ ...buttonStyle, justifySelf: "start" }} disabled={!llmEnabled}>
                      AI Taslak Oluştur
                    </button>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Ürün bilgisi boş bırakılırsa taslak somut özellik uydurmaz; bilgi isteyen bir
                      cevap üretir.
                    </span>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
