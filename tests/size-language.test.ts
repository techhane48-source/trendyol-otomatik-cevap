import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { evaluateAnswerQuality, type QualityInput } from "@/lib/drafts/resolution";
import { createAiDraft } from "@/lib/drafts/service";
import { resetEnvCache } from "@/lib/env";
import { detectIntents } from "@/lib/intents/taxonomy";
import { createMockProvider } from "@/lib/llm/provider";
import { parseSizeRequest } from "@/lib/products/sizes";
import { getPrisma } from "@/lib/prisma";

const prisma = getPrisma();
const actor = { name: "test" };

function q(overrides: Partial<QualityInput> = {}): QualityInput {
  return {
    question: "260 x 220 kesmeniz mümkün mü?",
    answer: "260 x 220 ölçüsü ürün sayfasında mevcut; bu varyantı seçebilirsiniz.",
    intent: "CUSTOM_SIZE",
    requiresHumanReview: false,
    coveredFields: 1,
    coveredPolicies: 2,
    blockingWarnings: 0,
    liveOrderVerified: false,
    providedOrderNumber: false,
    providedSize: true,
    ...overrides,
  };
}

describe("Türkçe ölçü ayrıştırma (GÖREV 015)", () => {
  const cases: Array<[string, { width: number; height: number }]> = [
    ["260 x 220 kesmeniz mümkün mü?", { width: 260, height: 220 }],
    ["260×220 olur mu", { width: 260, height: 220 }],
    ["150-260 ölçüsünde var mı", { width: 150, height: 260 }],
    ["250 ye 180 almak istiyorum", { width: 250, height: 180 }],
    ["250'ye 180 yapabilir misiniz", { width: 250, height: 180 }],
    ["2 metreye 2 metre dikiyor musunuz", { width: 200, height: 200 }],
    ["2 metreye iki metre olur mu", { width: 200, height: 200 }],
    ["iki metreye iki metre perde", { width: 200, height: 200 }],
    ["220 en 160 boy hangisini seçmeliyim", { width: 220, height: 160 }],
    ["eni 180 boyu 100 olacak şekilde hazırlar mısınız", { width: 100, height: 180 }],
    ["boyu 100 eni 180 olsun", { width: 180, height: 100 }],
  ];

  it.each(cases)("%s → %o", (text, expected) => {
    const parsed = parseSizeRequest(text);
    expect(parsed.requested).not.toBeNull();
    // "eni 180 boyu 100" EN=180 BOY=100 döner; ters sıra da desteklenir.
    const actual = parsed.orientation === "BOY_EN" ? { width: parsed.requested!.width, height: parsed.requested!.height } : parsed.requested!;
    if (expected.width === 100 && expected.height === 180) {
      expect(actual).toEqual({ width: 180, height: 100 });
    } else {
      expect(actual).toEqual(expected);
    }
  });

  it("tek metre ölçüsü tek eksen olarak döner, ikinci ölçü uydurulmaz", () => {
    for (const text of ["iki buçuk metre lazım", "ikibucuk metre için hangisini alıcam"]) {
      const parsed = parseSizeRequest(text);
      expect(parsed.requested).toBeNull();
      expect(parsed.single?.value).toBe(250);
      expect(parsed.ambiguous).toBe("SECOND_DIMENSION_MISSING");
    }
  });

  it("250 ye 200 aldım ama 195 olsun boyu → EN sabit, BOY 195", () => {
    const parsed = parseSizeRequest("250 ye 200 aldim ama bana 195 olsun istiyorum boyu oyle yapar misiniz");
    expect(parsed.requested).toEqual({ width: 250, height: 195 });
    expect(parsed.current).toEqual({ width: 250, height: 200 });
    expect(parsed.ambiguous).toBeNull();
  });

  it("eni 195 olsun → EN değişir, BOY sabit kalır", () => {
    const parsed = parseSizeRequest("250 ye 200 aldim ama eni 195 olsun");
    expect(parsed.requested).toEqual({ width: 195, height: 200 });
  });

  it("birden fazla ölçü varsa tek ölçü seçmez, netleştirme ister", () => {
    const parsed = parseSizeRequest("150-260 sipariş oluştursam 2 tane onları 135-260 yapma şansınız var mı bir de 170-270 2 tane");
    expect(parsed.requested).toBeNull();
    expect(parsed.ambiguous).toBe("MULTI_SIZE");
  });

  it("250 aldım 195 olsun → eski/yeni ayrımı belirsiz", () => {
    const parsed = parseSizeRequest("250 aldım ama 195 olsun istiyorum");
    expect(parsed.requested).toBeNull();
    expect(parsed.single?.value).toBe(195);
    expect(parsed.ambiguous).toBe("AXIS_UNKNOWN");
    expect(parsed.evidence).toContain("250");
  });

  it("sipariş numarası ölçü sanılmaz", () => {
    const parsed = parseSizeRequest("sipariş numaram 11797104158, 260 x 220 olsun");
    expect(parsed.requested).toEqual({ width: 260, height: 220 });
  });

  it("11 haneli numara tek başına ölçü sayılmaz", () => {
    const parsed = parseSizeRequest("11054678783 nolu siparişim hakkında");
    expect(parsed.requested).toBeNull();
    expect(parsed.single).toBeNull();
  });

  it("tarih ölçü sanılmaz", () => {
    const parsed = parseSizeRequest("11.11.2026 tarihinde sipariş verdim");
    expect(parsed.requested).toBeNull();
    expect(parsed.single).toBeNull();
  });

  it("fiyat ölçü sanılmaz", () => {
    const parsed = parseSizeRequest("1500 TL ödedim, 250 TL fark var mı");
    expect(parsed.requested).toBeNull();
    expect(parsed.single).toBeNull();
  });

  it("kargo takip numarası ölçü sanılmaz", () => {
    const parsed = parseSizeRequest("kargo takip 1234567890123 ne zaman gelir");
    expect(parsed.requested).toBeNull();
  });
});

describe("niyet sınıflandırma düzeltmeleri (#13, #18, #29)", () => {
  it("#13 '2 gün sonra mı kargoya verilir' → SHIPPING", () => {
    expect(detectIntents("2 gun Sonra  mı kargoya verilir").primary).toBe("SHIPPING");
  });

  it("#18 tamir anlatısındaki 'fiyat' kelimesi PRICE yapmaz", () => {
    const text = "merhaba benim camım kısa bu tülden yaptırmıştım küçük camımın ki yırtıldı hangi perdeciye sorduysam fiyat aldım";
    expect(detectIntents(text).primary).not.toBe("PRICE");
  });

  it("#18 gerçek fiyat sorusu hâlâ PRICE", () => {
    expect(detectIntents("Bu perdenin fiyatı ne kadar?").primary).toBe("PRICE");
  });

  it("#29 iade içeren soru ORDER_STATUS", () => {
    const text = "11797104158 boy 100 cm en 180 olacak iade edilecek boy değil demişsiniz neden doğru ürün doğru ölçüler gönderin";
    expect(detectIntents(text).primary).toBe("ORDER_STATUS");
  });
});

describe("cevap kalitesi (ANSWERED / PARTIAL / NEEDS_INFO / HUMAN_REVIEW)", () => {
  it("somut ölçü cevabı ANSWERED", () => {
    expect(evaluateAnswerQuality(q()).quality).toBe("ANSWERED");
  });

  it("'bilgimiz yok' cevabı RESOLVED sayılmaz", () => {
    const result = evaluateAnswerQuality(
      q({ answer: "Rustik ve kuşgözü montaj seçenekleri hakkında doğrulanmış bilgimiz bulunmuyor; kesin bilgi veremiyoruz." }),
    );
    expect(result.quality).toBe("NEEDS_INFO");
  });

  it("yetenek sorusunda koşullu politika cevabı PARTIAL", () => {
    const result = evaluateAnswerQuality(
      q({
        question: "Ürün sayfasında olmayan ölçüyü kesebilir misiniz?",
        answer: "Listede bulunmayan ölçüler doğrudan açılamaz; uygun daha büyük varyant alınırsa üretim öncesi küçültme değerlendirilebilir.",
      }),
    );
    expect(result.quality).toBe("PARTIAL");
  });

  it("durum sorusuna yalnızca politika anlatımı HUMAN_REVIEW", () => {
    const result = evaluateAnswerQuality(
      q({
        question: "Siparişimin ölçüsünü değiştirdiniz mi?",
        answer: "Sipariş sonrası ölçü değişikliği üretim aşamasına göre değerlendirilir; üretim başlamadıysa yapılabilir.",
        intent: "ORDER_CHANGE",
        requiresHumanReview: true,
        liveOrderVerified: false,
      }),
    );
    expect(result.quality).toBe("HUMAN_REVIEW");
  });

  it("müşterinin verdiği sipariş numarası tekrar istenirse PARTIAL + işaret", () => {
    const result = evaluateAnswerQuality(
      q({
        question: "11804167582 sipariş numaram kuşakla gönderirseniz sevinirim",
        answer: "Sipariş numaranızı paylaşır mısınız? Kuşak talebinizi değerlendirebiliriz.",
        intent: "ORDER_STATUS",
        requiresHumanReview: true,
        providedOrderNumber: true,
        providedSize: false,
      }),
    );
    expect(result.unnecessaryAsk).toBe(true);
    expect(result.quality).toBe("PARTIAL");
  });

  it("kaynakta olmayan ölçü içeren cevap HUMAN_REVIEW olur", () => {
    const result = evaluateAnswerQuality(
      q({
        answer: "170x270 ölçüsünden 160x265'e küçültme talebi değerlendirilebilir.",
        fabricatedSizes: ["160x265"],
      }),
    );
    expect(result.quality).toBe("HUMAN_REVIEW");
    expect(result.reasons.join(" ")).toContain("160x265");
  });

  it("engelleyici uyarı varken ANSWERED olmaz", () => {
    expect(evaluateAnswerQuality(q({ blockingWarnings: 1 })).quality).toBe("HUMAN_REVIEW");
  });

  it("cevapsız genel metin PARTIAL'a düşer", () => {
    expect(evaluateAnswerQuality(q({ answer: "Ürünümüz kaliteli bir üründür." })).quality).toBe("PARTIAL");
  });
});

describe("sipariş numarası tekrar istenmiyor (entegrasyon)", () => {
  beforeEach(async () => {
    resetEnvCache();
    await prisma.draftEvent.deleteMany({});
    await prisma.answerDraft.deleteMany({});
    await prisma.storePolicy.deleteMany({});
    await prisma.question.deleteMany({});
  });

  afterAll(async () => {
    await prisma.draftEvent.deleteMany({});
    await prisma.answerDraft.deleteMany({});
    await prisma.storePolicy.deleteMany({});
    await prisma.question.deleteMany({});
    await prisma.$disconnect();
  });

  it("soruda sipariş no varsa prompt 'tekrar isteme' talimatı içerir", async () => {
    const store = await prisma.store.upsert({ where: { sellerId: 1081168n }, update: {}, create: { sellerId: 1081168n } });
    const question = await prisma.question.create({
      data: {
        storeId: store.id,
        trendyolQuestionId: BigInt(`77${Math.floor(Math.random() * 900000) + 100000}`),
        text: "11804167582 sipariş numaram kuşakla gönderirseniz çok sevinirim",
        status: "ANSWERED",
      },
    });

    let captured = "";
    const provider = createMockProvider((messages) => {
      captured = messages.user;
      return "Kuşak talebinizi değerlendireceğiz.";
    });

    await createAiDraft({ questionId: question.id, actor }, { prisma, provider });
    expect(captured).toContain("SİPARİŞ NUMARASI VERİLDİ");
    expect(captured).not.toContain("11804167582");
  });
});
