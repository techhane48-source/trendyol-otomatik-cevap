/**
 * Ürün bilgi kartı ↔ soru eşleştirmesi.
 *
 * Amaç: bir varyantın bilgisi başka varyantın sorusuna karışmasın. Bu yüzden
 * eşleştirme **mağaza içinde** ve **kimlik hiyerarşisiyle** yapılır:
 *
 * 1. `EXACT_VARIANT` — aynı `storeId` + aynı `productMainId` + aynı `productId`
 * 2. `MAIN_PRODUCT`  — aynı `storeId` + aynı `productMainId`, varyant kimliği boş kayıt
 * 3. `AMBIGUOUS`     — soruda varyant kimliği yok ve aynı ana üründe birden fazla
 *                      varyant kaydı var → **tahmin edilmez**, insan kararı gerekir
 * 4. `MISSING`       — eşleşen kayıt yok
 *
 * Yalnızca `VERIFIED` kayıtlar AI girdisi olarak kullanılabilir; `DRAFT` kayıtlar
 * yalnızca "bilgi var ama doğrulanmadı" bilgisi olarak raporlanır.
 */

export type ProductMatchKind = "EXACT_VARIANT" | "MAIN_PRODUCT" | "AMBIGUOUS" | "MISSING";

export interface ProductInfoMatchRow {
  id: string;
  storeId: string;
  productMainId: string;
  productId: string | null;
  title: string | null;
  status: "DRAFT" | "VERIFIED";
}

export interface ProductMatchInput {
  storeId: string;
  productMainId: string | null;
  productId: string | null;
}

export type ProductMatchResult =
  | { kind: "EXACT_VARIANT" | "MAIN_PRODUCT"; product: ProductInfoMatchRow }
  | { kind: "AMBIGUOUS"; candidates: ProductInfoMatchRow[] }
  | { kind: "MISSING" };

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function matchProductInfo(
  question: ProductMatchInput,
  infos: ProductInfoMatchRow[],
): ProductMatchResult {
  const productMainId = normalizeId(question.productMainId);
  const productId = normalizeId(question.productId);

  // Başka mağazanın kaydı asla kullanılmaz.
  const scoped = infos.filter((info) => info.storeId === question.storeId);

  if (!productMainId) return { kind: "MISSING" };

  const sameMain = scoped.filter((info) => info.productMainId.trim() === productMainId);
  if (sameMain.length === 0) return { kind: "MISSING" };

  if (productId) {
    const exact = sameMain.filter((info) => normalizeId(info.productId) === productId);
    if (exact.length > 1) {
      return { kind: "AMBIGUOUS", candidates: exact };
    }
    if (exact.length === 1) return { kind: "EXACT_VARIANT", product: exact[0] };
  }

  const mainLevel = sameMain.filter((info) => normalizeId(info.productId) === null);
  if (mainLevel.length > 1) {
    return { kind: "AMBIGUOUS", candidates: mainLevel };
  }
  if (mainLevel.length === 1) return { kind: "MAIN_PRODUCT", product: mainLevel[0] };

  // Soruda varyant kimliği yok, ama ana ürün altında varyant kayıtları var:
  // hangisinin kastedildiği bilinmiyor → tahmin etme.
  const variants = sameMain.filter((info) => normalizeId(info.productId) !== null);
  if (!productId && variants.length > 0) {
    return { kind: "AMBIGUOUS", candidates: variants };
  }

  return { kind: "MISSING" };
}

/** Eşleştirme sonucu AI'da kullanılabilir mi? (yalnızca doğrulanmış kayıt) */
export function isUsableForDraft(result: ProductMatchResult): boolean {
  if (result.kind === "AMBIGUOUS" || result.kind === "MISSING") return false;
  return result.product.status === "VERIFIED";
}
