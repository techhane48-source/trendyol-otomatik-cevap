import { cookies } from "next/headers";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getPrisma } from "@/lib/prisma";
import { createLogger } from "@/lib/logger";
import { signInAction, signOutAction } from "./actions";

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

/**
 * Erişim kapısı ekranı. Çok kullanıcılı kimlik doğrulama değildir: paylaşılan
 * tek erişim anahtarı (`APP_ACCESS_TOKEN`) ile korunan basit bir giriş formu.
 */
function AccessGate({ error, status }: { error: string; status: number }) {
  const misconfigured = status === 503;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Erişim gerekli</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {error}
      </p>
      {misconfigured ? (
        <p style={{ marginBottom: 0 }}>
          Sunucuda <code>APP_ACCESS_TOKEN</code> tanımlanmalı. Tanımlanana kadar üretimde erişim
          kapalıdır.
        </p>
      ) : (
        <form action={signInAction} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="password"
            name="token"
            placeholder="Erişim anahtarı"
            autoComplete="current-password"
            required
            style={{
              flex: "1 1 220px",
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text)",
            }}
          />
          <button
            type="submit"
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--card)",
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            Giriş
          </button>
        </form>
      )}
    </div>
  );
}

export default async function QuestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ hata?: string }>;
}) {
  const cookieStore = await cookies();
  const access = checkAccess(cookieStore.get(ACCESS_COOKIE_NAME)?.value ?? null);

  if (!access.ok) {
    return (
      <>
        <h1>Sorular</h1>
        <AccessGate error={access.error} status={access.status} />
      </>
    );
  }

  const params = await searchParams;
  const loginError = params?.hata === "1";

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
        Son 50 soru — yalnızca <code>GET /questions/filter</code> ile okunur, cevap gönderilmez.{" "}
        <a href="/drafts">Taslak paneli →</a>
      </p>

      {loginError ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>Giriş başarısız:</strong>{" "}
          <span className="muted">erişim anahtarı geçersiz.</span>
        </div>
      ) : null}

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

      <form action={signOutAction} style={{ marginTop: 16 }}>
        <button
          type="submit"
          style={{
            padding: "6px 12px",
            fontSize: 13,
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--muted)",
            cursor: "pointer",
          }}
        >
          Oturumu kapat
        </button>
      </form>
    </>
  );
}
