import { cookies } from "next/headers";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getPrisma } from "@/lib/prisma";
import { FIELD_DEFS, getCardFields, getProductQuestionHints, listTopProducts } from "@/lib/products/bank";
import { listSuggestions } from "@/lib/products/suggestions";

import {
  acceptSuggestionAction,
  bulkFieldAction,
  generateSuggestionsAction,
  importCsvAction,
  rejectSuggestionAction,
  setFieldAction,
  unverifyFieldAction,
  verifyFieldAction,
} from "./actions";

export const dynamic = "force-dynamic";

const OK_MESSAGES: Record<string, string> = {
  "alan-kaydedildi": "Alan kaydedildi (doğrulanmadı).",
  "alan-dogrulandi": "Alan doğrulandı. Diğer alanlar etkilenmedi.",
  "alan-dogrulama-kaldirildi": "Alan doğrulaması kaldırıldı.",
  "toplu-guncellendi": "Toplu güncelleme yapıldı (doğrulanmamış).",
  "csv-iceri": "CSV içe aktarıldı — gelen değerler doğrulanmamıştır.",
  "oneri-uretildi": "Geçmiş cevaplardan öneriler üretildi.",
  "oneri-kabul": "Öneri kabul edildi; alan doğrulanmamış olarak yazıldı.",
  "oneri-reddedildi": "Öneri reddedildi.",
};

const ERROR_MESSAGES: Record<string, string> = {
  yetkisiz: "Yönetici oturumu gerekir.",
  "unknown-field": "Bilinmeyen alan.",
  "empty-field": "Boş alan doğrulanamaz.",
  "card-not-found": "Ürün kartı bulunamadı.",
  "empty-csv": "CSV boş.",
  "invalid-csv": "CSV geçersiz (productMainId kolonu zorunlu).",
  "no-product": "Ürün seçilmedi.",
  "beklenmeyen-hata": "Beklenmeyen bir hata oluştu.",
};

const cellStyle: React.CSSProperties = { padding: "7px 9px", borderBottom: "1px solid var(--border)", fontSize: 12.5, verticalAlign: "top" };
const headStyle: React.CSSProperties = { ...cellStyle, textAlign: "left", fontSize: 11.5, opacity: 0.7 };
const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--fg)",
  fontSize: 12.5,
};
const buttonStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

export default async function ProductBankPage({
  searchParams,
}: {
  searchParams: Promise<{ main?: string; ok?: string; hata?: string; ozet?: string }>;
}) {
  const cookieStore = await cookies();
  const access = checkAccess(cookieStore.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) {
    return (
      <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 20 }}>Erişim gerekli</h1>
        <p style={{ opacity: 0.75 }}>Ürün bilgi bankası için yönetici oturumu gerekir.</p>
      </main>
    );
  }

  const params = await searchParams;
  const prisma = getPrisma();
  const store = await prisma.store.findFirst({ orderBy: { createdAt: "asc" } });
  if (!store) {
    return <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>Mağaza kaydı yok.</main>;
  }

  const [products, suggestions] = await Promise.all([
    listTopProducts({ storeId: store.id, limit: 10 }, { prisma }),
    listSuggestions({ storeId: store.id, status: "PENDING", limit: 60 }, { prisma }),
  ]);

  const selected = params.main ? await getCardFields({ storeId: store.id, productMainId: params.main }, { prisma }) : null;
  const selectedMeta = products.find((product) => product.productMainId === params.main);
  const hints = params.main
    ? await getProductQuestionHints({ storeId: store.id, productMainId: params.main, perCategory: 2 }, { prisma })
    : [];
  const priority = products.slice(0, 3);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1250 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, marginBottom: 4 }}>Ürün bilgi bankası</h1>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
            Alan bazında doğrulama: bir alanın doğrulanması diğerlerini doğrulamaz. CSV ve geçmiş cevap önerileri
            <strong> doğrulanmamış</strong> yazılır.
          </p>
        </div>
        <nav style={{ display: "flex", gap: 12, fontSize: 13 }}>
          <a href="/products">Kartlar</a>
          <a href="/drafts">Taslaklar</a>
          <a href="/answers">Geçmiş cevaplar</a>
          <a href="/product-bank/csv">CSV indir</a>
        </nav>
      </header>

      {params.ok && OK_MESSAGES[params.ok] ? (
        <p style={{ marginTop: 12, padding: "9px 12px", borderRadius: 8, background: "#e8f6ee", color: "#14532d", fontSize: 13 }}>
          {OK_MESSAGES[params.ok]} {params.ozet ? <span style={{ opacity: 0.8 }}>({params.ozet})</span> : null}
        </p>
      ) : null}
      {params.hata ? (
        <p style={{ marginTop: 12, padding: "9px 12px", borderRadius: 8, background: "#fdeaea", color: "#7f1d1d", fontSize: 13 }}>
          {ERROR_MESSAGES[params.hata] ?? "İşlem tamamlanamadı."}
        </p>
      ) : null}

      <section style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 16, marginBottom: 6 }}>Öncelikli ürünler (ilk 3)</h2>
        <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
          Bu üç ürün soruların büyük kısmını oluşturuyor. Kartı açıp kumaş, pile, karartma, özel ölçü, yıkama ve montaj
          alanlarını doldurun; doğrulamayı siz yapın. Alanlar otomatik doğrulanmaz.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {priority.map((product, index) => (
            <div
              key={product.productMainId}
              style={{ flex: "1 1 280px", border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}
            >
              <div style={{ fontSize: 12, opacity: 0.6 }}>{index + 1}. öncelik · {product.questionCount} soru</div>
              <div style={{ fontSize: 13.5, margin: "4px 0" }}>{product.productName ?? product.productMainId}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                {product.answeredCount} cevaplı · {product.verifiedFields}/{FIELD_DEFS.length} doğrulanmış alan
              </div>
              <a
                href={`/product-bank?main=${encodeURIComponent(product.productMainId)}#kart`}
                style={{ display: "inline-block", marginTop: 8, fontSize: 12.5 }}
              >
                Kartı doldur →
              </a>
            </div>
          ))}
        </div>

        <h2 style={{ fontSize: 16, margin: "22px 0 6px" }}>En çok soru gelen 10 ürün</h2>
        {products.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>Ürün verisi yok (önce soruları senkronize edin).</p>
        ) : (
          <form action={bulkFieldAction}>
            <input type="hidden" name="storeId" value={store.id} />
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={headStyle}>Seç</th>
                  <th style={headStyle}>Ürün</th>
                  <th style={headStyle}>Soru</th>
                  <th style={headStyle}>Cevap</th>
                  <th style={headStyle}>Varyant</th>
                  <th style={headStyle}>Kart</th>
                  <th style={headStyle}>Doğrulanmış alan</th>
                  <th style={headStyle} />
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.productMainId}>
                    <td style={cellStyle}>
                      <input type="checkbox" name="productMainIds" value={product.productMainId} />
                    </td>
                    <td style={{ ...cellStyle, maxWidth: 380 }}>
                      <div>{product.productName ?? "—"}</div>
                      <div style={{ fontSize: 11, opacity: 0.6 }}>{product.productMainId}</div>
                    </td>
                    <td style={cellStyle}>{product.questionCount}</td>
                    <td style={cellStyle}>{product.answeredCount}</td>
                    <td style={cellStyle}>{product.variants.length}</td>
                    <td style={cellStyle}>{product.hasCard ? "var" : "yok"}</td>
                    <td style={cellStyle}>{product.verifiedFields} / {FIELD_DEFS.length}</td>
                    <td style={cellStyle}>
                      <a href={`/product-bank?main=${encodeURIComponent(product.productMainId)}`}>Kartı aç</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <label style={{ fontSize: 12 }}>
                Alan
                <select name="fieldKey" style={{ ...inputStyle, display: "block", marginTop: 4 }}>
                  {FIELD_DEFS.map((field) => (
                    <option key={field.key} value={field.key}>
                      {field.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 12, flex: 1, minWidth: 240 }}>
                Değer (seçili ürünlere yazılır, doğrulanmamış)
                <input name="value" style={{ ...inputStyle, display: "block", marginTop: 4, width: "100%" }} />
              </label>
              <button type="submit" style={buttonStyle}>
                Toplu uygula
              </button>
            </div>
          </form>
        )}
      </section>

      {selected ? (
        <section id="kart" style={{ marginTop: 26, padding: 14, border: "1px solid var(--border)", borderRadius: 10 }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>
            {selectedMeta?.productName ?? selected.title ?? "Ürün"} · {selected.productMainId}
          </h2>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
            Kart durumu: {selected.status} · eksik/doğrulanmamış alan: {selected.missingFields.length}
          </p>

          {hints.length > 0 ? (
            <details style={{ marginBottom: 12 }} open>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>Bu ürün için geçmiş sorular (doldururken bakın)</summary>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
                {hints.slice(0, 8).map((hint, index) => (
                  <li key={`${hint.category}-${index}`} style={{ marginBottom: 4 }}>
                    <span style={{ opacity: 0.6 }}>[{hint.category}]</span> {hint.text}
                    {hint.answerText ? <div style={{ opacity: 0.7 }}>eski cevap: {hint.answerText}</div> : null}
                  </li>
                ))}
              </ul>
              <p style={{ fontSize: 11.5, opacity: 0.6, marginBottom: 0 }}>
                Eski cevaplar doğrulanmış bilgi değildir; alanları kendi bilginizle doldurup doğrulayın.
              </p>
            </details>
          ) : null}

          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
            Önerilen sıra: kumaş türü → pile oranı → karartma → özel ölçü → ütü/yıkama → montaj → dikim şekli.
          </p>

          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headStyle}>Alan</th>
                <th style={headStyle}>Değer</th>
                <th style={headStyle}>Durum</th>
                <th style={headStyle}>İşlem</th>
              </tr>
            </thead>
            <tbody>
              {selected.fields.map((field) => (
                <tr key={field.key}>
                  <td style={cellStyle}>{field.label}</td>
                  <td style={cellStyle}>
                    <form action={setFieldAction} style={{ display: "flex", gap: 6 }}>
                      <input type="hidden" name="storeId" value={store.id} />
                      <input type="hidden" name="productMainId" value={selected.productMainId} />
                      <input type="hidden" name="fieldKey" value={field.key} />
                      <input name="value" defaultValue={field.value} style={{ ...inputStyle, minWidth: 280 }} />
                      <button type="submit" style={buttonStyle}>
                        Kaydet
                      </button>
                    </form>
                  </td>
                  <td style={cellStyle}>
                    {field.verified ? (
                      <span style={{ color: "#14532d" }}>
                        doğrulandı
                        <div style={{ fontSize: 11, opacity: 0.7 }}>
                          {field.verifiedBy} · {field.verifiedAt ? new Date(field.verifiedAt).toLocaleDateString("tr-TR") : ""}
                        </div>
                      </span>
                    ) : (
                      <span style={{ color: "#7c4a03" }}>doğrulanmadı{field.source ? ` · ${field.source}` : ""}</span>
                    )}
                  </td>
                  <td style={cellStyle}>
                    <div style={{ display: "flex", gap: 6 }}>
                      {!field.verified ? (
                        <form action={verifyFieldAction}>
                          <input type="hidden" name="storeId" value={store.id} />
                          <input type="hidden" name="productMainId" value={selected.productMainId} />
                          <input type="hidden" name="fieldKey" value={field.key} />
                          <input type="hidden" name="value" value={field.value} />
                          <button type="submit" style={buttonStyle} disabled={field.value.trim() === ""}>
                            Doğrula
                          </button>
                        </form>
                      ) : (
                        <form action={unverifyFieldAction}>
                          <input type="hidden" name="storeId" value={store.id} />
                          <input type="hidden" name="productMainId" value={selected.productMainId} />
                          <input type="hidden" name="fieldKey" value={field.key} />
                          <button type="submit" style={buttonStyle}>
                            Doğrulamayı kaldır
                          </button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section style={{ marginTop: 26 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
          <h2 style={{ fontSize: 16, marginBottom: 4 }}>Geçmiş cevaplardan öneriler</h2>
          <form action={generateSuggestionsAction}>
            <input type="hidden" name="storeId" value={store.id} />
            <button type="submit" style={buttonStyle}>
              Önerileri üret
            </button>
          </form>
        </div>
        <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
          Öneriler kaynak soru kimlikleriyle listelenir; çelişen değerler işaretlenir. Kabul edilen öneri bile
          <strong> doğrulanmamış</strong> alan olarak yazılır.
        </p>

        {suggestions.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>Öneri yok.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headStyle}>Ürün</th>
                <th style={headStyle}>Alan</th>
                <th style={headStyle}>Öneri</th>
                <th style={headStyle}>Kaynak sorular</th>
                <th style={headStyle}>Çelişki</th>
                <th style={headStyle}>İşlem</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((suggestion) => (
                <tr key={suggestion.id}>
                  <td style={cellStyle}>{suggestion.productMainId}</td>
                  <td style={cellStyle}>{FIELD_DEFS.find((field) => field.key === suggestion.fieldKey)?.label ?? suggestion.fieldKey}</td>
                  <td style={{ ...cellStyle, maxWidth: 380 }}>{suggestion.value}</td>
                  <td style={cellStyle}>{suggestion.sourceQuestionIds.map((id) => `#${id}`).join(", ")}</td>
                  <td style={cellStyle}>
                    {suggestion.conflict ? (
                      <span style={{ color: "#7f1d1d" }}>var: {suggestion.conflictValues.join(" | ").slice(0, 90)}</span>
                    ) : suggestion.needsReview ? (
                      <span style={{ color: "#7c4a03" }}>belirsiz — insan incelemesi</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={cellStyle}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <form action={acceptSuggestionAction}>
                        <input type="hidden" name="suggestionId" value={suggestion.id} />
                        <button type="submit" style={buttonStyle}>
                          Kabul et
                        </button>
                      </form>
                      <form action={rejectSuggestionAction}>
                        <input type="hidden" name="suggestionId" value={suggestion.id} />
                        <button type="submit" style={buttonStyle}>
                          Reddet
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginTop: 26, padding: 14, border: "1px solid var(--border)", borderRadius: 10 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>CSV içe aktarma</h2>
        <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
          Kolonlar: productMainId, productId, {FIELD_DEFS.map((field) => field.key).join(", ")}. Gelen değerler
          doğrulanmamış kabul edilir; doğrulama alan bazında yapılır.
        </p>
        <form action={importCsvAction}>
          <input type="hidden" name="storeId" value={store.id} />
          <textarea
            name="csv"
            rows={5}
            placeholder="productMainId,productId,fabric,pleat,..."
            style={{ ...inputStyle, width: "100%", fontFamily: "monospace" }}
          />
          <button type="submit" style={{ ...buttonStyle, marginTop: 8 }}>
            İçe aktar
          </button>
        </form>
      </section>
    </main>
  );
}
