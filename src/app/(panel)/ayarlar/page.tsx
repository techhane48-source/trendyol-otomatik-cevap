import { requireUser } from "@/lib/auth/session";
import { getStoreSettings } from "@/lib/store/settings";
import { saveSettingsAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AyarlarPage() {
  const user = await requireUser(["OWNER", "ADMIN"]);
  const settings = await getStoreSettings(user.storeId);
  const rule = settings.orderRules?.changeRequest ?? null;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>Trendyol bağlantısı</h2>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
            Her mağaza kendi satıcı hesabıyla çalışır; bağlantı bilgileri şifreli saklanır.
          </p>
        </div>
        <a href="/ayarlar/entegrasyonlar" className="btn">
          Entegrasyonları yönet
        </a>
      </div>

      <div className="card">
        <h2 style={{ margin: 0, fontSize: 16 }}>Mağaza ayarları</h2>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
          {user.storeName ?? "Mağaza"} · Buradaki yapılandırma yalnızca bu mağazayı etkiler.
        </p>
      </div>

      <form action={saveSettingsAction} style={{ display: "grid", gap: 16 }}>
        <div className="card" style={{ display: "grid", gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>Modüller</h3>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Kapatılan modüller menüde gizlenir; verileri silinmez.
          </p>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" name="showcase" defaultChecked={settings.modules.showcase} /> Vitrin / ürün kartları
          </label>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" name="catalog" defaultChecked={settings.modules.catalog} /> Katalog ve ürün bilgi bankası
          </label>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" name="changeRequests" defaultChecked={settings.modules.changeRequests} /> Ölçü / işlem değişiklik talepleri
          </label>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" name="workQueue" defaultChecked={settings.modules.workQueue} /> İş kuyruğu
          </label>
        </div>

        <div className="card" style={{ display: "grid", gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>İş kuyruğu kategorileri</h3>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Kategori yapısı sabittir; etiket ve sorumlu ekip mağazaya özel değiştirilebilir. Sektör terimleri (ör.
            “atölye”) varsayılan değildir.
          </p>
          <table style={{ fontSize: 13, width: "100%" }}>
            <thead className="muted">
              <tr>
                <th align="left">Kategori</th>
                <th align="left">Etiket</th>
                <th align="left">Sorumlu ekip</th>
              </tr>
            </thead>
            <tbody>
              {settings.workflow.map((entry) => (
                <tr key={entry.category}>
                  <td>{entry.category}</td>
                  <td>
                    <input name={`label_${entry.category}`} defaultValue={entry.label} style={{ width: "100%" }} />
                  </td>
                  <td>
                    <input name={`team_${entry.category}`} defaultValue={entry.team} style={{ width: "100%" }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ display: "grid", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>İşlem talep türleri</h3>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Her satır <code>anahtar|etiket</code> biçiminde. Örnek: <code>measure_change|Ölçü değişikliği</code>.
          </p>
          <textarea
            name="requestTypes"
            rows={Math.max(3, settings.requestTypes.length + 1)}
            defaultValue={settings.requestTypes.map((type) => `${type.key}|${type.label}`).join("\n")}
            style={{ fontFamily: "monospace", fontSize: 13 }}
          />
        </div>

        <div className="card" style={{ display: "grid", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>Sipariş değişiklik kuralı</h3>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Boş bırakılırsa kural uygulanmaz (genel davranış). Durumlar virgülle yazılır. Karar her talep anında
            siparişin güncel durumuyla yeniden verilir.
          </p>
          <label style={{ fontSize: 13 }}>
            İzin verilen durumlar
            <input
              name="allowedStatuses"
              defaultValue={rule?.allowedStatuses.join(", ") ?? ""}
              placeholder="Örn: Created"
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ fontSize: 13 }}>
            Kapalı durumlar
            <input
              name="blockedStatuses"
              defaultValue={rule?.blockedStatuses.join(", ") ?? ""}
              placeholder="Örn: Picking, Shipped, Delivered, Cancelled"
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ fontSize: 13 }}>
            Tanımsız durumda
            <select name="unknownDecision" defaultValue={rule?.unknown ?? "HUMAN_REVIEW"}>
              <option value="HUMAN_REVIEW">İnsan incelemesi</option>
              <option value="DENY">Reddet</option>
              <option value="ALLOW">İzin ver</option>
            </select>
          </label>
        </div>

        <div>
          <button type="submit" className="btn btn-primary">
            Ayarları kaydet
          </button>
        </div>
      </form>
    </div>
  );
}
