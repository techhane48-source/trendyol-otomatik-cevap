import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { isUsableForDraft, matchProductInfo, type ProductInfoMatchRow } from "@/lib/products/matching";
import {
  ProductInfoError,
  createProductInfo,
  getProductInfoHistory,
  listProductInfos,
  parseAttributesText,
  unverifyProductInfo,
  updateProductInfo,
  verifyProductInfo,
} from "@/lib/products/service";
import { disconnectPrisma, getPrisma } from "@/lib/prisma";

const prisma = getPrisma();

async function storeIdNow(): Promise<string> {
  return (await prisma.store.findFirstOrThrow()).id;
}
const actor = { name: "depo-sorumlusu" };

async function resetDatabase(): Promise<void> {
  await prisma.draftEvent.deleteMany();
  await prisma.answerDraft.deleteMany();
  await prisma.productInfoEvent.deleteMany();
  await prisma.productInfo.deleteMany();
  await prisma.question.deleteMany();
  await prisma.store.deleteMany();
}

async function seedStore(sellerId = 1081168n): Promise<string> {
  const store = await prisma.store.create({ data: { sellerId } });
  return store.id;
}

async function seedCard(
  storeId: string,
  overrides: { productMainId?: string; productId?: string | null; attributes?: { label: string; value: string }[] } = {},
) {
  return createProductInfo(
    {
      storeId,
      productMainId: overrides.productMainId ?? "MAIN-1",
      productId: overrides.productId === undefined ? null : overrides.productId,
      title: "Bambu Tül Perde",
      attributes: overrides.attributes ?? [
        { label: "Kumaş", value: "Bambu dokulu tül" },
        { label: "Karartma", value: "Blackout değil" },
      ],
      actor,
    },
    { prisma },
  );
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("parseAttributesText", () => {
  it("\"Etiket: Değer\" satırlarını ayrıştırır", () => {
    expect(parseAttributesText("Kumaş: Bambu dokulu tül\nPile = 1/3 sık pile")).toEqual([
      { label: "Kumaş", value: "Bambu dokulu tül" },
      { label: "Pile", value: "1/3 sık pile" },
    ]);
  });

  it("geçersiz satırda hata verir", () => {
    expect(() => parseAttributesText("Kumaş Bambu tül")).toThrow(ProductInfoError);
  });

  it("boş satırları yok sayar", () => {
    expect(parseAttributesText("\n\nKarartma: Blackout değil\n\n")).toEqual([
      { label: "Karartma", value: "Blackout değil" },
    ]);
  });
});

describe("ürün bilgi kartı oluşturma", () => {
  it("DRAFT olarak kaydeder ve geçmişe CREATED yazar", async () => {
    const storeId = await seedStore();

    const card = await seedCard(storeId);

    expect(card.status).toBe("DRAFT");
    expect(card.attributes).toHaveLength(2);
    expect(card.verifiedBy).toBeNull();

    const history = await getProductInfoHistory(await storeIdNow(), card.id, { prisma });
    expect(history.map((event) => event.action)).toEqual(["CREATED"]);
    expect(history[0].actor).toBe("depo-sorumlusu");
  });

  it("aynı mağaza + ürün kimliği için ikinci kaydı reddeder", async () => {
    const storeId = await seedStore();
    await seedCard(storeId);

    await expect(seedCard(storeId)).rejects.toMatchObject({ code: "DUPLICATE_PRODUCT_INFO" });
  });

  it("yetkisiz (aktörsüz) oluşturmayı reddeder", async () => {
    const storeId = await seedStore();

    await expect(
      createProductInfo(
        { storeId, productMainId: "MAIN-9", attributes: [{ label: "Kumaş", value: "Tül" }], actor: { name: " " } },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("ürün kimliği zorunludur", async () => {
    const storeId = await seedStore();

    await expect(
      createProductInfo(
        { storeId, productMainId: "   ", attributes: [{ label: "Kumaş", value: "Tül" }], actor },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: "INVALID_PRODUCT_ID" });
  });

  it("boş özellik değerini reddeder", async () => {
    const storeId = await seedStore();

    await expect(
      createProductInfo(
        { storeId, productMainId: "MAIN-2", attributes: [{ label: "Kumaş", value: "  " }], actor },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ATTRIBUTE" });
  });
});

describe("doğrulama ve değişiklik geçmişi", () => {
  it("doğrulama kim ve zaman bilgisini yazar", async () => {
    const storeId = await seedStore();
    const card = await seedCard(storeId);

    const verified = await verifyProductInfo({ id: card.id, actor, note: "tedarikçi teyidi" }, { prisma });

    expect(verified.status).toBe("VERIFIED");
    expect(verified.verifiedBy).toBe("depo-sorumlusu");
    expect(verified.verifiedAt).toBeInstanceOf(Date);

    const history = await getProductInfoHistory(await storeIdNow(), card.id, { prisma });
    expect(history.map((event) => event.action)).toEqual(["CREATED", "VERIFIED"]);
    expect(history[1].note).toBe("tedarikçi teyidi");
  });

  it("özelliksiz kart doğrulanamaz", async () => {
    const storeId = await seedStore();
    const card = await createProductInfo(
      { storeId, productMainId: "MAIN-3", attributes: [], actor },
      { prisma },
    );

    await expect(verifyProductInfo({ id: card.id, actor }, { prisma })).rejects.toMatchObject({
      code: "EMPTY_PRODUCT_INFO",
    });
  });

  it("düzenleme doğrulamayı sıfırlar ve önceki değerleri geçmişe yazar", async () => {
    const storeId = await seedStore();
    const card = await seedCard(storeId);
    await verifyProductInfo({ id: card.id, actor }, { prisma });

    const updated = await updateProductInfo(
      {
        id: card.id,
        title: "Bambu Tül Perde (yeni)",
        attributes: [{ label: "Kumaş", value: "Bambu dokulu tül" }],
        actor,
      },
      { prisma },
    );

    expect(updated.status).toBe("DRAFT");
    expect(updated.verifiedBy).toBeNull();

    const history = await getProductInfoHistory(await storeIdNow(), card.id, { prisma });
    expect(history.map((event) => event.action)).toEqual(["CREATED", "VERIFIED", "UPDATED", "UNVERIFIED"]);

    const changes = history[2].changes as {
      before?: { title?: string; attributes?: unknown[] };
      after?: { title?: string; status?: string };
    };
    expect(changes.before?.title).toBe("Bambu Tül Perde");
    expect(changes.before?.attributes).toHaveLength(2);
    expect(changes.after?.status).toBe("DRAFT");
  });

  it("doğrulama kaldırılabilir", async () => {
    const storeId = await seedStore();
    const card = await seedCard(storeId);
    await verifyProductInfo({ id: card.id, actor }, { prisma });

    const draft = await unverifyProductInfo({ id: card.id, actor, note: "yanlış bilgi" }, { prisma });

    expect(draft.status).toBe("DRAFT");
    expect(draft.verifiedAt).toBeNull();
    await expect(unverifyProductInfo({ id: card.id, actor }, { prisma })).rejects.toMatchObject({
      code: "NOT_VERIFIED",
    });
  });
});

describe("panel araması", () => {
  it("ürün kimliği, varyant kimliği ve başlıkta arar", async () => {
    const storeId = await seedStore();
    await seedCard(storeId, { productMainId: "MAIN-ABC", productId: "VAR-1" });
    await createProductInfo(
      { storeId, productMainId: "MAIN-XYZ", title: "Ahşap Perde", attributes: [{ label: "Renk", value: "Ceviz" }], actor },
      { prisma },
    );

    expect((await listProductInfos(await storeIdNow(), { query: "VAR-1" }, { prisma })).map((item) => item.productMainId)).toEqual([
      "MAIN-ABC",
    ]);
    expect((await listProductInfos(await storeIdNow(), { query: "ahşap" }, { prisma })).map((item) => item.productMainId)).toEqual([
      "MAIN-XYZ",
    ]);
    expect(await listProductInfos(await storeIdNow(), { query: "yok-böyle" }, { prisma })).toHaveLength(0);
  });

  it("duruma göre filtreler", async () => {
    const storeId = await seedStore();
    const card = await seedCard(storeId);
    await seedCard(storeId, { productMainId: "MAIN-2" });
    await verifyProductInfo({ id: card.id, actor }, { prisma });

    expect(await listProductInfos(await storeIdNow(), { status: "VERIFIED" }, { prisma })).toHaveLength(1);
    expect(await listProductInfos(await storeIdNow(), { status: "DRAFT" }, { prisma })).toHaveLength(1);
  });
});

describe("eşleştirme — varyant karışıklığı", () => {
  const storeId = "store-1";

  function row(overrides: Partial<ProductInfoMatchRow> & { id: string }): ProductInfoMatchRow {
    return {
      storeId,
      productMainId: "MAIN-1",
      productId: null,
      title: null,
      status: "VERIFIED",
      ...overrides,
    };
  }

  it("varyant kimliği eşleşiyorsa EXACT_VARIANT döner", () => {
    const result = matchProductInfo(
      { storeId, productMainId: "MAIN-1", productId: "VAR-2" },
      [row({ id: "a" }), row({ id: "b", productId: "VAR-2" })],
    );

    expect(result.kind).toBe("EXACT_VARIANT");
    if (result.kind === "EXACT_VARIANT") expect(result.product.id).toBe("b");
  });

  it("varyant kimliği yoksa ana ürün kaydı kullanılır", () => {
    const result = matchProductInfo({ storeId, productMainId: "MAIN-1", productId: null }, [row({ id: "a" })]);

    expect(result.kind).toBe("MAIN_PRODUCT");
  });

  it("varyant kimliği yok ve birden fazla varyant varsa AMBIGUOUS döner (tahmin yok)", () => {
    const result = matchProductInfo({ storeId, productMainId: "MAIN-1", productId: null }, [
      row({ id: "a", productId: "VAR-1" }),
      row({ id: "b", productId: "VAR-2" }),
    ]);

    expect(result.kind).toBe("AMBIGUOUS");
    if (result.kind === "AMBIGUOUS") expect(result.candidates).toHaveLength(2);
  });

  it("varyant kimliği eşleşmezse ana ürün kaydına düşer", () => {
    const result = matchProductInfo({ storeId, productMainId: "MAIN-1", productId: "VAR-9" }, [
      row({ id: "a" }),
      row({ id: "b", productId: "VAR-1" }),
    ]);

    expect(result.kind).toBe("MAIN_PRODUCT");
  });

  it("başka mağazanın kaydı asla kullanılmaz", () => {
    const result = matchProductInfo({ storeId, productMainId: "MAIN-1", productId: null }, [
      row({ id: "a", storeId: "store-2" }),
    ]);

    expect(result.kind).toBe("MISSING");
  });

  it("ürün kimliği yoksa MISSING döner", () => {
    const result = matchProductInfo({ storeId, productMainId: null, productId: "VAR-1" }, [
      row({ id: "a", productId: "VAR-1" }),
    ]);

    expect(result.kind).toBe("MISSING");
  });

  it("DRAFT kart taslakta kullanılamaz", () => {
    const result = matchProductInfo({ storeId, productMainId: "MAIN-1", productId: null }, [
      row({ id: "a", status: "DRAFT" }),
    ]);

    expect(result.kind).toBe("MAIN_PRODUCT");
    expect(isUsableForDraft(result)).toBe(false);
  });

  it("VERIFIED kart taslakta kullanılabilir", () => {
    const result = matchProductInfo({ storeId, productMainId: "MAIN-1", productId: null }, [row({ id: "a" })]);
    expect(isUsableForDraft(result)).toBe(true);
  });
});
