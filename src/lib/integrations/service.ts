import { getPrisma } from "@/lib/prisma";
import { createTrendyolClient, TrendyolApiError } from "@/lib/trendyol/client";
import { decryptSecret, encryptSecret, encryptionKeyStatus, keyIdOf, maskSecret, parseKey } from "./crypto";

/**
 * Mağaza bazlı Trendyol bağlantı yönetimi (GÖREV 020).
 *
 * - Her mağazanın kendi Seller ID / API Key / API Secret'ı vardır.
 * - Sırlar AES-256-GCM ile şifreli saklanır; panel/API yalnızca maskeli özet görür.
 * - `.env` kimlik bilgileri hiçbir mağazaya otomatik uygulanmaz.
 * - Bağlantı yoksa işlem fail-closed: başka mağazanın kimliğine geri dönülmez.
 */

export type IntegrationStatus = "UNCONFIGURED" | "CONNECTED" | "ERROR" | "DISABLED";

export class IntegrationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
  }
}

/** SUPPORT rolü kimlik bilgilerini göremez/değiştiremez (sunucu tarafı kontrol). */
export function assertCanManageIntegration(role: string): void {
  if (role !== "OWNER" && role !== "ADMIN") {
    throw new IntegrationError("FORBIDDEN", "Bu işlem için mağaza sahibi veya yönetici yetkisi gerekir.");
  }
}

export interface IntegrationView {
  storeId: string;
  sellerId: string;
  apiKeyMasked: string;
  apiSecretMasked: string;
  status: IntegrationStatus;
  lastCheckAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  disabledAt: Date | null;
  encryptionReady: boolean;
  keyId: string | null;
}

export interface StoreCredentials {
  sellerId: string;
  apiKey: string;
  apiSecret: string;
}

function sanitizeError(error: unknown): string {
  if (error instanceof TrendyolApiError) {
    return `${error.kind}${error.status ? ` (HTTP ${error.status})` : ""}`;
  }
  if (error instanceof IntegrationError) return error.code;
  return "UNKNOWN";
}

export async function getIntegrationView(storeId: string): Promise<IntegrationView | null> {
  const prisma = getPrisma();
  const row = await prisma.storeIntegration.findUnique({ where: { storeId } });
  const key = encryptionKeyStatus();

  if (!row) {
    return {
      storeId,
      sellerId: "",
      apiKeyMasked: "—",
      apiSecretMasked: "—",
      status: "UNCONFIGURED",
      lastCheckAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      disabledAt: null,
      encryptionReady: key.ok,
      keyId: key.keyId,
    };
  }

  let apiKeyMasked = "••••";
  let apiSecretMasked = "••••";
  if (key.ok) {
    try {
      apiKeyMasked = maskSecret(decryptSecret(row.apiKeyEnc));
      apiSecretMasked = maskSecret(decryptSecret(row.apiSecretEnc));
    } catch {
      apiKeyMasked = "çözülemedi";
      apiSecretMasked = "çözülemedi";
    }
  }

  return {
    storeId,
    sellerId: row.sellerId.toString(),
    apiKeyMasked,
    apiSecretMasked,
    status: row.status as IntegrationStatus,
    lastCheckAt: row.lastCheckAt,
    lastSuccessAt: row.lastSuccessAt,
    lastError: row.lastError,
    lastSyncAt: row.lastSyncAt,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncError: row.lastSyncError,
    disabledAt: row.disabledAt,
    encryptionReady: key.ok,
    keyId: row.keyId,
  };
}

/** Kayıtlı bağlantının sırlarını çözer. Yalnızca sunucu tarafı işlemler kullanır. */
export async function resolveCredentials(storeId: string): Promise<StoreCredentials> {
  const prisma = getPrisma();
  const row = await prisma.storeIntegration.findUnique({ where: { storeId } });
  if (!row) {
    throw new IntegrationError("INTEGRATION_MISSING", "Bu mağaza için Trendyol bağlantısı tanımlı değil.");
  }
  if (row.status === "DISABLED" || row.disabledAt) {
    throw new IntegrationError("INTEGRATION_DISABLED", "Bu mağazanın Trendyol bağlantısı devre dışı.");
  }

  try {
    return {
      sellerId: row.sellerId.toString(),
      apiKey: decryptSecret(row.apiKeyEnc),
      apiSecret: decryptSecret(row.apiSecretEnc),
    };
  } catch (error) {
    throw new IntegrationError(
      "INTEGRATION_DECRYPT_FAILED",
      error instanceof Error && error.name === "EncryptionKeyMissingError"
        ? "Şifreleme anahtarı tanımlı değil; kimlik bilgileri çözülemiyor."
        : "Kimlik bilgileri çözülemedi (anahtar rotasyonu gerekli olabilir).",
    );
  }
}

export async function saveIntegration(input: {
  storeId: string;
  sellerId: string;
  apiKey: string;
  apiSecret: string;
  actor: string;
}): Promise<IntegrationView> {
  const prisma = getPrisma();
  const key = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY);
  if (!key) {
    throw new IntegrationError(
      "ENCRYPTION_KEY_MISSING",
      "Şifreleme anahtarı tanımlı değil; kimlik bilgisi kaydedilemez.",
    );
  }

  const sellerIdRaw = input.sellerId.trim();
  if (!/^\d{4,12}$/.test(sellerIdRaw)) {
    throw new IntegrationError("INVALID_SELLER_ID", "Satıcı ID yalnızca rakamlardan oluşmalı (4-12 hane).");
  }
  if (input.apiKey.trim().length < 8 || input.apiSecret.trim().length < 8) {
    throw new IntegrationError("INVALID_CREDENTIALS", "API anahtarı ve gizli anahtar en az 8 karakter olmalı.");
  }

  const apiKeyEnc = encryptSecret(input.apiKey.trim());
  const apiSecretEnc = encryptSecret(input.apiSecret.trim());

  await prisma.storeIntegration.upsert({
    where: { storeId: input.storeId },
    create: {
      storeId: input.storeId,
      sellerId: BigInt(sellerIdRaw),
      apiKeyEnc,
      apiSecretEnc,
      keyId: keyIdOf(key),
      status: "UNCONFIGURED",
      createdBy: input.actor,
      updatedBy: input.actor,
    },
    update: {
      sellerId: BigInt(sellerIdRaw),
      apiKeyEnc,
      apiSecretEnc,
      keyId: keyIdOf(key),
      status: "UNCONFIGURED",
      disabledAt: null,
      updatedBy: input.actor,
    },
  });

  return (await getIntegrationView(input.storeId))!;
}

/**
 * Salt okunur bağlantı testi: Trendyol'dan 1 soru ister.
 * Başarısızsa durum ERROR olarak kaydedilir; yanlışlıkla CONNECTED gösterilmez.
 */
export async function testIntegration(storeId: string): Promise<{ ok: boolean; error?: string; checkedAt: Date }> {
  const prisma = getPrisma();
  const checkedAt = new Date();

  let credentials: StoreCredentials;
  try {
    credentials = await resolveCredentials(storeId);
  } catch (error) {
    const message = sanitizeError(error);
    await prisma.storeIntegration.updateMany({ where: { storeId }, data: { lastCheckAt: checkedAt, lastError: message, status: "ERROR" } });
    return { ok: false, error: message, checkedAt };
  }

  try {
    const client = createTrendyolClient({
      sellerId: credentials.sellerId,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
    });
    const page = await client.fetchQuestionsPage({ page: 0, size: 1 });
    if (!page || !page.page) {
      throw new IntegrationError("UNEXPECTED_RESPONSE", "Beklenmeyen Trendyol yanıtı.");
    }
    await prisma.storeIntegration.updateMany({
      where: { storeId },
      data: { status: "CONNECTED", lastCheckAt: checkedAt, lastSuccessAt: checkedAt, lastError: null },
    });
    return { ok: true, checkedAt };
  } catch (error) {
    const message = sanitizeError(error);
    await prisma.storeIntegration.updateMany({
      where: { storeId },
      data: { status: "ERROR", lastCheckAt: checkedAt, lastError: message },
    });
    return { ok: false, error: message, checkedAt };
  }
}

export async function disableIntegration(storeId: string, actor: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.storeIntegration.updateMany({
    where: { storeId },
    data: { status: "DISABLED", disabledAt: new Date(), updatedBy: actor },
  });
}

export async function enableIntegration(storeId: string, actor: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.storeIntegration.updateMany({
    where: { storeId },
    data: { status: "UNCONFIGURED", disabledAt: null, updatedBy: actor },
  });
}

/**
 * Senkronizasyon kilidi: aynı mağazada eşzamanlı çalışmayı engeller.
 * 10 dakikadan eski kilit "ölü" sayılır ve devralınır.
 */
export async function acquireSyncLock(storeId: string): Promise<{ acquired: boolean; reason?: string }> {
  const prisma = getPrisma();
  const row = await prisma.storeIntegration.findUnique({ where: { storeId } });
  if (!row) return { acquired: false, reason: "INTEGRATION_MISSING" };

  const now = new Date();
  if (row.syncLockedAt && now.getTime() - row.syncLockedAt.getTime() < 10 * 60 * 1000) {
    return { acquired: false, reason: "SYNC_ALREADY_RUNNING" };
  }

  await prisma.storeIntegration.update({ where: { storeId }, data: { syncLockedAt: now } });
  return { acquired: true };
}

export async function releaseSyncLock(
  storeId: string,
  result: { status: string; error?: string | null },
): Promise<void> {
  const prisma = getPrisma();
  await prisma.storeIntegration.updateMany({
    where: { storeId },
    data: {
      syncLockedAt: null,
      lastSyncAt: new Date(),
      lastSyncStatus: result.status,
      lastSyncError: result.error ?? null,
    },
  });
}
