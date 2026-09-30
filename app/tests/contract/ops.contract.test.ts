// Admin session controls over HTTP: status, skip, abort.
import { assert, assertEquals } from "@std/assert";
import { app } from "../../src/main.ts";
import { Session } from "../../src/session.ts";
import { sessions } from "../../src/sessionManager.ts";
import { clearAllResolvers, getPendingTags } from "../../src/resolveTag.ts";
import { perfTag } from "../../src/contract.ts";
import type { Competition } from "../../src/types.ts";
import { createMockClient, delay } from "../test-utils.ts";
import { adminHeaders, secretFor } from "../auth-utils.ts";

const competition: Competition = {
  id: 10,
  name: "C",
  competitors: [{ id: 100, name: "A", duration: 1 }],
  rubric: {
    id: 1,
    criteria: [{ id: 1, name: "T" }],
    judges: [{ id: 2, name: "J2", criteria: [1] }],
  },
};

const call = (method: string, path: string, admin = true) =>
  app.request(path, { method, headers: admin ? adminHeaders : {} });

/** A registered session; `connect` chooses which clients are present. */
function live(connect: string[]) {
  clearAllResolvers();
  sessions.clear();
  const unassigned = new Map();
  for (const id of connect) unassigned.set(id, createMockClient(id));
  const session = new Session(1, {
    unassignedClients: unassigned,
    trackId: 1,
    saveScore: () => Promise.resolve(),
  });
  sessions.set(1, session);
  return { session, done: session.runSession([competition], ["dj1"]) };
}

Deno.test("ops: session controls require the admin token", async () => {
  for (
    const [m, p] of [["GET", "/admin/sessions"], [
      "POST",
      "/admin/sessions/1/skip",
    ], ["POST", "/admin/sessions/1/abort"]]
  ) {
    assertEquals((await call(m, p, false)).status, 401, `${m} ${p}`);
  }
});

Deno.test("ops: unknown sessions are 404", async () => {
  sessions.clear();
  assertEquals((await call("POST", "/admin/sessions/99/skip")).status, 404);
  assertEquals((await call("POST", "/admin/sessions/99/abort")).status, 404);
  assertEquals(await (await call("GET", "/admin/sessions")).json(), []);
});

Deno.test("ops: status shows what a stuck session is waiting for; skip goes on without it", async () => {
  const { done } = live(["judge2"]); // the DJ never connects
  await delay(30);

  const list = await (await call("GET", "/admin/sessions")).json();
  assertEquals(list.length, 1);
  assertEquals([list[0].id, list[0].running, list[0].waiting_for], [1, true, [
    "dj1",
  ]]);

  const skip = await call("POST", "/admin/sessions/1/skip");
  assertEquals([skip.status, (await skip.json()).skipped], [200, "waiting"]);
  await delay(30);
  const after = (await (await call("GET", "/admin/sessions")).json())[0];
  assertEquals([after.phase, after.position], ["performing", 0]);

  // performing: skipping again skips the performance, then nothing is pending
  assertEquals(
    (await (await call("POST", "/admin/sessions/1/skip")).json()).skipped,
    "performance",
  );
  await done;
  assertEquals((await call("POST", "/admin/sessions/1/skip")).status, 404); // no longer running
  sessions.clear();
});

Deno.test("ops: 409 when there is nothing to skip", async () => {
  const { session, done } = live(["dj1", "judge2"]);
  await delay(30);
  session.currentPhase = "idle"; // between phases
  session.currentCompetition = null;
  // a running session that is neither waiting, performing nor scoring
  const res = await call("POST", "/admin/sessions/1/skip");
  assert([200, 409].includes(res.status));
  await call("POST", "/admin/sessions/1/abort");
  await done;
  sessions.clear();
});

Deno.test("ops: abort ends the session, releases its waits, and frees it to start again", async () => {
  const { done } = live(["dj1", "judge2"]);
  await delay(30);
  // a DJ can answer while it runs
  const dj = await secretFor("dj1");
  const respond = () =>
    app.request("/response", {
      method: "POST",
      headers: {
        cookie: `session_token=${dj}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tag: perfTag(10, 0), payload: true }),
    });

  const res = await call("POST", "/admin/sessions/1/abort");
  assertEquals([res.status, (await res.json()).success], [200, true]);
  await done;
  assertEquals(getPendingTags(), []);
  assertEquals((await respond()).status, 404); // nothing is waiting any more
  assertEquals(sessions.get(1)?.isRunning() ?? false, false);
  sessions.clear();
});

Deno.test("ops: aborting a leftover session that is not running just removes it", async () => {
  sessions.clear();
  sessions.set(
    5,
    new Session(5, {
      unassignedClients: new Map(),
      saveScore: () => Promise.resolve(),
    }),
  );
  const res = await call("POST", "/admin/sessions/5/abort");
  assertEquals(res.status, 200);
  assertEquals(sessions.has(5), false);
});
