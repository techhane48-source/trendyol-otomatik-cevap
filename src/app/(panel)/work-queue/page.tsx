import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { getStoreSettings } from "@/lib/store/settings";
import { getWorkMetrics, listWorkItems } from "@/lib/work-queue/service";
import { PRIORITY_LABELS, STAGE_LABELS, STATUS_LABELS } from "@/lib/work-queue/classify";
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
  const user = await requireUser();
  const settings = await getStoreSettings(user.storeId);

  if (!settings.modules.workQueue) {
    return (
      <div className="panel-card">
        <h2 className="panel-title mb-2">İş kuyruğu kapalı</h2>
        <p className="panel-muted">Bu modül mağaza ayarlarından kapatılmış. Açmak için yöneticiye başvurun.</p>
      </div>
    );
  }

  const params = await searchParams;
  const [items, metrics] = await Promise.all([
    listWorkItems(user.storeId, {
      category: params.category,
      status: params.status,
      priority: params.priority,
      team: params.team,
      search: params.q,
    }),
    getWorkMetrics(user.storeId),
  ]);

  const labelOf = (category: string) =>
    settings.workflow.find((entry) => entry.category === category)?.label ??
    (category === "SUPPORT" ? "İnsan incelemesi" : category === "WORKSHOP" ? "İşlem talebi" : category);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>Akıllı iş kuyruğu</h2>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
              {user.storeName ?? "Mağaza"} · Sorular mağazanın kategori yapılandırmasına göre sınıflandırılır. Onay/ret
              yalnızca yetkili rolle yapılır; AI kendi kendine onay veremez.
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
          <Metric label="İnsan incelemesi" value={metrics.support} />
          <Metric label="İşlem talebi" value={metrics.workshop} />
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
            {settings.workflow.map((entry) => (
              <option key={entry.category} value={entry.category}>
                {entry.label}
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
            {[...new Set(settings.workflow.map((entry) => entry.team))].map((team) => (
              <option key={team} value={team}>
                {team}
              </option>
            ))}
          </select>
          <button type="submit" className="btn">
            Filtrele
          </button>
        </form>
      </div>

      {items.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>Kayıt yok. “Kuyruğu yenile” ile mevcut sorulardan iş kayıtları oluşturun.</p>
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
                  <span className="badge">{labelOf(item.category)}</span>
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
                  {item.sources
                    .map((source) => `${source.label}${source.at ? ` (${dateFormatter.format(new Date(source.at))})` : ""}`)
                    .join(" | ")}
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

                {item.category === "ACTION_REQUEST" || item.category === "WORKSHOP" ? (
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
        Yetkilendirme: OWNER/ADMIN onay ve üretim aşaması değiştirebilir; SUPPORT yalnızca incelemeye alabilir. Tüm
        işlemler mağaza kapsamında ve işlem geçmişinde kayıtlıdır.
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
