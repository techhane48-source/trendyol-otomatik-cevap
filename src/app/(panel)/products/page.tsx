import { cookies } from "next/headers";

import { requireUser } from "@/lib/auth/session";
import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import {
  getProductInfoHistory,
  listProductInfos,
  type ProductInfoView,
} from "@/lib/products/service";

import {
  createProductAction,
  unverifyProductAction,
  updateProductAction,
  verifyProductAction,
} from "./actions";

export const dynamic = "force-dynamic";

const log = createLogger("page.products");

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

function formatDate(value: Date | null | undefined): string {
  return value ? dateFormatter.format(value) : "—";
}

const MESSAGES: Record<string, string> = {
  olusturuldu: "Ürün bilgi kartı oluşturuldu (durum: DRAFT — doğrulanmadan AI'da kullanılmaz).",
  guncellendi: "Kart güncellendi; içerik değiştiği için doğrulama sıfırlandı.",
  dogrulandi: "Kart doğrulandı; artık AI taslaklarında kullanılabilir.",
  "dogrulama-kaldirildi": "Doğrulama kaldırıldı; kart yeniden DRAFT.",
};

const ERRORS: Record<string, string> = {
  "invalid-product-id": "Ürün kimliği geçersiz (1–64 karakter).",
  "invalid-attribute": "Özellik satırları \"Etiket: Değer\" biçiminde olmalı.",
  "duplicate-product-info": "Bu mağaza ve ürün kimliği için kart zaten var; düzenleyin.",
  "product-info-not-found": "Kart bulunamadı.",
  "already-verified": "Kart zaten doğrulanmış.",
  "not-verified": "Kart zaten doğrulanmamış.",
  "empty-product-info": "Doğrulamak için en az bir özellik girilmelidir.",
  "store-required": "Mağaza (sellerId) gerekli.",
  "store-not-found": "Mağaza bulunamadı.",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
};

const buttonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--text)",
  cursor: "pointer",
};

function attributesToText(product: ProductInfoView): string {
  return product.attributes.map((attribute) => `${attribute.label}: ${attribute.value}`).join("\n");
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ hata?: string; ok?: string; q?: string }>;
}) {
  const user = await requireUser();
  const cookieStore = await cookies();
  const access = checkAccess(cookieStore.get(ACCESS_COOKIE_NAME)?.value ?? null);

  if (!access.ok) {
    return (
      <>
        <h1>Ürün Bilgileri</h1>
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Erişim gerekli</h2>
          <p className="muted" style={{ marginTop: 0 }}>{access.error}</p>
          <p style={{ marginBottom: 0 }}><a href="/questions">Giriş ekranına git</a></p>
        </div>
      </>
    );
  }

  const params = await searchParams;
  const query = params?.q?.trim() ?? "";
  const okMessage = params?.ok ? MESSAGES[params.ok] : null;
  const errorMessage = params?.hata ? (ERRORS[params.hata] ?? `İşlem başarısız (${params.hata}).`) : null;

  let products: ProductInfoView[] = [];
  let loadError: string | null = null;

  try {
    products = await listProductInfos(user.storeId, { query: query || null, limit: 50 });
  } catch (error) {
    log.error("Ürün bilgileri yüklenemedi", { error });
    loadError = "Ürün bilgileri yüklenemedi.";
  }

  const histories = new Map<string, Awaited<ReturnType<typeof getProductInfoHistory>>>();
  for (const product of products) {
    histories.set(product.id, await getProductInfoHistory(user.storeId, product.id));
  }

  return (
    <>
      <h1>Ürün Bilgileri</h1>
      <p className="subtitle">
        Doğrulanmış ürün bilgisi AI taslağında kullanılır. Yalnızca <strong>VERIFIED</strong> kartlar
        kullanılır; varyant kimliği eşleşmezse bilgi tahmin edilmez.{" "}
        <a href="/drafts">Taslak paneli →</a>
      </p>

      {okMessage ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>Tamam:</strong> <span className="muted">{okMessage}</span>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>Hata:</strong> <span className="muted">{errorMessage}</span>
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: 12 }}>
        <form method="get" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            name="q"
            defaultValue={query}
            placeholder="Ürün kimliği, varyant kimliği veya başlıkta ara"
            style={{ ...inputStyle, flex: "1 1 260px", width: "auto" }}
          />
          <button type="submit" style={buttonStyle}>Ara</button>
        </form>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Yeni ürün bilgi kartı</h2>
        <form action={createProductAction} style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input name="sellerId" placeholder="Satıcı ID (ör. 1081168)" defaultValue={getEnv().TRENDYOL_SELLER_ID} style={{ ...inputStyle, flex: "1 1 160px", width: "auto" }} />
            <input name="productMainId" placeholder="Ürün kimliği (productMainId) — zorunlu" required style={{ ...inputStyle, flex: "1 1 220px", width: "auto" }} />
            <input name="productId" placeholder="Varyant kimliği (opsiyonel)" style={{ ...inputStyle, flex: "1 1 180px", width: "auto" }} />
          </div>
          <input name="title" placeholder="Başlık (ör. Bambu Tül Perde)" style={inputStyle} />
          <textarea
            name="attributes"
            rows={5}
            placeholder={"Her satıra bir özellik: Etiket: Değer\nKumaş: Bambu dokulu tül\nPile: 1/3 sık pile\nKarartma: Blackout değil"}
            style={inputStyle}
          />
          <input name="notes" placeholder="Not (opsiyonel)" style={inputStyle} />
          <button type="submit" style={{ ...buttonStyle, justifySelf: "start" }}>Kart oluştur</button>
        </form>
      </div>

      {loadError ? (
        <div className="card"><strong>Hata:</strong> <span className="muted">{loadError}</span></div>
      ) : products.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            {query ? "Aramaya uyan kayıt yok." : "Henüz ürün bilgi kartı yok. Yukarıdaki formdan ekleyin."}
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {products.map((product) => {
            const verified = product.status === "VERIFIED";
            const history = histories.get(product.id) ?? [];

            return (
              <div key={product.id} className="card">
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong>{product.title ?? "(başlıksız)"}</strong>
                  <span className={verified ? "badge answered" : "badge waiting"}>
                    {verified ? "Doğrulandı" : "Taslak (doğrulanmadı)"}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Ürün: {product.productMainId} · Varyant: {product.productId ?? "ana ürün"} ·{" "}
                  {verified ? `doğrulayan: ${product.verifiedBy} (${formatDate(product.verifiedAt)})` : "doğrulanmadı"}
                </div>

                <table style={{ marginTop: 8 }}>
                  <tbody>
                    {product.attributes.length === 0 ? (
                      <tr><td className="muted">Özellik girilmemiş.</td></tr>
                    ) : (
                      product.attributes.map((attribute) => (
                        <tr key={`${attribute.label}-${attribute.value}`}>
                          <th style={{ width: "32%", textAlign: "left" }}>{attribute.label}</th>
                          <td>{attribute.value}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>

                <details style={{ marginTop: 8 }}>
                  <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Düzenle</summary>
                  <form action={updateProductAction} style={{ display: "grid", gap: 6, marginTop: 8 }}>
                    <input type="hidden" name="id" value={product.id} />
                    <input name="title" defaultValue={product.title ?? ""} placeholder="Başlık" style={inputStyle} />
                    <input name="productId" defaultValue={product.productId ?? ""} placeholder="Varyant kimliği (boş = ana ürün)" style={inputStyle} />
                    <textarea name="attributes" defaultValue={attributesToText(product)} rows={5} style={inputStyle} />
                    <input name="notes" defaultValue={product.notes ?? ""} placeholder="Not" style={inputStyle} />
                    <button type="submit" style={{ ...buttonStyle, justifySelf: "start" }}>Kaydet</button>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Düzenleme doğrulamayı sıfırlar; kart yeniden DRAFT olur.
                    </span>
                  </form>
                </details>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  {verified ? (
                    <form action={unverifyProductAction}>
                      <input type="hidden" name="id" value={product.id} />
                      <button type="submit" style={buttonStyle}>Doğrulamayı kaldır</button>
                    </form>
                  ) : (
                    <form action={verifyProductAction} style={{ display: "flex", gap: 8 }}>
                      <input type="hidden" name="id" value={product.id} />
                      <input name="note" placeholder="Doğrulama notu" style={{ ...inputStyle, width: 220 }} />
                      <button type="submit" style={buttonStyle}>Doğrula</button>
                    </form>
                  )}
                </div>

                {history.length > 0 ? (
                  <details style={{ marginTop: 8 }}>
                    <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
                      Değişiklik geçmişi ({history.length})
                    </summary>
                    <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
                      {history.map((event) => (
                        <li key={event.id}>
                          <span className="muted">
                            {formatDate(event.createdAt)} · {event.action} · {event.actor}
                            {event.note ? ` — ${event.note}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
