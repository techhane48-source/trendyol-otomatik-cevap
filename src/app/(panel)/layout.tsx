import Link from "next/link";
import { cookies } from "next/headers";

import { PanelChrome } from "@/components/panel/panel-chrome";
import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getPrisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Panel yerleşimi: tek yerde erişim kapısı + ortak kabuk.
 * Yetkisiz istekte sayfa içeriği hiç render edilmez; yalnızca giriş yönlendirmesi görünür.
 */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const access = checkAccess(cookieStore.get(ACCESS_COOKIE_NAME)?.value);

  if (!access.ok) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface px-4">
        <div className="panel-card w-full max-w-md text-center">
          <h1 className="mb-2 text-lg font-semibold text-ink">Erişim gerekli</h1>
          <p className="mb-5 text-sm text-subtle">
            {access.status === 503
              ? "Panel erişim anahtarı tanımlı değil. Sunucu yöneticisi APP_ACCESS_TOKEN değişkenini ayarlamalı."
              : "Bu paneli görüntülemek için erişim anahtarıyla giriş yapın."}
          </p>
          <Link href="/giris" className="btn btn-primary">
            Giriş ekranına git
          </Link>
        </div>
      </div>
    );
  }

  let pendingDrafts = 0;
  try {
    const prisma = getPrisma();
    pendingDrafts = await prisma.answerDraft.count({
      where: { status: { in: ["PENDING", "NEEDS_INFO"] } },
    });
  } catch {
    // Veritabanı erişilemezse rozet gösterilmez; kabuk yine çalışır.
  }

  return <PanelChrome pendingBadge={pendingDrafts}>{children}</PanelChrome>;
}
