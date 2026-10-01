// Admin browser sign-in: token -> cookie, CSRF header on changes, logout, and
// that the CLI's bearer token keeps working.
import { assert, assertEquals } from "@std/assert";
import { app } from "../../src/main.ts";
import { ADMIN_TOKEN, adminHeaders } from "../auth-utils.ts";

const req = (path: string, init: RequestInit = {}) =>
  app.request(path, { redirect: "manual", ...init });
const json = { "content-type": "application/json" };

async function login(token = ADMIN_TOKEN) {
  const res = await req("/admin/login", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ token }),
  });
  await res.body?.cancel();
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  return { res, cookie };
}

Deno.test("admin login: the right token sets an HttpOnly, SameSite=Strict cookie", async () => {
  const { res, cookie } = await login();
  assertEquals(res.status, 200);
  const raw = res.headers.get("set-cookie")!;
  assert(/^admin_session=/.test(raw));
  assert(/HttpOnly/i.test(raw) && /SameSite=Strict/i.test(raw));
  assert(!raw.includes(ADMIN_TOKEN), "the cookie is not the token");
  assert(cookie);
  assertEquals(res.headers.get("cache-control"), "no-store");
});

Deno.test("admin login: wrong or missing token is refused and sets no cookie", async () => {
  const wrong = await login("nope");
  assertEquals(wrong.res.status, 401);
  assertEquals(wrong.res.headers.get("set-cookie"), null);

  const noBody = await req("/admin/login", {
    method: "POST",
    headers: json,
    body: "{}",
  });
  assertEquals(noBody.status, 401);
  const notJson = await req("/admin/login", {
    method: "POST",
    body: "token=x",
  });
  assertEquals(notJson.status, 415);
});

Deno.test("admin cookie: reads work; changes need the x-admin-request header", async () => {
  const { cookie } = await login();
  const auth = { cookie: cookie! };

  assertEquals((await req("/admin/me", { headers: auth })).status, 200);
  const overview = await req("/admin/overview", { headers: auth });
  assertEquals(overview.status, 200);
  assertEquals(await overview.json(), { festivals: [], judges: [] }); // no database here

  // A cross-site form post could send the cookie but not this header.
  const bare = await req("/admin/credentials", {
    method: "POST",
    headers: { ...auth, ...json },
    body: JSON.stringify({ client_id: "dj1" }),
  });
  assertEquals(bare.status, 403);
  await bare.body?.cancel();

  const ok = await req("/admin/credentials", {
    method: "POST",
    headers: { ...auth, ...json, "x-admin-request": "1" },
    body: JSON.stringify({ client_id: "dj1" }),
  });
  // 201 created (memory mode) - the point is it is let through.
  assert([201, 404].includes(ok.status), `unexpected ${ok.status}`);
  await ok.body?.cancel();
});

Deno.test("admin cookie: no cookie, a made-up cookie, or the device cookie get nothing", async () => {
  const attempts: Record<string, string>[] = [
    {},
    { cookie: "admin_session=forged" },
    { cookie: "session_token=forged" },
  ];
  for (const headers of attempts) {
    assertEquals((await req("/admin/me", { headers })).status, 401);
    assertEquals((await req("/admin/overview", { headers })).status, 401);
  }
});

Deno.test("admin logout: the cookie stops working immediately", async () => {
  const { cookie } = await login();
  const auth = { cookie: cookie! };
  assertEquals((await req("/admin/me", { headers: auth })).status, 200);
  const out = await req("/admin/logout", { method: "POST", headers: auth });
  assertEquals(out.status, 200);
  await out.body?.cancel();
  assertEquals((await req("/admin/me", { headers: auth })).status, 401);
});

Deno.test("admin: the bearer token still works (CLI), and a wrong one is not rescued by a cookie", async () => {
  assertEquals(
    (await req("/admin/overview", { headers: adminHeaders })).status,
    200,
  );
  const { cookie } = await login();
  const mixed = await req("/admin/me", {
    headers: { authorization: "Bearer wrong", cookie: cookie! },
  });
  assertEquals(mixed.status, 401);
});

Deno.test("admin page and bundle are served; the page needs no login to load", async () => {
  const page = await req("/admin");
  assertEquals(page.status, 200);
  assert((await page.text()).includes("/js/admin.js"));
  const js = await req("/js/admin.js");
  assertEquals(js.status, 200);
  await js.body?.cancel();
});
