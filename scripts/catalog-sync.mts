import "dotenv/config";

import { applyAutoFill, approveAutoFilled, buildAutoFillPlan, summarizePlan } from "../src/lib/products/autofill";
import { syncCatalog } from "../src/lib/products/catalog-sync";
import { disconnectPrisma, getPrisma } from "../src/lib/prisma";

/**
 * Trendyol kataloğunu çeker ve ürün kartlarını otomatik TASLAK doldurur (GÖREV 010).
 *
 *   npx tsx scripts/catalog-sync.mts            → yalnızca katalog anlık görüntüsü
 *   npx tsx scripts/catalog-sync.mts --apply    → kartlara taslak doldur
 *   npx tsx scripts/catalog-sync.mts --approve  → katalogdan gelen, inceleme istemeyen alanları doğrula
 *
 * Salt okunur: Trendyol'a hiçbir yazma isteği gitmez.
 */
const args = new Set(process.argv.slice(2));
const doApply = args.has("--apply");
const doApprove = args.has("--approve");

const prisma = getPrisma();
const store = await prisma.store.findFirst({ orderBy: { createdAt: "asc" } });
if (!store) {
  console.error("Mağaza bulunamadı.");
  process.exit(2);
}

console.log("KATALOG SENKRONU (salt okunur GET)");
const sync = await syncCatalog({ storeId: store.id, limit: 10 }, { prisma, pageSize: 100, maxPages: 3 });
console.log(`  istenen: ${sync.requested} · senkron: ${sync.synced} · bulunamadı: ${sync.notFound} · hata: ${sync.failed}`);
console.log(`  varyant: ${sync.variants} · sayfa sınırına takılan ürün: ${sync.truncated}`);
for (const product of sync.products) {
  console.log(`  ${product.status.padEnd(9)} ${product.productMainId.padEnd(24)} varyant=${String(product.variants).padStart(4)} ${product.title?.slice(0, 55) ?? ""}`);
}

const plans = await buildAutoFillPlan({ storeId: store.id }, { prisma });
const totals = summarizePlan(plans);
console.log("\nOTOMATİK DOLDURMA PLANI (taslak)");
console.log(`  ürün: ${totals.products} · doldurulabilir: ${totals.filled} · inceleme: ${totals.review} · boş: ${totals.missing} · korunan doğrulanmış: ${totals.verifiedKept}`);
for (const plan of plans) {
  console.log(`  ${plan.productMainId.padEnd(24)} dolu=${plan.filledCount} inceleme=${plan.reviewCount} boş=${plan.missingCount} (${plan.variants} varyant${plan.truncated ? ", sınır" : ""})`);
  for (const field of plan.fields.filter((item) => item.state !== "EMPTY")) {
    const tag = field.state === "REVIEW" ? "İNCELE" : field.state === "KEPT" ? "DOĞRULANMIŞ" : "TASLAK";
    console.log(`      ${tag.padEnd(11)} ${field.label.padEnd(16)} ${String(field.value).slice(0, 46).padEnd(48)} [${field.source ?? "-"}${field.confidence ? "/" + field.confidence : ""}]`);
  }
}

if (doApply) {
  const applied = await applyAutoFill({ storeId: store.id, actor: "katalog-otomatik" }, { prisma });
  console.log(`\nUYGULANDI: ${applied.products} ürün · ${applied.filled} alan taslak · ${applied.review} alan incelemeye düştü · ${applied.skipped} alan boş`);
}

if (doApprove) {
  let verified = 0;
  let skipped = 0;
  for (const plan of plans) {
    const result = await approveAutoFilled({ storeId: store.id, productMainId: plan.productMainId, actor: "katalog-onay" }, { prisma });
    verified += result.verified;
    skipped += result.skipped;
  }
  console.log(`\nONAY: ${verified} alan doğrulandı · ${skipped} alan inceleme bekliyor (geçmiş cevap kaynaklılar onaylanmadı)`);
}

await disconnectPrisma();
