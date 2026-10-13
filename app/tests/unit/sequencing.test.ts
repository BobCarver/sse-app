// Phase 3 of the redesign, inside a session: the planned start gates the DJ,
// the operator can hold, release and cancel, and judges are claimed per
// competition (a judge held by another track is waited for).
import { assert, assertEquals } from "@std/assert";
import { Session, type SessionDependencies } from "../../src/session.ts";
import { JudgeClaims, sessions } from "../../src/sessionManager.ts";
import { clearAllResolvers, resolveTag } from "../../src/resolveTag.ts";
import { beginTag, perfTag, scoreTag } from "../../src/contract.ts";
import { handleResponse } from "../../src/responseService.ts";
import type { Competition, ProgressEvent, SSEClient } from "../../src/types.ts";
import { createMockClient, delay } from "../test-utils.ts";

const comp = (
  id: number,
  judge = 2,
  ...competitorIds: number[]
): Competition => ({
  id,
  name: `C${id}`,
  competitors: (competitorIds.length ? competitorIds : [id * 10]).map((c) => ({
    id: c,
    name: `P${c}`,
    duration: 60,
  })),
  rubric: {
    id: 1,
    criteria: [{ id: 1, name: "T" }],
    judges: [{ id: judge, name: `J${judge}`, criteria: [1] }],
  },
});
const five = [{ criteria_id: 1, score: 5 }];
const sent = (c: { __messages: string[] }, event: string) =>
  c.__messages.filter((m) => m.startsWith(`event: ${event}\n`))
    .map((m) => JSON.parse(m.split("data: ")[1]));

type Mock = SSEClient & { __messages: string[] };

/** A session on `trackId`, sharing `pool` (and `claims`) with others. */
function make(
  id: number,
  trackId: number,
  over: Partial<SessionDependencies> = {},
  pool = new Map<string, SSEClient>(),
) {
  const events: ProgressEvent[] = [];
  const session = new Session(id, {
    unassignedClients: pool,
    trackId,
    saveScore: () => Promise.resolve(),
    recordProgress: (e) => {
      events.push(e);
      return Promise.resolve();
    },
    ...over,
  });
  return { session, events, pool };
}
function connect(pool: Map<string, SSEClient>, ...ids: string[]) {
  const out: Record<string, Mock> = {};
  for (const id of ids) {
    out[id] = createMockClient(id) as Mock;
    pool.set(id, out[id]);
  }
  return out;
}

Deno.test("planned start: the DJ cannot start before it; an early press is refused (425)", async () => {
  clearAllResolvers();
  sessions.clear();
  const planned = new Date(Date.now() + 200);
  const { session, pool } = make(1, 1, {
    djGates: true,
    plannedStart: planned,
  });
  const c = connect(pool, "dj1", "sb1", "judge2");
  sessions.set(1, session);
  const done = session.runSession([comp(10)], ["dj1", "sb1"]);
  await delay(40);

  // Everyone is told when; the DJ's button counts down to it.
  const [ready] = sent(c.sb1, "competition_ready");
  assertEquals(ready.starts_at, planned.toISOString());
  assert(typeof ready.server_time === "string");
  assertEquals(session.status().waiting_for, [
    `planned start ${planned.toISOString()}`,
  ]);
  const early = handleResponse("dj1", { tag: beginTag(10), payload: true });
  assertEquals(early, {
    ok: false,
    status: 425,
    error: `not before ${planned.toISOString()}`,
  });
  assertEquals(sent(c.dj1, "competition_start"), []);

  await delay(220); // the planned time has come
  assertEquals(session.beginNotBefore(10), undefined);
  assertEquals(session.status().waiting_for, ["dj-start"]);
  assertEquals(handleResponse("dj1", { tag: beginTag(10), payload: true }), {
    ok: true,
  });
  await delay(20);
  assertEquals(sent(c.dj1, "performance_start").length, 1);
  session.abort();
  await done;
  sessions.clear();
});

Deno.test("planned start: without DJ gates the session still waits for it", async () => {
  clearAllResolvers();
  const { session, pool } = make(1, 1, {
    plannedStart: new Date(Date.now() + 120),
  });
  const c = connect(pool, "dj1", "sb1", "judge2");
  const done = session.runSession([comp(10)], ["dj1", "sb1"]);
  await delay(40);
  assertEquals(sent(c.dj1, "performance_start"), []);
  await delay(140);
  assertEquals(sent(c.dj1, "performance_start").length, 1);
  session.abort();
  await done;
});

Deno.test("planned start: a session resumed after it began is not held back again", async () => {
  clearAllResolvers();
  const { session, pool } = make(1, 1, {
    plannedStart: new Date(Date.now() + 60_000),
  });
  const c = connect(pool, "dj1", "sb1", "judge2");
  const done = session.runSession(
    [comp(10, 2, 100, 101)],
    ["dj1", "sb1"],
    { finished: new Set(["10:100"]) },
  );
  await delay(40);
  assertEquals(sent(c.dj1, "performance_start"), [
    { competition_id: 10, position: 1 },
  ]);
  session.abort();
  await done;
});

Deno.test("hold: nothing new starts until release; the hold is recorded", async () => {
  clearAllResolvers();
  const { session, pool, events } = make(1, 1);
  const c = connect(pool, "dj1", "sb1", "judge2");
  const done = session.runSession([comp(10, 2, 100, 101)], ["dj1", "sb1"]);
  await delay(30); // performing 100
  assertEquals(session.hold(), true);
  assertEquals(session.hold(), false); // already held
  resolveTag(perfTag(10, 0), true); // the song ends while held
  await delay(30);
  assertEquals(sent(c.judge2, "enable_scoring"), []); // scoring does not open
  assertEquals(session.status().held, true);
  assertEquals(session.status().waiting_for[0], "held by operator");

  assertEquals(session.release(), true);
  await delay(20);
  assertEquals(sent(c.judge2, "enable_scoring").length, 1);
  resolveTag(scoreTag(10, 100, 2), five);
  await delay(20);
  assertEquals(sent(c.dj1, "performance_start").length, 2); // and on to 101
  assertEquals(
    events.filter((e) => e.kind === "held"),
    [{ kind: "held", held: true }, { kind: "held", held: false }],
  );
  session.abort();
  await done;
});

Deno.test("hold: a session that was held before a restart starts held", async () => {
  clearAllResolvers();
  const { session, pool } = make(1, 1, { held: true });
  const c = connect(pool, "dj1", "sb1", "judge2");
  const done = session.runSession([comp(10)], ["dj1", "sb1"]);
  await delay(30);
  assertEquals(sent(c.sb1, "competition_start"), []);
  assertEquals(session.status().waiting_for, ["held by operator"]);
  session.release();
  await delay(20);
  assertEquals(sent(c.sb1, "competition_start").length, 1);
  session.abort();
  await done;
});

Deno.test("cancel: the session ends as cancelled and every page is told", async () => {
  clearAllResolvers();
  const { session, pool, events } = make(1, 1);
  const c = connect(pool, "dj1", "sb1", "judge2");
  const done = session.runSession([comp(10)], ["dj1", "sb1"]);
  await delay(30);
  assertEquals(session.cancel(), true);
  await done;
  assertEquals(session.endReason, "cancelled");
  assertEquals(sent(c.sb1, "session_end")[0].reason, "cancelled");
  assertEquals(events.at(-1), {
    kind: "session_ended",
    reason: "cancelled",
    untouched: false,
  });
  assertEquals(session.cancel(), false); // not running any more
});

Deno.test("judges are claimed per competition: another track waits for a held judge, then gets them", async () => {
  clearAllResolvers();
  const claims = new JudgeClaims();
  const pool = new Map<string, SSEClient>();
  const a = make(1, 1, { claims }, pool);
  const b = make(2, 2, { claims }, pool);
  const c = connect(pool, "dj1", "sb1", "dj2", "sb2", "judge2");

  const doneA = a.session.runSession([comp(10)], ["dj1", "sb1"]);
  await delay(30); // A holds judge 2 for competition 10
  const doneB = b.session.runSession([comp(20)], ["dj2", "sb2"]);
  await delay(30);
  assertEquals(b.session.status().waiting_for, ["judge2 (held by track 1)"]);
  assertEquals(sent(c.sb2, "competition_start"), []);

  // A's competition ends: the judge is given back and B claims them.
  resolveTag(perfTag(10, 0), true);
  await delay(20);
  resolveTag(scoreTag(10, 100, 2), five);
  await doneA;
  await delay(30);
  assertEquals(sent(c.sb2, "competition_start").length, 1);
  assertEquals(claims.holder("judge2")?.sessionId, 2);
  assert(b.session.clients.get("judge2"), "judge 2 is now in session 2");
  b.session.abort();
  await doneB;
  assertEquals(claims.holder("judge2"), undefined); // given back at the end
});

Deno.test("judges are claimed per competition: the operator can go on without a judge held elsewhere", async () => {
  clearAllResolvers();
  const claims = new JudgeClaims();
  const pool = new Map<string, SSEClient>();
  const a = make(1, 1, { claims }, pool);
  const b = make(2, 2, { claims }, pool);
  const c = connect(pool, "dj1", "sb1", "dj2", "sb2", "judge2");
  const doneA = a.session.runSession([comp(10)], ["dj1", "sb1"]);
  await delay(30);
  const doneB = b.session.runSession([comp(20)], ["dj2", "sb2"]);
  await delay(30);
  assertEquals(b.session.skip(), "waiting");
  await delay(20);
  assertEquals(sent(c.dj2, "performance_start").length, 1);
  assertEquals(claims.holder("judge2")?.sessionId, 1); // still A's
  resolveTag(perfTag(20, 0), true);
  await delay(20);
  // Judge 2 is recorded absent for B; nobody scored, so B waits for the operator.
  assertEquals(
    b.events.filter((e) => e.kind === "score_missing").map((e) =>
      (e as { reason: string }).reason
    ),
    ["absent"],
  );
  a.session.abort();
  b.session.abort();
  await Promise.all([doneA, doneB]);
});
