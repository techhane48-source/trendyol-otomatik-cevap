import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Trendyol Soru Asistanı",
  description: "Trendyol müşteri sorularını okuyan ve kaydeden salt okunur panel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>
        <div className="shell">
          <header className="topbar">
            <span className="brand">Trendyol Soru Asistanı</span>
            <nav>
              <a href="/questions">Sorular</a>
              <a href="/api/health">Sağlık</a>
            </nav>
          </header>
          <main>{children}</main>
          <footer className="footer">
            Faz 1 — salt okunur. Cevap gönderme özelliği bilinçli olarak yok.
          </footer>
        </div>
      </body>
    </html>
  );
}
