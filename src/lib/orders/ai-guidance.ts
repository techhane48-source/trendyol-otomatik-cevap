import type { DraftWarning } from "@/lib/llm/guardrails";

/**
 * Sipariş/ölçü değişikliği bağlamına göre AI taslağı kısıtları.
 *
 * Kural: AI hiçbir zaman kendi başına talep onaylamış gibi konuşamaz.
 * - "onaylandı / uygulandı" yalnızca APPROVED kayıt varsa söylenebilir.
 * - "talebinizi aldık / üretim onayı bekleniyor" yalnızca PENDING_REVIEW varsa.
 * - "yapılamıyor" yalnızca sipariş işleme alınmışsa (Picking ve sonrası).
 * - Diğer tüm durumlarda kesin vaat yok, insan incelemesine yönlendirme.
 */

export type OrderChangeState =
  | { kind: "NONE" }
  | { kind: "PENDING_REVIEW"; orderNumber: string | null; status: string | null }
  | { kind: "NEEDS_VERIFICATION"; reason: string | null }
  | { kind: "APPROVED"; orderNumber: string | null }
  | { kind: "REJECTED"; reason: string | null }
  | { kind: "INVALIDATED"; orderNumber: string | null };

export interface OrderGuidance {
  /** Taslakta kullanılabilecek en güçlü ifade */
  allowedClaim: "NONE" | "RECEIVED" | "APPROVED" | "TOO_LATE" | "REVIEW";
  /** Prompt'a eklenecek talimat */
  instruction: string;
  /** Önerilen güvenli cümle (modele örnek) */
  suggestedPhrase: string | null;
}

export function buildOrderGuidance(state: OrderChangeState): OrderGuidance {
  switch (state.kind) {
    case "APPROVED":
      return {
        allowedClaim: "APPROVED",
        instruction:
          "Sipariş için ölçü değişikliği talebi bu mağaza tarafından ONAYLANDI. Yalnızca 'talebiniz onaylandı' denilebilir; kargo/teslim tarihi vaadi verilemez.",
        suggestedPhrase: "Ölçü değişikliği talebiniz onaylandı.",
      };
    case "PENDING_REVIEW":
      return {
        allowedClaim: "RECEIVED",
        instruction:
          "Talep alındı ancak henüz ONAYLANMADI. Yalnızca 'talebinizi aldık, üretim onayı bekleniyor' denilebilir. 'Onaylandı', 'uygulanacak', 'dikkate alınacak' gibi kesin ifadeler YASAK.",
        suggestedPhrase: "Ölçü değişikliği talebinizi aldık, üretim onayı bekleniyor.",
      };
    case "NEEDS_VERIFICATION":
      return {
        allowedClaim: "REVIEW",
        instruction:
          "Talep insan incelemesinde; sipariş kalemi/sahipliği/ölçü yönü doğrulanmadı. Kesin söz verme, 'kontrol edilip bilgi verilecek' de.",
        suggestedPhrase: "Talebinizi kontrol edip size bilgi vereceğiz.",
      };
    case "REJECTED":
      return {
        allowedClaim: "TOO_LATE",
        instruction:
          "Talep reddedildi (sipariş üretime alınmış veya uygun değil). 'Ölçü değişikliği yapılamıyor' denilebilir; suçlayıcı dil kullanma.",
        suggestedPhrase: "Siparişiniz işleme alındığı için ölçü değişikliği yapamıyoruz.",
      };
    case "INVALIDATED":
      return {
        allowedClaim: "REVIEW",
        instruction:
          "Daha önce alınan talep, sipariş durumu değiştiği için geçersiz kılındı. Onay/uygulama iddiası YASAK; insan incelemesine yönlendir.",
        suggestedPhrase: "Talebiniz yeniden kontrol ediliyor; kesin bilgi veremiyoruz.",
      };
    default:
      return {
        allowedClaim: "NONE",
        instruction:
          "Bu soru için kayıtlı ölçü değişikliği talebi YOK. 'Talebinizi aldık', 'onaylandı', 'uygulanacak' gibi ifadeler YASAK. Değişiklik isteği varsa yalnızca süreci anlat.",
        suggestedPhrase: null,
      };
  }
}

const APPROVAL_CLAIM =
  /(onayland[ıi]|onaylanm[ıi][şs]|onaylad[ıi]k|uygulanacak|uyguland[ıi]|dikkate al[ıi]nacak|notunuzu ald[ıi]k|talebinizi ald[ıi]k)/i;
const REJECTION_CLAIM = /(yap[ıi]lam[ıi]yor|de[ğg]i[şs]tirilemiyor|m[üu]mk[üu]n de[ğg]il)/i;

/**
 * Taslak metnindeki sipariş/ölçü iddialarını bağlama göre denetler.
 * İhlal varsa guardrail uyarısı üretir (onay akışı bu uyarıyı kabul etmeden ilerlemez).
 */
export function detectOrderClaimViolations(text: string, state: OrderChangeState): DraftWarning[] {
  const guidance = buildOrderGuidance(state);
  const claimsApproval = APPROVAL_CLAIM.test(text);
  const claimsImpossible = REJECTION_CLAIM.test(text);
  const warnings: DraftWarning[] = [];

  if (claimsApproval && guidance.allowedClaim !== "APPROVED" && guidance.allowedClaim !== "RECEIVED") {
    warnings.push({
      kind: "PROMISE",
      phrase: "Onay/uygulama iddiası var ancak onaylı talep kaydı yok.",
    });
  }

  if (claimsApproval && guidance.allowedClaim === "RECEIVED" && /(onayland[ıi]|uygulanacak|uyguland[ıi])/i.test(text)) {
    warnings.push({
      kind: "PROMISE",
      phrase: "Talep yalnızca alındı; 'onaylandı/uygulanacak' ifadesi kullanılamaz.",
    });
  }

  if (claimsImpossible && guidance.allowedClaim !== "TOO_LATE") {
    warnings.push({
      kind: "PROMISE",
      phrase: "Sipariş durumu doğrulanmadan 'yapılamıyor' denemez.",
    });
  }

  return warnings;
}
