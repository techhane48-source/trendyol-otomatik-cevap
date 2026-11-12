import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, encryptionKeyStatus, generateEncryptionKey, maskSecret } from "@/lib/integrations/crypto";
import {
  IntegrationError,
  acquireSyncLock,
  assertCanManageIntegration,
  getIntegrationView,
  releaseSyncLock,
  resolveCredentials,
  saveIntegration,
  testIntegration,
} from "@/lib/integrations/service";
import { getPrisma } from "@/lib/prisma";

/**
 * GÖREV 020 — mağaza bazlı Trendyol entegrasyonu testleri.
 * İki test mağazası; gerçek Aura verisi kopyalanmaz. Ağ çağrısı yoktur:
 * bağlantı testinde `fetch` sahte yanıt döndürür.
 */

const prisma = getPrisma();
let storeA = "";
let storeB = "";
const realFetch = globalThis.fetch;
const ORIGINAL_KEY = process.env.INTEGRATION_ENCRYPTION_KEY;

async function makeStore(sellerId: number, name: string): Promise<string> {
  const store = await prisma.store.create({ data: { sellerId: BigInt(sellerId), name } });
  return store.id;
}

beforeAll(async () => {
  if (!process.env.INTEGRATION_ENCRYPTION_KEY) {
    process.env.INTEGRATION_ENCRYPTION_KEY = generateEncryptionKey();
  }
  storeA = await makeStore(991001, "Test Mağaza A");
  storeB = await makeStore(991002, "Test Mağaza B");
});

beforeEach(async () => {
  await prisma.storeIntegration.deleteMany({ where: { storeId: { in: [storeA, storeB] } } });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await prisma.storeIntegration.deleteMany({ where: { storeId: { in: [storeA, storeB] } } });
  await prisma.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
  process.env.INTEGRATION_ENCRYPTION_KEY = ORIGINAL_KEY;
  await prisma.$disconnect();
});

describe("şifreleme", () => {
  it("AES-256-GCM gidiş-dönüş ve nonce farklılığı", () => {
    const first = encryptSecret("super-secret-value");
    const second = encryptSecret("super-secret-value");
    expect(first).not.toBe(second);
    expect(first.startsWith("v1.")).toBe(true);
    expect(first).not.toContain("super-secret-value");
    expect(decryptSecret(first)).toBe("super-secret-value");
  });

  it("anahtar yoksa şifreleme fail-closed", () => {
    const saved = process.env.INTEGRATION_ENCRYPTION_KEY;
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/anahtar/i);
    expect(encryptionKeyStatus().ok).toBe(false);
    process.env.INTEGRATION_ENCRYPTION_KEY = saved;
  });

  it("farklı anahtar çözemez", () => {
    const payload = encryptSecret("gizli");
    process.env.INTEGRATION_ENCRYPTION_KEY = generateEncryptionKey();
    expect(() => decryptSecret(payload)).toThrow(/rotasyon/i);
  });

  it("maskeleme sırrı göstermez", () => {
    const masked = maskSecret("abcdef123456");
    expect(masked.endsWith("3456")).toBe(true);
    expect(masked).not.toContain("abcdef");
  });
});

describe("bağlantı kaydı", () => {
  it("sırlar şifreli saklanır, görünüm yalnızca maske döner", async () => {
    const view = await saveIntegration({
      storeId: storeA,
      sellerId: "991001",
      apiKey: "api-key-AAA-111",
      apiSecret: "api-secret-AAA-222",
      actor: "test",
    });
    expect(view.status).toBe("UNCONFIGURED");
    expect(view.apiKeyMasked).not.toContain("api-key-AAA");
    expect(view.apiSecretMasked).not.toContain("api-secret-AAA");

    const row = await prisma.storeIntegration.findUniqueOrThrow({ where: { storeId: storeA } });
    expect(row.apiKeyEnc).not.toContain("api-key-AAA");
    expect(row.apiSecretEnc).not.toContain("api-secret-AAA");
    expect(JSON.stringify(view)).not.toContain("api-secret-AAA");
  });

  it("SUPPORT kimlik bilgisi yönetemez", () => {
    expect(() => assertCanManageIntegration("SUPPORT")).toThrow(IntegrationError);
    expect(() => assertCanManageIntegration("ADMIN")).not.toThrow();
    expect(() => assertCanManageIntegration("OWNER")).not.toThrow();
  });

  it("geçersiz satıcı ID reddedilir", async () => {
    await expect(
      saveIntegration({ storeId: storeA, sellerId: "abc", apiKey: "12345678", apiSecret: "12345678", actor: "t" }),
    ).rejects.toThrow(/Satıcı ID/);
  });
});

describe("mağaza izolasyonu", () => {
  it("A'nın bağlantısı B için kullanılamaz", async () => {
    await saveIntegration({ storeId: storeA, sellerId: "991001", apiKey: "key-A-12345", apiSecret: "secret-A-12345", actor: "t" });

    const credsA = await resolveCredentials(storeA);
    expect(credsA.apiKey).toBe("key-A-12345");

    await expect(resolveCredentials(storeB)).rejects.toMatchObject({ code: "INTEGRATION_MISSING" });
    const viewB = await getIntegrationView(storeB);
    expect(viewB?.status).toBe("UNCONFIGURED");
    expect(viewB?.apiKeyMasked).toBe("—");
  });

  it("devre dışı bağlantı kimlik bilgisi vermez", async () => {
    await saveIntegration({ storeId: storeA, sellerId: "991001", apiKey: "key-A-12345", apiSecret: "secret-A-12345", actor: "t" });
    await prisma.storeIntegration.update({ where: { storeId: storeA }, data: { status: "DISABLED", disabledAt: new Date() } });
    await expect(resolveCredentials(storeA)).rejects.toMatchObject({ code: "INTEGRATION_DISABLED" });
  });

  it("her mağaza kendi satıcı ID'sini korur", async () => {
    await saveIntegration({ storeId: storeA, sellerId: "991001", apiKey: "key-A-12345", apiSecret: "secret-A-12345", actor: "t" });
    await saveIntegration({ storeId: storeB, sellerId: "991002", apiKey: "key-B-12345", apiSecret: "secret-B-12345", actor: "t" });

    expect((await resolveCredentials(storeA)).sellerId).toBe("991001");
    expect((await resolveCredentials(storeB)).sellerId).toBe("991002");
    expect((await resolveCredentials(storeB)).apiKey).toBe("key-B-12345");
  });
});

describe("bağlantı testi", () => {
  it("401 dönerse bağlantı başarılı sayılmaz", async () => {
    await saveIntegration({ storeId: storeA, sellerId: "991001", apiKey: "wrong-key-111", apiSecret: "wrong-secret-111", actor: "t" });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as typeof fetch;

    const result = await testIntegration(storeA);
    expect(result.ok).toBe(false);
    const view = await getIntegrationView(storeA);
    expect(view?.status).toBe("ERROR");
    expect(view?.lastError).not.toContain("wrong-secret");
  });

  it("başarılı salt okunur yanıt CONNECTED yapar", async () => {
    await saveIntegration({ storeId: storeA, sellerId: "991001", apiKey: "key-A-12345", apiSecret: "secret-A-12345", actor: "t" });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ page: 0, size: 1, totalElements: 0, totalPages: 0, content: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const result = await testIntegration(storeA);
    expect(result.ok).toBe(true);
    expect((await getIntegrationView(storeA))?.status).toBe("CONNECTED");
  });

  it("yanlış Seller ID 401 alır ve ERROR kalır", async () => {
    await saveIntegration({ storeId: storeA, sellerId: "999999", apiKey: "key-A-12345", apiSecret: "secret-A-12345", actor: "t" });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })) as typeof fetch;
    const result = await testIntegration(storeA);
    expect(result.ok).toBe(false);
    expect((await getIntegrationView(storeA))?.status).toBe("ERROR");
  });
});

describe("senkronizasyon kilidi", () => {
  it("aynı mağazada ikinci senkronizasyon engellenir, farklı mağaza etkilenmez", async () => {
    await saveIntegration({ storeId: storeA, sellerId: "991001", apiKey: "key-A-12345", apiSecret: "secret-A-12345", actor: "t" });
    await saveIntegration({ storeId: storeB, sellerId: "991002", apiKey: "key-B-12345", apiSecret: "secret-B-12345", actor: "t" });

    const first = await acquireSyncLock(storeA);
    expect(first.acquired).toBe(true);

    const second = await acquireSyncLock(storeA);
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe("SYNC_ALREADY_RUNNING");

    const other = await acquireSyncLock(storeB);
    expect(other.acquired).toBe(true);

    await releaseSyncLock(storeA, { status: "SUCCESS" });
    const view = await getIntegrationView(storeA);
    expect(view?.lastSyncStatus).toBe("SUCCESS");
    expect(view?.lastSyncAt).toBeTruthy();

    expect((await acquireSyncLock(storeA)).acquired).toBe(true);
    await releaseSyncLock(storeA, { status: "SUCCESS" });
    await releaseSyncLock(storeB, { status: "SUCCESS" });
  });

  it("A'nın hatası B'nin durumunu değiştirmez", async () => {
    await saveIntegration({ storeId: storeA, sellerId: "991001", apiKey: "key-A-12345", apiSecret: "secret-A-12345", actor: "t" });
    await saveIntegration({ storeId: storeB, sellerId: "991002", apiKey: "key-B-12345", apiSecret: "secret-B-12345", actor: "t" });

    await acquireSyncLock(storeA);
    await releaseSyncLock(storeA, { status: "FAILED", error: "TRENDYOL_AUTH_ERROR" });

    const viewA = await getIntegrationView(storeA);
    const viewB = await getIntegrationView(storeB);
    expect(viewA?.lastSyncStatus).toBe("FAILED");
    expect(viewB?.lastSyncStatus).toBeNull();
    expect(viewB?.status).toBe("UNCONFIGURED");
  });
});

describe("mağazalar arası kayıt numarası çakışması", () => {
  it("aynı sipariş numarası iki mağazada ayrı kayıt olarak durabilir", async () => {
    const shared = "TEST-ORDER-1";
    await prisma.order.create({ data: { storeId: storeA, orderNumber: shared, status: "Created", customerRef: "ref-a" } });
    await prisma.order.create({ data: { storeId: storeB, orderNumber: shared, status: "Created", customerRef: "ref-b" } });

    const rows = await prisma.order.findMany({ where: { orderNumber: shared }, select: { storeId: true } });
    expect(rows.map((row) => row.storeId).sort()).toEqual([storeA, storeB].sort());

    await prisma.order.deleteMany({ where: { orderNumber: shared } });
  });
});
