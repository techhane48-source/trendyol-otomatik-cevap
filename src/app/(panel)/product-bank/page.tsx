import Link from "next/link";
import { cookies } from "next/headers";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getPrisma } from "@/lib/prisma";
import { buildAutoFillPlan, labelOf, summarizePlan, type AutoFillPlan } from "@/lib/products/autofill";
import { getProductQuestionHints, listTopProducts } from "@/lib/products/bank";
import { listSuggestions } from "@/lib/products/suggestions";
import {
  acceptSuggestionAction,
  approveAutoAction,
  autoFillAction,
  generateSuggestionsAction,
  rejectSuggestionAction,
  setFieldAction,
  syncCatalogAction,
  unverifyFieldAction,
  verifyFieldAction,
  verifySelectedAction,
} from "./actions";

export const dynamic = "force-dynamic";

const OK_MESSAGES: Record<string, string> = {
  katalog: "Katalogdan ürünler çekildi.",
  otomatik: "Bilgiler taslak olarak dolduruldu.",
  onay: "Otomatik doldurulan alanlar doğrulandı.",
  "toplu-onay": "Seçilen alanlar doğrulandı.",
  "alan-kaydedildi": "Alan kaydedildi (doğrulanmadı).",
  "alan-dogrulandi": "Alan doğrulandı.",
  "alan-dogrulama-kaldirildi": "Doğrulama kaldırıldı.",
  "toplu-guncellendi": "Toplu güncelleme yapıldı.",
  "csv-iceri": "CSV içe aktarıldı.",
  "oneri-uretildi": "Geçmiş cevaplardan öneriler üretildi.",
  "oneri-kabul": "Öneri karta yazıldı (doğrulanmadı).",
  "oneri-reddedildi": "Öneri reddedildi.",
};

const ERROR_MESSAGES: Record<string, string> = {
  yetkisiz: "Erişim gerekli.",
  "secim-yok": "Doğrulanacak alan seçilmedi.",
  katalog: "Katalog çekilemedi; API erişimini kontrol edin.",
  otomatik: "Otomatik doldurma tamamlanamadı.",
};

const VERDICT_LABEL: Record<string, { text: string; className: string }> = {
  TRUSTED: { text: "GÜVENİLİR", className: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/30" },
  REVIEW: { text: "İNCELEME", className: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/30" },
  REJECT: { text: "RED", className: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-500/30" },
  EMPTY: { text: "BOŞ", className: "bg-[var(--hover)] text-subtle border-line" },
};

const SOURCE_LABEL: Record<string, string> = {
  CATALOG_ATTRIBUTE: "KATALOG",
  CATALOG_DESCRIPTION: "ÜRÜN AÇIKLAMASI",
  HISTORY_ANSWER: "GEÇMİŞ CEVAP",
  MANUAL: "ELLE",
  CSV_IMPORT: "CSV",
};

type Tab = "guvenilir" | "inceleme" | "dogrulanmis" | "bos";

function normalize(value: string): string {
  return value.toLocaleLowerCase("tr-TR");
}

export default async function ProductBankPage({
  searchParams,
}: {
  searchParams: Promise<{ main?: string; ok?: string; hata?: string; ozet?: string; durum?: string; q?: string }>;
}) {
  const cookieStore = await cookies();
  const access = checkAccess(cookieStore.get(ACCESS_COOKIE_NAME)?.value);

  const params = await searchParams;
  const prisma = getPrisma();
  const store = await prisma.store.findFirst({ orderBy: { createdAt: "asc" } });

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

  const [products, plans] = await Promise.all([
    listTopProducts({ storeId: store.id }, { prisma }),
    buildAutoFillPlan({ storeId: store.id }, { prisma }),
  ]);

  const summary = summarizePlan(plans);
  const planByMain = new Map(plans.map((plan) => [plan.productMainId, plan]));
  const tab: Tab = (["guvenilir", "inceleme", "dogrulanmis", "bos"] as Tab[]).includes(params.durum as Tab)
    ? (params.durum as Tab)
    : "guvenilir";
  const q = normalize((params.q ?? "").trim());

  const trustedRows = plans.flatMap((plan) =>
    plan.fields
      .filter((field) => field.verdict === "TRUSTED" && !field.verified && field.value)
      .map((field) => ({ plan, field })),
  );

  const visiblePlans = plans
    .filter((plan) => (q ? normalize(plan.title ?? plan.productMainId).includes(q) : true))
    .sort((a, b) => (planCount(b, tab) === 0 ? 1 : 0) - (planCount(a, tab) === 0 ? 1 : 0));

  const selectedPlan = params.main ? planByMain.get(params.main) ?? null : null;
  const hints = params.main
    ? await getProductQuestionHints({ storeId: store.id, productMainId: params.main, perCategory: 2 }, { prisma })
    : [];
  const suggestions = await listSuggestions({ storeId: store.id, status: "PENDING", limit: 60 }, { prisma });

  return (
    <div className="space-y-6">
      {params.ok && OK_MESSAGES[params.ok] ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {OK_MESSAGES[params.ok]} {params.ozet ? <span className="opacity-80">({params.ozet})</span> : null}
        </div>
      ) : null}
      {params.hata ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          {ERROR_MESSAGES[params.hata] ?? "İşlem tamamlanamadı."}
        </div>
      ) : null}

      <section className="panel-card">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="panel-title">Ürün bilgi bankası</h2>
            <p className="panel-muted mt-1">
              Katalogdan çekilen {summary.products} ürün · {trustedRows.length} güvenilir aday · {summary.verifiedKept} doğrulanmış alan
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <form action={syncCatalogAction}>
              <input type="hidden" name="storeId" value={store.id} />
              <button className="btn btn-ghost" type="submit">
                1 · Ürünleri getir
              </button>
            </form>
            <form action={autoFillAction}>
              <input type="hidden" name="storeId" value={store.id} />
              <button className="btn btn-ghost" type="submit">
                2 · Otomatik doldur
              </button>
            </form>
            <Link href="/product-bank/csv" className="btn btn-ghost" prefetch={false}>
              CSV indir
            </Link>
            <form action={generateSuggestionsAction}>
              <input type="hidden" name="storeId" value={store.id} />
              <button className="btn btn-ghost" type="submit">
                Öneri üret
              </button>
            </form>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Kpi label="Güvenilir aday" value={trustedRows.length} tone="text-emerald-600" />
          <Kpi label="İnceleme" value={summary.review} tone="text-amber-600" />
          <Kpi label="Doğrulanmış" value={summary.verifiedKept} tone="text-brand-600" />
          <Kpi label="Boş" value={summary.missing} tone="text-subtle" />
        </div>
      </section>

      <section className="panel-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav className="flex flex-wrap gap-1 rounded-xl bg-[var(--hover)] p-1">
            {(
              [
                ["guvenilir", `Güvenilir (${trustedRows.length})`],
                ["inceleme", `İnceleme (${summary.review})`],
                ["dogrulanmis", `Doğrulanmış (${summary.verifiedKept})`],
                ["bos", `Boş (${summary.missing})`],
              ] as Array<[Tab, string]>
            ).map(([key, label]) => (
              <Link
                key={key}
                href={`/product-bank?durum=${key}${params.main ? `&main=${encodeURIComponent(params.main)}` : ""}`}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  tab === key ? "bg-card text-ink shadow-sm" : "text-subtle hover:text-ink"
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>

          <form action="/product-bank" className="flex items-center gap-2">
            <input type="hidden" name="durum" value={tab} />
            <input name="q" defaultValue={params.q ?? ""} placeholder="Ürün ara…" className="field w-48" />
            <button className="btn btn-ghost" type="submit">
              Ara
            </button>
          </form>
        </div>

        {tab === "guvenilir" ? (
          <BulkTable rows={trustedRows} storeId={store.id} />
        ) : tab === "inceleme" ? (
          <ReviewTable plans={visiblePlans} />
        ) : tab === "dogrulanmis" ? (
          <VerifiedTable plans={visiblePlans} />
        ) : (
          <EmptyTable plans={visiblePlans} />
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="panel-title">Ürünler</h2>
          <p className="panel-muted text-xs">En çok soru gelen ürünler üstte</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visiblePlans.map((plan) => (
            <ProductCard
              key={plan.productMainId}
              plan={plan}
              questions={products.find((product) => product.productMainId === plan.productMainId)?.questionCount ?? 0}
              verifiedFields={products.find((product) => product.productMainId === plan.productMainId)?.verifiedFields ?? 0}
              storeId={store.id}
              active={params.main === plan.productMainId}
            />
          ))}
        </div>
      </section>

      {selectedPlan ? (
        <section id="kart" className="panel-card scroll-mt-24">
          <div className="flex flex-col gap-3 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="panel-title">{selectedPlan.title ?? selectedPlan.productMainId}</h2>
              <p className="panel-muted mt-1 text-xs">
                {selectedPlan.variants} varyant · {selectedPlan.trustedCount} güvenilir · {selectedPlan.reviewCount} inceleme ·{" "}
                {selectedPlan.missingCount} boş
                {selectedPlan.truncated ? " · sayfalama sınırı nedeniyle eksik varyant" : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <form action={approveAutoAction}>
                <input type="hidden" name="storeId" value={store.id} />
                <input type="hidden" name="productMainId" value={selectedPlan.productMainId} />
                <button className="btn btn-primary" type="submit">
                  Güvenilir alanları onayla
                </button>
              </form>
              <Link href="/product-bank" className="btn btn-ghost">
                Kapat
              </Link>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="th">Alan</th>
                  <th className="th">Değer</th>
                  <th className="th">Kaynak</th>
                  <th className="th">Durum</th>
                  <th className="th">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {selectedPlan.fields.map((field) => {
                  const verdict = VERDICT_LABEL[field.verified ? "TRUSTED" : field.verdict] ?? VERDICT_LABEL.EMPTY;
                  return (
                    <tr key={field.key}>
                      <td className="td whitespace-nowrap font-medium">{field.label}</td>
                      <td className="td">
                        <form action={setFieldAction} className="flex items-center gap-2">
                          <input type="hidden" name="storeId" value={store.id} />
                          <input type="hidden" name="productMainId" value={selectedPlan.productMainId} />
                          <input type="hidden" name="fieldKey" value={field.key} />
                          <input
                            name="value"
                            defaultValue={field.value ?? ""}
                            placeholder="Bilinmiyor"
                            className="field min-w-[220px]"
                          />
                          <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                            Kaydet
                          </button>
                        </form>
                        {field.alternatives.length > 0 ? (
                          <p className="mt-1 text-[11px] text-amber-600">Varyantlarda farklı: {field.alternatives.join(" · ")}</p>
                        ) : null}
                      </td>
                      <td className="td whitespace-nowrap text-xs">
                        {field.source ? SOURCE_LABEL[field.source] ?? field.source : "—"}
                        {field.confidence ? <span className="text-subtle"> · {field.confidence}</span> : null}
                      </td>
                      <td className="td whitespace-nowrap">
                        <span className={`chip border ${verdict.className}`}>
                          {field.verified ? "DOĞRULANDI" : verdict.text}
                        </span>
                      </td>
                      <td className="td whitespace-nowrap">
                        {field.verified ? (
                          <form action={unverifyFieldAction}>
                            <input type="hidden" name="storeId" value={store.id} />
                            <input type="hidden" name="productMainId" value={selectedPlan.productMainId} />
                            <input type="hidden" name="fieldKey" value={field.key} />
                            <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                              Doğrulamayı kaldır
                            </button>
                          </form>
                        ) : (
                          <form action={verifyFieldAction}>
                            <input type="hidden" name="storeId" value={store.id} />
                            <input type="hidden" name="productMainId" value={selectedPlan.productMainId} />
                            <input type="hidden" name="fieldKey" value={field.key} />
                            <input type="hidden" name="value" value={field.value ?? ""} />
                            <button
                              className="btn btn-ghost px-2 py-1 text-xs"
                              type="submit"
                              disabled={!field.value}
                              title={field.value ? "Bu alanı doğrula" : "Önce değer girin"}
                            >
                              Doğrula
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hints.length > 0 ? (
            <div className="mt-5 rounded-xl border border-line p-4">
              <h3 className="mb-2 text-sm font-semibold text-ink">Bu ürün için en sık sorulanlar</h3>
              <ul className="space-y-1 text-xs text-subtle">
                {hints.slice(0, 6).map((hint, index) => (
                  <li key={index} className="truncate">
                    · {hint.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {suggestions.length > 0 ? (
        <section className="panel-card">
          <h2 className="panel-title mb-1">Geçmiş cevaplardan öneriler</h2>
          <p className="panel-muted mb-4 text-xs">
            Öneriler kanıt değildir; kabul edildiğinde alan yazılır ama doğrulanmış sayılmaz.
          </p>
          <ul className="divide-y divide-line">
            {suggestions.slice(0, 12).map((suggestion) => (
              <li key={suggestion.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">
                    <span className="font-medium">{labelOf(suggestion.fieldKey)}</span>: {suggestion.value}
                  </p>
                  <p className="text-xs text-subtle">
                    {planByMain.get(suggestion.productMainId)?.title ?? suggestion.productMainId}
                    {suggestion.conflict ? " · çelişki" : ""}
                    {suggestion.needsReview ? " · belirsiz" : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  <form action={acceptSuggestionAction}>
                    <input type="hidden" name="suggestionId" value={suggestion.id} />
                    <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                      Kabul et
                    </button>
                  </form>
                  <form action={rejectSuggestionAction}>
                    <input type="hidden" name="suggestionId" value={suggestion.id} />
                    <button className="btn btn-ghost px-2 py-1 text-xs" type="submit">
                      Reddet
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function planCount(plan: AutoFillPlan, tab: Tab): number {
  if (tab === "guvenilir") return plan.trustedCount;
  if (tab === "inceleme") return plan.reviewCount;
  if (tab === "dogrulanmis") return plan.fields.filter((field) => field.verified).length;
  return plan.missingCount;
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-line px-3 py-3">
      <p className="text-[11px] uppercase tracking-wide text-subtle">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

function BulkTable({
  rows,
  storeId,
}: {
  rows: Array<{ plan: AutoFillPlan; field: AutoFillPlan["fields"][number] }>;
  storeId: string;
}) {
  if (rows.length === 0) {
    return <p className="panel-muted mt-4">Şu anda güvenilir aday yok. Önce “Ürünleri getir” ve “Otomatik doldur” adımlarını çalıştırın.</p>;
  }

  return (
    <form action={verifySelectedAction} className="mt-4">
      <input type="hidden" name="storeId" value={storeId} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="panel-muted text-xs">
          {rows.length} güvenilir aday listeleniyor. Onay yalnızca seçtiğiniz satırlar için geçerlidir; sunucu her satırı yeniden
          sınıflandırır.
        </p>
        <div className="flex gap-2">
          <button className="btn btn-primary" type="submit">
            Seçilenleri doğrula
          </button>
          <button className="btn btn-ghost" type="submit" name="all" value="1">
            Tüm güvenilir adayları doğrula
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="th w-8">Seç</th>
              <th className="th">Ürün</th>
              <th className="th">Özellik</th>
              <th className="th">Değer</th>
              <th className="th">Kaynak</th>
              <th className="th">Güven</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ plan, field }) => (
              <tr key={`${plan.productMainId}-${field.key}`}>
                <td className="td">
                  <input
                    type="checkbox"
                    name="pick"
                    value={`${plan.productMainId}|${field.key}|${field.value ?? ""}`}
                    defaultChecked
                    className="h-4 w-4 accent-[var(--accent)]"
                    aria-label={`${plan.title ?? plan.productMainId} ${field.label}`}
                  />
                </td>
                <td className="td">{plan.title ?? plan.productMainId}</td>
                <td className="td whitespace-nowrap">{field.label}</td>
                <td className="td font-medium">{field.value}</td>
                <td className="td whitespace-nowrap text-xs">{field.source ? SOURCE_LABEL[field.source] ?? field.source : "—"}</td>
                <td className="td">
                  <span className="chip border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
                    GÜVENİLİR
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </form>
  );
}

function ReviewTable({ plans }: { plans: AutoFillPlan[] }) {
  const rows = plans.flatMap((plan) =>
    plan.fields
      .filter((field) => field.verdict === "REVIEW" && field.value)
      .map((field) => ({ plan, field })),
  );

  if (rows.length === 0) return <p className="panel-muted mt-4">İnceleme bekleyen alan yok.</p>;

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="th">Ürün</th>
            <th className="th">Özellik</th>
            <th className="th">Değer</th>
            <th className="th">Kaynak</th>
            <th className="th">Neden inceleme</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 80).map(({ plan, field }) => (
            <tr key={`${plan.productMainId}-${field.key}`}>
              <td className="td">
                <Link href={`/product-bank?main=${encodeURIComponent(plan.productMainId)}#kart`} className="text-brand-600 hover:underline">
                  {plan.title ?? plan.productMainId}
                </Link>
              </td>
              <td className="td whitespace-nowrap">{field.label}</td>
              <td className="td">{field.value}</td>
              <td className="td whitespace-nowrap text-xs">{field.source ? SOURCE_LABEL[field.source] ?? field.source : "—"}</td>
              <td className="td text-xs text-subtle">{field.verdictReasons[0] ?? "belirsiz"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 80 ? <p className="mt-2 text-xs text-subtle">İlk 80 satır gösteriliyor ({rows.length} toplam).</p> : null}
    </div>
  );
}

function VerifiedTable({ plans }: { plans: AutoFillPlan[] }) {
  const rows = plans.flatMap((plan) =>
    plan.fields.filter((field) => field.verified).map((field) => ({ plan, field })),
  );

  if (rows.length === 0) return <p className="panel-muted mt-4">Henüz doğrulanmış alan yok.</p>;

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="th">Ürün</th>
            <th className="th">Özellik</th>
            <th className="th">Değer</th>
            <th className="th">Kaynak</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ plan, field }) => (
            <tr key={`${plan.productMainId}-${field.key}`}>
              <td className="td">{plan.title ?? plan.productMainId}</td>
              <td className="td whitespace-nowrap">{field.label}</td>
              <td className="td font-medium">{field.value}</td>
              <td className="td whitespace-nowrap text-xs">{field.source ? SOURCE_LABEL[field.source] ?? field.source : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyTable({ plans }: { plans: AutoFillPlan[] }) {
  const rows = plans.flatMap((plan) =>
    plan.fields.filter((field) => !field.value).map((field) => ({ plan, field })),
  );

  if (rows.length === 0) return <p className="panel-muted mt-4">Boş alan yok.</p>;

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="th">Ürün</th>
            <th className="th">Eksik alan</th>
            <th className="th">İşlem</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 80).map(({ plan, field }) => (
            <tr key={`${plan.productMainId}-${field.key}`}>
              <td className="td">{plan.title ?? plan.productMainId}</td>
              <td className="td whitespace-nowrap">{field.label}</td>
              <td className="td">
                <Link
                  href={`/product-bank?main=${encodeURIComponent(plan.productMainId)}#kart`}
                  className="text-sm text-brand-600 hover:underline"
                >
                  Elle gir
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductCard({
  plan,
  questions,
  verifiedFields,
  storeId,
  active,
}: {
  plan: AutoFillPlan;
  questions: number;
  verifiedFields: number;
  storeId: string;
  active: boolean;
}) {
  return (
    <article className={`panel-card flex flex-col gap-3 ${active ? "border-brand-500" : ""}`}>
      <div>
        <h3 className="text-sm font-semibold text-ink">{plan.title ?? plan.productMainId}</h3>
        <p className="mt-1 text-xs text-subtle">
          {questions} soru · {plan.variants} varyant{plan.truncated ? " (sınır)" : ""}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <span className="chip text-emerald-700 dark:text-emerald-400">{plan.trustedCount} güvenilir</span>
        <span className="chip text-amber-700 dark:text-amber-400">{plan.reviewCount} inceleme</span>
        <span className="chip">{plan.missingCount} boş</span>
        <span className="chip text-brand-600 dark:text-brand-500">{verifiedFields} doğrulanmış</span>
      </div>

      <div className="mt-auto flex items-center gap-2">
        <Link href={`/product-bank?main=${encodeURIComponent(plan.productMainId)}#kart`} className="btn btn-ghost flex-1 justify-center">
          İncele
        </Link>
        {plan.trustedCount > 0 ? (
          <form action={approveAutoAction} className="flex-1">
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="productMainId" value={plan.productMainId} />
            <button className="btn btn-primary w-full justify-center" type="submit">
              Onayla ({plan.trustedCount})
            </button>
          </form>
        ) : null}
      </div>
    </article>
  );
}
