import { getPrisma } from "@/lib/prisma";
import { createLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createLogger("page.questions");

interface QuestionRow {
  id: string;
  text: string;
  productName: string | null;
  rawStatus: string | null;
  status: string;
  askedAt: Date | null;
  firstSeenAt: Date;
}

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

function formatDate(value: Date | null): string {
  if (!value) return "—";
  return dateFormatter.format(value);
}

function statusLabel(status: string, rawStatus: string | null): string {
  return rawStatus ?? status;
}

function statusClass(status: string): string {
  if (status === "WAITING_FOR_ANSWER") return "badge waiting";
  if (status === "ANSWERED") return "badge answered";
  return "badge";
}

export default async function QuestionsPage() {
  let questions: QuestionRow[] = [];
  let errorMessage: string | null = null;

  try {
    const prisma = getPrisma();
    const rows = await prisma.question.findMany({
      orderBy: [{ askedAt: "desc" }, { firstSeenAt: "desc" }],
      take: 50,
      select: {
        id: true,
        text: true,
        productName: true,
        rawStatus: true,
        status: true,
        askedAt: true,
        firstSeenAt: true,
      },
    });
    questions = rows as QuestionRow[];
  } catch (error) {
    log.error("Sorular yüklenemedi", { error });
    errorMessage = "Sorular yüklenemedi. Veritabanı bağlantısını kontrol edin.";
  }

  return (
    <>
      <h1>Sorular</h1>
      <p className="subtitle">
        Son 50 soru — yalnızca <code>GET /questions/filter</code> ile okunur, cevap gönderilmez.
      </p>

      {errorMessage ? (
        <div className="card">
          <strong>Hata:</strong> <span className="muted">{errorMessage}</span>
        </div>
      ) : questions.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            Kayıtlı soru yok. Soruları çekmek için:{" "}
            <code>curl -X POST http://localhost:3000/api/sync</code>
          </p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th style={{ width: "46%" }}>Soru</th>
                <th>Ürün</th>
                <th>Tarih</th>
                <th>Durum</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((question) => (
                <tr key={question.id}>
                  <td>{question.text}</td>
                  <td className="muted">{question.productName ?? "—"}</td>
                  <td className="muted">{formatDate(question.askedAt ?? question.firstSeenAt)}</td>
                  <td>
                    <span className={statusClass(question.status)}>
                      {statusLabel(question.status, question.rawStatus)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
