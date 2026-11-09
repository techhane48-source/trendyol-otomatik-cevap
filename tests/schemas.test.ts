import { describe, expect, it } from "vitest";

import {
  mapQuestionStatus,
  normalizeQuestion,
  parseQuestionsPage,
  toDate,
  TrendyolResponseValidationError,
} from "@/lib/trendyol/schemas";

const validQuestion = {
  id: 987654321,
  text: "Yatak ölçüsü nedir?",
  creationDate: 1_700_000_000_000,
  status: "WAITING_FOR_ANSWER",
  productName: "Pamuklu Nevresim Takımı",
  productMainId: "PRD-1",
  productId: "111",
  customerId: "222",
};

describe("Trendyol yanıt şeması", () => {
  it("gerçek yanıt biçimindeki sayfayı doğrular", () => {
    const { page, questions } = parseQuestionsPage({
      content: [validQuestion, { ...validQuestion, id: 5, status: "ANSWERED" }],
      totalPages: 1,
      totalElements: 2,
      last: true,
      size: 50,
      number: 0,
      empty: false,
    });

    expect(page.totalElements).toBe(2);
    expect(page.last).toBe(true);
    expect(questions).toHaveLength(2);
    expect(questions[0].trendyolQuestionId).toBe(987654321n);
    expect(questions[0].askedAt?.toISOString()).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("content alanı yoksa boş liste kabul edilir (esnek doğrulama)", () => {
    const { questions, page } = parseQuestionsPage({ totalPages: 0 });
    expect(page.content).toEqual([]);
    expect(questions).toEqual([]);
  });

  it("content dizi değilse doğrulama hatası verir", () => {
    expect(() => parseQuestionsPage({ content: "bozuk" })).toThrow(TrendyolResponseValidationError);
  });

  it("dokümanda olmayan ek alanlar korunur", () => {
    const question = normalizeQuestion({ ...validQuestion, bilinmeyenAlan: 42 }, 0);
    expect((question.raw as Record<string, unknown>).bilinmeyenAlan).toBe(42);
  });

  it("soru metni yoksa doğrulama hatası verir", () => {
    expect(() => normalizeQuestion({ ...validQuestion, text: undefined }, 3)).toThrow(
      /content\[3\]/,
    );
  });

  it("sayısal olmayan kimlik reddedilir", () => {
    expect(() => normalizeQuestion({ ...validQuestion, id: "abc" }, 0)).toThrow(
      TrendyolResponseValidationError,
    );
  });

  it("cevap nesnesinden metni çıkarır", () => {
    const question = normalizeQuestion(
      {
        ...validQuestion,
        status: "ANSWERED",
        answeredDate: "2026-01-05T10:00:00Z",
        answer: { text: "Ölçüler ürün açıklamasındadır." },
      },
      0,
    );

    expect(question.answerText).toBe("Ölçüler ürün açıklamasındadır.");
    expect(question.answeredAt).toBeInstanceOf(Date);
  });
});

describe("yardımcı dönüşümler", () => {
  it("epoch ms, saniye ve ISO metnini Date'e çevirir", () => {
    expect(toDate(1_700_000_000_000)?.getTime()).toBe(1_700_000_000_000);
    expect(toDate(1_700_000_000)?.getTime()).toBe(1_700_000_000_000);
    expect(toDate("2026-03-01T08:30:00Z")?.toISOString()).toBe("2026-03-01T08:30:00.000Z");
    expect(toDate(null)).toBeNull();
    expect(toDate("bozuk-tarih")).toBeNull();
  });

  it("bilinmeyen durum UNKNOWN olarak eşlenir", () => {
    expect(mapQuestionStatus("WAITING_FOR_ANSWER").status).toBe("WAITING_FOR_ANSWER");
    expect(mapQuestionStatus("ANSWERED").status).toBe("ANSWERED");
    expect(mapQuestionStatus("YENI_DURUM").status).toBe("UNKNOWN");
    expect(mapQuestionStatus(null)).toEqual({ status: "UNKNOWN", rawStatus: null });
  });
});
