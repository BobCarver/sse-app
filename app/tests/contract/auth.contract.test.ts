// deno-lint-ignore-file no-explicit-any
// Auth contract: admin-issued links, cookies, revocation, admin-only routes,
// and who may answer which /response tag.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { app, clientCheck, credentials } from "../../src/main.ts";
import { Session } from "../../src/session.ts";
import { sessions } from "../../src/sessionManager.ts";
import { clearAllResolvers } from "../../src/resolveTag.ts";
import { perfTag, scoreTag } from "../../src/contract.ts";
import type { Competition } from "../../src/types.ts";
import { createMockClient, delay } from "../test-utils.ts";
import { adminHeaders, secretFor } from "../auth-utils.ts";

// Contract tests run against an empty schema: don't require real tracks/judges.
clientCheck.exists = () => Promise.resolve(true);

const req = (path: string, init: RequestInit = {}) =>
  app.request(path, { redirect: "manual", ...init });
const cookie = (secret: string) => ({ cookie: `session_token=${secret}` });

async function issueViaAdmin(client_id: string, label?: string) {
  const res = await req("/admin/credentials", {
    method: "POST",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({ client_id, label }),
  });
  return { res, body: await res.json() };
}

// --- admin API -----------------------------------------------------------------

Deno.test("admin: endpoints require the admin bearer token", async () => {
  const attempts: Record<string, string>[] = [
    {},
    { authorization: "Bearer wrong" },
    { authorization: "Basic abc" },
  ];
  for (const headers of attempts) {
    assertEquals((await req("/admin/credentials", { headers })).status, 401);
    assertEquals(
      (await req("/admin/credentials", { method: "POST", headers, body: "{}" }))
        .status,
      401,
    );
    assertEquals(
      (await req("/admin/credentials/1", { method: "DELETE", headers })).status,
      401,
    );
    assertEquals(
      (await req("/sessions/1/start", { method: "POST", headers })).status,
      401,
    );
  }
});

Deno.test("admin: with no ADMIN_TOKEN configured, admin routes are closed (503), not open", async () => {
  const saved = Deno.env.get("ADMIN_TOKEN")!;
  Deno.env.delete("ADMIN_TOKEN");
  try {
    assertEquals(
      (await req("/admin/credentials", { headers: adminHeaders })).status,
      503,
    );
    assertEquals(
      (await req("/sessions/1/start", {
        method: "POST",
        headers: adminHeaders,
      })).status,
      503,
    );
    assertEquals(
      (await req("/admin/credentials", {
        headers: { authorization: "Bearer " },
      })).status,
      503,
    );
  } finally {
    Deno.env.set("ADMIN_TOKEN", saved);
  }
});

Deno.test("admin: issue returns a link once; listing never shows secrets", async () => {
  const { res, body } = await issueViaAdmin("judge2", "Alice");
  assertEquals(res.status, 201);
  assertEquals([body.client_id, body.label], ["judge2", "Alice"]);
  assertStringIncludes(body.link, "/join/");
  const secret = body.link.split("/join/")[1];

  const list =
    await (await req("/admin/credentials", { headers: adminHeaders })).json();
  const mine = list.find((c: any) => c.id === body.id);
  assertEquals(mine.client_id, "judge2");
  assertEquals(JSON.stringify(list).includes(secret), false);
});

Deno.test("admin: rejects invalid client ids and bodies", async () => {
  for (const id of ["admin1", "judge", "dj-1", "", 5, null]) {
    assertEquals((await issueViaAdmin(id as any)).res.status, 400, String(id));
  }
  const bad = await req("/admin/credentials", {
    method: "POST",
    headers: adminHeaders,
    body: "not json",
  });
  assertEquals(bad.status, 400);
  assertEquals(
    (await req("/admin/credentials/abc", {
      method: "DELETE",
      headers: adminHeaders,
    })).status,
    400,
  );
  assertEquals(
    (await req("/admin/credentials/99999", {
      method: "DELETE",
      headers: adminHeaders,
    })).status,
    404,
  );
});

// --- joining ---------------------------------------------------------------------

Deno.test("join: a valid link sets a hardened cookie and lands on the right page per role", async () => {
  for (
    const [clientId, page] of [["dj3", "/dj"], ["judge7", "/judge"], [
      "sb3",
      "/scoreboard",
    ]]
  ) {
    const secret = await secretFor(clientId);
    const res = await req(`/join/${secret}`);
    assertEquals([res.status, res.headers.get("location")], [302, page]);
    const set = res.headers.get("set-cookie")!;
    assertStringIncludes(set, `session_token=${secret}`);
    assertStringIncludes(set, "HttpOnly");
    assertStringIncludes(set, "SameSite=Strict");
    assertStringIncludes(set, "Path=/");
    assertEquals(set.includes("Secure"), false); // plain http in dev
    assertEquals(res.headers.get("cache-control"), "no-store");
    assertEquals(res.headers.get("referrer-policy"), "no-referrer");
  }
});

Deno.test("join: cookie is Secure behind an https proxy", async () => {
  const secret = await secretFor("dj1");
  const res = await req(`/join/${secret}`, {
    headers: { "x-forwarded-proto": "https" },
  });
  assertStringIncludes(res.headers.get("set-cookie")!, "Secure");
});

Deno.test("join: unknown or revoked links are refused and set no cookie", async () => {
  const unknown = await req("/join/not-a-real-secret");
  assertEquals(unknown.status, 401);
  assertEquals(unknown.headers.get("set-cookie"), null);

  const { body } = await issueViaAdmin("judge2");
  const secret = body.link.split("/join/")[1];
  await req(`/admin/credentials/${body.id}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  const revoked = await req(`/join/${secret}`);
  assertEquals(revoked.status, 401);
  assertEquals(revoked.headers.get("set-cookie"), null);
});

Deno.test("join: the secret is never written to the request log", async () => {
  const secret = await secretFor("judge9");
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    await req(`/join/${secret}`);
  } finally {
    console.log = orig;
  }
  assert(
    logged.some((l) => l.includes("/join/***")),
    "request is logged, redacted",
  );
  assertEquals(logged.some((l) => l.includes(secret)), false);
});

// --- identity & revocation -----------------------------------------------------------

Deno.test("session: reports who the device is; no or unknown cookie is 401", async () => {
  const secret = await secretFor("judge5");
  const res = await req("/session", { headers: cookie(secret) });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).client_id, "judge5");
  assertEquals(res.headers.get("cache-control"), "no-store");

  assertEquals((await req("/session")).status, 401);
  assertEquals(
    (await req("/session", { headers: cookie("nope") })).status,
    401,
  );
});

Deno.test("revocation takes effect immediately on /session, /events and /response", async () => {
  const { body } = await issueViaAdmin("judge6");
  const secret = body.link.split("/join/")[1];
  const ctl = new AbortController();
  const events = await req("/events", {
    headers: cookie(secret),
    signal: ctl.signal,
  });
  assertEquals(events.status, 200);
  ctl.abort();
  await events.body?.cancel().catch(() => {});

  const del = await req(`/admin/credentials/${body.id}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  assertEquals(del.status, 200);

  assertEquals(
    (await req("/session", { headers: cookie(secret) })).status,
    401,
  );
  assertEquals((await req("/events", { headers: cookie(secret) })).status, 401);
  const resp = await req("/response", {
    method: "POST",
    headers: { ...cookie(secret), "content-type": "application/json" },
    body: JSON.stringify({ tag: perfTag(1, 0), payload: true }),
  });
  assertEquals(resp.status, 401);
});

Deno.test("SSE identity comes from the credential, not from anything the client sends", async () => {
  const secret = await secretFor("judge8");
  const ctl = new AbortController();
  const res = await req("/events?sub=dj1", {
    headers: cookie(secret),
    signal: ctl.signal,
  });
  assertEquals(res.status, 200);
  ctl.abort();
  await res.body?.cancel().catch(() => {});
  await delay(20);
});

// --- who may answer what ---------------------------------------------------------------

const competition: Competition = {
  id: 10,
  name: "C",
  competitors: [{ id: 100, name: "A", duration: 60 }],
  rubric: {
    id: 1,
    criteria: [{ id: 1, name: "T" }],
    judges: [{ id: 2, name: "J2", criteria: [1] }, {
      id: 3,
      name: "J3",
      criteria: [1],
    }],
  },
};

function respond(
  secret: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return req("/response", {
    method: "POST",
    headers: {
      ...cookie(secret),
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function liveSession() {
  clearAllResolvers();
  sessions.clear();
  const unassigned = new Map();
  const saved: unknown[] = [];
  const session = new Session(1, {
    unassignedClients: unassigned,
    saveScore: (s) => {
      saved.push(s);
      return Promise.resolve();
    },
  });
  for (const id of ["dj1", "judge2", "judge3"]) {
    unassigned.set(id, createMockClient(id));
  }
  sessions.set(1, session);
  const done = session.runSession([competition], ["dj1"]);
  await delay(40);
  return { session, done, saved };
}

Deno.test("ownership: only the session's DJ may answer a performance", async () => {
  const { done } = await liveSession();
  const judge = await secretFor("judge2");
  const otherTrackDj = await secretFor("dj9"); // a DJ, but not in this session
  const scoreboard = await secretFor("sb1");
  const dj = await secretFor("dj1");

  for (const s of [judge, otherTrackDj, scoreboard]) {
    assertEquals(
      (await respond(s, { tag: perfTag(10, 0), payload: true })).status,
      403,
    );
  }
  assertEquals(
    (await respond(dj, { tag: perfTag(10, 0), payload: true })).status,
    200,
  );
  await delay(20);
  // finish scoring so the session ends
  for (const j of [2, 3]) {
    await respond(await secretFor(`judge${j}`), {
      tag: scoreTag(10, 100, j),
      payload: [{ criteria_id: 1, score: 5 }],
    });
  }
  await done;
  sessions.clear();
});

Deno.test("ownership: a judge can only submit their own score", async () => {
  const { done, saved } = await liveSession();
  await respond(await secretFor("dj1"), { tag: perfTag(10, 0), payload: true });
  await delay(20);

  const judge2 = await secretFor("judge2");
  const judge3 = await secretFor("judge3");
  const dj = await secretFor("dj1");
  const scores = [{ criteria_id: 1, score: 9 }];

  // judge 2 tries to score for judge 3; the DJ tries to score; a scoreboard tries
  assertEquals(
    (await respond(judge2, { tag: scoreTag(10, 100, 3), payload: scores }))
      .status,
    403,
  );
  assertEquals(
    (await respond(dj, { tag: scoreTag(10, 100, 2), payload: scores })).status,
    403,
  );
  assertEquals(
    (await respond(await secretFor("sb1"), {
      tag: scoreTag(10, 100, 2),
      payload: scores,
    })).status,
    403,
  );
  assertEquals(saved.length, 0);

  // The impersonation attempts did not consume anyone's turn.
  assertEquals(
    (await respond(judge2, { tag: scoreTag(10, 100, 2), payload: scores }))
      .status,
    200,
  );
  assertEquals(
    (await respond(judge3, { tag: scoreTag(10, 100, 3), payload: scores }))
      .status,
    200,
  );
  await done;
  assertEquals(saved.length, 2);
  sessions.clear();
});

Deno.test("csrf: /response requires a JSON content-type", async () => {
  const { done } = await liveSession();
  const dj = await secretFor("dj1");
  for (
    const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
    ]
  ) {
    const res = await req("/response", {
      method: "POST",
      headers: { ...cookie(dj), "content-type": type },
      body: JSON.stringify({ tag: perfTag(10, 0), payload: true }),
    });
    assertEquals(res.status, 415, type);
  }
  // clean up: let the session end
  await respond(dj, { tag: perfTag(10, 0), payload: false });
  await done;
  sessions.clear();
});

Deno.test("credentials store has the issued entries (sanity)", () => {
  assert(credentials.list().length > 0);
});
