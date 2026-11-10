import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Trendyol Soru Asistanı — Yönetim Paneli",
  description:
    "Trendyol müşteri soruları, AI cevap taslakları, sipariş ölçü talepleri ve ürün bilgi bankası yönetim paneli",
};

/**
 * Kök layout yalnızca kabuk görevini üstlenir (html/body + tema başlatma).
 * Panelin kendi yerleşimi `(panel)/layout.tsx` içindedir; `/giris` sade düzenini korur.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr" suppressHydrationWarning>
      <head>
        {/* Tema ilk boyamada uygulanır: koyu modda beyaz parlama olmaz. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var t=localStorage.getItem("panel-theme");document.documentElement.dataset.theme=t==="dark"?"dark":"light";}catch(e){document.documentElement.dataset.theme="light";}})();',
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
