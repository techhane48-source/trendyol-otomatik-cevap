import { cookies } from "next/headers";

import { ACCESS_COOKIE_NAME, checkAccess } from "@/lib/auth";
import { exportCsv } from "@/lib/products/bank";

/** CSV dışa aktarma (yalnızca oturumlu). */
export async function GET(): Promise<Response> {
  const store = await cookies();
  const access = checkAccess(store.get(ACCESS_COOKIE_NAME)?.value ?? null);
  if (!access.ok) {
    return new Response("Erişim gerekli", { status: access.status });
  }

  const csv = await exportCsv();
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="urun-bilgi-bankasi.csv"',
    },
  });
}
