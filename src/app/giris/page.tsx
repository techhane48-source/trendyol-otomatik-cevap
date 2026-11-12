import { legacyLoginAllowed } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const HATA_MESAJLARI: Record<string, string> = {
  "1": "E-posta veya şifre hatalı. Tekrar deneyin.",
  "2": "Sunucuda APP_ACCESS_TOKEN tanımlı değil. Anahtar olmadan panele erişilemez.",
  "3": "Çok fazla başarısız deneme. 15 dakika sonra tekrar deneyin.",
  "4": "Bu hesap devre dışı bırakılmış. Mağaza yöneticisine başvurun.",
  "5": "Eski erişim anahtarı kapatıldı. Lütfen e-posta ve şifre ile giriş yapın.",
};

/**
 * Panel giriş ekranı (GÖREV 018).
 *
 * Asıl yol e-posta + şifre ile kullanıcı oturumudur. Geçiş dönemi için eski
 * paylaşımlı anahtar da (APP_ACCESS_TOKEN) kabul edilir; kaldırılınca bu alan
 * kendiliğinden çalışmaz hale gelir.
 */
export default async function GirisPage({ searchParams }: { searchParams: Promise<{ hata?: string }> }) {
  const params = await searchParams;
  const hata = params.hata ? HATA_MESAJLARI[params.hata] ?? HATA_MESAJLARI["1"] : null;
  const allowLegacy = await legacyLoginAllowed();

  return (
    <main style={{ maxWidth: 380, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 18, marginBottom: 6 }}>Trendyol Soru Asistanı</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginTop: 0 }}>Mağaza hesabınızla giriş yapın.</p>

      {hata ? (
        <p
          role="alert"
          style={{
            fontSize: 13,
            padding: "8px 10px",
            border: "1px solid #b91c1c",
            borderRadius: 6,
            color: "#7f1d1d",
            marginBottom: 12,
          }}
        >
          {hata}
        </p>
      ) : null}

      <form action="/api/giris" method="post">
        <label htmlFor="email" style={{ display: "block", fontSize: 12.5, marginBottom: 4 }}>
          E-posta
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          style={{ width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: 6, border: "1px solid #bbb" }}
        />

        <label htmlFor="password" style={{ display: "block", fontSize: 12.5, margin: "10px 0 4px" }}>
          Şifre
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
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
          Giriş yap
        </button>
      </form>

      {allowLegacy ? (
      <details style={{ marginTop: 18, fontSize: 12, opacity: 0.8 }}>
        <summary style={{ cursor: "pointer" }}>Eski erişim anahtarıyla giriş (geçiş dönemi)</summary>
        <p style={{ margin: "8px 0" }}>
          Kullanıcı hesabı olmayan kurulumlarda paylaşımlı anahtar geçici olarak çalışmaya devam eder. Anahtar
          kaldırıldığında bu yol kapanır.
        </p>
        <form action="/api/giris" method="post">
          <label htmlFor="token" style={{ display: "block", fontSize: 12.5, marginBottom: 4 }}>
            Erişim anahtarı
          </label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            style={{ width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: 6, border: "1px solid #bbb" }}
          />
          <button type="submit" style={{ marginTop: 8, padding: "7px 10px", fontSize: 13, borderRadius: 6, cursor: "pointer" }}>
            Anahtarla giriş
          </button>
        </form>
      </details>
      ) : null}

      <p style={{ fontSize: 11.5, opacity: 0.6, marginTop: 16, lineHeight: 1.5 }}>
        İlk kurulumda mağaza sahibi hesabı <a href="/kurulum">kurulum ekranından</a> oluşturulur. Oturum 7 gün
        geçerlidir; 12 saat hareketsizlikte kapanır.
      </p>
    </main>
  );
}
