import type { PrismaClient } from "@/generated/prisma/client";

import { getPrisma } from "@/lib/prisma";

/**
 * Türkçe ölçü anlama ve varyant karşılaştırması (GÖREV 013 + GÖREV 015).
 *
 * Desteklenen biçimler:
 *   260 x 220 · 260×220 · 150-260 · 250 ye 180 · 250'ye 180
 *   2 metreye 2 metre · 2 metreye iki metre · iki metreye iki metre
 *   iki buçuk metre · ikibucuk metre · 220 en 160 boy · eni 180 boyu 100
 *   250 aldım 195 olsun (mevcut/istenen tek ölçü — eksen belirsiz)
 *
 * İlkeler:
 * - EN = genişlik, BOY = yükseklik. Yön metinden çıkarılamazsa uydurulmaz.
 * - Tek ölçü verildiyse ikinci ölçü UYDURULMAZ; eksen netleştirmesi istenir.
 * - Sipariş numarası, tarih ve fiyat ölçü sanılmaz.
 * - Liste dışı ölçü doğrudan satılmaz; yalnızca daha büyük varyanttan küçültme
 *   talebi değerlendirilebilir (üretim onayı, söz yok).
 */

export interface VariantSize {
  width: number;
  height: number;
  label: string;
}

export interface SizeAnalysis {
  requested: { width: number; height: number };
  variantCount: number;
  exact: VariantSize | null;
  shrinkCandidates: VariantSize[];
  hasData: boolean;
}

export type SizeAxis = "EN_BOY" | "BOY_EN";

export interface SizeRequest {
  /** İstenen (yeni) ölçü; iki eksen de biliniyorsa dolu. */
  requested: { width: number; height: number } | null;
  /** Sipariş sonrası değişiklikte "mevcut" ölçü (tek eksen olabilir). */
  current: { width: number; height: number } | null;
  /** Tek eksen verilmişse o değer (cm). */
  single: { value: number; role: "current" | "requested" } | null;
  orientation: SizeAxis;
  /** Ölçü ifadesi belirsizse nedeni. */
  ambiguous: "AXIS_UNKNOWN" | "SECOND_DIMENSION_MISSING" | "MULTI_SIZE" | null;
  /** Ayrıştırılan ham ifade (gerekçe için). */
  evidence: string | null;
}

const EMPTY_REQUEST: SizeRequest = {
  requested: null,
  current: null,
  single: null,
  orientation: "EN_BOY",
  ambiguous: null,
  evidence: null,
};

const NUMBER_WORDS: Record<string, number> = {
  bir: 1, iki: 2, uc: 3, "üç": 3, dort: 4, "dört": 4, bes: 5, "beş": 5, alti: 6, "altı": 6,
  yedi: 7, sekiz: 8, dokuz: 9, on: 10, yirmi: 20, otuz: 30, kirk: 40, "kırk": 40,
  elli: 50, altmis: 60, "altmış": 60, yetmis: 70, "yetmiş": 70, seksen: 80, doksan: 90, yuz: 100, "yüz": 100,
};

function turkishLower(text: string): string {
  return text.toLocaleLowerCase("tr-TR");
}

/** "ikibucuk", "iki buçuk", "2.5", "2,5" → sayı. */
function parseNumberToken(token: string): number | null {
  const cleaned = token.trim().replace(/['’]/g, "");
  if (!cleaned) return null;

  const numeric = Number(cleaned.replace(",", "."));
  if (Number.isFinite(numeric)) return numeric;

  const compact = cleaned.replace(/[\s-]/g, "");
  if (compact.includes("bucuk") || compact.includes("buçuk")) {
    const head = compact.split(/bucuk|buçuk/)[0] ?? "";
    const base = head ? parseNumberToken(head) : null;
    return (base ?? 0) + 0.5;
  }

  if (compact in NUMBER_WORDS) return NUMBER_WORDS[compact];
  return null;
}

/** 2-4 haneli ölçü adayı; sipariş no parçası / yıl / fiyat elenir. */
function isPlausibleDimension(value: number, raw: string, text: string, index: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (value < 20 || value > 1000) return false;
  if (/^\d{4}$/.test(raw) && value >= 1990 && value <= 2100) return false; // yıl
  if (/\d{6,}/.test(text.slice(Math.max(0, index - 1), index + raw.length + 1))) return false; // uzun sayı parçası

  const around = text.slice(Math.max(0, index - 20), index + raw.length + 20);
  if (/(tl|₺|lira|fiyat|ücret|tutar)/i.test(around) && !/(cm|en|boy|ölçü)/i.test(around)) return false;
  if (/(sipariş|siparis|takip)/i.test(around) && !/(cm|en|boy|ölçü)/i.test(around)) return false;
  return true;
}

/**
 * Metindeki ölçü ifadelerini çıkarır.
 * `current` yalnızca "250 aldım 195 olsun" gibi eski/yeni ölçü ayrımı varsa dolar.
 */
export function parseSizeRequest(rawText: string): SizeRequest {
  const text = turkishLower(rawText ?? "");
  if (!text.trim()) return { ...EMPTY_REQUEST };

  // 1a) "250 ye 200 aldım ama 195 olsun boyu" → mevcut çift + tek eksen değişimi
  const changeWithBase =
    /(\d{2,4})\s*(?:cm)?\s*['’]?\s*(?:ye|ya|x|×|[-–/])\s*(\d{2,4})\s*(?:cm)?\s*(?:ald[ıi]m|sipari[şs])\D{0,40}?(\d{2,4})\s*(?:cm)?\s*(?:olsun|olacak|yap[a-zçğıöşü]*)/.exec(text);
  if (changeWithBase) {
    const baseWidth = Number(changeWithBase[1]);
    const baseHeight = Number(changeWithBase[2]);
    const newValue = Number(changeWithBase[3]);
    const after = text.slice(changeWithBase.index, changeWithBase.index + changeWithBase[0].length + 25);
    const axis = /\bboy[a-zçğıöşü]*/.test(after) ? "height" : /\ben[a-zçğıöşü]*/.test(after) ? "width" : null;
    if (axis) {
      return {
        requested: { width: axis === "width" ? newValue : baseWidth, height: axis === "height" ? newValue : baseHeight },
        current: { width: baseWidth, height: baseHeight },
        single: null,
        orientation: "EN_BOY",
        ambiguous: null,
        evidence: `${changeWithBase[1]}x${changeWithBase[2]} → ${newValue} (${changeWithBase[0].trim()})`,
      };
    }
  }

  // 1) Sipariş sonrası: "250 aldım 195 olsun"
  const change = /(\d{2,4})\s*(?:cm)?\s*(?:ald[ıi]m|aldim|sipari[şs])\D{0,40}?(\d{2,4})\s*(?:cm)?\s*(?:olsun|olacak|yap[ıi]n|yapabilir)/.exec(text);
  if (change) {
    const current = Number(change[1]);
    const requested = Number(change[2]);
    if (isPlausibleDimension(current, change[1], text, change.index) && isPlausibleDimension(requested, change[2], text, change.index)) {
      const after = text.slice(change.index, change.index + change[0].length + 25);
      const axisWord = /\bboy[a-zçğıöşü]*/.test(after) ? "height" : /\ben[a-zçğıöşü]*/.test(after) ? "width" : null;
      if (axisWord) {
        const width = axisWord === "width" ? requested : current;
        const height = axisWord === "height" ? requested : current;
        return {
          requested: { width, height },
          current: null,
          single: null,
          orientation: "EN_BOY",
          ambiguous: null,
          evidence: `${change[1]} → ${change[2]} (${change[0].trim()})`,
        };
      }
      // Hangi ölçünün değiştiği (EN mi BOY mu) metinden kesin değil: tek değer + belirsizlik.
      return {
        requested: null,
        current: null,
        single: { value: requested, role: "requested" },
        orientation: "EN_BOY",
        ambiguous: "AXIS_UNKNOWN",
        evidence: `${change[1]} → ${change[2]} (${change[0].trim()})`,
      };
    }
  }

  // 1b) "150-260 sipariş ettim, 135-260 yapma şansınız var mı" → son ölçü istenen
  const pairs = [...text.matchAll(/(\d{2,4})\s*(?:cm)?\s*[-–/]\s*(\d{2,4})\s*(?:cm)?/g)].filter(
    (match) => isPlausibleDimension(Number(match[1]), match[1], text, match.index ?? 0) &&
      isPlausibleDimension(Number(match[2]), match[2], text, match.index ?? 0),
  );
  if (pairs.length >= 2) {
    // Birden fazla ölçü geçiyor: hangisinin istendiği kesin değil, hepsi birlikte sorulmalı.
    return {
      requested: null,
      current: null,
      single: null,
      orientation: "EN_BOY",
      ambiguous: "MULTI_SIZE",
      evidence: pairs.map((match) => match[0].trim()).join(" | "),
    };
  }

  // 2) İki ölçü: "260 x 220", "260×220", "150-260", "250 ye 180", "250'ye 180"
  const pair =
    /(\d{2,4})\s*(?:cm)?\s*[x×*]\s*(\d{2,4})/.exec(text) ??
    /(\d{2,4})\s*(?:cm)?\s*['’]?\s*(?:ye|ya)\s*(\d{2,4})/.exec(text) ??
    /(\d{2,4})\s*(?:cm)?\s*[-–/]\s*(\d{2,4})\s*(?:cm)?/.exec(text);
  if (pair) {
    const first = Number(pair[1]);
    const second = Number(pair[2]);
    if (isPlausibleDimension(first, pair[1], text, pair.index) && isPlausibleDimension(second, pair[2], text, pair.index)) {
      return {
        requested: { width: first, height: second },
        current: null,
        single: null,
        orientation: "EN_BOY",
        ambiguous: null,
        evidence: pair[0].trim(),
      };
    }
  }

  // 3) "en 180 boy 100" / "eni 180 boyu 100" / "220 en 160 boy"
  const enBoy = /(?:en[ıi]?|geni[şs]li[ğg]i?)\s*[:\s]\s*(\d{2,4})[^\d]{0,12}(?:boy[u]?|y[üu]ksekli[ğg]i?)\s*[:\s]\s*(\d{2,4})/.exec(text);
  if (enBoy) {
    const width = Number(enBoy[1]);
    const height = Number(enBoy[2]);
    if (isPlausibleDimension(width, enBoy[1], text, enBoy.index) && isPlausibleDimension(height, enBoy[2], text, enBoy.index)) {
      return {
        requested: { width, height },
        current: null,
        single: null,
        orientation: "EN_BOY",
        ambiguous: null,
        evidence: enBoy[0].trim(),
      };
    }
  }

  const boyEn = /(?:boy[u]?|y[üu]ksekli[ğg]i?)\s*[:\s]\s*(\d{2,4})[^\d]{0,12}(?:en[ıi]?|geni[şs]li[ğg]i?)\s*[:\s]\s*(\d{2,4})/.exec(text);
  if (boyEn) {
    const height = Number(boyEn[1]);
    const width = Number(boyEn[2]);
    if (isPlausibleDimension(width, boyEn[2], text, boyEn.index) && isPlausibleDimension(height, boyEn[1], text, boyEn.index)) {
      return {
        requested: { width, height },
        current: null,
        single: null,
        orientation: "BOY_EN",
        ambiguous: null,
        evidence: boyEn[0].trim(),
      };
    }
  }

  // 4) "220en 160boy"
  const glued = /(\d{2,4})\s*en\b[^\d]{0,6}(\d{2,4})\s*boy/.exec(text);
  if (glued) {
    const width = Number(glued[1]);
    const height = Number(glued[2]);
    if (isPlausibleDimension(width, glued[1], text, glued.index) && isPlausibleDimension(height, glued[2], text, glued.index)) {
      return {
        requested: { width, height },
        current: null,
        single: null,
        orientation: "EN_BOY",
        ambiguous: null,
        evidence: glued[0].trim(),
      };
    }
  }

  // 5) Metre: "2 metreye 2 metre", "2 metreye iki metre", "iki metreye iki metre"
  const metrePair =
    /(\d+(?:[.,]\d+)?|[a-zçğıöşü]+(?:\s*(?:buçuk|bucuk))?)\s*metre[a-zçğıöşü]*[^a-zçğıöşü\d]{0,8}(\d+(?:[.,]\d+)?|[a-zçğıöşü]+(?:\s*(?:buçuk|bucuk))?)\s*metre/.exec(text);
  if (metrePair) {
    const first = parseNumberToken(metrePair[1]);
    const second = parseNumberToken(metrePair[2]);
    if (first !== null && second !== null) {
      const width = Math.round(first * 100);
      const height = Math.round(second * 100);
      if (width >= 20 && width <= 1000 && height >= 20 && height <= 1000) {
        return {
          requested: { width, height },
          current: null,
          single: null,
          orientation: "EN_BOY",
          ambiguous: null,
          evidence: metrePair[0].trim(),
        };
      }
    }
  }

  // 6) Tek ölçü: "ikibucuk metre", "250 cm"
  const singleMetre = /(\d+(?:[.,]\d+)?|[a-zçğıöşü]+(?:\s*(?:buçuk|bucuk))?)\s*metre/.exec(text);
  if (singleMetre) {
    const value = parseNumberToken(singleMetre[1]);
    if (value !== null) {
      const cm = Math.round(value * 100);
      if (cm >= 20 && cm <= 1000) {
        return {
          requested: null,
          current: null,
          single: { value: cm, role: "requested" },
          orientation: "EN_BOY",
          ambiguous: "SECOND_DIMENSION_MISSING",
          evidence: singleMetre[0].trim(),
        };
      }
    }
  }

  const singleCm = /(?:^|[^\d])(\d{2,4})\s*(?:cm|santim)\b/.exec(text);
  if (singleCm) {
    const value = Number(singleCm[1]);
    if (isPlausibleDimension(value, singleCm[1], text, singleCm.index)) {
      return {
        requested: null,
        current: null,
        single: { value, role: "requested" },
        orientation: "EN_BOY",
        ambiguous: "SECOND_DIMENSION_MISSING",
        evidence: singleCm[0].trim(),
      };
    }
  }

  return { ...EMPTY_REQUEST };
}

/** Metinde geçen "W x H" ölçü etiketlerini normalize eder (160x265 gibi). */
export function sizeLabelsIn(text: string): string[] {
  const labels = new Set<string>();
  const regex = /(\d{2,4})\s*(?:cm)?\s*[x×*]\s*(\d{2,4})/g;
  for (const match of text.matchAll(regex)) {
    labels.add(`${Number(match[1])}x${Number(match[2])}`);
  }

  // "130/180", "150-260" gibi çiftler de ölçü sayılır (tarih/uzun sayı hariç).
  const pairRegex = /(\d{2,4})\s*[-/]\s*(\d{2,4})(?!\d)/g;
  for (const match of text.matchAll(pairRegex)) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width < 20 || height < 20 || width > 1000 || height > 1000) continue;
    if (width >= 1990 && width <= 2100) continue;
    labels.add(`${width}x${height}`);
  }
  return [...labels];
}

/** Geriye dönük uyumluluk: yalnızca iki ekseni de bilinen ölçüyü döner. */
export function extractRequestedSize(text: string): { width: number; height: number } | null {
  return parseSizeRequest(text).requested;
}

/** "260 x 260", "260x220 cm" gibi katalog etiketlerini ayrıştırır. */
export function parseSizeLabel(value: string): VariantSize | null {
  const match = /(\d{2,4})\s*(?:cm)?\s*[x×*]\s*(\d{2,4})\s*(?:cm)?/i.exec(value.trim());
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 20 || height < 20 || width > 1000 || height > 1000) return null;

  return { width, height, label: `${width} x ${height}` };
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
    const name = turkishLower(record.name);
    if (!name.includes("boyut") && !name.includes("ebat") && name !== "ölçü" && name !== "olcu") continue;

    const parsed = parseSizeLabel(record.value);
    if (!parsed) continue;
    if (seen.has(parsed.label)) continue;
    seen.add(parsed.label);
    sizes.push(parsed);
  }

  return sizes.sort((a, b) => a.width * a.height - b.width * b.height);
}

export function analyzeRequestedSize(sizes: VariantSize[], requested: { width: number; height: number }): SizeAnalysis {
  const exact = sizes.find((size) => size.width === requested.width && size.height === requested.height) ?? null;

  const shrinkCandidates = exact
    ? []
    : sizes.filter(
        (size) =>
          size.width >= requested.width &&
          size.height >= requested.height &&
          (size.width > requested.width || size.height > requested.height),
      );

  return { requested, variantCount: sizes.length, exact, shrinkCandidates, hasData: sizes.length > 0 };
}

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

/** Ölçü ifadesi belirsizse modele verilecek netleştirme notu. */
export function describeSizeAmbiguity(request: SizeRequest): string | null {
  if (request.ambiguous === "SECOND_DIMENSION_MISSING") {
    return `Müşteri tek ölçü verdi${request.single ? ` (${request.single.value} cm)` : ""}. İkinci ölçü ve hangi yöne (EN mi BOY mu) ait olduğu belli değil; UYDURMA, yalnızca bu bilgiyi netleştir.`;
  }
  if (request.ambiguous === "MULTI_SIZE") {
    return "Müşteri birden fazla ölçü verdi; hangisinin sipariş/istenen ölçü olduğu net değil. Hangi ölçü için işlem yapılacağını sor, tek ölçü seçip onaylama.";
  }
  if (request.ambiguous === "AXIS_UNKNOWN") {
    return "Müşteri eski ve yeni ölçüyü verdi ancak hangisinin EN, hangisinin BOY olduğu net değil; değişikliğin hangi yöne yapılacağını sor, uydurma.";
  }
  return null;
}
