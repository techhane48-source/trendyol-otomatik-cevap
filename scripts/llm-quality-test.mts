import "dotenv/config";

import { getEnv } from "../src/lib/env";
import { BudgetError, assertBudget, estimateRunCostUSD, hasPricing } from "../src/lib/llm/budget";
import { buildDraftMessages } from "../src/lib/llm/prompt";
import { createLlmProvider } from "../src/lib/llm/provider";
import { sanitizeQuestion } from "../src/lib/llm/sanitize";
import { LlmRequestError } from "../src/lib/llm/types";
import { computeCostUSD, resolvePricing } from "../src/lib/llm/usage";
import { isUsableForDraft, matchProductInfo } from "../src/lib/products/matching";
import { findProductInfoForQuestion } from "../src/lib/products/service";
import { getPrisma } from "../src/lib/prisma";

/**
 * 10 soruluk canlı kalite testi (AŞAMA 2).
 *
 * Kurallar:
 * - Açık onay olmadan ÇALIŞMAZ (`--onay` bayrağı zorunlu).
 * - Fiyat tarifesi tanımlı değilse veya tahmini maliyet bütçeyi aşıyorsa başlamaz.
 * - Her soru için EN FAZLA bir çağrı; hata tekrarı yok (provider tekrarı kapalı).
 * - Trendyol'a hiçbir istek gitmez; sorular yalnızca yerel veritabanından okunur.
 * - Taslak oluşturulmaz, onaylanmaz: yalnızca ölçüm ve kullanım kaydı.
 * - Müşteri metni PII'den arındırılarak gönderilir.
 *
 * Kullanım: npx tsx scripts/llm-quality-test.mts --onay [--limit 10]
 */

const args = process.argv.slice(2);
const approved = args.includes("--onay") || args.includes("--approve");
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 10;

if (!approved) {
  console.log("ONAY GEREKLİ: ücretli canlı test başlatılmadı.");
  console.log("Çalıştırmak için: npx tsx scripts/llm-quality-test.mts --onay --limit 10");
  process.exit(4);
}

const env = getEnv();
const pricing = resolvePricing(env);
const prisma = getPrisma();

if (env.LLM_PROVIDER === "disabled" || !env.LLM_API_KEY) {
  console.error("ATLANDI: LLM_PROVIDER / LLM_API_KEY tanımlı değil. Canlı test yapılmadı.");
  await prisma.$disconnect();
  process.exit(3);
}

const CALLS = Math.max(1, Math.min(limit, 10));
const APPROX_INPUT = 700;
const APPROX_OUTPUT = 250;

console.log("— Canlı kalite testi planı —");
console.log(`model   : ${env.LLM_MODEL}`);
console.log(`soru    : ${CALLS}`);
console.log(`bütçe   : $${env.LLM_MAX_COST_USD} (env LLM_MAX_COST_USD)`);

try {
  const estimate = assertBudget({
    calls: CALLS,
    approxInputTokensPerCall: APPROX_INPUT,
    approxOutputTokensPerCall: APPROX_OUTPUT,
    pricing,
    budgetUSD: env.LLM_MAX_COST_USD,
  });
  console.log(`tahmini : $${estimate}`);
} catch (error) {
  if (error instanceof BudgetError) {
    console.error(`DURDURULDU: ${error.message}`);
    await prisma.$disconnect();
    process.exit(5);
  }
  throw error;
}

const CATEGORIES: Array<{ key: string; label: string; pattern: RegExp }> = [
  { key: "olcu", label: "ölçü", pattern: /(ölçü|olcu|cm|ebat|genişlik|genislik|yükseklik|yukseklik|kaç metre)/i },
  { key: "pile", label: "pile", pattern: /(pile|büzgü|buzgu|toplama oranı)/i },
  { key: "kumas", label: "kumaş", pattern: /(kumaş|kumas|tül|tul|dokuma|polyester|pamuk|ipek)/i },
  { key: "seffaflik", label: "şeffaflık", pattern: /(şeffaf|seffaf|görünür|gorunur|karartma|blackout|gece)/i },
  { key: "renk", label: "renk", pattern: /(renk|bej|pudra|mint|gri|antrasit|krem)/i },
  { key: "montaj", label: "montaj", pattern: /(montaj|kurulum|takıl|takil|bant|korniş|kornis|ray)/i },
  { key: "yikama", label: "yıkama", pattern: /(yıka|yika|temizlik|ütü|utu|makine)/i },
  { key: "stok", label: "stok", pattern: /(stok|mevcut|var mı|kaldı|kaldi)/i },
  { key: "kargo", label: "kargo", pattern: /(kargo|teslimat|teslim|gönderi|gonderi|kaç gün)/i },
  { key: "iade", label: "iade", pattern: /(iade|değişim|degisim|geri gönder)/i },
];

const questions = await prisma.question.findMany({
  orderBy: { createdAt: "desc" },
  take: 300,
  select: {
    id: true,
    text: true,
    productName: true,
    productMainId: true,
    productId: true,
    storeId: true,
  },
});

if (questions.length === 0) {
  console.error("DURDURULDU: veritabanında soru yok. Önce salt-okunur senkronizasyon çalıştırın.");
  await prisma.$disconnect();
  process.exit(6);
}

function categoryOf(text: string): { key: string; label: string } {
  for (const category of CATEGORIES) {
    if (category.pattern.test(text)) return { key: category.key, label: category.label };
  }
  return { key: "diger", label: "diğer" };
}

// Kategori çeşitliliği: her kategoriden en fazla bir soru, sonra kalanlarla doldur.
const picked: typeof questions = [];
const used = new Set<string>();
for (const category of CATEGORIES) {
  const match = questions.find((question) => !used.has(question.id) && category.pattern.test(question.text));
  if (match) {
    picked.push(match);
    used.add(match.id);
  }
  if (picked.length >= CALLS) break;
}
for (const question of questions) {
  if (picked.length >= CALLS) break;
  if (!used.has(question.id)) {
    picked.push(question);
    used.add(question.id);
  }
}

const provider = createLlmProvider({ ...env, LLM_MAX_RETRIES: 0 });
let totalCost = 0;
let totalTokens = 0;
let durationSum = 0;
let ok = 0;
let failed = 0;
let missingInfo = 0;

console.log("\n— Sonuçlar —");
console.log("no | kategori | eşleşme | durum | ms | token | $ | soru (maskeli)");

for (const [index, question] of picked.entries()) {
  if (totalCost >= env.LLM_MAX_COST_USD) {
    console.log(`DURDURULDU: bütçe sınırına ulaşıldı ($${totalCost}).`);
    break;
  }

  const sanitized = sanitizeQuestion(question.text);
  const category = categoryOf(question.text);

  const candidates = await findProductInfoForQuestion(
    { storeId: question.storeId, productMainId: question.productMainId, productId: question.productId },
    { prisma },
  );
  const match = matchProductInfo(
    { storeId: question.storeId, productMainId: question.productMainId, productId: question.productId },
    candidates,
  );
  const usable = (match.kind === "EXACT_VARIANT" || match.kind === "MAIN_PRODUCT") && isUsableForDraft(match);
  const card = usable ? candidates.find((candidate) => candidate.id === match.product.id) : undefined;
  const facts =
    card && Array.isArray(card.attributes)
      ? (card.attributes as unknown as Array<{ label: string; value: string }>)
      : [];
  const productInfoText = facts.length > 0 ? facts.map((fact) => `${fact.label}: ${fact.value}`).join("\n") : null;
  if (!productInfoText) missingInfo += 1;

  const messages = buildDraftMessages({
    questionText: sanitized.text,
    productName: question.productName,
    productMainId: question.productMainId,
    productInfo: productInfoText,
    storeName: null,
    tone: null,
  });

  const startedAt = Date.now();
  try {
    const completion = await provider.complete(messages);
    const cost = computeCostUSD(completion.usage, pricing);
    totalCost += cost;
    totalTokens += completion.usage.totalTokens;
    durationSum += completion.durationMs;
    ok += 1;

    await prisma.llmUsage.create({
      data: {
        provider: completion.provider,
        model: completion.model,
        promptVersion: completion.promptVersion,
        outcome: "SUCCESS",
        durationMs: completion.durationMs,
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        totalTokens: completion.usage.totalTokens,
        estimated: completion.usage.estimated,
        estimatedCostUSD: cost,
        questionId: question.id,
        purpose: "quality-live",
      },
    });

    console.log(
      `${index + 1} | ${category.label} | ${match.kind}${usable ? "" : " (kullanılmadı)"} | OK | ${completion.durationMs} | ${completion.usage.totalTokens} | $${cost.toFixed(6)} | ${sanitized.text.slice(0, 70)}`,
    );
    console.log(`   → ${completion.text.replace(/\s+/g, " ").slice(0, 220)}`);
  } catch (error) {
    failed += 1;
    const code = error instanceof LlmRequestError ? error.code : "UNKNOWN";
    await prisma.llmUsage.create({
      data: {
        provider: provider.name,
        model: provider.model,
        promptVersion: env.LLM_PROMPT_VERSION,
        outcome: "ERROR",
        errorCode: code,
        durationMs: Date.now() - startedAt,
        estimated: true,
        estimatedCostUSD: 0,
        questionId: question.id,
        purpose: "quality-live",
      },
    });
    console.log(`${index + 1} | ${category.label} | ${match.kind} | HATA ${code} | ${Date.now() - startedAt} | - | - | ${sanitized.text.slice(0, 70)}`);
  }
}

console.log("\n— Özet —");
console.log(`test edilen soru : ${ok + failed} (başarılı ${ok}, başarısız ${failed})`);
console.log(`gerçek model     : ${provider.model}`);
console.log(`ortalama süre    : ${ok > 0 ? Math.round(durationSum / ok) : 0} ms`);
console.log(`toplam token     : ${totalTokens}`);
console.log(`tahmini maliyet  : $${totalCost.toFixed(6)}${hasPricing(pricing) ? "" : " (fiyat tanımsız)"}`);
console.log(`ürün bilgisi yok : ${missingInfo}/${ok + failed}`);
console.log("İnsan değerlendirmesi YAPILMADI — kalite sonucu ilan edilmedi.");
console.log("Trendyol'a hiçbir istek gönderilmedi; taslak onaylanmadı.");

await prisma.$disconnect();
