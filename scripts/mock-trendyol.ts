import http from "node:http";

/**
 * Geliştirme amaçlı sahte Trendyol Q&A sunucusu.
 * Gerçek API anahtarı olmadan uçtan uca akışı denemek için kullanılır.
 *
 *   npx tsx scripts/mock-trendyol.ts 5599
 *   TRENDYOL_BASE_URL=http://127.0.0.1:5599/integration/qna npm run dev
 *
 * Yalnızca GET isteklerine yanıt verir; hiçbir yazma endpoint'i yoktur.
 *
 * MUTABAKAT SENARYOSU: aynı 4 soru kimliği hem `WAITING_FOR_ANSWER` hem
 * `ANSWERED` filtresinde döner. Böylece iki durumu birlikte tarayan bir
 * senkronizasyon, son geçişte durumu `ANSWERED` olarak günceller.
 */

const PORT = Number(process.argv[2] ?? 5599);
const now = Date.now();

const BASE_QUESTIONS = Array.from({ length: 4 }, (_, index) => ({
  id: 900_001 + index,
  text: `Örnek müşteri sorusu #${index + 1}: Ürün ölçüleri nedir?`,
  creationDate: now - (index + 1) * 3_600_000,
  productName: `Örnek Ürün ${index + 1}`,
  productMainId: `MAIN-${index + 1}`,
  productId: String(50_000 + index),
  customerId: String(70_000 + index),
  imageUrl: `https://example.invalid/img/${index + 1}.jpg`,
}));

function itemsFor(status: string, page: number, size: number) {
  const all = BASE_QUESTIONS.map((question) => ({
    ...question,
    status,
    ...(status === "ANSWERED"
      ? { answer: { id: 500_000 + question.id, text: "Örnek satıcı cevabı", creationDate: now } }
      : {}),
  }));

  const totalPages = Math.max(1, Math.ceil(all.length / size));
  return {
    content: all.slice(page * size, page * size + size),
    totalPages,
    totalElements: all.length,
    page,
    size,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Sahte sunucu yalnızca GET destekler" }));
    return;
  }

  if (!/\/sellers\/\d+\/questions\/filter$/.test(url.pathname)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Bilinmeyen yol" }));
    return;
  }

  const status = url.searchParams.get("status") ?? "WAITING_FOR_ANSWER";
  const page = Number(url.searchParams.get("page") ?? "0");
  const size = Number(url.searchParams.get("size") ?? "50");

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(itemsFor(status, page, size)));
});

server.listen(PORT, () => {
  console.log(`Sahte Trendyol Q&A sunucusu: http://127.0.0.1:${PORT}`);
  console.log(`TRENDYOL_BASE_URL=http://127.0.0.1:${PORT}/integration/qna`);
  console.log(`${BASE_QUESTIONS.length} sahte soru; aynı kimlikler iki durumda da döner.`);
});
