// "start" resumes where a session left off: finalized/skipped competitors are not
// run again, and the one that was being scored gets its scoring re-opened.
import { assertEquals } from "@std/assert";
import { planResume, type ResumeRows } from "../../src/resume.ts";
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

const rows = (
  statuses: Record<string, string>,
  performedScores: ResumeRows["performedScores"] = [],
  sessionStatus = "active",
): ResumeRows => ({
  sessionStatus,
  competitors: Object.entries(statuses).map(([k, status]) => {
    const [competition_id, competitor_id] = k.split(":").map(Number);
    return { competition_id, competitor_id, status };
  }),
  performedScores,
});

Deno.test("planResume: finalized and skipped competitors at the front are finished", () => {
  const plan = planResume(
    [comp(10, 100, 101, 102, 103)],
    rows({
      "10:100": "finalized",
      "10:101": "skipped",
      "10:102": "upcoming",
      "10:103": "upcoming",
    }),
  );
  assertEquals([...plan.finished], ["10:100", "10:101"]);
  assertEquals(plan.reopen, undefined); // 102 is run from its performance
});

Deno.test("planResume: a performed competitor gets scoring re-opened with its saved scores", () => {
  const plan = planResume(
    [comp(10, 100, 101), comp(11, 110)],
    rows(
      { "10:100": "finalized", "10:101": "performed", "11:110": "upcoming" },
      [
        {
          competition_id: 10,
          competitor_id: 101,
          judge_id: 2,
          criteria_id: 1,
          score: 7,
        },
      ],
    ),
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

Deno.test("planResume: a performed competitor with no saved scores still re-opens scoring", () => {
  const plan = planResume([comp(10, 100)], rows({ "10:100": "performed" }));
  assertEquals(plan.reopen?.scores, []);
});

Deno.test("planResume: earlier competitors are never revisited, even if not finalized", () => {
  // Only what is in play when it stopped matters; 100 was left 'performed' by
  // an older run, 101 is the one in play.
  const plan = planResume(
    [comp(10, 100, 101)],
    rows({ "10:100": "finalized", "10:101": "upcoming" }),
  );
  assertEquals([...plan.finished], ["10:100"]);
});

Deno.test("planResume: a completed session starts from scratch", () => {
  const completed = rows({ "10:100": "finalized" }, [], "completed");
  assertEquals(planResume([comp(10, 100)], completed).finished.size, 0);
  assertEquals(planResume([comp(10, 100)], undefined).finished.size, 0);
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
