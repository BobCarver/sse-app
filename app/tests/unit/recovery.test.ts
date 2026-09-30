// State replay for clients that (re)connect mid-event.
import { assertEquals } from "@std/assert";
import { Session } from "../../src/session.ts";
import { SessionManager, sessions } from "../../src/sessionManager.ts";
import { handleSSEConnection } from "../../src/sse.ts";
import { clearAllResolvers, resolveTag } from "../../src/resolveTag.ts";
import { perfTag, scoreTag } from "../../src/contract.ts";
import type { Competition, SSEClient } from "../../src/types.ts";
import { createDependencies, createMockClient, delay } from "../test-utils.ts";

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

const events = (c: { __messages: string[] }) =>
  c.__messages.map((m) => m.split("\n")[0].replace("event: ", ""));

/** Session paused in a given phase with everyone connected. */
async function running(phase: "performing" | "scoring") {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);
  for (const id of ["dj1", "sb1", "judge2", "judge3"]) {
    deps.unassignedClients.set(id, createMockClient(id));
  }
  const done = session.runSession([competition], ["dj1", "sb1"]);
  await delay(30);
  if (phase === "scoring") {
    resolveTag(perfTag(10, 0), true);
    await delay(20);
  }
  return { session, deps, done };
}

async function finish(session: Session, done: Promise<void>) {
  resolveTag(perfTag(10, 0), true); // no-op if already past
  await delay(20); // let the session open its score waiters
  for (const j of [2, 3]) {
    resolveTag(scoreTag(10, 100, j), [{ criteria_id: 1, score: 5 }]);
  }
  await done;
  sessions.delete(session.id);
}

Deno.test("recovery: nobody gets a replay before a competition is underway", async () => {
  const deps = createDependencies();
  const session = new Session(1, deps);
  const c = createMockClient("judge2");
  await session.handleClientReconnect(c);
  assertEquals(c.__messages, []);
});

Deno.test("recovery while performing: DJ gets performance_recovery (not performance_start); others get the position", async () => {
  const { session, done } = await running("performing");
  const dj = createMockClient("dj1"),
    sb = createMockClient("sb1"),
    judge = createMockClient("judge2");
  for (const c of [dj, sb, judge]) await session.handleClientReconnect(c);

  assertEquals(events(dj), ["competition_start", "performance_recovery"]);
  assertEquals(events(sb), ["competition_start", "performance_start"]);
  assertEquals(events(judge), ["competition_start", "performance_start"]); // scoring not open yet
  await finish(session, done);
});

Deno.test("recovery while scoring: unsubmitted judge is re-enabled; submitted judge is not; scoreboard gets scores so far", async () => {
  const { session, done } = await running("scoring");
  resolveTag(scoreTag(10, 100, 2), [{ criteria_id: 1, score: 7 }]); // judge 2 submits
  await delay(20);

  const j2 = createMockClient("judge2"),
    j3 = createMockClient("judge3"),
    sb = createMockClient("sb1"),
    dj = createMockClient("dj1");
  for (const c of [j2, j3, sb, dj]) await session.handleClientReconnect(c);

  assertEquals(events(j2), ["competition_start", "performance_start"]); // already submitted
  assertEquals(events(j3), [
    "competition_start",
    "performance_start",
    "enable_scoring",
  ]);
  assertEquals(events(sb), [
    "competition_start",
    "performance_start",
    "score_update",
  ]);
  assertEquals(events(dj), ["competition_start"]); // nothing to do for DJ while judges score
  const replayed = JSON.parse(sb.__messages[2].split("data: ")[1]);
  assertEquals([replayed.judge_id, replayed.scores], [2, [{
    criteria_id: 1,
    score: 7,
  }]]);
  await finish(session, done);
});

Deno.test("recovery: judges never receive other judges' scores in a replay", async () => {
  const { session, done } = await running("scoring");
  resolveTag(scoreTag(10, 100, 2), [{ criteria_id: 1, score: 7 }]);
  await delay(20);
  const j3 = createMockClient("judge3");
  await session.handleClientReconnect(j3);
  assertEquals(events(j3).includes("score_update"), false);
  await finish(session, done);
});

Deno.test("recovery: no replay once the competition is over", async () => {
  const { session, done } = await running("performing");
  await finish(session, done);
  const late = createMockClient("sb1");
  await session.handleClientReconnect(late);
  assertEquals(late.__messages, []);
});

// --- connection identity ---------------------------------------------------

Deno.test("connectClient: a second connection with the same id supersedes the first", async () => {
  const { session, done } = await running("performing");
  const first = session.clients.get("judge2") as SSEClient & {
    __messages: string[];
  };
  const second = createMockClient("judge2");
  session.connectClient(second);
  assertEquals(events(first).includes("superseded"), true);
  assertEquals(session.clients.get("judge2"), second);
  await finish(session, done);
});

Deno.test("disconnectClient: a stale stream closing does not evict its replacement", async () => {
  const { session, done } = await running("performing");
  const old = session.clients.get("judge2")!;
  const replacement = createMockClient("judge2");
  session.connectClient(replacement);

  session.disconnectClient("judge2", old); // old stream's abort arrives late
  assertEquals(session.clients.get("judge2"), replacement);

  session.disconnectClient("judge2", replacement); // real disconnect
  assertEquals(session.clients.get("judge2"), undefined);
  await finish(session, done);
});

Deno.test("handleSSEConnection: stale abort leaves the newer connection registered", async () => {
  sessions.clear();
  const unassigned = new Map<string, SSEClient>();
  const deps = { SessionManager, unassignedClients: unassigned };
  const written: string[] = [];
  const stream = {
    write: (s: string) => {
      written.push(s);
      return Promise.resolve();
    },
  } as never;

  const ctlA = new AbortController(), ctlB = new AbortController();
  const a = handleSSEConnection(stream, ctlA.signal, "judge9", "judge", deps);
  await delay(5);
  const clientA = unassigned.get("judge9")!;
  const b = handleSSEConnection(stream, ctlB.signal, "judge9", "judge", deps);
  await delay(5);
  const clientB = unassigned.get("judge9")!;
  assertEquals(clientA === clientB, false);

  ctlA.abort(); // old stream ends AFTER the new one connected
  await a;
  assertEquals(unassigned.get("judge9"), clientB);

  ctlB.abort();
  await b;
  assertEquals(unassigned.has("judge9"), false);
  assertEquals(written.some((w) => w.includes("event: superseded")), true);
});

Deno.test("handleSSEConnection: an already-aborted signal does not hang", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const stream = { write: () => Promise.resolve() } as never;
  await handleSSEConnection(stream, ctl.signal, "judge8", "judge", {
    SessionManager,
    unassignedClients: new Map(),
  });
});
