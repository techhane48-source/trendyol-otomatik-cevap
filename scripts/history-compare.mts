import "dotenv/config";

import { createAiDraft } from "../src/lib/drafts/service";
import { createLlmProvider } from "../src/lib/llm/provider";
import { getEnv } from "../src/lib/env";
import { getPrisma } from "../src/lib/prisma";

/**
 * GÖREV 008 — geçmiş cevap hafızasının etkisini ölçen karşılaştırma.
 *
 * Aynı 10 gerçek soru iki kez üretilir: hafızalı / hafızasız.
 * Buradaki puanlar OTOMATİK ve kaba göstergelerdir; insan değerlendirmesinin yerine geçmez.
 *
 * Kullanım: npx tsx scripts/history-compare.mts [--limit 10] [--onay]
 */

const prisma = getPrisma();
const env = getEnv();
const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1]) || 10;
const approved = args.includes("--onay");

const GENERIC_PATTERNS = [
  /kontrol edip/i,
  /bilgi verece/i,
  /ileteceğim/i,
  /değerlendireceğiz/i,
];

interface Row {
  text: string;
  warnings: number;
  stale: number;
  needsInfo: boolean;
  length: number;
  generic: number;
  history: number;
  score: number;
  latencyMs: number;
}

function label(row: Row): string {
  // Otomatik kaba puan: somut bilgi + kısa metin + az uyarı iyidir; genel kaçamak cevap kötüdür.
  const concreteness = row.generic === 0 ? 2 : row.generic === 1 ? 1 : 0;
  const penalty = row.stale * 1.5 + (row.needsInfo ? 1 : 0);
  return (concreteness + (row.length <= 320 ? 1 : 0) - penalty).toFixed(1);
}

async function main(): Promise<void> {
  if (!approved) {
    console.error("ONAY GEREKLİ: canlı modelle ücretli karşılaştırma için --onay ekleyin.");
    process.exit(4);
  }
  if (!env.LLM_API_KEY) {
    console.error("ATLANDI: LLM_API_KEY yok; canlı karşılaştırma yapılmadı.");
    process.exit(3);
  }

  const questions = await prisma.question.findMany({
    where: { answerText: { not: null }, status: "ANSWERED" },
    orderBy: { answeredAt: "desc" },
    take: limit,
    select: { id: true, text: true, trendyolQuestionId: true, productName: true },
  });

  if (questions.length === 0) {
    console.error("Geçmiş cevap yok; karşılaştırma yapılamaz.");
    process.exit(2);
  }

  const provider = createLlmProvider(env);
  const createdDraftIds: string[] = [];
  const rows: Row[] = [];
  let cost = 0;

  console.log(`MODEL: ${provider.model} · soru: ${questions.length} · istek: ${questions.length * 2}`);
  console.log("");

  for (const [index, question] of questions.entries()) {
    const withHistory = await createAiDraft(
      { questionId: question.id, actor: { name: "karsilastirma-testi" } },
      { prisma, provider },
    );
    const withoutHistory = await createAiDraft(
      { questionId: question.id, actor: { name: "karsilastirma-testi" }, includeHistory: false },
      { prisma, provider },
    );

    createdDraftIds.push(withHistory.id, withoutHistory.id);
    cost += (withHistory.estimatedCostUSD ?? 0) + (withoutHistory.estimatedCostUSD ?? 0);

    const build = (draft: typeof withHistory, historyCount: number): Row => ({
      text: draft.text,
      warnings: draft.warnings.length,
      stale: draft.warnings.filter((warning) => warning.kind === "STALE").length,
      needsInfo: draft.status === "NEEDS_INFO",
      length: draft.text.length,
      generic: GENERIC_PATTERNS.filter((pattern) => pattern.test(draft.text)).length,
      history: historyCount,
      score: 0,
      latencyMs: draft.durationMs ?? 0,
    });

    const a = build(withHistory, withHistory.historyUsed.length);
    const b = build(withoutHistory, 0);
    a.score = Number(label(a));
    b.score = Number(label(b));

    rows.push(a, b);
    console.log(
      `#${index + 1} #${question.trendyolQuestionId} · hafızalı: ${a.history} kayıt · ${a.length} kr · uyarı ${a.warnings} (stale ${a.stale}) · ${withHistory.status} · puan ${a.score}`,
    );
    console.log(
      `    hafızasız: ${b.length} kr · uyarı ${b.warnings} (stale ${b.stale}) · ${withoutHistory.status} · puan ${b.score}`,
    );
  }

  // rows dizisi her soru için [hafızalı, hafızasız] sırasıyla eklenir.
  const withRows = rows.filter((_row, index) => index % 2 === 0);
  const withoutRows = rows.filter((_row, index) => index % 2 === 1);

  const summary = (subset: Row[]) => ({
    score: subset.reduce((sum, row) => sum + row.score, 0) / (subset.length || 1),
    generic: subset.reduce((sum, row) => sum + row.generic, 0) / (subset.length || 1),
    stale: subset.reduce((sum, row) => sum + row.stale, 0),
    needsInfo: subset.filter((row) => row.needsInfo).length,
    length: subset.reduce((sum, row) => sum + row.length, 0) / (subset.length || 1),
    latency: subset.reduce((sum, row) => sum + row.latencyMs, 0) / (subset.length || 1),
  });

  const A = summary(withRows);
  const B = summary(withoutRows);

  console.log("");
  console.log("ÖZET (OTOMATİK — insan değerlendirmesi değildir)");
  console.log(`  ortalama otomatik puan : hafızalı ${A.score.toFixed(2)} · hafızasız ${B.score.toFixed(2)}`);
  console.log(`  genel/kaçamak ifade    : hafızalı ${A.generic.toFixed(2)} · hafızasız ${B.generic.toFixed(2)}`);
  console.log(`  STALE uyarısı          : hafızalı ${A.stale} · hafızasız ${B.stale}`);
  console.log(`  NEEDS_INFO             : hafızalı ${A.needsInfo} · hafızasız ${B.needsInfo}`);
  console.log(`  ortalama uzunluk       : hafızalı ${A.length.toFixed(0)} · hafızasız ${B.length.toFixed(0)} karakter`);
  console.log(`  ortalama süre          : hafızalı ${A.latency.toFixed(0)} · hafızasız ${B.latency.toFixed(0)} ms`);
  console.log(`  tahmini maliyet        : $${cost.toFixed(6)}`);

  // Ölçüm kayıtları silinir (gerçek sorulara dokunulmaz; yalnızca bu koşuda üretilen taslaklar).
  await prisma.draftEvent.deleteMany({ where: { draftId: { in: createdDraftIds } } });
  await prisma.answerDraft.deleteMany({ where: { id: { in: createdDraftIds } } });
  await prisma.llmUsage.deleteMany({ where: { questionId: { in: questions.map((question) => question.id) }, purpose: "draft" } });
  console.log(`\nTEMİZLİK: ${createdDraftIds.length} ölçüm taslağı silindi (gerçek soru/cevap korundu).`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("HATA:", (error as Error).message);
  await prisma.$disconnect();
  process.exit(1);
});
