import "dotenv/config";

import { writeFileSync } from "node:fs";

import { createAiDraft } from "../src/lib/drafts/service";
import { getEnv } from "../src/lib/env";
import { createLlmProvider } from "../src/lib/llm/provider";
import { getPrisma } from "../src/lib/prisma";

/**
 * GÖREV 012 — gerçek 30 soruluk kalite ölçümü.
 *
 * Ölçülen metrikler (tümü metin üzerinden, LLM'e sorulmadan hesaplanır):
 * - niyet doğruluğu (elle etiketlenmiş 30 gerçek soru)
 * - somut cevap oranı (kaçamak olmayan + net ifade/sayı içeren)
 * - yanlış bilgi oranı (guardrail PROMISE/STALE uyarısı üreten taslaklar)
 * - gereksiz kaçış oranı (kaynak varken kaçamak cevap)
 *
 * Kullanım: npx tsx scripts/intent-eval.mts --onay [--label baseline|after]
 */

/** Niyet sınıflandırıcı yalnızca yeni sürümde var; baseline karşılaştırmasında null kalır. */
let detectIntents: ((text: string) => { primary: string; all: string[] }) | null = null;
try {
  const mod = await import("../src/lib/intents/taxonomy");
  detectIntents = mod.detectIntents;
} catch {
  detectIntents = null;
}

const EVASIVE = [
  /kontrol edip/i,
  /kontrol edece/i,
  /bilgi verece/i,
  /iletece[ğg]im/i,
  /iletece[ğg]iz/i,
  /de[ğg]erlendirece[ğg]iz/i,
  /d[öo]n[üü][şs] yapaca/i,
  /ara[şs]t[ıi]r[ıi]p/i,
];

const CONCRETE = /\d|[Ee]vet|[Hh]ay[ıi]r|yap[ıi]yoruz|yap[ıi]lm[ıi]yor|mevcut|g[öo]nderilir|de[ğg]i[şs]tirilebilir|dikilir|olur\b/i;

/** Elle etiketlenmiş gerçek sorular (30). Sıra, en yeni 30 yanıtlı soruyla aynıdır. */
const LABELS = [
  "CUSTOM_SIZE",
  "CUSTOM_SIZE",
  "ORDER_CHANGE",
  "ORDER_CHANGE",
  "CUSTOM_SIZE",
  "PRICE",
  "ORDER_STATUS",
  "CUSTOM_SIZE",
  "OTHER",
  "CUSTOM_SIZE",
  "OTHER",
  "ORDER_CHANGE",
  "SHIPPING",
  "OTHER",
  "ORDER_STATUS",
  "FABRIC",
  "ORDER_STATUS",
  "OTHER",
  "CUSTOM_SIZE",
  "CARE",
  "CUSTOM_SIZE",
  "CUSTOM_SIZE",
  "ORDER_STATUS",
  "FABRIC",
  "FABRIC",
  "MOUNT",
  "CUSTOM_SIZE",
  "SEWING",
  "ORDER_STATUS",
  "ORDER_CHANGE",
];

function isEvasive(text: string): boolean {
  return EVASIVE.some((pattern) => pattern.test(text));
}

async function main() {
  const approved = process.argv.includes("--onay");
  const labelIndex = process.argv.indexOf("--label");
  const label = labelIndex > -1 ? process.argv[labelIndex + 1] : "after";

  if (!approved) {
    console.log("ATLANDI: ücretli çağrı için --onay gerekli.");
    process.exit(3);
  }

  const prisma = getPrisma();
  const store = await prisma.store.findFirst({ orderBy: { createdAt: "asc" } });
  if (!store) {
    console.log("Mağaza yok.");
    process.exit(4);
  }

  // Ürün bilgi kartı ve politikalar gerçek veriden gelir; burada hiçbir şey uydurulmaz.
  const provider = createLlmProvider(getEnv());

  const questions = await prisma.question.findMany({
    where: { storeId: store.id, answerText: { not: null } },
    orderBy: { askedAt: "desc" },
    take: 30,
    select: { id: true, text: true, productName: true },
  });

  const results: Array<Record<string, unknown>> = [];
  const createdDraftIds: string[] = [];

  for (const [index, question] of questions.entries()) {
    try {
      const draft = await createAiDraft({ questionId: question.id, actor: { name: "eval" } }, { prisma, provider });
      createdDraftIds.push(draft.id);

      const text = draft.text;
      const evasive = isEvasive(text);
      const policies = ((draft as unknown as { policiesUsed?: unknown[] }).policiesUsed ?? []) as unknown[];
      const hasSource = draft.usedFacts.length > 0 || policies.length > 0;
      const concrete = !evasive && CONCRETE.test(text);
      const wrongInfo = draft.warnings.some((warning) => warning.kind === "PROMISE" || warning.kind === "STALE");
      const unnecessaryEscape = evasive && hasSource;

      results.push({
        index: index + 1,
        question: question.text.replace(/\s+/g, " ").slice(0, 120),
        label: LABELS[index] ?? "OTHER",
        intent: (draft as unknown as { intent?: string }).intent ?? null,
        intents: detectIntents ? detectIntents(question.text).all : null,
        strategy: (draft as unknown as { strategy?: string }).strategy ?? null,
        resolution: draft.resolution,
        evasive,
        concrete,
        wrongInfo,
        unnecessaryEscape,
        sources: draft.usedFacts.length + policies.length,
        answer: text.replace(/\s+/g, " ").slice(0, 200),
      });
    } catch (error) {
      results.push({
        index: index + 1,
        question: question.text.replace(/\s+/g, " ").slice(0, 120),
        label: LABELS[index] ?? "OTHER",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const scored = results.filter((row) => !row.error);
  // Çok niyetli sorular için: elle etiketlenen niyet, tespit edilen niyetlerden biri mi?
  const intentMatches = scored.filter((row) => {
    const list = (row.intents as string[] | null) ?? (row.intent ? [row.intent as string] : []);
    return list.includes(row.label as string);
  }).length;
  const summary = {
    label,
    total: results.length,
    scored: scored.length,
    intentAccuracy: scored.length ? +(intentMatches / scored.length).toFixed(2) : 0,
    concreteRate: scored.length ? +(scored.filter((row) => row.concrete).length / scored.length).toFixed(2) : 0,
    wrongInfoRate: scored.length ? +(scored.filter((row) => row.wrongInfo).length / scored.length).toFixed(2) : 0,
    unnecessaryEscapeRate: scored.length
      ? +(scored.filter((row) => row.unnecessaryEscape).length / scored.length).toFixed(2)
      : 0,
    evasiveRate: scored.length ? +(scored.filter((row) => row.evasive).length / scored.length).toFixed(2) : 0,
    resolved: scored.filter((row) => row.resolution === "RESOLVED").length,
    needsInfo: scored.filter((row) => row.resolution === "NEEDS_INFO").length,
    generic: scored.filter((row) => row.resolution === "GENERIC").length,
  };

  const outPath = `C:/Users/berke/AppData/Local/hermes/cache/scratch/intent-eval-${label}.json`;
  writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2), "utf8");

  console.log(JSON.stringify(summary, null, 2));
  console.log(`Rapor: ${outPath}`);

  const usage = await prisma.llmUsage.aggregate({
    _sum: { estimatedCostUSD: true },
    _count: { _all: true },
  });
  console.log(`Toplam kayıtlı çağrı: ${usage._count._all} · tahmini maliyet: $${Number(usage._sum.estimatedCostUSD ?? 0).toFixed(4)}`);

  // Değerlendirme taslakları panelde birikmesin: oluşturulanlar silinir (soru kayıtları korunur).
  if (!process.argv.includes("--keep")) {
    await prisma.draftEvent.deleteMany({ where: { draftId: { in: createdDraftIds } } });
    await prisma.answerDraft.deleteMany({ where: { id: { in: createdDraftIds } } });
    console.log(`Temizlik: ${createdDraftIds.length} değerlendirme taslağı silindi.`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("HATA:", error instanceof Error ? error.message : error);
  process.exit(1);
});
