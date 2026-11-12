import { cookies } from "next/headers";

import { requireUser } from "@/lib/auth/session";
import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import {
  MAX_SAMPLES,
  MIN_SAMPLES,
  getUsageReport,
  listQualityRuns,
  listQualitySets,
  listRunItems,
} from "@/lib/quality/service";

import { createSetAction, scoreItemAction, startRunAction } from "./actions";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

const OK_MESSAGES: Record<string, string> = {
  "set-olusturuldu": "Değerlendirme seti oluşturuldu. Hazır olduğunuzda değerlendirmeyi başlatın.",
  "degerlendirme-bitti": "Değerlendirme tamamlandı. Aşağıdan örnekleri puanlayabilirsiniz.",
  "puan-kaydedildi": "İnsan puanı kaydedildi.",
};

const ERROR_MESSAGES: Record<string, string> = {
  yetkisiz: "Bu sayfa için yönetici oturumu gerekir.",
  "llm-yapilandirilmadi": "AI sağlayıcısı yapılandırılmadı (LLM_PROVIDER / LLM_API_KEY).",
  "llm-hatasi": "AI sağlayıcısına ulaşılamadı; bazı örnekler değerlendirilemedi.",
  "invalid-score": "Puan 1–5 arasında olmalı.",
  "invalid-sample-count": `Örnek sayısı ${MIN_SAMPLES}–${MAX_SAMPLES} arasında olmalı.`,
  "no-questions": "Değerlendirme için kayıtlı soru bulunamadı.",
  "set-not-found": "Değerlendirme seti bulunamadı.",
  "empty-set": "Bu sette örnek soru yok.",
  "questions-missing": "Setteki sorular artık veritabanında yok.",
  "item-not-found": "Değerlendirme örneği bulunamadı.",
  "beklenmeyen-hata": "Beklenmeyen bir hata oluştu.",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--fg)",
  fontSize: 14,
};

const cellStyle: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--border)", fontSize: 13 };
const headStyle: React.CSSProperties = { ...cellStyle, textAlign: "left", fontSize: 12, opacity: 0.7 };

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toFixed(6)}`;
}

export default async function QualityPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; hata?: string; run?: string }>;
}) {
  const user = await requireUser();
  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  const env = getEnv();

  if (!access.ok) {
    return (
      <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 20 }}>Erişim gerekli</h1>
        <p style={{ opacity: 0.75 }}>Kalite panelini görmek için yönetici oturumuyla giriş yapın.</p>
      </main>
    );
  }

  const params = await searchParams;
  const [sets, runs, usage] = await Promise.all([listQualitySets(user.storeId), listQualityRuns(user.storeId), getUsageReport(user.storeId)]);
  const selectedRunId = params.run ?? runs[0]?.runId ?? null;
  const items = selectedRunId ? await listRunItems(user.storeId, selectedRunId) : [];
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? null;

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1150 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, marginBottom: 4 }}>Kalite değerlendirme</h1>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
            Yalnızca yerel kayıtlı sorular kullanılır. Trendyol&apos;a istek gönderilmez, cevap yazılmaz.
          </p>
        </div>
        <nav style={{ display: "flex", gap: 12, fontSize: 13 }}>
          <a href="/questions">Sorular</a>
          <a href="/drafts">Taslaklar</a>
          <a href="/products">Ürün bilgileri</a>
        </nav>
      </header>

      {params.ok && OK_MESSAGES[params.ok] ? (
        <p style={{ marginTop: 16, padding: "10px 12px", borderRadius: 8, background: "#e8f6ee", color: "#14532d", fontSize: 13 }}>
          {OK_MESSAGES[params.ok]}
        </p>
      ) : null}
      {params.hata ? (
        <p style={{ marginTop: 16, padding: "10px 12px", borderRadius: 8, background: "#fdeaea", color: "#7f1d1d", fontSize: 13 }}>
          {ERROR_MESSAGES[params.hata] ?? "İşlem tamamlanamadı."}
        </p>
      ) : null}

      <section style={{ marginTop: 22, padding: 16, border: "1px solid var(--border)", borderRadius: 12 }}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>1) Değerlendirme seti oluştur</h2>
        <p style={{ fontSize: 12.5, opacity: 0.7, marginTop: 0 }}>
          Gerçek sorulardan {MIN_SAMPLES}–{MAX_SAMPLES} örnek seçilir. Soru metinleri kişisel verilerden arındırılarak
          saklanır. Set oluşturmak AI çağrısı yapmaz.
        </p>
        <form action={createSetAction} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ flex: "2 1 260px", fontSize: 12 }}>
            Set adı
            <input name="name" placeholder="Örn. Ekim değerlendirmesi" style={inputStyle} />
          </label>
          <label style={{ flex: "0 1 140px", fontSize: 12 }}>
            Örnek sayısı
            <input name="sampleCount" type="number" min={MIN_SAMPLES} max={MAX_SAMPLES} defaultValue={MIN_SAMPLES} style={inputStyle} />
          </label>
          <button type="submit" style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer" }}>
            Set oluştur
          </button>
        </form>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 16 }}>2) Setler</h2>
        {sets.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>Henüz set yok.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headStyle}>Ad</th>
                <th style={headStyle}>Örnek</th>
                <th style={headStyle}>Oluşturan</th>
                <th style={headStyle}>Tarih</th>
                <th style={headStyle}>İşlem</th>
              </tr>
            </thead>
            <tbody>
              {sets.map((set) => (
                <tr key={set.id}>
                  <td style={cellStyle}>{set.name}</td>
                  <td style={cellStyle}>{set.sampleCount}</td>
                  <td style={cellStyle}>{set.createdBy}</td>
                  <td style={cellStyle}>{dateFormatter.format(set.createdAt)}</td>
                  <td style={cellStyle}>
                    <form action={startRunAction}>
                      <input type="hidden" name="setId" value={set.id} />
                      <button
                        type="submit"
                        style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer", fontSize: 12 }}
                      >
                        Değerlendirmeyi başlat
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16 }}>3) Koşular ve metrikler</h2>
        <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
          Otomatik kontroller (uyarı, bilgi eksikliği, üslup) insan değerlendirmesinin yerine geçmez.
        </p>
        {runs.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>Henüz değerlendirme koşusu yok.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headStyle}>Set</th>
                <th style={headStyle}>Prompt</th>
                <th style={headStyle}>Model</th>
                <th style={headStyle}>Örnek</th>
                <th style={headStyle}>Ort. insan puanı</th>
                <th style={headStyle}>Uyarı oranı</th>
                <th style={headStyle}>Bilgi eksikliği</th>
                <th style={headStyle}>Maliyet</th>
                <th style={headStyle}>Tarih</th>
                <th style={headStyle} />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <td style={cellStyle}>{run.setName}</td>
                  <td style={cellStyle}>{run.promptVersion}</td>
                  <td style={cellStyle}>{run.model}</td>
                  <td style={cellStyle}>{run.itemCount}</td>
                  <td style={cellStyle}>
                    {run.avgHumanScore === null ? "—" : `${run.avgHumanScore} (${run.scoredCount} puan)`}
                  </td>
                  <td style={cellStyle}>%{run.warningRate}</td>
                  <td style={cellStyle}>%{run.needsInfoRate}</td>
                  <td style={cellStyle}>{money(run.totalCostUSD)}</td>
                  <td style={cellStyle}>{dateFormatter.format(run.startedAt)}</td>
                  <td style={cellStyle}>
                    <a href={`/quality?run=${run.runId}`} style={{ fontSize: 12 }}>
                      {run.runId === selectedRunId ? "Seçili" : "İncele"}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedRun ? (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 16 }}>
            4) Örnekler — {selectedRun.setName} · prompt {selectedRun.promptVersion} · {selectedRun.model}
          </h2>
          {items.length === 0 ? (
            <p style={{ fontSize: 13, opacity: 0.7 }}>Bu koşuda örnek yok.</p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {items.map((item, index) => (
                <article key={item.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
                  <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 6 }}>
                    #{index + 1} · durum: {item.outcome} · {item.durationMs} ms · {money(item.costUSD)}
                  </div>
                  <p style={{ margin: "0 0 6px", fontSize: 13 }}>
                    <strong>Soru (maskelenmiş):</strong> {item.questionMasked}
                  </p>
                  <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                    <strong>AI cevabı:</strong> {item.answerText || "—"}
                  </p>
                  <p style={{ margin: "0 0 8px", fontSize: 12, opacity: 0.75 }}>
                    Otomatik: {item.checks?.warningCount ?? 0} uyarı ·{" "}
                    {item.checks?.noVerifiedInfo ? "doğrulanmış bilgi yok" : "doğrulanmış bilgi var"} ·{" "}
                    {item.checks?.sentenceCount ?? 0} cümle ·{" "}
                    {item.checks?.needsHuman ? "insan müdahalesi önerilir" : "otomatik kontroller temiz"}
                  </p>
                  <form action={scoreItemAction} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <input type="hidden" name="itemId" value={item.id} />
                    <input type="hidden" name="runId" value={selectedRun.runId} />
                    <label style={{ fontSize: 12 }}>
                      Puan (1–5)
                      <select name="score" defaultValue={item.humanScore ?? 3} style={{ ...inputStyle, width: 80 }}>
                        {[1, 2, 3, 4, 5].map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ flex: "1 1 220px", fontSize: 12 }}>
                      Not
                      <input name="note" defaultValue={item.humanNote ?? ""} style={inputStyle} />
                    </label>
                    <button
                      type="submit"
                      style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer", fontSize: 12 }}
                    >
                      Puanı kaydet
                    </button>
                    {item.humanScore !== null ? (
                      <span style={{ fontSize: 12, opacity: 0.7 }}>Kayıtlı: {item.humanScore}/5</span>
                    ) : null}
                  </form>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <section style={{ marginTop: 26 }}>
        <h2 style={{ fontSize: 16 }}>5) Kullanım ve maliyet</h2>
        <p style={{ fontSize: 13, opacity: 0.8 }}>
          Toplam çağrı: {usage.totalCalls} · başarısız: {usage.failedCalls} · token: {usage.totalTokens} · tahmini
          maliyet: {money(usage.totalCostUSD)} · ort. süre: {usage.avgDurationMs} ms
          {env.LLM_INPUT_COST_PER_1K === 0 && env.LLM_OUTPUT_COST_PER_1K === 0
            ? " (fiyat tanımlı değil: maliyet 0 görünür, LLM_INPUT_COST_PER_1K / LLM_OUTPUT_COST_PER_1K ayarlayın)"
            : ""}
        </p>
        {usage.daily.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse", maxWidth: 520 }}>
            <thead>
              <tr>
                <th style={headStyle}>Gün</th>
                <th style={headStyle}>Çağrı</th>
                <th style={headStyle}>Token</th>
                <th style={headStyle}>Maliyet</th>
              </tr>
            </thead>
            <tbody>
              {usage.daily.map((row) => (
                <tr key={row.day.toISOString()}>
                  <td style={cellStyle}>{row.day.toISOString().slice(0, 10)}</td>
                  <td style={cellStyle}>{row.calls}</td>
                  <td style={cellStyle}>{row.tokens}</td>
                  <td style={cellStyle}>{money(row.costUSD)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </main>
  );
}
