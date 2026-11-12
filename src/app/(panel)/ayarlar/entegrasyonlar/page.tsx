import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { getIntegrationView } from "@/lib/integrations/service";
import {
  disableIntegrationAction,
  enableIntegrationAction,
  saveIntegrationAction,
  testIntegrationAction,
} from "./actions";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("tr-TR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Istanbul" });

const STATUS: Record<string, { label: string; className: string }> = {
  UNCONFIGURED: { label: "Yapılandırılmadı / test bekliyor", className: "badge" },
  CONNECTED: { label: "Bağlı", className: "badge" },
  ERROR: { label: "Hata", className: "badge waiting" },
  DISABLED: { label: "Devre dışı", className: "badge" },
};

const ERRORS: Record<string, string> = {
  encryption_key_missing: "Şifreleme anahtarı tanımlı değil. Sunucuda INTEGRATION_ENCRYPTION_KEY ayarlanmalı.",
  invalid_seller_id: "Satıcı ID yalnızca rakamlardan oluşmalı (4-12 hane).",
  invalid_credentials: "API anahtarı ve gizli anahtar en az 8 karakter olmalı.",
  baglanti_basarisiz: "Bağlantı doğrulanamadı. Bilgileri kontrol edin; durum ERROR olarak kaydedildi.",
  error: "İşlem tamamlanamadı.",
};

const OK: Record<string, string> = {
  kaydedildi: "Bağlantı bilgileri şifreli olarak kaydedildi. Test etmeden bağlı sayılmaz.",
  "baglanti-dogrulandi": "Trendyol bağlantısı salt okunur istekle doğrulandı.",
  "devre-disi": "Bağlantı devre dışı bırakıldı; senkronizasyon bu mağazada çalışmaz.",
  etkin: "Bağlantı yeniden etkinleştirildi; test etmeniz önerilir.",
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ ok?: string; hata?: string }> }) {
  const user = await requireUser(["OWNER", "ADMIN"]);
  const params = await searchParams;
  const view = await getIntegrationView(user.storeId);

  const okMessage = params.ok ? OK[params.ok] ?? "İşlem tamamlandı." : null;
  const errorMessage = params.hata ? ERRORS[params.hata] ?? ERRORS.error : null;
  const status = STATUS[view?.status ?? "UNCONFIGURED"];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h2 style={{ margin: 0, fontSize: 16 }}>Trendyol bağlantısı</h2>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
          {user.storeName ?? "Mağaza"} · Her mağaza yalnızca kendi satıcı hesabını kullanır. Sırlar AES-256-GCM ile
          şifreli saklanır ve panelde maskelenir.
        </p>

        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          <span className={status.className}>{status.label}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            Satıcı ID: {view?.sellerId || "—"}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            Son kontrol: {view?.lastCheckAt ? dateFormatter.format(view.lastCheckAt) : "—"}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            Son başarılı: {view?.lastSuccessAt ? dateFormatter.format(view.lastSuccessAt) : "—"}
          </span>
        </div>

        {view?.lastError ? (
          <p style={{ fontSize: 12, color: "#b91c1c", margin: "8px 0 0" }}>Son hata: {view.lastError}</p>
        ) : null}

        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          API anahtarı: {view?.apiKeyMasked ?? "—"} · API secret: {view?.apiSecretMasked ?? "—"}
          {view && !view.encryptionReady ? " · Şifreleme anahtarı yok: kaydetme ve çözme kapalı." : ""}
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: 0, fontSize: 14 }}>Senkronizasyon durumu</h3>
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
          Son senkron: {view?.lastSyncAt ? dateFormatter.format(view.lastSyncAt) : "—"}
          {view?.lastSyncStatus ? ` · ${view.lastSyncStatus}` : ""}
          {view?.lastSyncError ? ` · ${view.lastSyncError}` : ""}
        </p>
      </div>

      {okMessage ? (
        <div className="card" style={{ fontSize: 13 }}>
          {okMessage}
        </div>
      ) : null}
      {errorMessage ? (
        <div className="card" style={{ fontSize: 13, color: "#b91c1c" }}>
          {errorMessage}
        </div>
      ) : null}

      <form action={saveIntegrationAction} className="card" style={{ display: "grid", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Bağlantı bilgileri</h3>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Var olan gizli değerler tekrar gösterilmez. Boş bırakma yoktur; güncelleme için tüm alanları yeniden girin.
        </p>
        <label style={{ fontSize: 13 }}>
          Trendyol Satıcı ID
          <input name="sellerId" defaultValue={view?.sellerId ?? ""} placeholder="ör. 1081168" required style={{ width: "100%" }} />
        </label>
        <label style={{ fontSize: 13 }}>
          API Key
          <input name="apiKey" type="password" autoComplete="off" required style={{ width: "100%" }} />
        </label>
        <label style={{ fontSize: 13 }}>
          API Secret
          <input name="apiSecret" type="password" autoComplete="off" required style={{ width: "100%" }} />
        </label>
        <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>
          Şifreli kaydet
        </button>
      </form>

      <div className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <form action={testIntegrationAction}>
          <button type="submit" className="btn">
            Bağlantıyı test et (salt okunur)
          </button>
        </form>
        {view?.status === "DISABLED" ? (
          <form action={enableIntegrationAction}>
            <button type="submit" className="btn">
              Yeniden etkinleştir
            </button>
          </form>
        ) : (
          <form action={disableIntegrationAction}>
            <button type="submit" className="btn">
              Bağlantıyı devre dışı bırak
            </button>
          </form>
        )}
      </div>

      <div className="card muted" style={{ fontSize: 12 }}>
        Güvenlik notu: API Secret hiçbir yanıtta, logda veya panelde açık gösterilmez. Şifreleme anahtarı
        <code> INTEGRATION_ENCRYPTION_KEY </code> ortam değişkenindedir; veritabanında tutulmaz. Anahtar yoksa
        kaydetme ve çözme işlemleri güvenli biçimde başarısız olur.
      </div>
    </div>
  );
}
