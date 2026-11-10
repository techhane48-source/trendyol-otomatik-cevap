import "dotenv/config";

import { z } from "zod";

import { getEnv, resolveUserAgent } from "../src/lib/env";
import { trendyolQnaPageSchema, trendyolQuestionSchema } from "../src/lib/trendyol/schemas";

/**
 * TEK SEFERLİK salt okunur canlı doğrulama.
 *
 * - Trendyol'a YALNIZCA 1 istek gönderir: GET /questions/filter?page=0&size=5
 * - Tekrar deneme (retry) YOKTUR; istek sayısı 1'dir.
 * - Yazma endpoint'i çağrılmaz.
 * - Çıktıya API anahtarı, secret, Authorization başlığı, soru metni veya müşteri
 *   kimliği YAZILMAZ. Yalnızca HTTP durumu, alan ADLARI ve şema uyuşmazlıkları.
 *
 * Kullanım: npm run live:check
 */

const MAX_QUESTIONS = 5;

/** Opsiyonel CLI argümanı: `npm run live:check -- ANSWERED` */
const STATUS_ARG = process.argv[2]?.trim().toUpperCase() || "WAITING_FOR_ANSWER";
const ALLOWED_STATUSES = ["WAITING_FOR_ANSWER", "ANSWERED", "REJECTED"] as const;

if (!(ALLOWED_STATUSES as readonly string[]).includes(STATUS_ARG)) {
  console.error(`Geçersiz durum: ${STATUS_ARG}. İzin verilenler: ${ALLOWED_STATUSES.join(", ")}`);
  process.exit(1);
}

function maskSellerId(sellerId: string): string {
  return sellerId.length <= 2 ? "**" : `***${sellerId.slice(-2)}`;
}

/**
 * Bir değerin YALNIZCA yapısını betimler (değer içeriği yazdırılmaz):
 * tip, nesne ise alt alan adları, metin ise uzunluk.
 */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "yok";
  if (typeof value === "string") return `string (uzunluk ${value.length})`;
  if (typeof value === "number" || typeof value === "boolean") return typeof value;
  if (Array.isArray(value)) return `dizi (${value.length})`;
  if (typeof value === "object") {
    return `nesne { ${Object.keys(value as Record<string, unknown>).sort().join(", ")} }`;
  }
  return typeof value;
}

function describeIssues(error: z.ZodError): string[] {
  // Sadece yol + kural; gönderilen değer yazdırılmaz.
  return error.issues.map((issue) => {
    const field = issue.path.join(".") || "(kök)";
    return `${field} → ${issue.code}: ${issue.message}`;
  });
}

async function main(): Promise<void> {
  const env = getEnv();
  const baseUrl = env.TRENDYOL_BASE_URL.replace(/\/+$/, "");

  const params = new URLSearchParams({
    page: "0",
    size: String(MAX_QUESTIONS),
    status: STATUS_ARG,
    orderByField: "CreatedDate",
    orderByDirection: "ASC",
  });

  const url = `${baseUrl}/sellers/${env.TRENDYOL_SELLER_ID}/questions/filter?${params.toString()}`;
  const safeUrl = url.replace(env.TRENDYOL_SELLER_ID, maskSellerId(env.TRENDYOL_SELLER_ID));
  const authorization = `Basic ${Buffer.from(`${env.TRENDYOL_API_KEY}:${env.TRENDYOL_API_SECRET}`, "utf8").toString("base64")}`;

  console.log("== Trendyol canlı doğrulama (salt okunur, tek istek) ==");
  console.log(`İstek      : GET ${safeUrl}`);
  console.log(`User-Agent : ${resolveUserAgent(env)}`);
  console.log(`Üst sınır  : ${MAX_QUESTIONS} soru`);
  console.log("");

  const startedAt = Date.now();
  let response: Response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: authorization,
        "User-Agent": resolveUserAgent(env),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(Math.max(env.TRENDYOL_TIMEOUT_MS, 20_000)),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Bilinmeyen";
    console.log(`SONUÇ: AĞ HATASI (${name}) — istek tamamlanmadı, tekrar denenmedi.`);
    process.exitCode = 1;
    return;
  }

  const elapsed = Date.now() - startedAt;
  console.log(`HTTP durum : ${response.status} ${response.statusText} (${elapsed} ms)`);

  if (!response.ok) {
    const body = await response.text();
    // Gövde anahtar içerebilir; yalnızca uzunluk ve ilk satırın kısaltılmış hâli.
    const firstLine = body.split(/\r?\n/)[0]?.slice(0, 120) ?? "";
    console.log(`Gövde      : ${body.length} bayt`);
    if (firstLine) console.log(`İlk satır  : ${firstLine}`);
    console.log("");
    console.log("SONUÇ: İstek başarısız — şema doğrulaması yapılmadı (yanıt gövdesi işlenmedi).");
    process.exitCode = 1;
    return;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    console.log("SONUÇ: Yanıt JSON olarak okunamadı.");
    process.exitCode = 2;
    return;
  }

  const isObject = payload !== null && typeof payload === "object" && !Array.isArray(payload);
  console.log(`Yanıt türü : ${Array.isArray(payload) ? "dizi" : typeof payload}`);
  if (isObject) {
    const keys = Object.keys(payload as Record<string, unknown>).sort();
    console.log(`Üst alanlar: ${keys.join(", ")}`);
  }

  // 1) Sayfa sarmalayıcısı mevcut şemaya uyuyor mu?
  const pageParsed = trendyolQnaPageSchema.safeParse(payload);
  if (!pageParsed.success) {
    console.log("");
    console.log("ŞEMA UYUMSUZLUĞU — sayfa sarmalayıcısı:");
    for (const line of describeIssues(pageParsed.error)) console.log(`  - ${line}`);
    console.log("");
    console.log("SONUÇ: MEVCUT ŞEMA GEÇMEDİ. Kod değiştirilmedi; önce rapor incelenmeli.");
    process.exitCode = 2;
    return;
  }

  const page = pageParsed.data;
  console.log(
    `Sayfa      : content=${page.content.length}, totalPages=${page.totalPages ?? "?"}, ` +
      `totalElements=${page.totalElements ?? "?"}, last=${page.last ?? "?"}, size=${page.size ?? "?"}`,
  );

  // 2) Tek tek soru kayıtları (değer yazdırılmadan).
  const itemReports = page.content.slice(0, MAX_QUESTIONS).map((item, index) => {
    const parsed = trendyolQuestionSchema.safeParse(item);
    const keys =
      item !== null && typeof item === "object"
        ? Object.keys(item as Record<string, unknown>).sort()
        : [];
    return { index, parsed, keys, answerShape: describeShape((item as Record<string, unknown>)?.answer) };
  });

  const failed = itemReports.filter((report) => !report.parsed.success);

  if (itemReports.length > 0) {
    console.log("Soru alanları (ilk kayıt): " + itemReports[0].keys.join(", "));
    console.log("answer alanının yapısı : " + itemReports[0].answerShape);
  }

  if (failed.length === 0) {
    console.log("");
    console.log(`SONUÇ: ŞEMA UYUMLU — ${itemReports.length} kayıt mevcut Zod şemasıyla doğrulandı.`);
    console.log("(Soru metni, müşteri bilgisi, anahtar ve başlıklar çıktıya yazılmadı.)");
    process.exitCode = 0;
    return;
  }

  console.log("");
  console.log("ŞEMA UYUMSUZLUĞU — soru kayıtları:");
  for (const report of failed) {
    console.log(`  content[${report.index}] alanları: ${report.keys.join(", ") || "(nesne değil)"}`);
    for (const line of describeIssues(report.parsed.error as z.ZodError)) {
      console.log(`    - ${line}`);
    }
  }
  console.log("");
  console.log("SONUÇ: MEVCUT ŞEMA GEÇMEDİ. Kod değiştirilmedi; önce rapor incelenmeli.");
  process.exitCode = 2;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Bilinmeyen hata";
  console.error(`HATA: ${message}`);
  process.exitCode = 1;
});
