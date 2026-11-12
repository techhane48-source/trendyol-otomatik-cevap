import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 24 }}>
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Bu işlem için yetkiniz yok</h1>
        <p style={{ fontSize: 14, opacity: 0.75, marginTop: 8 }}>
          Bu sayfa mağaza sahibi (OWNER) veya yönetici (ADMIN) rolü gerektirir. Yetki gerekiyorsa mağaza sahibinizle
          görüşün.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link href="/" className="btn">
            Panele dön
          </Link>
        </p>
      </div>
    </main>
  );
}
