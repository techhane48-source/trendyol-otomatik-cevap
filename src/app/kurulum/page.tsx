import { redirect } from "next/navigation";

import { getPrisma } from "@/lib/prisma";
import { createOwnerAction } from "./actions";

export const dynamic = "force-dynamic";

const HATALAR: Record<string, string> = {
  weak_password: "Şifre en az 10 karakter olmalı ve harf ile rakam içermeli.",
  invalid_email: "Geçerli bir e-posta adresi girin.",
  email_taken: "Bu e-posta zaten kayıtlı.",
  store: "Mağaza kaydı bulunamadı. Önce Trendyol senkronizasyonu çalıştırılmalı.",
  error: "Kurulum tamamlanamadı. Tekrar deneyin.",
};

/** İlk kurulum ekranı — yalnızca hiç kullanıcı yokken erişilir. */
export default async function KurulumPage({ searchParams }: { searchParams: Promise<{ hata?: string }> }) {
  const prisma = getPrisma();
  if ((await prisma.user.count()) > 0) redirect("/giris");

  const params = await searchParams;
  const hata = params.hata ? HATALAR[params.hata] ?? HATALAR.error : null;
  const store = await prisma.store.findFirst({ orderBy: { createdAt: "asc" } });

  return (
    <main style={{ maxWidth: 420, margin: "70px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 18, marginBottom: 6 }}>İlk kurulum</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginTop: 0 }}>
        Bu mağaza için sahip (OWNER) hesabını oluşturun. Bu ekran yalnızca bir kez kullanılabilir.
      </p>
      {store ? (
        <p style={{ fontSize: 12, opacity: 0.7 }}>
          Mağaza: <strong>{store.name ?? "isimsiz"}</strong> · Satıcı ID {store.sellerId.toString()}
        </p>
      ) : null}

      {hata ? (
        <p style={{ fontSize: 13, padding: "8px 10px", border: "1px solid #b91c1c", borderRadius: 6, color: "#7f1d1d" }}>
          {hata}
        </p>
      ) : null}

      <form action={createOwnerAction}>
        <label htmlFor="name" style={{ display: "block", fontSize: 12.5, marginBottom: 4 }}>
          Ad soyad
        </label>
        <input id="name" name="name" style={{ width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: 6, border: "1px solid #bbb" }} />

        <label htmlFor="email" style={{ display: "block", fontSize: 12.5, margin: "10px 0 4px" }}>
          E-posta
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          style={{ width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: 6, border: "1px solid #bbb" }}
        />

        <label htmlFor="password" style={{ display: "block", fontSize: 12.5, margin: "10px 0 4px" }}>
          Şifre (en az 10 karakter, harf + rakam)
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={10}
          style={{ width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: 6, border: "1px solid #bbb" }}
        />

        <button
          type="submit"
          style={{
            marginTop: 14,
            width: "100%",
            padding: "9px 12px",
            fontSize: 14,
            borderRadius: 6,
            border: "1px solid #4F46E5",
            background: "#4F46E5",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Sahip hesabını oluştur
        </button>
      </form>
    </main>
  );
}
