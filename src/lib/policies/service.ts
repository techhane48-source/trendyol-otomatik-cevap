import type { PrismaClient } from "@/generated/prisma/client";

import { getPrisma } from "@/lib/prisma";

/**
 * Mağaza işletme politikaları (GÖREV 012).
 *
 * Ürün bilgisinden AYRI katman: "özel ölçü kabul ediliyor mu", "hangi aralıklarda",
 * "hangi dikim seçenekleri var", "sipariş sonrası değişiklik sınırı" gibi kurallar
 * ürüne değil mağazaya aittir.
 *
 * KURAL: politika metni yalnızca satıcı tarafından yazılır. `verified=false` olan
 * politika AI'ya kesin bilgi olarak girmez; doğrulanmamış politika uydurma sayılır.
 */

export const POLICY_DEFS = [
  {
    key: "customSize",
    label: "Özel ölçü kabulü",
    hint: "Özel ölçü alıyor musunuz? Hangi koşullarda?",
    placeholder: "Örn. Özel ölçü üretim yapıyoruz.",
  },
  {
    key: "sizeRanges",
    label: "Ölçü aralıkları",
    hint: "Kabul edilen en/boy sınırları ve artış adımı.",
    placeholder: "Örn. En 100–400 cm, boy 100–300 cm; 1 cm hassasiyet.",
  },
  {
    key: "sewing",
    label: "Dikim seçenekleri",
    hint: "Pile, düz dikim, ekstrafor gibi seçenekler.",
    placeholder: "Örn. 1'e 2, 1'e 3 pile; düz dikim; ekstrafor büzgülü.",
  },
  {
    key: "accessories",
    label: "Aksesuar seçenekleri",
    hint: "File, astar, kurşunlu etek, kanca/bant vb.",
    placeholder: "Örn. Kurşunlu etek opsiyoneldir; file/astar yok.",
  },
  {
    key: "orderChange",
    label: "Sipariş sonrası değişiklik",
    hint: "Hangi aşamaya kadar ölçü değişikliği kabul ediliyor?",
    placeholder: "Örn. Üretim başlamadan (Created) ölçü değişikliği yapılabilir.",
  },
  {
    key: "price",
    label: "Fiyat ve kampanya politikası",
    hint: "Fiyat değişimi/kampanya sorularında nasıl yanıt verilmeli?",
    placeholder: "Örn. Fiyatlar kampanya dönemlerinde değişebilir; sipariş anındaki fiyat geçerlidir.",
  },
  {
    key: "shipping",
    label: "Kargo / teslimat",
    hint: "Kargo süresi ve teslim bilgisi.",
    placeholder: "Örn. Siparişler 1–3 iş günü içinde kargoya verilir.",
  },
] as const;

export type PolicyKey = (typeof POLICY_DEFS)[number]["key"];

export function isPolicyKey(value: string): value is PolicyKey {
  return POLICY_DEFS.some((definition) => definition.key === value);
}

export function policyLabelOf(key: string): string {
  return POLICY_DEFS.find((definition) => definition.key === key)?.label ?? key;
}

export interface PolicyRow {
  key: string;
  label: string;
  value: string;
  verified: boolean;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  updatedAt: Date;
}

export interface PolicyContext {
  storeId: string;
  policies: PolicyRow[];
  /** Yalnızca doğrulanmış politikalar AI'ya kesin bilgi olarak girer. */
  verified: PolicyRow[];
}

/** Tüm politikalar (boş olanlar da) panelde düzenlenebilsin diye döner. */
export async function getPolicyContext(
  input: { storeId: string },
  deps: { prisma?: PrismaClient } = {},
): Promise<PolicyContext> {
  const prisma = deps.prisma ?? getPrisma();
  const rows = await prisma.storePolicy.findMany({ where: { storeId: input.storeId } });

  const policies: PolicyRow[] = POLICY_DEFS.map((definition) => {
    const row = rows.find((item) => item.key === definition.key);
    return {
      key: definition.key,
      label: definition.label,
      value: row?.value ?? "",
      verified: row?.verified ?? false,
      verifiedBy: row?.verifiedBy ?? null,
      verifiedAt: row?.verifiedAt ?? null,
      updatedAt: row?.updatedAt ?? new Date(0),
    };
  });

  return { storeId: input.storeId, policies, verified: policies.filter((policy) => policy.verified && policy.value.trim()) };
}

export interface PolicyInput {
  storeId: string;
  key: string;
  value: string;
  actor: string;
}

/**
 * Politika metnini kaydeder. Değer değişirse doğrulama DÜŞER: satıcı yeni metni
 * onaylamadan AI onu kesin bilgi olarak kullanamaz.
 */
export async function savePolicy(input: PolicyInput, deps: { prisma?: PrismaClient } = {}): Promise<{ changed: boolean }> {
  if (!isPolicyKey(input.key)) throw new Error("POLICY_KEY_INVALID");

  const prisma = deps.prisma ?? getPrisma();
  const value = input.value.trim().slice(0, 2000);
  const existing = await prisma.storePolicy.findUnique({
    where: { storeId_key: { storeId: input.storeId, key: input.key } },
  });

  const changed = (existing?.value ?? "") !== value;

  await prisma.storePolicy.upsert({
    where: { storeId_key: { storeId: input.storeId, key: input.key } },
    create: { storeId: input.storeId, key: input.key, value, verified: false, source: "MANUAL" },
    update: { value, ...(changed ? { verified: false, verifiedBy: null, verifiedAt: null } : {}) },
  });

  return { changed };
}

export async function verifyPolicy(input: PolicyInput, deps: { prisma?: PrismaClient } = {}): Promise<void> {
  const prisma = deps.prisma ?? getPrisma();
  await prisma.storePolicy.update({
    where: { storeId_key: { storeId: input.storeId, key: input.key } },
    data: { verified: true, verifiedBy: input.actor, verifiedAt: new Date() },
  });
}

export async function unverifyPolicy(input: Omit<PolicyInput, "value">, deps: { prisma?: PrismaClient } = {}): Promise<void> {
  const prisma = deps.prisma ?? getPrisma();
  await prisma.storePolicy.update({
    where: { storeId_key: { storeId: input.storeId, key: input.key } },
    data: { verified: false, verifiedBy: null, verifiedAt: null },
  });
}
