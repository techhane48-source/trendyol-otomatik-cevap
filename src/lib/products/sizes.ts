import type { PrismaClient } from "@/generated/prisma/client";

import { getPrisma } from "@/lib/prisma";

/**
 * Varyant ölçü analizi (GÖREV 013).
 *
 * Amaç: "260 x 220 kesmeniz mümkün mü?" gibi sorularda uydurmak yerine Trendyol
 * kataloğundaki GERÇEK varyant ölçüleriyle karşılaştırma yapmak.
 *
 * Kurallar:
 * - Ölçü etiketi "EN x BOY" sırasındadır (Trendyol "Boyut/Ebat" alanı).
 * - Liste dışı ölçü doğrudan satılmaz; yalnızca daha büyük varyanttan KÜÇÜLTME
 *   talep edilebilir ve bu üretim onayına bağlıdır.
 * - Büyütme (satın alınan ölçüden daha büyük üretim) mümkün değildir.
 * - Katalog verisi yoksa "ölçü mevcut" gibi bir ifade üretilmez.
 */

export interface VariantSize {
  width: number;
  height: number;
  label: string;
}

export interface SizeAnalysis {
  requested: { width: number; height: number };
  /** Katalogda kayıtlı varyant sayısı. */
  variantCount: number;
  /** İstenen ölçüyle birebir aynı varyant. */
  exact: VariantSize | null;
  /** Her iki yönde de büyük/eşit olan, küçültmeye uygun adaylar (en küçükten büyüğe). */
  shrinkCandidates: VariantSize[];
  /** Katalogda ölçü verisi var mı? */
  hasData: boolean;
}

const SIZE_PATTERN = /(\d{2,4})\s*(?:cm)?\s*[x×*]\s*(\d{2,4})\s*(?:cm)?/i;
const SINGLE_SIZE_PATTERN = /(\d{2,4})\s*(?:cm)?\s*(?:en|genişlik)\b.*?(\d{2,4})\s*(?:cm)?\s*(?:boy|yükseklik)\b/i;

/** "260 x 260", "260x220 cm" gibi etiketleri ayrıştırır. */
export function parseSizeLabel(value: string): VariantSize | null {
  const text = value.trim();
  if (!text) return null;
  const match = SIZE_PATTERN.exec(text) ?? SINGLE_SIZE_PATTERN.exec(text);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 20 || height < 20 || width > 1000 || height > 1000) return null;

  return { width, height, label: `${width} x ${height}` };
}

/** Müşteri sorusundaki ölçüyü (EN x BOY) çıkarır. */
export function extractRequestedSize(text: string): { width: number; height: number } | null {
  const parsed = parseSizeLabel(text);
  if (parsed) return { width: parsed.width, height: parsed.height };

  // "2 metreye 2 metre" gibi yazımlar: metre → cm.
  const metre = /(\d+(?:[.,]\d+)?)\s*metre\w*\s*(?:ye|ye|e)?\s*(?:x|×|çarpı)?\s*(\d+(?:[.,]\d+)?)\s*metre/i.exec(text);
  if (metre) {
    const width = Math.round(Number(metre[1].replace(",", ".")) * 100);
    const height = Math.round(Number(metre[2].replace(",", ".")) * 100);
    if (width >= 20 && height >= 20) return { width, height };
  }

  return null;
}

/** Katalog ürününün özellik listesinden "Boyut/Ebat" değerlerini toplar. */
export function variantSizesOf(attributes: unknown): VariantSize[] {
  if (!Array.isArray(attributes)) return [];
  const sizes: VariantSize[] = [];
  const seen = new Set<string>();

  for (const item of attributes) {
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; value?: unknown };
    if (typeof record.name !== "string" || typeof record.value !== "string") continue;
    const name = record.name.toLocaleLowerCase("tr");
    if (!name.includes("boyut") && !name.includes("ebat") && name !== "ölçü" && name !== "olcu") continue;

    const parsed = parseSizeLabel(record.value);
    if (!parsed) continue;
    if (seen.has(parsed.label)) continue;
    seen.add(parsed.label);
    sizes.push(parsed);
  }

  return sizes.sort((a, b) => a.width * a.height - b.width * b.height);
}

/**
 * İstenen ölçüyü mevcut varyantlarla karşılaştırır.
 * Küçültme adayı: hem en hem boy istenenden büyük veya eşit, en az biri kesin büyük.
 * Büyütme adayı bilinçli olarak dönmez: satın alınan kumaş büyütülemez.
 */
export function analyzeRequestedSize(sizes: VariantSize[], requested: { width: number; height: number }): SizeAnalysis {
  const exact =
    sizes.find((size) => size.width === requested.width && size.height === requested.height) ?? null;

  const shrinkCandidates = exact
    ? []
    : sizes.filter(
        (size) =>
          size.width >= requested.width &&
          size.height >= requested.height &&
          (size.width > requested.width || size.height > requested.height),
      );

  return {
    requested,
    variantCount: sizes.length,
    exact,
    shrinkCandidates,
    hasData: sizes.length > 0,
  };
}

/** Soruya bağlı ana ürünün varyant ölçülerini katalogdan okur. */
export async function getVariantSizesForQuestion(
  input: { storeId: string; productMainId: string | null },
  deps: { prisma?: PrismaClient } = {},
): Promise<VariantSize[]> {
  if (!input.productMainId) return [];
  const prisma = deps.prisma ?? getPrisma();

  const product = await prisma.catalogProduct.findUnique({
    where: { storeId_productMainId: { storeId: input.storeId, productMainId: input.productMainId } },
    select: { attributes: true },
  });

  return variantSizesOf(product?.attributes);
}

/** Analizi prompt'a verilecek doğrulanmış metne çevirir. Uydurma ifade içermez. */
export function describeSizeAnalysis(analysis: SizeAnalysis): string {
  const { requested } = analysis;
  const lines: string[] = [];

  lines.push(`- İstenen ölçü: ${requested.width} x ${requested.height} (EN x BOY)`);

  if (!analysis.hasData) {
    lines.push("- Katalogda bu ürün için ölçü verisi YOK. Ölçünün mevcut olduğunu söyleme.");
    return lines.join("\n");
  }

  lines.push(`- Katalogdaki varyant sayısı: ${analysis.variantCount}`);

  if (analysis.exact) {
    lines.push(`- İstenen ölçü listede VAR: ${analysis.exact.label}. Müşteri bu varyantı doğrudan seçebilir.`);
    return lines.join("\n");
  }

  lines.push("- İstenen ölçü listede YOK: doğrudan özel ölçü siparişi açılamaz.");

  if (analysis.shrinkCandidates.length > 0) {
    const labels = analysis.shrinkCandidates.slice(0, 3).map((size) => size.label).join(", ");
    lines.push(
      `- Daha büyük varyant(lar) mevcut: ${labels}. Bu varyant satın alınırsa üretim ÖNCESİ küçültme TALEBİ değerlendirilebilir;`,
      "  kabul garantisi yoktur ve üretim ekibi onayı gerekir.",
    );
  } else {
    lines.push("- İstenen ölçüden büyük/eşit varyant YOK: küçültme yoluyla bu ölçüye ulaşılamaz.");
  }

  lines.push("- Büyütme yapılamaz: satın alınan ölçüden daha büyük üretim talep edilemez.");

  return lines.join("\n");
}
