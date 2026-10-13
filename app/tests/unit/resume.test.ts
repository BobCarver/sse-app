// "start" resumes at the cursor: competitors before it are not run again, and
// the one that was being scored gets its scoring re-opened.
import { assertEquals, assertThrows } from "@std/assert";
import { nextInOrder, planResume, type ResumeRows } from "../../src/resume.ts";
import { Session, type SessionDependencies } from "../../src/session.ts";
import { clearAllResolvers, resolveTag } from "../../src/resolveTag.ts";
import { perfTag, scoreTag } from "../../src/contract.ts";
import type { Competition, ProgressEvent } from "../../src/types.ts";
import { createDependencies, createMockClient, delay } from "../test-utils.ts";

const comp = (id: number, ...competitorIds: number[]): Competition => ({
  id,
  name: `C${id}`,
  competitors: competitorIds.map((
    c,
  ) => ({ id: c, name: `P${c}`, duration: 60 })),
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

const cursorAt = (
  competitionId: number,
  competitorId: number,
  phase: "performing" | "scoring" | null,
  cursorScores: ResumeRows["cursorScores"] = [],
): ResumeRows => ({
  finished: false,
  open: true,
  cursor: { competitionId, competitorId, phase },
  cursorScores,
});

Deno.test("planResume: everything before the cursor is finished; not begun runs from its performance", () => {
  const plan = planResume(
    [comp(10, 100, 101, 102, 103)],
    cursorAt(10, 102, null),
  );
  assertEquals([...plan.finished], ["10:100", "10:101"]);
  assertEquals(plan.reopen, undefined); // 102 is run from its performance
  assertEquals(plan.underway, undefined); // its competition had not begun
});

Deno.test("planResume: cut off mid-performance runs it again; its competition is under way", () => {
  const plan = planResume(
    [comp(10, 100), comp(11, 110, 111)],
    cursorAt(11, 110, "performing"),
  );
  assertEquals([...plan.finished], ["10:100"]);
  assertEquals(plan.reopen, undefined);
  assertEquals(plan.underway, 11);
});

Deno.test("planResume: cut off mid-scoring re-opens scoring with its saved scores", () => {
  const plan = planResume(
    [comp(10, 100, 101), comp(11, 110)],
    cursorAt(10, 101, "scoring", [
      {
        competition_id: 10,
        competitor_id: 101,
        judge_id: 2,
        criteria_id: 1,
        score: 7,
      },
    ]),
  );
  assertEquals([...plan.finished], ["10:100"]);
  assertEquals(plan.reopen, {
    competitionId: 10,
    competitorId: 101,
    scores: [{
      competition_id: 10,
      competitor_id: 101,
      judge_id: 2,
      scores: [{ criteria_id: 1, score: 7 }],
    }],
  });
});

Deno.test("planResume: scoring with no saved scores still re-opens scoring", () => {
  const plan = planResume([comp(10, 100)], cursorAt(10, 100, "scoring"));
  assertEquals(plan.reopen?.scores, []);
});

Deno.test("planResume: an open session with no cursor has every competitor done", () => {
  const plan = planResume([comp(10, 100), comp(11, 110)], {
    finished: false,
    open: true,
    cursor: null,
    cursorScores: [],
  });
  assertEquals([...plan.finished], ["10:100", "11:110"]);
});

Deno.test("planResume: a session that is not open starts from the top", () => {
  assertEquals(planResume([comp(10, 100)], undefined).finished.size, 0);
  assertEquals(
    planResume([comp(10, 100)], {
      finished: false,
      open: false,
      cursor: null,
      cursorScores: [],
    }).finished.size,
    0,
  );
});

Deno.test("planResume: a cursor outside the session is an error, not a guess", () => {
  assertThrows(() => planResume([comp(10, 100)], cursorAt(99, 1, null)));
});

Deno.test("nextInOrder: the following competitor, across competitions", () => {
  const order = [comp(10, 100, 101), comp(11, 110)];
  assertEquals(nextInOrder(order, 10, 0), {
    competitionId: 10,
    competitorId: 101,
  });
  assertEquals(nextInOrder(order, 10, 1), {
    competitionId: 11,
    competitorId: 110,
  });
  assertEquals(nextInOrder(order, 11, 0), null);
});

function setup() {
  clearAllResolvers();
  const deps: SessionDependencies = createDependencies();
  const events: ProgressEvent[] = [];
  deps.recordProgress = (e) => {
    events.push(e);
    return Promise.resolve();
  };
  const clients: Record<string, ReturnType<typeof createMockClient>> = {};
  for (const id of ["dj1", "sb1", "judge2", "judge3"]) {
    clients[id] = createMockClient(id);
    deps.unassignedClients.set(id, clients[id]);
  }
  return { session: new Session(1, deps), events, clients };
}
const sent = (c: { __messages: string[] }, event: string) =>
  c.__messages.filter((m) => m.startsWith(`event: ${event}\n`))
    .map((m) => JSON.parse(m.split("data: ")[1]));
const five = [{ criteria_id: 1, score: 5 }];

Deno.test("runSession: finished competitors are not run again, positions are kept", async () => {
  const { session, events, clients } = setup();
  const done = session.runSession(
    [comp(10, 100, 101), comp(11, 110)],
    ["dj1", "sb1"],
    { finished: new Set(["10:100", "11:110"]) },
  );
  await delay(30);
  assertEquals(sent(clients.dj1, "performance_start"), [
    { competition_id: 10, position: 1 },
  ]);

  resolveTag(perfTag(10, 1), true);
  await delay(20);
  resolveTag(scoreTag(10, 101, 2), five);
  resolveTag(scoreTag(10, 101, 3), five);
  await done;

  assertEquals(events[0], { kind: "session_started", resume: true });
  assertEquals(
    events.filter((e) => e.kind === "competition_started").length,
    1,
  );
  // The one that ran was finalized before the session ended.
  const finalized = events.filter((e) => e.kind === "competitor_finalized");
  assertEquals(finalized, [{
    kind: "competitor_finalized",
    competitionId: 10,
    competitorId: 101,
    next: { competitionId: 11, competitorId: 110 }, // the cursor moves on
  }]);
});

Deno.test("runSession: re-opened scoring waits only for judges who had not scored, with no new performance", async () => {
  const { session, events, clients } = setup();
  const saved = {
    competition_id: 10,
    competitor_id: 101,
    judge_id: 2,
    scores: [{ criteria_id: 1, score: 7 }],
  };
  const done = session.runSession(
    [comp(10, 100, 101, 102)],
    ["dj1", "sb1"],
    {
      finished: new Set(["10:100"]),
      reopen: { competitionId: 10, competitorId: 101, scores: [saved] },
    },
  );
  await delay(30);

  // The DJ is not asked to perform 101; judge 2 (already scored) is not asked again.
  assertEquals(sent(clients.dj1, "performance_start"), []);
  assertEquals(sent(clients.judge2, "enable_scoring"), []);
  assertEquals(sent(clients.judge3, "enable_scoring"), [
    { competition_id: 10, position: 1 },
  ]);
  assertEquals(sent(clients.sb1, "score_update"), [saved]); // board shows it again
  assertEquals(session.status().waiting_for, ["judge3"]);

  resolveTag(scoreTag(10, 101, 3), five);
  await delay(30);
  // 101 is finalized, and the session goes straight on to 102's performance.
  assertEquals(
    events.filter((e) => e.kind === "competitor_finalized").map((e) =>
      (e as { competitorId: number }).competitorId
    ),
    [101],
  );
  assertEquals(sent(clients.dj1, "performance_start"), [
    { competition_id: 10, position: 2 },
  ]);
  session.abort();
  await done;
});
