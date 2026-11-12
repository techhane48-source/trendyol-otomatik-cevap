import { requireUser } from "@/lib/auth/session";
import { listUsers, ROLE_LABELS } from "@/lib/auth/users";
import { createUserAction, resetPasswordAction, updateUserAction } from "./actions";

export const dynamic = "force-dynamic";

const HATALAR: Record<string, string> = {
  weak_password: "Şifre en az 10 karakter olmalı ve harf ile rakam içermeli.",
  invalid_email: "Geçerli bir e-posta adresi girin.",
  email_taken: "Bu e-posta zaten kayıtlı.",
  last_owner: "Mağazanın son sahibi rolü düşürülemez veya kapatılamaz.",
  not_found: "Kullanıcı bulunamadı.",
  error: "İşlem tamamlanamadı.",
};

const dateFormatter = new Intl.DateTimeFormat("tr-TR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Istanbul" });

export default async function KullanicilarPage({ searchParams }: { searchParams: Promise<{ hata?: string }> }) {
  const user = await requireUser(["OWNER", "ADMIN"]);
  const params = await searchParams;
  const hata = params.hata ? HATALAR[params.hata] ?? HATALAR.error : null;
  const users = await listUsers(user.storeId);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h2 style={{ margin: 0, fontSize: 16 }}>Kullanıcılar</h2>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
          {user.storeName ?? "Mağaza"} · Yalnızca bu mağazanın kullanıcıları listelenir. Şifreler bcrypt ile saklanır.
        </p>
        {hata ? (
          <p style={{ marginTop: 10, fontSize: 13, color: "#b91c1c" }} role="alert">
            {hata}
          </p>
        ) : null}
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <thead className="muted">
            <tr>
              <th align="left">E-posta</th>
              <th align="left">Ad</th>
              <th align="left">Rol</th>
              <th align="left">Durum</th>
              <th align="left">Son giriş</th>
              <th align="left">İşlem</th>
            </tr>
          </thead>
          <tbody>
            {users.map((entry) => (
              <tr key={entry.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 4px" }}>{entry.email}</td>
                <td style={{ padding: "8px 4px" }}>{entry.name ?? "—"}</td>
                <td style={{ padding: "8px 4px" }}>
                  <form action={updateUserAction} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="hidden" name="userId" value={entry.id} />
                    <select name="role" defaultValue={entry.role}>
                      {Object.entries(ROLE_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
                      <input type="checkbox" name="active" defaultChecked={entry.active} /> aktif
                    </label>
                    <button type="submit" className="btn">
                      Kaydet
                    </button>
                  </form>
                </td>
                <td style={{ padding: "8px 4px" }}>{entry.active ? "Aktif" : "Kapalı"}</td>
                <td style={{ padding: "8px 4px" }}>{entry.lastLoginAt ? dateFormatter.format(entry.lastLoginAt) : "—"}</td>
                <td style={{ padding: "8px 4px" }}>
                  <form action={resetPasswordAction} style={{ display: "flex", gap: 6 }}>
                    <input type="hidden" name="userId" value={entry.id} />
                    <input name="password" type="password" placeholder="Yeni şifre" style={{ width: 140 }} />
                    <button type="submit" className="btn">
                      Sıfırla
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ display: "grid", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Yeni kullanıcı</h3>
        <form action={createUserAction} style={{ display: "grid", gap: 8, maxWidth: 420 }}>
          <input name="name" placeholder="Ad soyad" />
          <input name="email" type="email" placeholder="E-posta" required />
          <input name="password" type="password" placeholder="Şifre (en az 10 karakter, harf + rakam)" required minLength={10} />
          <select name="role" defaultValue="SUPPORT">
            {Object.entries(ROLE_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-primary">
            Kullanıcı ekle
          </button>
        </form>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Yeni kullanıcıya şifre bu ekrandan verilir; kullanıcı ilk girişten sonra kendi şifresini yöneticiden
          isteyebilir. Şifreler hiçbir yerde düz metin saklanmaz.
        </p>
      </div>
    </div>
  );
}
