import Link from "next/link";

import { requireUser } from "@/lib/auth/session";

import { buildAutoFillPlan, summarizePlan } from "@/lib/products/autofill";
import { getPrisma } from "@/lib/prisma";
import { getWorkMetrics } from "@/lib/work-queue/service";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

const DRAFT_ACTION: Record<string, string> = {
  CREATED: "oluşturuldu",
  EDITED: "düzenlendi",
  APPROVED: "onaylandı",
  REJECTED: "reddedildi",
  SUPERSEDED: "yeni sürüm",
};

const CHANGE_ACTION: Record<string, string> = {
  CREATED: "oluşturuldu",
  APPROVED: "onaylandı",
  REJECTED: "reddedildi",
  INVALIDATED: "geçersiz",
  VERIFICATION_REQUIRED: "doğrulama gerekli",
};

const TOTAL_FIELDS = 10;

interface DashboardData {
  totalQuestions: number;
  waitingQuestions: number;
  pendingDrafts: number;
  needsInfoDrafts: number;
  pendingChangeRequests: number;
  orders: number;
  product: { trusted: number; review: number; verified: number; missing: number; products: number };
  llm: { calls: number; errors: number; cost: number } | null;
  activity: Array<{ id: string; label: string; detail: string; at: Date }>;
}

/** Tüm sayılar veritabanından gelir; hiçbir gösterge örnek/uydurma veri kullanmaz. */
async function loadDashboard(storeId: string): Promise<DashboardData> {
  const prisma = getPrisma();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalQuestions,
    waitingQuestions,
    pendingDrafts,
    needsInfoDrafts,
    pendingChangeRequests,
    orders,
    plans,
    usage,
    errors,
    draftEvents,
    changeEvents,
  ] = await Promise.all([
    prisma.question.count({ where: { storeId } }),
    prisma.question.count({ where: { storeId, status: "WAITING_FOR_ANSWER" } }),
    prisma.answerDraft.count({ where: { storeId, status: "PENDING" } }),
    prisma.answerDraft.count({ where: { storeId, status: "NEEDS_INFO" } }),
    prisma.orderChangeRequest.count({ where: { storeId, status: "PENDING_REVIEW" } }),
    prisma.order.count({ where: { storeId } }),
    buildAutoFillPlan({ storeId }, { prisma }),
    prisma.llmUsage.aggregate({
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { estimatedCostUSD: true },
    }),
    prisma.llmUsage.count({ where: { createdAt: { gte: since }, outcome: "ERROR" } }),
    prisma.draftEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 4,
      include: { draft: { include: { question: { select: { text: true } } } } },
    }),
    prisma.orderChangeEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 3,
      include: { request: { select: { orderNumber: true } } },
    }),
  ]);

  const summary = summarizePlan(plans);

  const activity = [
    ...draftEvents.map((event) => ({
      id: `d-${event.id}`,
      label: `Taslak #${event.draftId.slice(-4)} · ${DRAFT_ACTION[event.action] ?? event.action}`,
      detail: event.draft.question.text.slice(0, 90),
      at: event.createdAt,
    })),
    ...changeEvents.map((event) => ({
      id: `c-${event.id}`,
      label: `Ölçü talebi · ${CHANGE_ACTION[event.action] ?? event.action}`,
      detail: `Sipariş ${event.request.orderNumber}`,
      at: event.createdAt,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 6);

  return {
    totalQuestions,
    waitingQuestions,
    pendingDrafts,
    needsInfoDrafts,
    pendingChangeRequests,
    orders,
    product: {
      trusted: summary.trusted,
      review: summary.review,
      verified: summary.verifiedKept,
      missing: summary.missing,
      products: summary.products,
    },
    llm: usage._count._all ? { calls: usage._count._all, errors, cost: Number(usage._sum.estimatedCostUSD ?? 0) } : null,
    activity,
  };
}

export default async function DashboardPage() {
  const prisma = getPrisma();
  const currentUser = await requireUser();
  const store = await prisma.store.findUnique({ where: { id: currentUser.storeId } });

  if (!store) {
    return (
      <div className="panel-card">
        <h2 className="panel-title mb-2">Mağaza kaydı yok</h2>
        <p className="panel-muted">Önce senkronizasyon çalıştırılmalı; mağaza bilgisi bulunamadı.</p>
      </div>
    );
  }

  const data = await loadDashboard(store.id);
  const work = await getWorkMetrics(store.id);
  const totalFieldSlots = Math.max(1, data.product.products * TOTAL_FIELDS);

  const stats = [
    {
      label: "Toplam müşteri sorusu",
      value: data.totalQuestions,
      hint: `${data.waitingQuestions} yanıt bekliyor`,
      href: "/questions",
    },
    {
      label: "Onay bekleyen taslak",
      value: data.pendingDrafts,
      hint: `${data.needsInfoDrafts} bilgi bekliyor`,
      href: "/drafts",
    },
    {
      label: "Ölçü değişiklik talebi",
      value: data.pendingChangeRequests,
      hint: "üretim onayı bekliyor",
      href: "/change-requests",
    },
    {
      label: "Doğrulanmış ürün alanı",
      value: data.product.verified,
      hint: `${data.product.trusted} aday doğrulanabilir`,
      href: "/product-bank",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Link key={stat.label} href={stat.href} className="panel-card transition-colors hover:border-brand-500">
            <p className="text-sm text-subtle">{stat.label}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-ink">{stat.value.toLocaleString("tr-TR")}</p>
            <p className="mt-1 text-xs text-subtle">{stat.hint}</p>
          </Link>
        ))}
      </div>

      <section className="panel-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="panel-title">İş kuyruğu</h2>
          <Link href="/work-queue" className="text-sm text-brand-600 hover:underline">
            Kuyruğu aç
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MiniStat label="Otomatik cevap adayı" value={work.autoCandidate} tone="ok" />
          <MiniStat label="Müşteri temsilcisi" value={work.support} tone="warn" />
          <MiniStat label="Atölye talebi" value={work.workshop} tone="info" />
          <MiniStat label="Bilgi eksik" value={work.needsInfo} tone="muted" />
          <MiniStat label="Bekleyen iş" value={work.pending} tone="warn" />
          <MiniStat label="Tamamlanan iş" value={work.completed} tone="ok" />
          <MiniStat
            label="Ortalama çözüm süresi"
            value={work.averageResolutionMinutes === null ? 0 : work.averageResolutionMinutes}
            tone="info"
          />
          <MiniStat label="Toplam iş kaydı" value={work.total} tone="muted" />
        </div>
        <p className="mt-3 text-xs text-subtle">
          Ortalama çözüm süresi yalnızca kapanmış (tamamlanan) kayıtlardan hesaplanır; birimi dakikadır.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="panel-card lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="panel-title">Ürün bilgi bankası durumu</h2>
            <Link href="/product-bank" className="text-sm font-medium text-brand-600 hover:underline">
              Bankayı aç
            </Link>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <MiniStat label="Doğrulanmış" value={data.product.verified} tone="ok" />
            <MiniStat label="Güvenilir aday" value={data.product.trusted} tone="info" />
            <MiniStat label="İnceleme" value={data.product.review} tone="warn" />
            <MiniStat label="Boş" value={data.product.missing} tone="muted" />
          </div>

          <div className="mt-5 space-y-2">
            <Bar label="Doğrulanmış" value={data.product.verified} total={totalFieldSlots} tone="bg-emerald-500" />
            <Bar label="Güvenilir aday" value={data.product.trusted} total={totalFieldSlots} tone="bg-brand-600" />
            <Bar label="İnceleme" value={data.product.review} total={totalFieldSlots} tone="bg-amber-500" />
          </div>
          <p className="mt-3 text-xs text-subtle">
            Oranlar {data.product.products} ürün × {TOTAL_FIELDS} alan üzerinden hesaplanır. Doğrulanmış sayısı yalnızca sizin
            onayladığınız alanları içerir.
          </p>
        </section>

        <section className="panel-card">
          <h2 className="panel-title mb-4">Hızlı işlemler</h2>
          <div className="space-y-2">
            <QuickAction
              href="/product-bank?durum=guvenilir"
              title="Güvenilir adayları doğrula"
              detail={`${data.product.trusted} aday hazır`}
            />
            <QuickAction href="/drafts" title="Taslakları incele" detail={`${data.pendingDrafts} onay bekliyor`} />
            <QuickAction href="/change-requests" title="Ölçü talepleri" detail={`${data.pendingChangeRequests} talep`} />
            <QuickAction href="/orders" title="Sipariş ara" detail={`${data.orders} sipariş kayıtlı`} />
          </div>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="panel-card lg:col-span-2">
          <h2 className="panel-title mb-4">Son işlemler</h2>
          {data.activity.length === 0 ? (
            <p className="panel-muted">Henüz işlem kaydı yok.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.activity.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{item.label}</p>
                    <p className="truncate text-xs text-subtle">{item.detail}</p>
                  </div>
                  <span className="shrink-0 text-xs text-subtle">{dateFormatter.format(item.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel-card">
          <h2 className="panel-title mb-4">AI kullanımı · son 7 gün</h2>
          {data.llm ? (
            <dl className="space-y-3 text-sm">
              <Row label="Çağrı" value={data.llm.calls.toLocaleString("tr-TR")} />
              <Row label="Hata" value={data.llm.errors.toLocaleString("tr-TR")} />
              <Row label="Tahmini maliyet" value={`$${data.llm.cost.toFixed(4)}`} />
            </dl>
          ) : (
            <p className="panel-muted">Son 7 günde kayıtlı AI çağrısı yok.</p>
          )}
          <Link href="/quality" className="mt-4 inline-block text-sm font-medium text-brand-600 hover:underline">
            Kalite raporunu aç
          </Link>
        </section>
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone: "ok" | "info" | "warn" | "muted" }) {
  const tones: Record<string, string> = {
    ok: "text-emerald-600",
    info: "text-brand-600",
    warn: "text-amber-600",
    muted: "text-subtle",
  };

  return (
    <div className="rounded-xl border border-line px-3 py-3">
      <p className="text-[11px] uppercase tracking-wide text-subtle">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${tones[tone]}`}>{value}</p>
    </div>
  );
}

function Bar({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-subtle">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--hover)]">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function QuickAction({ href, title, detail }: { href: string; title: string; detail: string }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-3 text-sm transition-colors hover:border-brand-500 hover:bg-[var(--hover)]"
    >
      <span>
        <span className="block font-medium text-ink">{title}</span>
        <span className="block text-xs text-subtle">{detail}</span>
      </span>
      <span aria-hidden="true" className="text-subtle">
        →
      </span>
    </Link>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-subtle">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}
