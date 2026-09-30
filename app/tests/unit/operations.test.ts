// Operator controls: abort, skip, timeouts, missing-judge records, status.
import { assert, assertEquals } from "@std/assert";
import { Session } from "../../src/session.ts";
import {
  clearAllResolvers,
  getPendingTags,
  resolveTag,
} from "../../src/resolveTag.ts";
import { perfTag, scoreTag } from "../../src/contract.ts";
import type { Competition } from "../../src/types.ts";
import { createDependencies, createMockClient, delay } from "../test-utils.ts";

const comp = (id: number, ...competitorIds: number[]): Competition => ({
  id,
  name: `C${id}`,
  competitors: competitorIds.map((c) => ({
    id: c,
    name: `P${c}`,
    duration: 60,
  })),
  rubric: {
    id: 1,
    criteria: [{ id: 1, name: "T" }],
    judges: [{ id: 2, name: "J2", criteria: [1] }, {
      id: 3,
      name: "J3",
      criteria: [1],
    }],
  },
});

const names = (c: { __messages: string[] }) =>
  c.__messages.map((m) => m.split("\n")[0].replace("event: ", ""));
const data = (c: { __messages: string[] }, event: string) =>
  c.__messages.filter((m) => m.startsWith(`event: ${event}\n`)).map((m) =>
    JSON.parse(m.split("data: ")[1])
  );
const five = [{ criteria_id: 1, score: 5 }];

/** Build a session with the named clients connected (or not). */
function setup(connect: string[] = ["dj1", "sb1", "judge2", "judge3"]) {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);
  const clients: Record<string, ReturnType<typeof createMockClient>> = {};
  for (const id of connect) {
    clients[id] = createMockClient(id);
    deps.unassignedClients.set(id, clients[id]);
  }
  return { session, deps, clients };
}

async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) Deno.env.delete(k);
  }
}

// --- abort -----------------------------------------------------------------------

Deno.test("abort: a session stuck waiting for a client that never connects can be stopped", async () => {
  const { session, deps } = setup(["sb1"]); // no DJ ever
  const done = session.runSession([comp(10, 100)], ["dj1", "sb1"]);
  await delay(30);
  assertEquals(session.status().waiting_for, ["dj1"]);
  assertEquals(getPendingTags(), ["required:dj1"]);

  assertEquals(session.abort(), true);
  await done; // resolves, does not throw
  assertEquals([session.isRunning(), session.endReason], [false, "aborted"]);
  assertEquals(getPendingTags(), []); // nothing left waiting
  assert(deps.unassignedClients.has("sb1"), "connected clients are released");
});

Deno.test("abort: mid-performance and mid-scoring release everything and tell clients", async () => {
  for (const phase of ["performing", "scoring"] as const) {
    const { session, clients } = setup();
    const done = session.runSession([comp(10, 100, 101)], ["dj1", "sb1"]);
    await delay(30);
    if (phase === "scoring") {
      resolveTag(perfTag(10, 0), true);
      await delay(20);
      assertEquals(session.currentPhase, "scoring");
    }
    assertEquals(session.abort("operator said so"), true);
    await done;

    assertEquals(session.endReason, "aborted", phase);
    assertEquals(getPendingTags(), [], phase);
    assertEquals(session.currentPhase, "idle");
    for (const id of Object.keys(clients)) {
      assertEquals(data(clients[id], "session_end"), [{
        reason: "aborted",
        incomplete: 0,
      }], `${phase} ${id}`);
    }
    // it did not go on to the second competitor
    assertEquals(data(clients.dj1, "performance_start").length, 1, phase);
  }
});

Deno.test("abort: false when not running, and only once", async () => {
  const { session } = setup();
  assertEquals(session.abort(), false);
  const done = session.runSession([comp(10, 100)], ["dj1", "sb1"]);
  await delay(30);
  assertEquals(session.abort(), true);
  assertEquals(session.abort(), false);
  await done;
  assertEquals(session.abort(), false);
});

Deno.test("abort: the session can be started again afterwards", async () => {
  const { session, clients } = setup();
  const first = session.runSession([comp(10, 100)], ["dj1", "sb1"]);
  await delay(30);
  session.abort();
  await first;
  for (const c of Object.values(clients)) session.connectClient(c);

  const second = session.runSession([comp(10, 100)], ["dj1", "sb1"]);
  await delay(30);
  resolveTag(perfTag(10, 0), false);
  await second;
  assertEquals(session.endReason, "completed");
});

// --- normal end ------------------------------------------------------------------

Deno.test("session_end: sent on normal completion with the count of missing scores", async () => {
  const { session, clients } = setup();
  const done = session.runSession([comp(10, 100)], ["dj1", "sb1"]);
  await delay(30);
  resolveTag(perfTag(10, 0), true);
  await delay(20);
  resolveTag(scoreTag(10, 100, 2), five);
  resolveTag(scoreTag(10, 100, 3), five);
  await done;
  assertEquals(data(clients.judge2, "session_end"), [{
    reason: "completed",
    incomplete: 0,
  }]);
});

// --- skip ------------------------------------------------------------------------

Deno.test("skip: nothing pending => undefined", () => {
  const { session } = setup();
  assertEquals(session.skip(), undefined); // not running
});

Deno.test("skip performance: DJ is told to stop, no scoring, next competitor starts", async () => {
  const { session, clients } = setup();
  const done = session.runSession([comp(10, 100, 101)], ["dj1", "sb1"]);
  await delay(30);
  assertEquals(session.skip(), "performance");
  await delay(30);

  assertEquals(data(clients.dj1, "performance_skipped"), [{
    competition_id: 10,
    position: 0,
  }]);
  assertEquals(names(clients.judge2).includes("enable_scoring"), false); // not scored
  assertEquals(data(clients.dj1, "performance_start").map((p) => p.position), [
    0,
    1,
  ]);
  assertEquals(names(clients.sb1).includes("performance_skipped"), false); // only the DJ
  session.abort();
  await done;
});

Deno.test("skip scoring: judges who have not submitted are closed out and recorded", async () => {
  const { session, clients } = setup();
  const saved: number[] = [];
  const done = session.runSession([comp(10, 100)], ["dj1", "sb1"]);
  (session as unknown as {
    deps: { saveScore: (s: { judge_id: number }) => Promise<void> };
  }).deps.saveScore = (s) => {
    saved.push(s.judge_id);
    return Promise.resolve();
  };
  await delay(30);
  resolveTag(perfTag(10, 0), true);
  await delay(20);
  resolveTag(scoreTag(10, 100, 2), five); // judge 2 scores, judge 3 never does
  await delay(20);
  assertEquals(session.status().waiting_for, ["judge3"]);

  assertEquals(session.skip(), "scoring");
  await done;

  assertEquals(saved, [2]); // judge 2's score is kept
  assertEquals(session.incomplete, [{
    competition_id: 10,
    competitor_id: 100,
    judge_id: 3,
    reason: "closed",
  }]);
  assertEquals(data(clients.judge3, "scoring_closed"), [{
    competition_id: 10,
    position: 0,
    missing_judge_ids: [3],
  }]);
  assertEquals(data(clients.judge2, "session_end")[0].incomplete, 1);
});

Deno.test("skip waiting: goes on without a judge who never connects, and does not wait for them later", async () => {
  const { session, clients } = setup(["dj1", "sb1", "judge2"]); // judge3 missing
  const done = session.runSession([comp(10, 100, 101)], ["dj1", "sb1"]);
  await delay(30);
  assertEquals(session.status().waiting_for, ["judge3"]);
  assertEquals(session.skip(), "waiting");
  await delay(30);
  assertEquals(session.currentPhase, "performing"); // competition started without judge 3

  for (const pos of [0, 1]) {
    resolveTag(perfTag(10, pos), true);
    await delay(20);
    // only judge 2 is waited for; a lone submission finishes scoring at once
    resolveTag(scoreTag(10, 100 + pos, 2), five);
    await delay(20);
  }
  await done;
  assertEquals(
    session.incomplete.map((i) => [i.competitor_id, i.judge_id, i.reason]),
    [
      [100, 3, "absent"],
      [101, 3, "absent"],
    ],
  );
  assertEquals(data(clients.judge2, "session_end")[0].incomplete, 2);
});

Deno.test("skip waiting: a judge who shows up after being excused is scored normally", async () => {
  const { session, deps } = setup(["dj1", "sb1", "judge2"]);
  const done = session.runSession([comp(10, 100)], ["dj1", "sb1"]);
  await delay(30);
  session.skip();
  await delay(20);
  const late = createMockClient("judge3");
  deps.unassignedClients.set("judge3", late);
  session.connectClient(late); // arrives during the performance
  resolveTag(perfTag(10, 0), true);
  await delay(20);
  resolveTag(scoreTag(10, 100, 2), five);
  resolveTag(scoreTag(10, 100, 3), five);
  await done;
  assertEquals(session.incomplete, []);
});

// --- timeouts --------------------------------------------------------------------

Deno.test("scoring time limit: late judges are recorded and told", async () => {
  await withEnv({ JUDGE_SCORE_TIMEOUT_MS: "80" }, async () => {
    const { session, clients } = setup();
    const done = session.runSession([comp(10, 100)], ["dj1", "sb1"]);
    await delay(30);
    resolveTag(perfTag(10, 0), true);
    await delay(20);
    resolveTag(scoreTag(10, 100, 2), five);
    await done; // judge 3 times out after 80ms

    assertEquals(session.incomplete.map((i) => [i.judge_id, i.reason]), [[
      3,
      "timeout",
    ]]);
    assertEquals(data(clients.judge3, "scoring_closed")[0].missing_judge_ids, [
      3,
    ]);
    assertEquals(session.endReason, "completed");
  });
});

Deno.test("performance time limit: a stuck DJ does not hang the session", async () => {
  await withEnv({ PERFORMANCE_TIMEOUT_MS: "60" }, async () => {
    const { session, clients } = setup();
    const done = session.runSession([comp(10, 100, 101)], ["dj1", "sb1"]);
    await done; // both performances time out; nothing is scored
    assertEquals(session.endReason, "completed");
    assertEquals(data(clients.dj1, "performance_start").length, 2);
    assertEquals(names(clients.judge2).includes("enable_scoring"), false);
    assertEquals(getPendingTags(), []);
  });
});

// --- status ----------------------------------------------------------------------

Deno.test("status: shows phase, connected clients, and who the session is waiting for", async () => {
  const { session } = setup(["dj1", "sb1", "judge2"]);
  const done = session.runSession([comp(10, 100)], ["dj1", "sb1"]);
  await delay(30);
  let s = session.status();
  assertEquals([s.running, s.phase, s.waiting_for], [true, "idle", ["judge3"]]);
  assertEquals(s.connected.sort(), ["dj1", "judge2", "sb1"]);

  session.skip();
  await delay(30);
  s = session.status();
  assertEquals([s.phase, s.competition_id, s.position, s.waiting_for], [
    "performing",
    10,
    0,
    [],
  ]);

  session.abort();
  await done;
  assertEquals(session.status().running, false);
});
