import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DraftAccessError,
  DraftError,
  DraftWarningsUnacknowledgedError,
  approveDraft,
  createAiDraft,
  editDraft,
  getDraftHistory,
  rejectDraft,
} from "@/lib/drafts/service";
import { resetEnvCache } from "@/lib/env";
import { createMockProvider } from "@/lib/llm/provider";
import { LlmNotConfiguredError, LlmRequestError } from "@/lib/llm/types";
import { createProductInfo, verifyProductInfo } from "@/lib/products/service";
import { disconnectPrisma, getPrisma } from "@/lib/prisma";

const prisma = getPrisma();
const actor = { name: "onaylayan-kisi" };

const provider = createMockProvider(
  () => "Merhaba, sorunuz için teşekkür ederiz. İlgili bilgiyi kontrol edip size ileteceğiz.",
);

async function resetDatabase(): Promise<void> {
  await prisma.qualityItem.deleteMany();
  await prisma.qualityRun.deleteMany();
  await prisma.qualitySet.deleteMany();
  await prisma.llmUsage.deleteMany();
  await prisma.draftEvent.deleteMany();
  await prisma.answerDraft.deleteMany();
  await prisma.productInfoEvent.deleteMany();
  await prisma.productInfo.deleteMany();
  await prisma.question.deleteMany();
  await prisma.store.deleteMany();
}

async function seedQuestion(
  overrides: { productName?: string | null; productMainId?: string | null; productId?: string | null } = {},
): Promise<string> {
  const store = await prisma.store.create({ data: { sellerId: 1081168n } });
  const question = await prisma.question.create({
    data: {
      storeId: store.id,
      trendyolQuestionId: 900001n,
      // Ürün bilgisi gerektirmeyen kategori: bu dosya onay/revizyon mekaniğini test eder.
      // Ürün bilgisi eksikliği NEEDS_INFO davranışı product-bank.test.ts içinde test edilir.
      text: "Siparişim ne zaman kargoya verilir?",
      status: "WAITING_FOR_ANSWER",
      rawStatus: "WAITING_FOR_ANSWER",
      productName: overrides.productName === undefined ? "Nevresim Takımı" : overrides.productName,
      productMainId: overrides.productMainId === undefined ? "MAIN-1" : overrides.productMainId,
      productId: overrides.productId === undefined ? "VAR-1" : overrides.productId,
      askedAt: new Date("2026-11-01T09:00:00Z"),
    },
  });
  return question.id;
}

beforeEach(async () => {
  process.env.LLM_PROVIDER = "mock";
  process.env.ADMIN_ACTOR_NAME = "onaylayan-kisi";
  resetEnvCache();
  await resetDatabase();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("AI taslağı oluşturma", () => {
  it("ilk revizyonu PENDING olarak kaydeder ve denetim kaydı yazar", async () => {
    const questionId = await seedQuestion();

    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    expect(draft.revision).toBe(1);
    expect(draft.status).toBe("PENDING");
    expect(draft.source).toBe("AI");
    expect(draft.model).toBe("mock-model");
    expect(draft.promptVersion).toBe("v2-intent");
    expect(draft.createdBy).toBe("onaylayan-kisi");

    const events = await prisma.draftEvent.findMany({ where: { draftId: draft.id } });
    expect(events.map((event) => event.action)).toEqual(["CREATED"]);
    expect(events[0].actor).toBe("onaylayan-kisi");
  });

  it("ürün bilgisi yokken üretilen somut iddiaları uyarı olarak saklar", async () => {
    const questionId = await seedQuestion();
    const fabricating = createMockProvider(() => "Ürün 200 cm genişliğinde ve 2 yıl garantilidir.");

    const draft = await createAiDraft({ questionId, actor }, { prisma, provider: fabricating });

    expect(draft.warnings.length).toBeGreaterThan(0);
    expect(draft.warnings.map((warning) => warning.kind)).toContain("MEASUREMENT");
  });

  it("verilen ürün bilgisiyle çelişmeyen taslakta uyarı üretmez", async () => {
    const questionId = await seedQuestion();
    const grounded = createMockProvider(() => "Ürün 200 cm genişliğindedir.");

    const draft = await createAiDraft(
      { questionId, actor, productInfo: "200 cm genişlik" },
      { prisma, provider: grounded },
    );

    expect(draft.warnings).toHaveLength(0);
  });

  it("sağlayıcı hata verirse hiçbir taslak kaydı oluşmaz", async () => {
    const questionId = await seedQuestion();
    const failing = createMockProvider(() => {
      throw new LlmRequestError("NETWORK", "LLM sağlayıcısına ulaşılamadı.");
    });

    await expect(createAiDraft({ questionId, actor }, { prisma, provider: failing })).rejects.toBeInstanceOf(
      LlmRequestError,
    );
    expect(await prisma.answerDraft.count()).toBe(0);
  });

  it("LLM yapılandırılmamışsa açık hata verir ve kayıt yazmaz", async () => {
    const questionId = await seedQuestion();
    process.env.LLM_PROVIDER = "disabled";
    resetEnvCache();

    await expect(createAiDraft({ questionId, actor }, { prisma })).rejects.toBeInstanceOf(
      LlmNotConfiguredError,
    );
    expect(await prisma.answerDraft.count()).toBe(0);
  });

  it("aktör yoksa yetkisiz hata verir", async () => {
    const questionId = await seedQuestion();

    await expect(
      createAiDraft({ questionId, actor: { name: "   " } }, { prisma, provider }),
    ).rejects.toBeInstanceOf(DraftAccessError);
  });

  it("olmayan soru için hata verir", async () => {
    await expect(
      createAiDraft({ questionId: "yok", actor }, { prisma, provider }),
    ).rejects.toBeInstanceOf(DraftError);
  });
});

describe("düzenleme ve geçmiş", () => {
  it("düzenleme yeni revizyon açar, eski revizyon SUPERSEDED olarak korunur", async () => {
    const questionId = await seedQuestion();
    const first = await createAiDraft({ questionId, actor }, { prisma, provider });

    const second = await editDraft(
      { draftId: first.id, text: "Ölçüler ürün açıklamasında yer alıyor.", actor, note: "kısaltıldı" },
      { prisma },
    );

    expect(second.revision).toBe(2);
    expect(second.source).toBe("HUMAN_EDIT");
    expect(second.text).toBe("Ölçüler ürün açıklamasında yer alıyor.");

    const old = await prisma.answerDraft.findUniqueOrThrow({ where: { id: first.id } });
    expect(old.status).toBe("SUPERSEDED");
    expect(old.text).toBe(first.text);

    const history = await getDraftHistory(questionId, { prisma });
    expect(history).toHaveLength(2);
    expect(history.map((item) => item.revision)).toEqual([1, 2]);
    expect(history[0].history.map((event) => event.action)).toEqual(["CREATED", "SUPERSEDED"]);
    expect(history[1].history.map((event) => event.action)).toEqual(["EDITED"]);
  });

  it("onaylanmış taslak düzenlenemez", async () => {
    const questionId = await seedQuestion();
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });
    await approveDraft({ draftId: draft.id, actor }, { prisma });

    await expect(
      editDraft({ draftId: draft.id, text: "Yeni metin denemesi", actor }, { prisma }),
    ).rejects.toMatchObject({ code: "DRAFT_LOCKED" });
  });

  it("çok kısa metni reddeder", async () => {
    const questionId = await seedQuestion();
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    await expect(editDraft({ draftId: draft.id, text: "ok", actor }, { prisma })).rejects.toMatchObject({
      code: "INVALID_TEXT",
    });
  });

  it("yeni AI taslağı önceki bekleyen revizyonu geçersiz kılar", async () => {
    const questionId = await seedQuestion();
    const first = await createAiDraft({ questionId, actor }, { prisma, provider });
    const second = await createAiDraft({ questionId, actor }, { prisma, provider });

    expect(second.revision).toBe(2);
    const old = await prisma.answerDraft.findUniqueOrThrow({ where: { id: first.id } });
    expect(old.status).toBe("SUPERSEDED");
  });
});

describe("onaylama ve reddetme", () => {
  it("onaylayan kişiyi ve zamanı kaydeder; Trendyol'a istek atmaz", async () => {
    const questionId = await seedQuestion();
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const approved = await approveDraft({ draftId: draft.id, actor, note: "uygun" }, { prisma });

    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedBy).toBe("onaylayan-kisi");
    expect(approved.approvedAt).toBeInstanceOf(Date);
    expect(approved.reviewNote).toBe("uygun");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    const events = await prisma.draftEvent.findMany({ where: { draftId: draft.id } });
    expect(events.map((event) => event.action)).toEqual(["CREATED", "APPROVED"]);
  });

  it("guardrail uyarısı olan taslak açık kabul olmadan onaylanamaz", async () => {
    const questionId = await seedQuestion();
    const fabricating = createMockProvider(() => "Ürün 200 cm genişliğindedir.");
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider: fabricating });

    await expect(approveDraft({ draftId: draft.id, actor }, { prisma })).rejects.toBeInstanceOf(
      DraftWarningsUnacknowledgedError,
    );

    const approved = await approveDraft(
      { draftId: draft.id, actor, acknowledgeWarnings: true, note: "ölçü teyit edildi" },
      { prisma },
    );
    expect(approved.status).toBe("APPROVED");
    expect(approved.reviewNote).toContain("guardrail uyarısı kabul edildi");
  });

  it("yeni revizyon onaylandığında önceki onay SUPERSEDED olur, geçmiş korunur", async () => {
    const questionId = await seedQuestion();
    const first = await createAiDraft({ questionId, actor }, { prisma, provider });
    await approveDraft({ draftId: first.id, actor }, { prisma });

    const second = await createAiDraft({ questionId, actor }, { prisma, provider });
    await approveDraft({ draftId: second.id, actor }, { prisma });

    const rows = await prisma.answerDraft.findMany({ where: { questionId }, orderBy: { revision: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("SUPERSEDED");
    expect(rows[1].status).toBe("APPROVED");
    // Onay bilgisi geçmişte kalır (silinmez)
    expect(rows[0].approvedBy).toBe("onaylayan-kisi");
  });

  it("reddedilen taslak onaylanamaz, reddeden ve zaman kaydedilir", async () => {
    const questionId = await seedQuestion();
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    const rejected = await rejectDraft({ draftId: draft.id, actor, note: "eksik" }, { prisma });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.rejectedBy).toBe("onaylayan-kisi");
    expect(rejected.rejectedAt).toBeInstanceOf(Date);

    await expect(approveDraft({ draftId: draft.id, actor }, { prisma })).rejects.toMatchObject({
      code: "DRAFT_REJECTED",
    });
  });

  it("geçersiz kılınmış (SUPERSEDED) taslak onaylanamaz", async () => {
    const questionId = await seedQuestion();
    const first = await createAiDraft({ questionId, actor }, { prisma, provider });
    await createAiDraft({ questionId, actor }, { prisma, provider });

    await expect(approveDraft({ draftId: first.id, actor }, { prisma })).rejects.toMatchObject({
      code: "DRAFT_SUPERSEDED",
    });
  });

  it("aynı taslak iki kez onaylanamaz", async () => {
    const questionId = await seedQuestion();
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });
    await approveDraft({ draftId: draft.id, actor }, { prisma });

    await expect(approveDraft({ draftId: draft.id, actor }, { prisma })).rejects.toMatchObject({
      code: "ALREADY_APPROVED",
    });
  });

  it("yetkisiz (aktörsüz) onay reddedilir", async () => {
    const questionId = await seedQuestion();
    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    await expect(
      approveDraft({ draftId: draft.id, actor: { name: "" } }, { prisma }),
    ).rejects.toBeInstanceOf(DraftAccessError);
  });
});

describe("ürün bilgisi entegrasyonu", () => {
  async function seedCardFor(
    questionId: string,
    options: { attributes: Array<{ label: string; value: string }>; verify?: boolean; productId?: string | null },
  ) {
    const question = await prisma.question.findUniqueOrThrow({ where: { id: questionId } });
    const card = await createProductInfo(
      {
        storeId: question.storeId,
        productMainId: question.productMainId as string,
        productId: options.productId === undefined ? question.productId : options.productId,
        title: question.productName,
        attributes: options.attributes,
        actor,
      },
      { prisma },
    );

    if (options.verify !== false) {
      return verifyProductInfo({ id: card.id, actor }, { prisma });
    }
    return card;
  }

  it("doğrulanmış kart bilgisi prompt'a girer ve taslakta kaynak olarak saklanır", async () => {
    const questionId = await seedQuestion();
    const card = await seedCardFor(questionId, {
      attributes: [
        { label: "Kumaş", value: "Bambu dokulu tül" },
        { label: "Karartma", value: "Blackout değil" },
      ],
    });

    let capturedPrompt = "";
    const capturing = createMockProvider((messages) => {
      capturedPrompt = messages.user;
      return "Ürünümüz blackout değildir; bambu dokulu tüldür.";
    });

    const draft = await createAiDraft({ questionId, actor }, { prisma, provider: capturing });

    expect(capturedPrompt).toContain("Bambu dokulu tül");
    expect(capturedPrompt).not.toContain("doğrulanmış ek bilgi YOK");

    expect(draft.productInfoId).toBe(card.id);
    expect(draft.productMatch).toBe("EXACT_VARIANT");
    expect(draft.usedFacts).toHaveLength(2);
    expect(draft.usedFacts[0].source).toBe("VERIFIED_CARD");
    // Doğrulanmış kartta bile alan bazlı eksikler raporlanır; "bilgi yok" uyarısı olmamalı.
    expect(draft.missingInfo).not.toContain("Doğrulanmış ürün özelliği bulunmuyor.");
  });

  it("doğrulanmamış kart kullanılmaz ve eksik olarak raporlanır", async () => {
    const questionId = await seedQuestion();
    await seedCardFor(questionId, {
      attributes: [{ label: "Kumaş", value: "Bambu dokulu tül" }],
      verify: false,
    });

    let capturedPrompt = "";
    const capturing = createMockProvider((messages) => {
      capturedPrompt = messages.user;
      return "Bilgiyi kontrol edip ileteceğiz.";
    });

    const draft = await createAiDraft({ questionId, actor }, { prisma, provider: capturing });

    expect(capturedPrompt).toContain("Ek ürün bilgisi: VERİLMEDİ");
    expect(draft.productInfoId).toBeNull();
    expect(draft.productMatch).toBe("EXACT_VARIANT");
    expect(draft.usedFacts).toHaveLength(0);
    expect(draft.missingInfo.join(" ")).toContain("doğrulanmamış");
  });

  it("varyant belirsizse bilgi kullanılmaz (AMBIGUOUS)", async () => {
    const questionId = await seedQuestion({ productId: null });
    const question = await prisma.question.findUniqueOrThrow({ where: { id: questionId } });

    for (const variantId of ["VAR-1", "VAR-2"]) {
      const card = await createProductInfo(
        {
          storeId: question.storeId,
          productMainId: "MAIN-1",
          productId: variantId,
          attributes: [{ label: "Kumaş", value: `Kumaş ${variantId}` }],
          actor,
        },
        { prisma },
      );
      await verifyProductInfo({ id: card.id, actor }, { prisma });
    }

    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    expect(draft.productMatch).toBe("AMBIGUOUS");
    expect(draft.productInfoId).toBeNull();
    expect(draft.usedFacts).toHaveLength(0);
    expect(draft.missingInfo.join(" ")).toContain("Varyant belirsiz");
  });

  it("başka mağazanın kartı kullanılmaz", async () => {
    const questionId = await seedQuestion();
    const otherStore = await prisma.store.create({ data: { sellerId: 2000001n } });
    const card = await createProductInfo(
      {
        storeId: otherStore.id,
        productMainId: "MAIN-1",
        productId: "VAR-1",
        attributes: [{ label: "Kumaş", value: "Başka mağaza kumaşı" }],
        actor,
      },
      { prisma },
    );
    await verifyProductInfo({ id: card.id, actor }, { prisma });

    const draft = await createAiDraft({ questionId, actor }, { prisma, provider });

    expect(draft.productMatch).toBe("MISSING");
    expect(draft.usedFacts).toHaveLength(0);
    expect(draft.productInfoId).toBeNull();
  });

  it("doğrulanmış özellik uyarı üretmez, kart dışı iddia üretir", async () => {
    const questionId = await seedQuestion();
    await seedCardFor(questionId, { attributes: [{ label: "Genişlik", value: "200 cm" }] });

    const grounded = createMockProvider(() => "Ürün 200 cm genişliğindedir.");
    const groundedDraft = await createAiDraft({ questionId, actor }, { prisma, provider: grounded });
    expect(groundedDraft.warnings).toHaveLength(0);

    const fabricating = createMockProvider(() => "Ürün 200 cm genişliğinde ve 5 yıl garantilidir.");
    const fabricatedDraft = await createAiDraft({ questionId, actor }, { prisma, provider: fabricating });
    expect(fabricatedDraft.warnings.map((warning) => warning.kind)).toContain("WARRANTY");
  });
});
