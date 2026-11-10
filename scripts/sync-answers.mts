import "dotenv/config";

import { getEnv } from "../src/lib/env";
import { getPrisma } from "../src/lib/prisma";
import { syncQuestions } from "../src/lib/trendyol/sync";
import { createTrendyolClient } from "../src/lib/trendyol/client";

/**
 * Cevaplanmış (ANSWERED) soruları ve gerçek satıcı cevaplarını SALT OKUNUR senkronize eder.
 * Tekrar kayıt oluşturmaz: (storeId, trendyolQuestionId) benzersiz anahtarı ile upsert eder.
 */

const prisma = getPrisma();
const env = getEnv();
const client = createTrendyolClient(env);

const before = await prisma.question.count({ where: { answerText: { not: null } } });

const result = await syncQuestions(
  { statuses: ["ANSWERED"], size: 50, maxPages: env.SYNC_MAX_PAGES },
  { prisma, client },
);

const after = await prisma.question.count({ where: { answerText: { not: null } } });
console.log(`SENKRON: görülen ${result.fetchedCount} · yazılan ${result.savedCount} · tamamlandı ${result.complete} · cevaplı soru ${before} → ${after}`);
console.log(`DURUMLAR: ${result.breakdown.map((item) => `${item.status}=${item.savedCount}/${item.fetchedCount}`).join(", ")}`);

const samples = await prisma.question.findMany({
  where: { answerText: { not: null } },
  orderBy: { answeredAt: "desc" },
  take: 3,
  select: { trendyolQuestionId: true, productName: true, answerText: true },
});
for (const sample of samples) {
  console.log(`ÖRNEK #${sample.trendyolQuestionId} · ${sample.productName ?? "—"} · cevap ${sample.answerText?.length ?? 0} karakter`);
}

await prisma.$disconnect();
