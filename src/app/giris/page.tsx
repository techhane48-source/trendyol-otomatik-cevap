export const dynamic = "force-dynamic";

const HATA_MESAJLARI: Record<string, string> = {
  "1": "Erişim anahtarı hatalı. Tekrar deneyin.",
  "2": "Sunucuda APP_ACCESS_TOKEN tanımlı değil. Anahtar olmadan panele erişilemez.",
};

/**
 * Panel giriş ekranı.
 *
 * Çok kullanıcılı kimlik doğrulama yoktur: paylaşılan erişim anahtarı (APP_ACCESS_TOKEN)
 * çerez olarak kurulur. Anahtar yalnızca sunucuda doğrulanır, sayfaya yazılmaz.
 */
export default async function GirisPage({
  searchParams,
}: {
  searchParams: Promise<{ hata?: string }>;
}) {
  const params = await searchParams;
  const hata = params.hata ? HATA_MESAJLARI[params.hata] ?? HATA_MESAJLARI["1"] : null;

  return (
    <main style={{ maxWidth: 380, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 18, marginBottom: 6 }}>Trendyol Soru Asistanı</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginTop: 0 }}>
        Devam etmek için erişim anahtarını girin.
      </p>

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
        <label htmlFor="token" style={{ display: "block", fontSize: 12.5, marginBottom: 4 }}>
          Erişim anahtarı
        </label>
        <input
          id="token"
          name="token"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          style={{ width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: 6, border: "1px solid #bbb" }}
        />
        <button
          type="submit"
          style={{
            marginTop: 12,
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

      <p style={{ fontSize: 11.5, opacity: 0.6, marginTop: 16, lineHeight: 1.5 }}>
        Anahtar <code>.env</code> dosyasındaki <code>APP_ACCESS_TOKEN</code> değeridir. Bu değer çerez olarak 12 saat
        saklanır; <a href="/api/giris?cikis=1">çıkış</a> ile silinir.
      </p>
    </main>
  );
}
