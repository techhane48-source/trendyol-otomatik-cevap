import "dotenv/config";

import { createAiDraft } from "../src/lib/drafts/service";
import { getEnv } from "../src/lib/env";
import { createLlmProvider } from "../src/lib/llm/provider";
import { getPrisma } from "../src/lib/prisma";
import { FIELD_DEFS, setField, verifyField } from "../src/lib/products/bank";

/**
 * GÖREV 009 — ürün kartı etkisinin ölçümü.
 *
 * Fazlar:
 *   --phase baseline : mevcut 10 soruda başlangıç sonuçları (kart yokken)
 *   --phase after    : aynı 10 soruda, doğrulanmış alanlar sonrası sonuçlar
 *   --synthetic      : SENTETİK mağazada kart etkisini gösteren kontrollü A/B
 *
 * Ölçümler OTOMATİKTİR; insan değerlendirmesinin yerine geçmez.
 * Kullanım: npx tsx scripts/product-quality.mts --onay [--phase baseline|after] [--synthetic]
 */

const prisma = getPrisma();
const env = getEnv();
const args = process.argv.slice(2);
const phase = (args[args.indexOf("--phase") + 1] ?? "baseline") as "baseline" | "after";
const synthetic = args.includes("--synthetic");
const approved = args.includes("--onay");

const GENERIC = [/kontrol edip/i, /bilgi verece/i, /ileteceğim/i, /değerlendireceğiz/i];
const CLAIM = [/kesinlikle göstermez/i, /tam karartma/i, /yarın teslim/i, /garantilidir/i];

interface Metrics {
  total: number;
  resolved: number;
  generic: number;
  needsInfo: number;
  claims: number;
  warnings: number;
  avgLength: number;
}

function measure(rows: Array<{ text: string; resolution: string; warnings: number }>): Metrics {
  return {
    total: rows.length,
    resolved: rows.filter((row) => row.resolution === "RESOLVED").length,
    generic: rows.filter((row) => GENERIC.some((pattern) => pattern.test(row.text))).length,
    needsInfo: rows.filter((row) => row.resolution === "NEEDS_INFO").length,
    claims: rows.filter((row) => CLAIM.some((pattern) => pattern.test(row.text))).length,
    warnings: rows.reduce((sum, row) => sum + row.warnings, 0),
    avgLength: Math.round(rows.reduce((sum, row) => sum + row.text.length, 0) / (rows.length || 1)),
  };
}

function report(title: string, metrics: Metrics): void {
  console.log(`\n${title}`);
  console.log(`  soru            : ${metrics.total}`);
  console.log(`  RESOLVED        : ${metrics.resolved} (%${Math.round((metrics.resolved / (metrics.total || 1)) * 100)})`);
  console.log(`  kaçamak/genel   : ${metrics.generic}`);
  console.log(`  NEEDS_INFO      : ${metrics.needsInfo}`);
  console.log(`  yanlış iddia    : ${metrics.claims}`);
  console.log(`  guardrail uyarı : ${metrics.warnings}`);
  console.log(`  ort. uzunluk    : ${metrics.avgLength} karakter`);
}

async function main(): Promise<void> {
  if (!approved) {
    console.error("ONAY GEREKLİ: canlı modelle ölçüm için --onay ekleyin.");
    process.exit(4);
  }
  if (!env.LLM_API_KEY) {
    console.error("ATLANDI: LLM_API_KEY yok.");
    process.exit(3);
  }

  const provider = createLlmProvider(env);
  console.log(`MODEL: ${provider.model} · faz: ${phase}${synthetic ? " · SENTETİK A/B" : ""}`);

  const created: string[] = [];

  if (synthetic) {
    // SENTETİK mağaza: gerçek müşteri verisi kullanılmaz, yalnızca mekanizmayı gösterir.
    const store = await prisma.store.upsert({ where: { sellerId: 999_001n }, update: {}, create: { sellerId: 999_001n } });
    const texts = [
      "Perde kumaşınız şeffaf mı?",
      "Kaç pile ile dikiliyor?",
      "Kumaş yıkandığında çekiyor mu?",
      "Karartma sağlıyor mu?",
    ];

    const ids: string[] = [];
    for (const [index, text] of texts.entries()) {
      const row = await prisma.question.create({
        data: {
          storeId: store.id,
          trendyolQuestionId: BigInt(999_100_000 + index),
          text,
          status: "WAITING_FOR_ANSWER",
          rawStatus: "WAITING_FOR_ANSWER",
          productName: "Sentetik Test Perde",
          productMainId: "SYN-MAIN-1",
          productId: "SYN-VAR-1",
          customerId: "SYN-CUSTOMER",
          askedAt: new Date(),
        },
      });
      ids.push(row.id);
    }

    const before = [];
    for (const questionId of ids) {
      const draft = await createAiDraft({ questionId, actor: { name: "olcum" } }, { prisma, provider });
      created.push(draft.id);
      before.push({ text: draft.text, resolution: draft.resolution, warnings: draft.warnings.length });
    }
    report("A) KART YOK (sentetik)", measure(before));

    // Alanlar burada SADECE mekanizmayı göstermek için doğrulanır (sentetik mağaza).
    await setField({ storeId: store.id, productMainId: "SYN-MAIN-1", fieldKey: "fabric", value: "Bambu dokulu tül", actor: "olcum" }, { prisma });
    await verifyField({ storeId: store.id, productMainId: "SYN-MAIN-1", fieldKey: "fabric", actor: "olcum" }, { prisma });
    await setField({ storeId: store.id, productMainId: "SYN-MAIN-1", fieldKey: "pleat", value: "1/3 pile", actor: "olcum" }, { prisma });
    await verifyField({ storeId: store.id, productMainId: "SYN-MAIN-1", fieldKey: "pleat", actor: "olcum" }, { prisma });

    const after = [];
    for (const questionId of ids) {
      const draft = await createAiDraft({ questionId, actor: { name: "olcum" } }, { prisma, provider });
      created.push(draft.id);
      after.push({ text: draft.text, resolution: draft.resolution, warnings: draft.warnings.length });
    }
    report("B) 2 ALAN DOĞRULANDI (sentetik)", measure(after));

    // Temizlik: sentetik mağaza verileri
    await prisma.draftEvent.deleteMany({ where: { draftId: { in: created } } });
    await prisma.answerDraft.deleteMany({ where: { id: { in: created } } });
    await prisma.llmUsage.deleteMany({ where: { questionId: { in: ids } } });
    await prisma.productInfoEvent.deleteMany({ where: { productInfo: { storeId: store.id } } });
    await prisma.productInfo.deleteMany({ where: { storeId: store.id } });
    await prisma.question.deleteMany({ where: { storeId: store.id } });
    await prisma.store.delete({ where: { id: store.id } });
    console.log("\nTEMİZLİK: sentetik mağaza silindi.");
    await prisma.$disconnect();
    return;
  }

  const questions = await prisma.question.findMany({
    where: { status: "ANSWERED", answerText: { not: null } },
    orderBy: { answeredAt: "desc" },
    take: 10,
    select: { id: true, trendyolQuestionId: true },
  });

  const verifiedFieldCount = await prisma.productInfo.findMany({ select: { attributes: true } });
  const verifiedTotal = verifiedFieldCount.reduce((sum, card) => {
    const attributes = Array.isArray(card.attributes) ? (card.attributes as Array<{ verified?: boolean }>) : [];
    return sum + attributes.filter((attribute) => attribute.verified === true).length;
  }, 0);
  console.log(`Doğrulanmış alan sayısı (tüm kartlar): ${verifiedTotal} / ${FIELD_DEFS.length} alan × kart`);

  const rows = [];
  for (const question of questions) {
    const draft = await createAiDraft({ questionId: question.id, actor: { name: "olcum" } }, { prisma, provider });
    created.push(draft.id);
    rows.push({ text: draft.text, resolution: draft.resolution, warnings: draft.warnings.length });
    console.log(
      `#${question.trendyolQuestionId} · ${draft.resolution} · ${draft.text.length} kr · ${draft.usedFacts.length} doğrulanmış alan · uyarı ${draft.warnings.length}`,
    );
  }

  report(phase === "baseline" ? "BAŞLANGIÇ (kart öncesi)" : "SONRA (doğrulanmış alanlar)", measure(rows));

  await prisma.draftEvent.deleteMany({ where: { draftId: { in: created } } });
  await prisma.answerDraft.deleteMany({ where: { id: { in: created } } });
  console.log(`\nTEMİZLİK: ${created.length} ölçüm taslağı silindi (sorular korundu).`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("HATA:", (error as Error).message);
  await prisma.$disconnect();
  process.exit(1);
});
