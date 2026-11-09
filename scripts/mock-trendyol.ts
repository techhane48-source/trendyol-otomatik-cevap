import http from "node:http";

/**
 * Geliştirme amaçlı sahte Trendyol Q&A sunucusu.
 * Gerçek API anahtarı olmadan uçtan uca akışı denemek için kullanılır.
 *
 *   npx tsx scripts/mock-trendyol.ts 5599
 *   TRENDYOL_BASE_URL=http://127.0.0.1:5599/integration/qna npm run dev
 *
 * Yalnızca GET isteklerine yanıt verir; hiçbir yazma endpoint'i yoktur.
 */

const PORT = Number(process.argv[2] ?? 5599);

const now = Date.now();

const QUESTIONS = Array.from({ length: 7 }, (_, index) => ({
  id: 900_000 + index,
  text: `Örnek müşteri sorusu #${index + 1}: Ürün ölçüleri nedir?`,
  creationDate: now - (index + 1) * 3_600_000,
  status: index % 3 === 0 ? "WAITING_FOR_ANSWER" : "WAITING_FOR_ANSWER",
  productName: `Örnek Ürün ${index + 1}`,
  productMainId: `MAIN-${index + 1}`,
  productId: String(50_000 + index),
  customerId: String(70_000 + index),
}));

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

  const page = Number(url.searchParams.get("page") ?? "0");
  const size = Number(url.searchParams.get("size") ?? "50");
  const totalPages = Math.max(1, Math.ceil(QUESTIONS.length / size));
  const content = QUESTIONS.slice(page * size, page * size + size);

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      content,
      totalPages,
      totalElements: QUESTIONS.length,
      number: page,
      size,
      last: page + 1 >= totalPages,
      first: page === 0,
      empty: content.length === 0,
    }),
  );
});

server.listen(PORT, () => {
  console.log(`Sahte Trendyol Q&A sunucusu: http://127.0.0.1:${PORT}`);
  console.log(`TRENDYOL_BASE_URL=http://127.0.0.1:${PORT}/integration/qna`);
  console.log(`${QUESTIONS.length} sahte soru, sayfa boyutu 50.`);
});
