import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Mağaza bazlı Trendyol kimlik bilgileri için simetrik şifreleme (GÖREV 020).
 *
 * - AES-256-GCM (doğrulanmış şifreleme; nonce + auth tag zorunlu).
 * - Anahtar YALNIZCA ortam değişkeninden gelir (`INTEGRATION_ENCRYPTION_KEY`),
 *   veritabanında saklanmaz.
 * - Anahtar yoksa/yanlışsa işlem fail-closed: şifre çözme denemesi yapılmaz.
 * - Format: `v1.<keyId>.<iv_b64>.<tag_b64>.<cipher_b64>` — keyId, rotasyon sırasında
 *   hangi anahtarın kullanıldığını gösterir (düz metin sır içermez).
 */

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

export class EncryptionKeyMissingError extends Error {
  constructor() {
    super("Kimlik bilgisi şifreleme anahtarı tanımlı değil (INTEGRATION_ENCRYPTION_KEY).");
    this.name = "EncryptionKeyMissingError";
  }
}

export function encryptionKeyStatus(): { ok: boolean; keyId: string | null } {
  const key = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY);
  if (!key) return { ok: false, keyId: null };
  return { ok: true, keyId: keyIdOf(key) };
}

/** Anahtar 32 byte (base64 veya 64 karakter hex) olmalı. */
export function parseKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  let buffer: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) buffer = Buffer.from(value, "hex");
  else {
    try {
      const decoded = Buffer.from(value, "base64");
      if (decoded.length === 32) buffer = decoded;
    } catch {
      buffer = null;
    }
  }
  return buffer && buffer.length === 32 ? buffer : null;
}

export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Yeni anahtar üretimi (kurulum/rotasyon aracı için; ekrana yazdırmayın). */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}

export function encryptSecret(plain: string): string {
  const key = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY);
  if (!key) throw new EncryptionKeyMissingError();

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, keyIdOf(key), iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string {
  const key = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY);
  if (!key) throw new EncryptionKeyMissingError();

  const parts = payload.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error("Şifreli kimlik bilgisi biçimi geçersiz.");
  }

  const [, keyId, ivB64, tagB64, dataB64] = parts;
  // timingSafeEqual ile keyId karşılaştırması (rotasyon sonrası eski kayıtların ayırt edilmesi)
  const expected = Buffer.from(keyIdOf(key));
  const found = Buffer.from(keyId);
  if (expected.length === found.length && !timingSafeEqual(expected, found)) {
    throw new Error("Kimlik bilgisi farklı bir anahtarla şifrelenmiş; rotasyon gerekli.");
  }

  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

/** Sır değerini maskeler: panelde/logda yalnızca son 4 karakter ipucu. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "—";
  if (value.length <= 4) return "••••";
  return `${"•".repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`;
}
