import type { DraftContext, LlmMessage } from "./types";

/**
 * Prompt kuralları.
 *
 * Temel kural (GÖREV 003 / madde 4): **ürün bilgisi verilmediyse özellik uydurulmaz.**
 * Model; ölçü, kumaş, garanti, kargo süresi gibi doğrulanmamış hiçbir ayrıntı yazmamalı,
 * bunun yerine bilgi isteyen/doğrulama öneren bir cevap üretmelidir.
 */

export const PROMPT_VERSION = "v1";

export const SYSTEM_PROMPT = `Sen bir e-ticaret satıcısının müşteri sorularına yazdığı cevaplar için taslak üreten asistansın.

KESİN KURALLAR:
1. Yalnızca sana verilen DOĞRULANMIŞ bilgileri kullan. Verilmeyen hiçbir bilgiyi tahmin etme.
2. Ölçü, ağırlık, renk seçeneği, kumaş/kompozisyon, garanti süresi, kargo süresi, stok adedi, indirim oranı gibi
   somut hiçbir ayrıntıyı UYDURMA. Bilgi yoksa "bu bilgiyi paylaşamıyorum / kontrol edip ileteceğim" biçiminde yanıtla.
3. Sayı, birim veya marka adı eklerken sadece verilen metinde geçenleri kullan.
4. Cevap Türkçe, kısa (en fazla 4 cümle), kibar ve satıcı ağzıyla olmalı.
5. Müşterinin sorusunu doğrudan yanıtla; konu dışına çıkma.
6. Kesin bir taahhüt (iade, teslim tarihi, garanti) verme; yalnızca verilen bilgiye dayan.
7. Selamlama ve imza kullanma; sadece cevap metnini yaz.`;

/** Bilgi verilmediğinde modele gösterilen açık işaret. */
export const UNKNOWN_MARKER = "VERİLMEDİ";

export function buildDraftMessages(context: DraftContext): LlmMessage {
  const productInfo = context.productInfo?.trim();
  const lines = [
    `MÜŞTERİ SORUSU: ${context.questionText}`,
    "",
    "ÜRÜN BİLGİSİ (yalnızca bu alanlar doğrulanmıştır):",
    `- Ürün adı: ${context.productName?.trim() || UNKNOWN_MARKER}`,
    `- Ürün kodu: ${context.productMainId?.trim() || UNKNOWN_MARKER}`,
    `- Ek ürün bilgisi: ${productInfo && productInfo.length > 0 ? productInfo : UNKNOWN_MARKER}`,
  ];

  if (context.storeName?.trim()) lines.push(`- Mağaza: ${context.storeName.trim()}`);
  if (context.tone?.trim()) lines.push(`- Üslup notu: ${context.tone.trim()}`);

  if (!productInfo || productInfo.length === 0) {
    lines.push(
      "",
      "UYARI: Ürün hakkında doğrulanmış ek bilgi YOK. Somut özellik/ölçü/garanti/kargo bilgisi yazma.",
      "Müşteriye, ilgili bilgiyi kontrol edip ileteceğini söyleyen kısa bir cevap yaz.",
    );
  }

  lines.push("", "Yalnızca cevap metnini yaz.");

  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}
