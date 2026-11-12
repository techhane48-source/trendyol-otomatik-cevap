/**
 * GÖREV 017 — 30 gerçek sorunun iş kuyruğu dağılımı.
 *
 * Kullanım:
 *   npx tsx scripts/intent-eval.mts --onay --keep --label g017
 *   npx tsx scripts/work-queue-eval.mts --label g017
 *
 * Trendyol'a hiçbir yazma yapılmaz; yalnızca yerel sınıflandırma ve sayım.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

import { disconnectPrisma, getPrisma } from "../src/lib/prisma";
import { ensureWorkItems } from "../src/lib/work-queue/service";

const prisma = getPrisma();

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const label = arg("--label", "g017");
  const file = `C:/Users/berke/AppData/Local/hermes/cache/scratch/intent-eval-${label}.json`;
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    results: Array<{ index: number; question: string }>;
  };

  const store = await prisma.store.findFirstOrThrow();
  const texts = data.results.map((row) => row.question);
  const questions = await prisma.question.findMany({
    where: { storeId: store.id },
    select: { id: true, text: true },
  });
  const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase("tr");
  const idByText = new Map(questions.map((question) => [norm(question.text), question.id]));
  const resolveId = (text: string): string | undefined => {
    const direct = idByText.get(norm(text));
    if (direct) return direct;
    const prefix = norm(text).slice(0, 25);
    return questions.find((question) => norm(question.text).startsWith(prefix))?.id;
  };
  const ids = data.results.map((row) => resolveId(row.question)).filter((id): id is string => Boolean(id));

  if (process.argv.includes("--refresh") && ids.length > 0) {
    await prisma.workItemEvent.deleteMany({ where: { workItem: { questionId: { in: ids } } } });
    await prisma.workItem.deleteMany({ where: { questionId: { in: ids } } });
  }

  const run = await ensureWorkItems({ storeId: store.id, questionIds: ids });

  const items = await prisma.workItem.findMany({
    where: { questionId: { in: ids } },
    select: { questionId: true, category: true, priority: true, status: true, orderMatch: true, orderStatusAtClassify: true, reasons: true },
  });
  const byQuestion = new Map(items.map((item) => [item.questionId, item]));

  const counts: Record<string, number> = { AUTO_CANDIDATE: 0, SUPPORT: 0, WORKSHOP: 0, NEEDS_INFO: 0 };
  const rows: Array<Record<string, unknown>> = [];

  for (const entry of data.results) {
    const id = resolveId(entry.question);
    const item = id ? byQuestion.get(id) : undefined;
    if (!item) continue;
    counts[item.category] = (counts[item.category] ?? 0) + 1;
    rows.push({
      index: entry.index,
      category: item.category,
      priority: item.priority,
      orderMatch: item.orderMatch,
      orderStatus: item.orderStatusAtClassify,
      question: entry.question.slice(0, 90),
    });
  }

  const out = {
    label,
    questions: ids.length,
    ensure: run,
    counts,
    rows,
  };
  const target = `C:/Users/berke/AppData/Local/hermes/cache/scratch/work-queue-eval-${label}.json`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(target, JSON.stringify(out, null, 2), "utf8");

  console.log(JSON.stringify({ questions: ids.length, ensure: run, counts }, null, 2));
  for (const row of rows) {
    console.log(`#${String(row.index).padStart(2)} ${String(row.category).padEnd(14)} ${String(row.priority).padEnd(7)} ${row.question}`);
  }
  console.log(`\nYazıldı: ${target}`);
  await disconnectPrisma();
}

main().catch(async (error) => {
  console.error("HATA:", error instanceof Error ? error.message : error);
  await disconnectPrisma();
  process.exit(1);
});
