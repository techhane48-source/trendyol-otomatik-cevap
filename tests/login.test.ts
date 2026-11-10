import { beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/giris/route";

const TOKEN = "test-access-token-1234567890";

function formRequest(token: string): Request {
  const body = new FormData();
  body.set("token", token);
  return new Request("http://localhost/api/giris", { method: "POST", body });
}

describe("panel girişi", () => {
  beforeEach(() => {
    process.env.APP_ACCESS_TOKEN = TOKEN;
  });

  it("doğru anahtarla HttpOnly çerez kurar ve panele yönlendirir", async () => {
    const response = await POST(formRequest(TOKEN));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("ty_access=");
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("yanlış anahtarı reddeder, çerez kurmaz ve anahtarı yanıtta sızdırmaz", async () => {
    const response = await POST(formRequest("yanlis-anahtar"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/giris?hata=1");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).not.toContain("yanlis-anahtar");
  });

  it("anahtar tanımlı değilse fail-closed: çerez kurmaz", async () => {
    delete process.env.APP_ACCESS_TOKEN;
    const response = await POST(formRequest("herhangi"));
    expect(response.headers.get("location")).toContain("/giris?hata=2");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("çıkış çerezi siler", async () => {
    const response = await GET(new Request("http://localhost/api/giris?cikis=1"));
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("ty_access=");
    expect(cookie).toContain("Max-Age=0");
  });
});
