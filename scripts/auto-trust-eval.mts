import "dotenv/config";

import { writeFileSync } from "node:fs";

import { createAiDraft } from "../src/lib/drafts/service";
import { getEnv } from "../src/lib/env";
import { createLlmProvider } from "../src/lib/llm/provider";
import { getAutoFactsForQuestion, usableAutoFacts } from "../src/lib/products/auto-facts";
import { getPrisma } from "../src/lib/prisma";

/**
 * GÖREV 014 ölçümü: kumaş / pile / karartma / bakım sorularında
 * risk bazlı otomatik güvenin (A sınıfı) etkisini ölçer.
 *
 * Aynı sorular iki kez üretilir: autoTrust kapalı (önce) ve açık (sonra).
 * Ölçütler: A sınıfı bilgi cevaba yansıdı mı, eksik alan kaldı mı, strateji ne oldu.
 */

const apply = process.argv.includes("--onay");
const limit = Number(process.env.EVAL_LIMIT ?? 12);

if (!apply) {
  console.log("Kuru çalışma. Ölçüm için: npx tsx scripts/auto-trust-eval.mts --onay");
  process.exit(0);
}

const prisma = getPrisma();
const provider = createLlmProvider(getEnv());

const store = await prisma.store.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
const storeId = store?.id;

const questions = await prisma.question.findMany({
  where: {
    answerText: { not: null },
    productMainId: { not: null },
    OR: [
      { text: { contains: "kumaş" } },
      { text: { contains: "keten" } },
      { text: { contains: "pile" } },
      { text: { contains: "karartma" } },
      { text: { contains: "güneş" } },
      { text: { contains: "yık" } },
      { text: { contains: "ütü" } },
    ],
  },
  orderBy: { askedAt: "desc" },
  take: limit,
  select: { id: true, text: true, productMainId: true },
});

type Row = {
  question: string;
  aFacts: string[];
  before: { answer: string; strategy: string; usedAuto: boolean; missing: string[] };
  after: { answer: string; strategy: string; usedAuto: boolean; missing: string[] };
};

const rows: Row[] = [];
let beforeHits = 0;
let afterHits = 0;
let beforeMissing = 0;
let afterMissing = 0;
const created: string[] = [];

for (const question of questions) {
  const facts = usableAutoFacts(
    await getAutoFactsForQuestion({ storeId: storeId!, productMainId: question.productMainId }, { prisma }),
  );
  if (facts.length === 0) continue;

  const before = await createAiDraft({ questionId: question.id, actor: { name: "ölçüm" }, autoTrust: false }, { prisma, provider });
  const after = await createAiDraft({ questionId: question.id, actor: { name: "ölçüm" }, autoTrust: true }, { prisma, provider });
  created.push(before.id, after.id);

  const hit = (answer: string) => facts.some((fact) => answer.toLocaleLowerCase("tr").includes(fact.value.split(" ")[0].toLocaleLowerCase("tr")));
  const beforeHit = hit(before.text);
  const afterHit = hit(after.text);
  if (beforeHit) beforeHits += 1;
  if (afterHit) afterHits += 1;
  if (before.missingForIntent.some((item) => /Kumaş|Pile|Karartma|Ütü|Yıkama/i.test(item))) beforeMissing += 1;
  if (after.missingForIntent.some((item) => /Kumaş|Pile|Karartma|Ütü|Yıkama/i.test(item))) afterMissing += 1;

  rows.push({
    question: question.text.slice(0, 90),
    aFacts: facts.map((fact) => `${fact.fieldKey}=${fact.value}`),
    before: { answer: before.text, strategy: before.strategy, usedAuto: before.usedFacts.some((fact) => fact.source === "CATALOG_AUTO"), missing: before.missingForIntent },
    after: { answer: after.text, strategy: after.strategy, usedAuto: after.usedFacts.some((fact) => fact.source === "CATALOG_AUTO"), missing: after.missingForIntent },
  });
}

const total = rows.length;
const report = {
  total,
  before: { factInAnswer: total ? beforeHits / total : 0, missingRelevantField: total ? beforeMissing / total : 0 },
  after: { factInAnswer: total ? afterHits / total : 0, missingRelevantField: total ? afterMissing / total : 0 },
  rows,
};

const path = "C:/Users/berke/AppData/Local/hermes/cache/scratch/auto-trust-eval.json";
writeFileSync(path, JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({ total, before: report.before, after: report.after }, null, 2));
console.log(`Rapor: ${path}`);

// Ölçüm taslakları silinir; müşteri sorularına dokunulmaz.
await prisma.draftEvent.deleteMany({ where: { draftId: { in: created } } });
await prisma.answerDraft.deleteMany({ where: { id: { in: created } } });
console.log(`Temizlik: ${created.length} ölçüm taslağı silindi.`);

await prisma.$disconnect();
