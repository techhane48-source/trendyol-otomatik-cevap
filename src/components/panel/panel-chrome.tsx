"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
  IconBox,
  IconChart,
  IconChat,
  IconClose,
  IconDashboard,
  IconDatabase,
  IconHistory,
  IconMenu,
  IconPolicy,
  IconQueue,
  IconRuler,
  IconSettings,
  IconSparkles,
} from "./icons";
import { ThemeToggle } from "./theme-toggle";

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  soon?: boolean;
}

const NAV_SECTIONS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "Panel",
    items: [
      { label: "Genel Bakış", href: "/", icon: IconDashboard },
      { label: "Müşteri Soruları", href: "/questions", icon: IconChat },
      { label: "AI Cevap Taslakları", href: "/drafts", icon: IconSparkles },
    ],
  },
  {
    title: "Operasyon",
    items: [
      { label: "Siparişler", href: "/orders", icon: IconBox },
      { label: "İş Kuyruğu", href: "/work-queue", icon: IconQueue },
      { label: "Ölçü Değişiklik Talepleri", href: "/change-requests", icon: IconRuler },
      { label: "Ürün Bilgi Bankası", href: "/product-bank", icon: IconDatabase },
      { label: "Mağaza Politikaları", href: "/policies", icon: IconPolicy },
    ],
  },
  {
    title: "Bilgi",
    items: [
      { label: "Geçmiş Cevaplar", href: "/answers", icon: IconHistory },
      { label: "Kalite ve Performans", href: "/quality", icon: IconChart },
      { label: "Ayarlar", href: "/ayarlar", icon: IconSettings, soon: true },
    ],
  },
];

const TITLES: Record<string, { title: string; subtitle: string }> = {
  "/": { title: "Genel Bakış", subtitle: "Mağazanın soru, taslak ve ürün bilgisi durumu" },
  "/questions": { title: "Müşteri Soruları", subtitle: "Trendyol'dan salt okunur çekilen sorular" },
  "/drafts": { title: "AI Cevap Taslakları", subtitle: "İnsan onayı bekleyen cevap taslakları" },
  "/orders": { title: "Siparişler", subtitle: "Sipariş arama ve ölçü değişikliği incelemesi" },
  "/change-requests": { title: "Ölçü Değişiklik Talepleri", subtitle: "Üretim onayı bekleyen ölçü talepleri" },
  "/product-bank": { title: "Ürün Bilgi Bankası", subtitle: "Katalogdan otomatik çıkarılan ürün bilgileri" },
  "/work-queue": { title: "İş Kuyruğu", subtitle: "Soruları sınıflandır, ekibe yönlendir, sonuçlandır" },
  "/policies": { title: "Mağaza Politikaları", subtitle: "Ürün bilgisinden ayrı işletme kuralları (özel ölçü, dikim, fiyat)" },
  "/answers": { title: "Geçmiş Cevaplar", subtitle: "Geçmiş satıcı cevaplarının inceleme durumu" },
  "/quality": { title: "Kalite ve Performans", subtitle: "AI kalite ölçümleri ve maliyet" },
};

/**
 * Panel kabuğu: sabit sol menü, üst bar, tema anahtarı ve mobil çekmece.
 * Yalnızca yerleşim ve gezinme sağlar; hiçbir veri işlemi yapmaz.
 */
export function PanelChrome({ pendingBadge, children }: { pendingBadge?: number; children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const meta = TITLES[pathname] ?? { title: "Yönetim Paneli", subtitle: "" };
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  const nav = (
    <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 pb-6">
      {NAV_SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">{section.title}</p>
          <ul className="space-y-1">
            {section.items.map((item) => {
              const Icon = item.icon;

              if (item.soon) {
                return (
                  <li key={item.href}>
                    <span className="nav-link cursor-not-allowed opacity-55" aria-disabled="true">
                      <Icon />
                      <span className="flex-1">{item.label}</span>
                      <span className="chip text-[10px]">yakında</span>
                    </span>
                  </li>
                );
              }

              return (
                <li key={item.href}>
                  <Link href={item.href} className={`nav-link ${isActive(item.href) ? "nav-link-active" : ""}`}>
                    <Icon />
                    <span className="flex-1">{item.label}</span>
                    {item.href === "/drafts" && pendingBadge ? (
                      <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                        {pendingBadge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-surface">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[280px] flex-col border-r border-line bg-[var(--sidebar)] lg:flex">
        <div className="px-5 py-5">
          <Brand />
        </div>
        {nav}
        <div className="border-t border-line px-5 py-4 text-[11px] leading-relaxed text-subtle">
          Salt okunur mod. Trendyol'a cevap gönderilmez, sipariş değiştirilmez.
        </div>
      </aside>

      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/45" onClick={() => setOpen(false)} aria-hidden="true" />
          <aside className="absolute inset-y-0 left-0 flex w-[286px] flex-col border-r border-line bg-[var(--sidebar)]">
            <div className="flex items-center justify-between px-4 py-4">
              <Brand />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn btn-ghost h-9 w-9 justify-center p-0"
                aria-label="Menüyü kapat"
              >
                <IconClose />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-[280px]">
        <header className="sticky top-0 z-20 border-b border-line bg-[var(--sidebar)]/95 backdrop-blur">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="btn btn-ghost h-10 w-10 justify-center p-0 lg:hidden"
              aria-label="Menüyü aç"
            >
              <IconMenu />
            </button>

            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold text-ink sm:text-lg">{meta.title}</h1>
              {meta.subtitle ? <p className="hidden truncate text-xs text-subtle sm:block">{meta.subtitle}</p> : null}
            </div>

            <ThemeToggle />

            <Link href="/api/giris?cikis=1" className="btn btn-ghost hidden sm:inline-flex" title="Oturumu kapat">
              Çıkış
            </Link>
          </div>
        </header>

        <main className="px-4 py-6 sm:px-6 lg:px-8">{children}</main>

        <footer className="border-t border-line px-4 py-5 text-xs text-subtle sm:px-6 lg:px-8">
          Tasarım &amp; Geliştirme: Ümit Aslan · Faz 1 — salt okunur panel
        </footer>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-sm font-bold text-white">
        TA
      </span>
      <span>
        <span className="block text-sm font-semibold leading-tight text-ink">Trendyol Soru Asistanı</span>
        <span className="block text-[11px] leading-tight text-subtle">Yönetim Paneli</span>
      </span>
    </Link>
  );
}
