/**
 * GÖREV 020 — Aura Perde bağlantısını .env'den mağaza kaydına taşır.
 *
 * Kullanım:
 *   npx tsx scripts/migrate-aura-integration.mts --dry-run
 *   npx tsx scripts/migrate-aura-integration.mts --apply
 *
 * Kurallar:
 * - Yalnızca `AURA_SELLER_ID` (varsayılan 1081168) mağazasına yazar.
 * - Sırlar yalnızca şifreli olarak saklanır; stdout/log'a asla yazılmaz.
 * - Mevcut kayıt varsa üzerine yazmaz (--force verilmedikçe).
 * - Başarısızlıkta veri silinmez; hata kodu döner.
 */
import "dotenv/config";

import { getPrisma } from "../src/lib/prisma";
import { encryptionKeyStatus, parseKey } from "../src/lib/integrations/crypto";
import { saveIntegration, getIntegrationView } from "../src/lib/integrations/service";

const dryRun = !process.argv.includes("--apply");
const force = process.argv.includes("--force");
const auraSellerId = process.env.AURA_SELLER_ID?.trim() || "1081168";

async function main() {
  const prisma = getPrisma();

  const key = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY);
  if (!key) {
    console.log(JSON.stringify({ ok: false, code: "ENCRYPTION_KEY_MISSING" }));
    process.exit(2);
  }

  const sellerId = process.env.TRENDYOL_SELLER_ID?.trim();
  const apiKey = process.env.TRENDYOL_API_KEY?.trim();
  const apiSecret = process.env.TRENDYOL_API_SECRET?.trim();

  if (!sellerId || !apiKey || !apiSecret) {
    console.log(JSON.stringify({ ok: false, code: "ENV_CREDENTIALS_MISSING" }));
    process.exit(2);
  }
  if (sellerId !== auraSellerId) {
    // Ortak env kimlik bilgileri yalnızca Aura'ya taşınabilir.
    console.log(JSON.stringify({ ok: false, code: "SELLER_MISMATCH", expected: auraSellerId }));
    process.exit(3);
  }

  const store = await prisma.store.findFirst({ where: { sellerId: BigInt(auraSellerId) } });
  if (!store) {
    console.log(JSON.stringify({ ok: false, code: "AURA_STORE_NOT_FOUND" }));
    process.exit(3);
  }

  const existing = await prisma.storeIntegration.findUnique({ where: { storeId: store.id } });
  if (existing && !force) {
    const view = await getIntegrationView(store.id);
    console.log(
      JSON.stringify({
        ok: true,
        skipped: "ALREADY_CONFIGURED",
        storeId: store.id,
        status: view?.status,
        keyId: encryptionKeyStatus().keyId,
      }),
    );
    process.exit(0);
  }

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, storeId: store.id, sellerId: auraSellerId }));
    process.exit(0);
  }

  await saveIntegration({
    storeId: store.id,
    sellerId: auraSellerId,
    apiKey,
    apiSecret,
    actor: "migration:env",
  });

  const view = await getIntegrationView(store.id);
  console.log(
    JSON.stringify({
      ok: true,
      applied: true,
      storeId: store.id,
      status: view?.status,
      keyId: view?.keyId,
      hasSecrets: Boolean(view && view.apiKeyMasked !== "—"),
    }),
  );
  process.exit(0);
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, code: error instanceof Error ? error.name : "UNKNOWN", detail: error instanceof Error ? error.message.slice(0, 120) : "" }));
  process.exit(1);
});
