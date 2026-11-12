import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getWorkMetrics, listWorkItems } from "@/lib/work-queue/service";
import { CATEGORY_LABELS, PRIORITY_LABELS, STAGE_LABELS, STATUS_LABELS } from "@/lib/work-queue/classify";
import { approveAction, completeAction, ensureQueueAction, rejectAction, stageAction, startReviewAction } from "./actions";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

const PRIORITY_BADGE: Record<string, string> = {
  URGENT: "badge waiting",
  HIGH: "badge waiting",
  NORMAL: "badge",
  LOW: "badge",
};

export default async function WorkQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; status?: string; priority?: string; team?: string; q?: string }>;
}) {
  const store = await cookies();
  if (!checkAccess(store.get(ACCESS_COOKIE_NAME)?.value)) redirect("/giris");

  const params = await searchParams;
  const [items, metrics] = await Promise.all([
    listWorkItems({ category: params.category, status: params.status, priority: params.priority, team: params.team, search: params.q }),
    getWorkMetrics(),
  ]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>Akıllı iş kuyruğu</h2>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
              Sorular açıklanabilir kurallarla sınıflandırılır. Onay/ret yalnızca yetkili rolle yapılır; AI kendi kendine onay veremez.
            </p>
          </div>
          <form action={ensureQueueAction}>
            <button type="submit" className="btn">
              Kuyruğu yenile
            </button>
          </form>
        </div>
      </div>

      <div className="card" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
          <Metric label="Toplam soru" value={metrics.total} />
          <Metric label="Otomatik aday" value={metrics.autoCandidate} />
          <Metric label="Temsilci" value={metrics.support} />
          <Metric label="Atölye" value={metrics.workshop} />
          <Metric label="Bilgi eksik" value={metrics.needsInfo} />
          <Metric label="Bekleyen iş" value={metrics.pending} />
          <Metric label="Tamamlanan" value={metrics.completed} />
          <Metric
            label="Ort. çözüm"
            value={metrics.averageResolutionMinutes === null ? "—" : `${metrics.averageResolutionMinutes} dk`}
          />
        </div>

        <form className="muted" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
          <input name="q" placeholder="Ara: soru, ürün, sipariş no" defaultValue={params.q ?? ""} style={{ minWidth: 240 }} />
          <select name="category" defaultValue={params.category ?? ""}>
            <option value="">Tüm kategoriler</option>
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={params.status ?? ""}>
            <option value="">Tüm durumlar</option>
            {Object.entries(STATUS_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <select name="priority" defaultValue={params.priority ?? ""}>
            <option value="">Tüm öncelikler</option>
            {Object.entries(PRIORITY_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <select name="team" defaultValue={params.team ?? ""}>
            <option value="">Tüm ekipler</option>
            <option value="AI">AI</option>
            <option value="Müşteri Temsilcisi">Müşteri Temsilcisi</option>
            <option value="Atölye">Atölye</option>
          </select>
          <button type="submit" className="btn">
            Filtrele
          </button>
        </form>
      </div>

      {items.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            Kayıt yok. “Kuyruğu yenile” ile mevcut sorulardan iş kayıtları oluşturun.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {items.map((item) => (
            <div key={item.id} className="card">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  {item.productName ?? "Ürün bilgisi yok"} · {dateFormatter.format(item.createdAt)}
                  {item.orderNumber ? ` · Sipariş ${item.orderNumber}` : ""}
                  {item.orderStatusAtClassify ? ` · ${item.orderStatusAtClassify}` : ""}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span className="badge">{CATEGORY_LABELS[item.category]}</span>
                  <span className="badge">{item.team}</span>
                  <span className={PRIORITY_BADGE[item.priority] ?? "badge"}>{PRIORITY_LABELS[item.priority]}</span>
                  <span className="badge">{STATUS_LABELS[item.status] ?? item.status}</span>
                </div>
              </div>

              <p style={{ margin: "8px 0" }}>{item.questionText}</p>

              {item.reasons.length > 0 ? (
                <details style={{ fontSize: 13, marginBottom: 8 }}>
                  <summary style={{ cursor: "pointer" }} className="muted">
                    Sınıflandırma gerekçesi
                  </summary>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {item.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {item.orderMatch && item.orderMatch !== "MATCHED" ? (
                <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
                  Sipariş eşleşmesi doğrulanmadı ({item.orderMatch}); kişisel sipariş detayı gösterilmedi.
                </p>
              ) : null}

              {item.draftText ? (
                <details open style={{ marginBottom: 8 }}>
                  <summary style={{ cursor: "pointer", fontSize: 13 }}>AI cevap taslağı</summary>
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      fontFamily: "inherit",
                      background: "var(--card)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: 10,
                      margin: "6px 0 0",
                      fontSize: 13,
                    }}
                  >
                    {item.draftText}
                  </pre>
                </details>
              ) : null}

              {item.sources.length > 0 ? (
                <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
                  Kaynaklar:{" "}
                  {item.sources.map((source) => `${source.label}${source.at ? ` (${dateFormatter.format(new Date(source.at))})` : ""}`).join(" | ")}
                </p>
              ) : null}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
                {item.status === "NEW" ? (
                  <form action={startReviewAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <button type="submit" className="btn">
                      İncelemeye al
                    </button>
                  </form>
                ) : null}

                {item.status === "IN_REVIEW" ? (
                  <>
                    <form action={approveAction}>
                      <input type="hidden" name="id" value={item.id} />
                      <button type="submit" className="btn">
                        Onayla
                      </button>
                    </form>
                    <form action={rejectAction}>
                      <input type="hidden" name="id" value={item.id} />
                      <button type="submit" className="btn">
                        Reddet
                      </button>
                    </form>
                  </>
                ) : null}

                {item.status === "APPROVED" || item.status === "REJECTED" ? (
                  <form action={completeAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <button type="submit" className="btn">
                      Tamamla
                    </button>
                  </form>
                ) : null}

                {item.team === "Atölye" ? (
                  <form action={stageAction} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="hidden" name="id" value={item.id} />
                    <select name="stage" defaultValue={item.productionStage ?? "NOT_STARTED"}>
                      {Object.entries(STAGE_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="btn">
                      Aşamayı kaydet
                    </button>
                  </form>
                ) : null}

                {item.closedAt ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Kapandı: {dateFormatter.format(item.closedAt)}
                  </span>
                ) : null}
              </div>

              {item.events.length > 0 ? (
                <details style={{ marginTop: 10, fontSize: 12 }}>
                  <summary style={{ cursor: "pointer" }} className="muted">
                    İşlem geçmişi ({item.events.length})
                  </summary>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {item.events.map((event) => (
                      <li key={`${event.action}-${event.createdAt.toISOString()}`}>
                        {event.action} · {event.actor} ({event.role}) · {dateFormatter.format(event.createdAt)}
                        {event.note ? ` · ${event.note}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="card muted" style={{ fontSize: 12 }}>
        Yetkilendirme notu: bu sürümde gerçek kullanıcı/rol altyapısı yok. Panel tek paylaşımlı anahtarla açılıyor ve
        oturum ADMIN sayılıyor; atölye onayı servis katmanında rol kontrolünden geçiyor (SUPPORT rolü onay veremez).
        Çok kullanıcılı rol yönetimi bir sonraki adımdır.
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px" }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}
