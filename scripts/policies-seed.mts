import "dotenv/config";

import { getPrisma } from "../src/lib/prisma";

/**
 * Aura Perde mağaza politikalarını TASLAK olarak yükler (GÖREV 013).
 *
 * - Metinler işletme sahibi tarafından belirlenmiştir; burada yalnızca sisteme aktarılır.
 * - Hiçbir kayıt VERIFIED yapılmaz: doğrulama panelden satıcıya aittir.
 * - Var olan kayıt EZİLMEZ (satıcı metni düzenlemiş veya doğrulamış olabilir).
 */

const POLICIES: Array<{ key: string; value: string }> = [
  {
    key: "customSize",
    value: [
      "Siparişler ürün sayfasındaki ölçü seçenekleri (varyantlar) üzerinden oluşturulur; listede bulunmayan ölçü doğrudan özel ölçü siparişi olarak açılamaz.",
      "İstisna: müşteri uygun daha büyük bir varyantı satın alıp üretim öncesinde küçültme talebinde bulunabilir. Bu talep üretim ekibinin onayına tabidir, otomatik kabul edilmez.",
      "İstenen ölçü listede varsa müşteri o varyantı doğrudan seçebilir.",
      "Onay alınmadan özel üretim sözü verilmez.",
    ].join(" "),
  },
  {
    key: "sizeRanges",
    value: [
      "Ölçüler ürün sayfasındaki mevcut varyantlarla sınırlıdır; ölçü EN (genişlik) x BOY (yükseklik) sırasındadır ve her iki ölçü birlikte değerlendirilir.",
      "Müşteri uygun daha büyük bir ölçü satın alarak üretim öncesi küçültme talep edebilir; küçültme teknik uygunluğa ve üretim ekibi onayına bağlıdır.",
      "Satın alınan kumaşın eni veya boyu büyütülemez.",
      "Uygun daha büyük varyant yoksa veya üretim durumu bilinmiyorsa kesin üretim sözü verilmez.",
      "Talebin müşteri sorusuna yazılması, atölyeye otomatik talimat gönderildiği anlamına gelmez.",
    ].join(" "),
  },
  {
    key: "sewing",
    value: [
      "Yalnızca ilgili ürünün mevcut varyantlarında bulunan dikim ve pile seçenekleri uygulanır.",
      "Bir üründe sunulan dikim/pile seçeneği başka ürün için otomatik geçerli değildir.",
      "Mevcut olmayan dikim seçeneği için olumlu cevap verilmez; varyant bilgisi eksikse seçenek varsayılmaz.",
    ].join(" "),
  },
  {
    key: "accessories",
    value: [
      "Aksesuar içeriği ürüne ve varyanta göre değişir.",
      "Ponpon, püskül, bağlama halatı ve benzeri aksesuarların dahil olup olmadığı ilgili ürünün verisinden doğrulanır.",
      "Bir üründeki aksesuar başka üründe varsayılmaz.",
      "Aksesuar ekleme veya çıkarma olanağı ayrıca doğrulanmadıkça taahhüt edilmez.",
    ].join(" "),
  },
  {
    key: "orderChange",
    value: [
      "Sipariş sonrası ölçü değişikliği talepleri sipariş durumuna ve gerçek üretim aşamasına göre değerlendirilir.",
      "Üretim başlamamışsa talep değerlendirilebilir; bu kesin onay anlamına gelmez.",
      "Kesim/dikim başlamışsa değişiklik mümkün olmayabilir; paketlenmiş veya kargoya verilmiş siparişlerde değişiklik taahhüt edilmez.",
      "Trendyol sipariş statüsü ile atölyenin gerçek üretim aşaması aynı kabul edilmez.",
      "Mevcut bir varyanta geçiş veya uygun küçültme istisnası dışında otomatik ölçü değişikliği kabul edilmez; değişiklik insan onayı gerektirir.",
    ].join(" "),
  },
  {
    key: "price",
    value: [
      "Fiyatlar kampanya, indirim, maliyet ve pazar yeri koşullarına göre değişebilir.",
      "Sipariş anında geçerli olan fiyat esas alınır; sonraki fiyat değişiklikleri tamamlanmış siparişin fiyatını değiştirmez.",
      "Eski fiyattan yeniden satış sözü verilmez.",
      "Gerçek geçmiş ve güncel fiyat verisi olmadan zam yapıldığı veya kampanyanın bittiği kesin olarak söylenmez.",
      "Fiyat sorularında kumaş, pile gibi ilgisiz ürün alanları aranmaz.",
    ].join(" "),
  },
  {
    key: "shipping",
    value: [
      "Kargoya verme süresi ürünün hazırlık süresine göre değişir.",
      "Trendyol'da gösterilen tahmini kargoya teslim tarihi esas alınır.",
      "Kargoya teslim ile müşteriye teslim aynı şey değildir; kesin teslimat günü doğrulanmış bilgi olmadan vaat edilmez.",
      "Siparişin gerçek kargo durumu biliniyorsa o bilgi önceliklidir.",
    ].join(" "),
  },
];

const apply = process.argv.includes("--apply");

const prisma = getPrisma();
const store = await prisma.store.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, sellerId: true } });
if (!store) {
  console.error("Mağaza bulunamadı. Önce `npm run sync` ile mağaza kaydı oluşturun.");
  process.exit(2);
}

console.log(`Mağaza: ${store.sellerId} · mod: ${apply ? "UYGULA" : "PLAN (yazmaz)"}`);

let created = 0;
let skipped = 0;

for (const policy of POLICIES) {
  const existing = await prisma.storePolicy.findUnique({
    where: { storeId_key: { storeId: store.id, key: policy.key } },
    select: { value: true, verified: true },
  });

  if (existing && existing.value.trim().length > 0) {
    skipped += 1;
    console.log(`  ATLANDI  ${policy.key} — mevcut metin korunuyor (${existing.verified ? "DOĞRULANMIŞ" : "taslak"})`);
    continue;
  }

  console.log(`  TASLAK   ${policy.key} — ${policy.value.length} karakter, verified=false`);
  if (!apply) continue;

  await prisma.storePolicy.upsert({
    where: { storeId_key: { storeId: store.id, key: policy.key } },
    create: { storeId: store.id, key: policy.key, value: policy.value, verified: false, source: "IMPORT" },
    update: { value: policy.value, verified: false, verifiedBy: null, verifiedAt: null, source: "IMPORT" },
  });
  created += 1;
}

const rows = await prisma.storePolicy.findMany({ where: { storeId: store.id }, select: { key: true, verified: true, value: true } });
console.log(
  `\nSonuç: ${apply ? `yazılan ${created}` : "plan"} · atlanan ${skipped} · toplam kayıt ${rows.length} · doğrulanmış ${rows.filter((r) => r.verified).length}`,
);
console.log("Not: hiçbir kayıt VERIFIED yapılmadı; doğrulama panelden satıcıya aittir. (/policies)");

await prisma.$disconnect();
