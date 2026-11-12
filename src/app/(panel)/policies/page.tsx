import { cookies } from "next/headers";

import { requireUser } from "@/lib/auth/session";
import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getPrisma } from "@/lib/prisma";
import { POLICY_DEFS, getPolicyContext } from "@/lib/policies/service";
import { savePolicyAction, unverifyPolicyAction, verifyPolicyAction } from "./actions";

export const dynamic = "force-dynamic";

const OK_MESSAGES: Record<string, string> = {
  kaydedildi: "Politika kaydedildi. Metin değiştiği için doğrulama düştü; onaylamadan AI kesin bilgi olarak kullanmaz.",
  "degisiklik-yok": "Değişiklik yok.",
  dogrulandi: "Politika doğrulandı; artık AI bu kuralı kesin bilgi olarak kullanabilir.",
  "dogrulama-kaldirildi": "Doğrulama kaldırıldı; politika artık AI'ya kesin bilgi olarak girmez.",
};

const ERROR_MESSAGES: Record<string, string> = {
  yetkisiz: "Erişim gerekli.",
  kaydedilemedi: "Politika kaydedilemedi.",
  dogrulanamadi: "İşlem tamamlanamadı.",
};

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

/**
 * Mağaza Politikaları (GÖREV 012).
 *
 * Ürün bilgisinden ayrı katman: özel ölçü kabulü, ölçü aralıkları, dikim/aksesuar,
 * sipariş sonrası değişiklik, fiyat-kampanya ve kargo kuralları. Metinler yalnızca
 * satıcı tarafından yazılır; doğrulanmadan AI'ya kesin bilgi olarak girmez.
 */
export default async function PoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; hata?: string; key?: string }>;
}) {
  const cookieStore = await cookies();
  const access = checkAccess(cookieStore.get(ACCESS_COOKIE_NAME)?.value);
  const params = await searchParams;

  const prisma = getPrisma();
  const currentUser = await requireUser();
  const store = await prisma.store.findUnique({ where: { id: currentUser.storeId } });

  if (!access.ok || !store) {
    return (
      <div className="panel-card">
        <h2 className="panel-title mb-2">{store ? "Erişim gerekli" : "Mağaza kaydı yok"}</h2>
        <p className="panel-muted">
          {store ? "Bu sayfayı görmek için giriş yapın." : "Önce senkronizasyon çalıştırılarak mağaza bilgisi oluşturulmalı."}
        </p>
      </div>
    );
  }

  const context = await getPolicyContext({ storeId: store.id }, { prisma });
  const verifiedCount = context.verified.length;

  return (
    <div className="space-y-5">
      {params.ok && OK_MESSAGES[params.ok] ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {OK_MESSAGES[params.ok]}
        </div>
      ) : null}
      {params.hata ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          {ERROR_MESSAGES[params.hata] ?? "İşlem tamamlanamadı."}
        </div>
      ) : null}

      <section className="panel-card">
        <h2 className="panel-title">Mağaza politikaları</h2>
        <p className="panel-muted mt-1">
          Ürün bilgisinden ayrı işletme kuralları. {verifiedCount}/{POLICY_DEFS.length} politika doğrulanmış. Doğrulanmamış
          politika AI cevabında kesin bilgi olarak kullanılmaz; burada yazdığınız metin sizin onayınızı bekler.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {context.policies.map((policy) => {
          const definition = POLICY_DEFS.find((item) => item.key === policy.key);
          return (
            <section key={policy.key} className="panel-card flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink">{policy.label}</h3>
                  <p className="mt-0.5 text-xs text-subtle">{definition?.hint}</p>
                </div>
                <span
                  className={`chip border ${
                    policy.verified
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400"
                      : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400"
                  }`}
                >
                  {policy.verified ? "DOĞRULANDI" : policy.value.trim() ? "TASLAK — ONAY BEKLİYOR" : "BOŞ"}
                </span>
              </div>

              <form action={savePolicyAction} className="flex flex-col gap-2">
                <input type="hidden" name="storeId" value={store.id} />
                <input type="hidden" name="key" value={policy.key} />
                <textarea
                  name="value"
                  defaultValue={policy.value}
                  placeholder={definition?.placeholder}
                  rows={3}
                  className="field min-h-[84px] resize-y"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button className="btn btn-ghost" type="submit">
                    Kaydet
                  </button>
                  {policy.verifiedAt ? (
                    <span className="text-[11px] text-subtle">
                      {policy.verifiedBy ?? "—"} · {dateFormatter.format(policy.verifiedAt)}
                    </span>
                  ) : (
                    <span className="text-[11px] text-subtle">Onay bekliyor</span>
                  )}
                </div>
              </form>

              <div className="flex gap-2">
                {policy.value.trim() === "" ? (
                  <span className="text-xs text-subtle">Metin boş — doğrulanamaz.</span>
                ) : policy.verified ? (
                  <form action={unverifyPolicyAction}>
                    <input type="hidden" name="storeId" value={store.id} />
                    <input type="hidden" name="key" value={policy.key} />
                    <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                      Doğrulamayı kaldır
                    </button>
                  </form>
                ) : (
                  <form action={verifyPolicyAction}>
                    <input type="hidden" name="storeId" value={store.id} />
                    <input type="hidden" name="key" value={policy.key} />
                    <button className="btn btn-primary px-3 py-1.5 text-xs" type="submit">
                      Doğrula
                    </button>
                  </form>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
